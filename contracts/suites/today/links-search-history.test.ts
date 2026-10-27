// Links between notes, full-text search, and the history every note keeps.
import { describe, expect, test } from "bun:test";
import { enc, operator, pass, paths, rest, runId, services } from "../lib.ts";

const api = operator();

async function linksOf(id: string): Promise<{ sourceId: string; targetId: string }[]> {
  const r = await api.get(`/notes/${id}?include_links=true`);
  expect(r.status).toBe(200);
  return r.body.links ?? [];
}

describe("links", () => {
  test("a [[wikilink]] in the body becomes a link both notes can see", async () => {
    const r = runId("links");
    const target = await api.post("/notes", { content: "the target", path: `${r}/Target` });
    const source = await api.post("/notes", { content: `see [[${r}/Target]] for more`, path: `${r}/Source` });

    const out = await linksOf(source.body.id);
    expect(out.some((l) => l.sourceId === source.body.id && l.targetId === target.body.id)).toBe(true);
    // The target sees the backlink.
    const back = await linksOf(target.body.id);
    expect(back.some((l) => l.sourceId === source.body.id && l.targetId === target.body.id)).toBe(true);
  });

  test("a link to a note that doesn't exist yet resolves when the note is made", async () => {
    const r = runId("links");
    const source = await api.post("/notes", { content: `waiting for [[${r}/Later]]`, path: `${r}/Early` });
    expect(source.status).toBe(201);
    expect(await linksOf(source.body.id)).toEqual([]);
    const later = await api.post("/notes", { content: "here now", path: `${r}/Later` });
    const out = await linksOf(source.body.id);
    expect(out.some((l) => l.targetId === later.body.id)).toBe(true);
  });

  test("removing the wikilink from the body removes the link", async () => {
    const r = runId("links");
    await api.post("/notes", { content: "t", path: `${r}/T` });
    const s = await api.post("/notes", { content: `[[${r}/T]]`, path: `${r}/S` });
    expect((await linksOf(s.body.id)).length).toBe(1);
    await api.patch(`/notes/${s.body.id}`, { content: "no links now", if_updated_at: s.body.updatedAt });
    expect(await linksOf(s.body.id)).toEqual([]);
  });

  test("a note's neighbourhood follows links two steps out", async () => {
    const r = runId("links");
    await api.post("/notes", { content: "c", path: `${r}/C` });
    await api.post("/notes", { content: `[[${r}/C]]`, path: `${r}/B` });
    const a = await api.post("/notes", { content: `[[${r}/B]]`, path: `${r}/A` });
    await api.post("/notes", { content: "far away", path: `${r}/D` });
    const near = await api.get(`/notes?near[note_id]=${a.body.id}&near[depth]=2&path_prefix=${enc(r)}`);
    expect(near.status).toBe(200);
    expect(paths(near.body).filter((p) => p !== `${r}/A`)).toEqual([`${r}/B`, `${r}/C`]);
  });
});

describe("search", () => {
  test("full-text search finds a note by a word in its body, and stops finding it when the word goes", async () => {
    const word = `zq${runId("w").replace(/[^a-z0-9]/g, "")}`;
    const made = await api.post("/notes", { content: `a note about ${word} and other things`, path: `${runId("search")}/n` });
    const hit = await api.get(`/notes?search=${word}`);
    expect(hit.status).toBe(200);
    expect(hit.body.map((n: any) => n.id)).toEqual([made.body.id]);

    await api.patch(`/notes/${made.body.id}`, { content: "nothing to see", if_updated_at: made.body.updatedAt });
    expect((await api.get(`/notes?search=${word}`)).body).toEqual([]);
  });

  test("a deleted note leaves search", async () => {
    const word = `zq${runId("w").replace(/[^a-z0-9]/g, "")}`;
    const made = await api.post("/notes", { content: word, path: `${runId("search")}/n` });
    expect((await api.get(`/notes?search=${word}`)).body.length).toBe(1);
    await api.del(`/notes/${made.body.id}`);
    expect((await api.get(`/notes?search=${word}`)).body).toEqual([]);
  });
});

describe("history", () => {
  test("each change keeps the version before it, readable in full", async () => {
    let note = (await api.post("/notes", { content: "first", path: `${runId("hist")}/n`, metadata: { v: 1 } })).body;
    for (const [content, v] of [["second", 2], ["third", 3]] as const) {
      note = (await api.patch(`/notes/${note.id}`, { content, metadata: { v }, if_updated_at: note.updatedAt })).body;
    }
    const list = await api.get(`/notes/${note.id}/versions`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);
    const bodies: string[] = [];
    for (const v of list.body.versions) {
      const one = await api.get(`/notes/${note.id}/versions/${v.version_ix}`);
      expect(one.status).toBe(200);
      bodies.push(one.body.content ?? one.body.version?.content);
    }
    expect(bodies.sort()).toEqual(["first", "second"]);
    expect((await api.get(`/notes/${note.id}`)).body.content).toBe("third");
  });

  test("an old version can be restored, and the restore is itself history", async () => {
    let note = (await api.post("/notes", { content: "original", path: `${runId("hist")}/r` })).body;
    note = (await api.patch(`/notes/${note.id}`, { content: "changed", if_updated_at: note.updatedAt })).body;
    const versions = (await api.get(`/notes/${note.id}/versions`)).body.versions;
    const original = versions.find((v: any) => v.content_len === "original".length) ?? versions[versions.length - 1];
    const restored = await api.post(`/notes/${note.id}/restore`, {
      version_ix: original.version_ix,
      if_updated_at: note.updatedAt,
    });
    expect(restored.status).toBe(200);
    expect((await api.get(`/notes/${note.id}`)).body.content).toBe("original");
    expect((await api.get(`/notes/${note.id}/versions`)).body.total).toBe(2);
  });

  test("history records who made each change", async () => {
    // Two different writers: the operator, then a person with a hub-signed pass.
    const token = await pass({ level: "write" });
    const person = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).sub;
    const them = rest(services().vaultViaHub, token);
    let note = (await api.post("/notes", { content: "a", path: `${runId("hist")}/who` })).body;
    note = (await them.patch(`/notes/${note.id}`, { content: "bb", if_updated_at: note.updatedAt })).body;
    note = (await api.patch(`/notes/${note.id}`, { content: "ccc", if_updated_at: note.updatedAt })).body;
    const versions = (await api.get(`/notes/${note.id}/versions`)).body.versions;
    // Each saved version records who replaced it: the person replaced "a", then the operator replaced "bb".
    const replacedBy = Object.fromEntries(versions.map((v: any) => [v.content_len, v.actor]));
    expect(replacedBy).toEqual({ 1: person, 2: "operator" });
  });
});
