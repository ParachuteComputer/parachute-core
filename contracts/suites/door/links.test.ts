// Surface C: links, search and history. The parts of a vault an app leans on once it holds more than one note.
import { describe, expect, test } from "bun:test";
import { enc, fp, refusal, rest, runId, shape } from "./_door.ts";

const api = rest("write");
const admin = rest("admin");

describe("links", () => {
  test("a [[wikilink]] becomes a link both ends can see", async () => {
    const r = runId("links");
    const b = await api.post("/notes", { content: "target", path: `${r}/b` });
    const a = await api.post("/notes", { content: `see [[${r}/b]]`, path: `${r}/a` });
    expect(a.status).toBe(201);
    const from = await api.get(`/notes/${a.body.id}?include_links=true`);
    const to = await api.get(`/notes/${b.body.id}?include_links=true`);
    const out = (from.body.links ?? []).filter((l: any) => l.targetId === b.body.id || l.target_id === b.body.id || l.target === b.body.id);
    expect(out.length).toBe(1);
    expect(JSON.stringify(to.body.links ?? [])).toContain(a.body.id);
    fp("links/link.shape", shape(from.body.links[0]));
  });

  test("a link to a note that doesn't exist yet resolves when the note is made, and goes when the text does", async () => {
    const r = runId("links");
    const a = await api.post("/notes", { content: `later [[${r}/later]]`, path: `${r}/a` });
    expect(a.status).toBe(201);
    fp("links/unresolved.warning", shape(a.body.warnings ?? null));
    const later = await api.post("/notes", { content: "now", path: `${r}/later` });
    const got = await api.get(`/notes/${a.body.id}?include_links=true`);
    expect(JSON.stringify(got.body.links ?? [])).toContain(later.body.id);
    const cut = await api.patch(`/notes/${a.body.id}`, { content: "no link now", if_updated_at: got.body.updatedAt });
    expect(cut.status).toBe(200);
    const after = await api.get(`/notes/${a.body.id}?include_links=true`);
    expect(JSON.stringify(after.body.links ?? [])).not.toContain(later.body.id);
  });

  test("an app can add a typed link, and find the path between two notes", async () => {
    const r = runId("links");
    const [a, b, c] = await Promise.all(["a", "b", "c"].map((n) => api.post("/notes", { content: n, path: `${r}/${n}` })));
    const l1 = await api.patch(`/notes/${a!.body.id}`, { links: { add: [{ target: b!.body.id, relationship: "depends-on" }] }, if_updated_at: a!.body.updatedAt });
    expect(l1.status, JSON.stringify(l1.body)).toBe(200);
    const l2 = await api.patch(`/notes/${b!.body.id}`, { links: { add: [{ target: c!.body.id, relationship: "depends-on" }] }, if_updated_at: b!.body.updatedAt });
    expect(l2.status).toBe(200);
    const path = await api.get(`/find-path?source=${a!.body.id}&target=${c!.body.id}`);
    expect(path.status).toBe(200);
    expect(JSON.stringify(path.body)).toContain(b!.body.id);
    fp("links/find-path.shape", shape(path.body));
    const none = await api.get(`/find-path?source=${c!.body.id}&target=${a!.body.id}&direction=outbound`);
    fp("links/find-path.none", { status: none.status, shape: shape(none.body) });
  });
});

describe("search", () => {
  test("search finds a note by its words, forgets old words, and forgets deleted notes", async () => {
    const word = `zq${runId("w")}`;
    const next = `zq${runId("w")}`;
    const made = await api.post("/notes", { content: `the ${word} appears here`, path: `${runId("search")}/s` });
    const hit = await api.get(`/notes?search=${word}`);
    expect(hit.status).toBe(200);
    expect(hit.body.map((n: any) => n.id)).toEqual([made.body.id]);
    fp("search/hit.shape", shape(hit.body[0]));
    const up = await api.patch(`/notes/${made.body.id}`, { content: `now ${next}`, if_updated_at: made.body.updatedAt });
    expect(up.status).toBe(200);
    expect((await api.get(`/notes?search=${word}`)).body).toEqual([]);
    expect((await api.get(`/notes?search=${next}`)).body.length).toBe(1);
    await api.del(`/notes/${made.body.id}`);
    expect((await api.get(`/notes?search=${next}`)).body).toEqual([]);
  });

  test("a search that can't be parsed is refused the same way", async () => {
    const r = await api.get(`/notes?search=${enc('"unclosed AND (')}`);
    fp("search/odd-query", { status: r.status, ok: Array.isArray(r.body) });
  });
});

describe("history", () => {
  test("every change keeps the version before it, readable and restorable", async () => {
    const made = await api.post("/notes", { content: "first", path: `${runId("hist")}/h` });
    const up = await api.patch(`/notes/${made.body.id}`, { content: "second", if_updated_at: made.body.updatedAt });
    expect(up.status).toBe(200);
    const versions = await api.get(`/notes/${made.body.id}/versions`);
    expect(versions.status).toBe(200);
    fp("history/versions.shape", shape(versions.body));
    const list = Array.isArray(versions.body) ? versions.body : versions.body.versions;
    expect(list.length).toBeGreaterThanOrEqual(1);
    const ix = list[list.length - 1].version_ix ?? list[list.length - 1].ix ?? list[list.length - 1].version;
    const one = await api.get(`/notes/${made.body.id}/versions/${ix}`);
    expect(one.status).toBe(200);
    fp("history/version.shape", shape(one.body));
    expect(JSON.stringify(one.body)).toContain("first");
    const blind = await api.post(`/notes/${made.body.id}/restore`, { version_ix: ix });
    expect(blind.status).toBe(428);
    fp("history/refusal.blind-restore", refusal(blind));
    const back = await api.post(`/notes/${made.body.id}/restore`, { version_ix: ix, if_updated_at: up.body.updatedAt });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    fp("history/restore.reply.shape", shape(back.body));
    expect((await api.get(`/notes/${made.body.id}`)).body.content).toBe("first");
  });

  test("a plain delete leaves a trace an admin can list; forgetting takes an admin", async () => {
    const made = await api.post("/notes", { content: "to delete", path: `${runId("hist")}/d` });
    await api.del(`/notes/${made.body.id}`);
    const listed = await admin.get("/history/deleted");
    expect(listed.status).toBe(200);
    fp("history/deleted.shape", shape(Array.isArray(listed.body) ? listed.body.slice(0, 1) : listed.body));
    const asWriter = await api.get("/history/deleted");
    expect(asWriter.status).toBe(403);
    const made2 = await api.post("/notes", { content: "to forget", path: `${runId("hist")}/f` });
    const forget = await api.del(`/notes/${made2.body.id}?erase_history=true`);
    expect(forget.status).toBe(403);
    fp("history/refusal.forget-without-admin", refusal(forget));
    expect((await admin.del(`/notes/${made2.body.id}?erase_history=true`)).status).toBe(200);
  });
});
