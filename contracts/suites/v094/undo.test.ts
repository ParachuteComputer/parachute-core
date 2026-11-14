// v094/undo: undo by write set (ROADMAP 0.9.4 row 3; T-471, PLAN-0.9.4 PR 2). `POST /api/write-sets/<id>/undo`
// puts back every record one write set changed, and nothing else. The undo is itself a write set, so undoing it puts
// the changes back. If a later write changed one of the records, undo refuses and lists the conflicts (all or
// nothing), unless `force`. A key undoes its own sets; admin any; a tag-scoped key only a set it can see whole.
// Black box: HTTP to the candidate's hub, keys minted by name. Made-up data.
// Red on the write-sets PR (b31f47d9): the undo route is 404.
import { beforeAll, describe, expect, test } from "bun:test";
import { must, pass, rest, services } from "../lib.ts";
import { adminPass, enc, mintKey, shortId, type Key } from "./_keys.ts";

let writer: Key; // the AI whose writes get undone
let other: Key; // another writer
let admin: Key;

beforeAll(async () => {
  writer = await mintKey("undo-claude", "write");
  other = await mintKey("undo-other", "write");
  admin = await adminPass();
});

const newestSet = async (k: Key) => {
  const r = await k.api("GET", "/write-sets?by=me&limit=1");
  must(r.status === 200 && r.body.write_sets.length, `newest set: ${r.status} ${r.text.slice(0, 200)}`);
  return r.body.write_sets[0].id as string;
};
const undo = (k: Key, id: string, body: Record<string, unknown> = {}) => k.api("POST", `/write-sets/${enc(id)}/undo`, body);

/** A record as a person would compare it: everything but its timestamps and who last changed it. */
async function snapshot(k: Key, id: string) {
  const r = await k.api("GET", `/notes/${id}?include_content=true&include_links=true`);
  if (r.status === 404) return null;
  must(r.status === 200, `read ${id}: ${r.status}`);
  const n = r.body;
  must(Array.isArray(n.links), `read ${id}: no links array in ${Object.keys(n).join(",")}`);
  const links = (n.links as any[]).filter((l) => (l.sourceId ?? l.source_id) === id);
  return {
    id: n.id,
    path: n.path,
    content: n.content,
    metadata: n.metadata,
    tags: [...(n.tags ?? [])].sort(),
    createdAt: n.createdAt ?? n.created_at,
    links: links.map((l: any) => `${l.targetId ?? l.target_id}:${l.relationship}`).sort(),
  };
}

describe("v094/undo: puts back what the set changed, and nothing else", () => {
  test("a set that created one record, changed a second and deleted a third: undo restores all three, leaves a fourth alone", async () => {
    const t = `u${shortId()}`;
    const anchor = (await other.api("POST", "/notes", { path: `${t}/anchor`, content: "a link target", tags: [t] })).body.id;
    const changed = (await writer.api("POST", "/notes", { path: `${t}/changed`, content: "the body before", metadata: { status: "draft", n: 1 }, tags: [t, `${t}-a`] })).body.id;
    const doomed = (await writer.api("POST", "/notes", { path: `${t}/doomed`, content: `kept words [[${t}/anchor]]`, metadata: { k: "v" }, tags: [t], links: [{ target: anchor, relationship: "cites" }] })).body.id;
    const bystander = (await other.api("POST", "/notes", { path: `${t}/bystander`, content: "untouched by the set" })).body.id;
    const before = { changed: await snapshot(writer, changed), doomed: await snapshot(writer, doomed), bystander: await snapshot(writer, bystander) };
    expect(before.doomed!.links).toEqual([`${anchor}:cites`, `${anchor}:wikilink`].sort());

    // One write set, three records (a client groups three calls with one id).
    const setId = `set-${shortId()}${shortId()}`;
    const h = { "Parachute-Write-Set": setId, "Parachute-Why": "tidying the project" };
    const made = await writer.api("POST", "/notes", { path: `${t}/made`, content: "new", tags: [t] }, h);
    must(made.status === 201, `create in set: ${made.status}`);
    const edit = await writer.api("PATCH", `/notes/${changed}`, { content: "the body after", metadata: { status: "done", n: null }, tags: { add: [`${t}-b`], remove: [`${t}-a`] }, links: { add: [{ target: anchor, relationship: "mentions" }] }, force: true }, h);
    must(edit.status === 200, `edit in set: ${edit.status} ${edit.text.slice(0, 200)}`);
    must((await writer.api("DELETE", `/notes/${doomed}`, undefined, h)).status === 200, "delete in set");
    await other.api("PATCH", `/notes/${bystander}`, { content: "changed by someone else", force: true });
    const bystanderAfter = await snapshot(writer, bystander);

    const r = await undo(writer, setId, { why: "that tidy was a mistake" });
    expect(r.status).toBe(200);
    expect(r.body.undoes).toBe(setId);
    expect(await snapshot(writer, made.body.id)).toBeNull();
    expect(await snapshot(writer, changed)).toEqual(before.changed);
    expect(await snapshot(writer, doomed)).toEqual(before.doomed);
    expect(await snapshot(writer, bystander)).toEqual(bystanderAfter);
    expect(bystanderAfter).not.toEqual(before.bystander);

    // The undo is a set of its own, saying what it undoes and why; the undone set says who undid it.
    const u = (await writer.api("GET", `/write-sets/${enc(r.body.write_set)}`)).body;
    expect(u).toMatchObject({ undoes: setId, why: "that tidy was a mistake", via: `key:${writer.name}` });
    expect((await writer.api("GET", `/write-sets/${enc(setId)}`)).body.undone_by).toBe(r.body.write_set);
  });

  test("undoing the undo puts the set's changes back", async () => {
    const path = `uu/${shortId()}`;
    const id = (await writer.api("POST", "/notes", { path, content: "one" })).body.id;
    await writer.api("PATCH", `/notes/${id}`, { content: "two", force: true });
    const edit = await newestSet(writer);
    const first = await undo(writer, edit);
    expect(first.status).toBe(200);
    expect((await snapshot(writer, id))?.content).toBe("one");
    const second = await undo(writer, first.body.write_set);
    expect(second.status).toBe(200);
    expect((await snapshot(writer, id))?.content).toBe("two");
  });

  test("a set already undone answers 409 already_undone with the undoing set", async () => {
    const id = (await writer.api("POST", "/notes", { path: `twice/${shortId()}`, content: "x" })).body.id;
    await writer.api("PATCH", `/notes/${id}`, { content: "y", force: true });
    const edit = await newestSet(writer);
    const first = await undo(writer, edit);
    expect(first.status).toBe(200);
    const again = await undo(writer, edit);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error_type: "already_undone", undone_by: first.body.write_set });
  });
});

describe("v094/undo: only what the set changed", () => {
  test("a set that changed only a field leaves the body as it is now", async () => {
    const id = (await writer.api("POST", "/notes", { path: `field/${shortId()}`, content: "the body stays", metadata: { stage: 1 } })).body.id;
    await writer.api("PATCH", `/notes/${id}`, { metadata: { stage: 2 }, force: true });
    const set = await newestSet(writer);
    expect((await undo(writer, set)).status).toBe(200);
    const now = await snapshot(writer, id);
    expect(now?.content).toBe("the body stays");
    expect(now?.metadata).toEqual({ stage: 1 });
  });
});

describe("v094/undo: a later write makes it refuse, all or nothing", () => {
  test("a later edit by another key: 409 undo_conflict listing it, nothing changed; force goes ahead", async () => {
    const t = `c${shortId()}`;
    const a = (await writer.api("POST", "/notes", { path: `${t}/a`, content: "a1" })).body.id;
    const b = (await writer.api("POST", "/notes", { path: `${t}/b`, content: "b1" })).body.id;
    const setId = `cf-${shortId()}${shortId()}`;
    const h = { "Parachute-Write-Set": setId };
    await writer.api("PATCH", `/notes/${a}`, { content: "a2", force: true }, h);
    await writer.api("PATCH", `/notes/${b}`, { content: "b2", force: true }, h);
    await other.api("PATCH", `/notes/${b}`, { content: "b3", force: true });
    const theirs = await newestSet(other);

    const refused = await undo(writer, setId);
    expect(refused.status).toBe(409);
    expect(refused.body.error_type).toBe("undo_conflict");
    expect(refused.body.conflicts).toEqual([expect.objectContaining({ id: b, path: `${t}/b`, write_set: theirs, via: `key:${other.name}` })]);
    expect((await snapshot(writer, a))?.content).toBe("a2"); // all or nothing: a is not undone either
    expect((await snapshot(writer, b))?.content).toBe("b3");

    const forced = await undo(writer, setId, { force: true });
    expect(forced.status).toBe(200);
    expect(forced.body.forced.map((c: any) => c.id)).toEqual([b]);
    expect((await snapshot(writer, a))?.content).toBe("a1");
    expect((await snapshot(writer, b))?.content).toBe("b1");
  });
});

describe("v094/undo: who may undo", () => {
  test("a key can't undo another key's set (404, as reading it); admin can", async () => {
    const id = (await other.api("POST", "/notes", { path: `who/${shortId()}`, content: "theirs" })).body.id;
    const theirs = await newestSet(other);
    expect((await undo(writer, theirs)).status).toBe(404);
    expect((await snapshot(writer, id))?.content).toBe("theirs");
    const byAdmin = await undo(admin, theirs);
    expect(byAdmin.status).toBe(200);
    expect(await snapshot(writer, id)).toBeNull();
  });

  test("a read key can't undo even its own kind of set", async () => {
    const reader = rest(services().vaultViaHub, await pass({ level: "read" }));
    const id = (await writer.api("POST", "/notes", { path: `rd/${shortId()}`, content: "x" })).body.id;
    const set = await newestSet(writer);
    expect((await reader.post(`/write-sets/${enc(set)}/undo`, {})).status).toBe(403);
    expect(await snapshot(writer, id)).not.toBeNull();
  });

  test("a tag-scoped key can't undo its set once a record in it has left its scope", async () => {
    const t = `sk${shortId()}`;
    const scoped = rest(services().vaultViaHub, await pass({ level: "write", tags: [t] }));
    const made = await scoped.post("/notes", { path: `${t}/r`, content: "in scope", tags: [t] });
    must(made.status === 201, `scoped create: ${made.status}`);
    const mine = (await scoped.get("/write-sets?by=me&limit=1")).body.write_sets[0].id;
    await admin.api("PATCH", `/notes/${made.body.id}`, { tags: { remove: [t], add: [`${t}-out`] }, force: true });
    expect((await scoped.post(`/write-sets/${enc(mine)}/undo`, { force: true })).status).toBe(404);
    expect(await snapshot(admin, made.body.id)).not.toBeNull();
  });

  test("an unknown set is 404; a body with anything but force and why is 400", async () => {
    expect((await undo(writer, "ws_nosuchsetatall00000")).status).toBe(404);
    await writer.api("POST", "/notes", { path: `bad/${shortId()}`, content: "x" });
    const set = await newestSet(writer);
    const r = await undo(writer, set, { forse: true });
    expect(r.status).toBe(400);
    expect(r.body.error_type).toBe("unknown_parameter");
  });
});
