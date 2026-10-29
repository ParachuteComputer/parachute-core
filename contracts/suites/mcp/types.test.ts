// Types and tags (T-318 design §8a): one membership store, an explicit kind on each tag record. A note returns
// `types` (the subset of its tags that are types) beside `tags` (every name, unchanged through 0.9, so Prism's and
// Uni's readers keep working). Writes accept `types`; an old client's tags: ["task"] lands as the type it is. Queries
// gain `type` (with subtypes); `tag` on a type keeps today's expansion. Fields and parents belong to types.
import { describe, expect, test } from "bun:test";
import { enc, mcp, operator, pass, rest, runId, services } from "../lib.ts";

async function admin() {
  const s = services();
  return mcp(`${s.vaultViaHub}/mcp`, s.operatorToken);
}

describe("mcp/types", () => {
  test("a tag with fields or parents is a type, a bare label a tag; list-tags says which", async () => {
    const c = await admin();
    const task = runId("task");
    const label = runId("label");
    await c.call("manage-types", { tag: task, fields: { [runId("f").replace(/-/g, "_")]: { type: "string" } } });
    await c.call("manage-types", { tag: `${task}/chore`, parent_names: [task] });
    await c.call("create-note", { path: runId("n"), content: "x", tags: [label] });
    const rows = await c.call("list-tags", {});
    const kind = (n: string) => rows.find((r: any) => r.name === n)?.kind;
    expect([kind(task), kind(`${task}/chore`), kind(label)]).toEqual(["type", "type", "tag"]);
    await expect(c.call("manage-types", { tag: label, kind: "tag", fields: { [runId("f").replace(/-/g, "_")]: { type: "string" } } })).rejects.toThrow(/can't be a plain tag/);
    await c.close();
  });

  test("a note shows types beside its tags, over MCP and REST; writes accept types, and old tags-only writes land as types", async () => {
    const c = await admin();
    const task = runId("task");
    const pin = runId("pin");
    await c.call("manage-types", { tag: task, fields: { [runId("f").replace(/-/g, "_")]: { type: "string" } } });
    const path = runId("note");
    const made = await c.call("create-note", { path, content: "x", types: [task], tags: [pin] });
    expect([...made.tags].sort()).toEqual([pin, task].sort());
    expect(made.types).toEqual([task]);
    const viaRest = await operator().get(`/notes/${enc(path)}`);
    expect(viaRest.body.types).toEqual([task]);
    expect([...viaRest.body.tags].sort()).toEqual([pin, task].sort());
    const old = await c.call("create-note", { path: runId("old"), content: "y", tags: [task] });
    expect(old.types).toEqual([task]);
    await expect(c.call("create-note", { path: runId("bad"), content: "z", types: [pin] })).rejects.toThrow(/plain tag, not a type/);
    const rest = await operator().post("/notes", { path: runId("r"), content: "r", types: [pin] });
    expect(rest.status).toBe(422);
    await c.close();
  });

  test("query: type includes subtypes; tag on a type keeps today's expansion; type on a plain tag teaches", async () => {
    const c = await admin();
    const ev = runId("event");
    const pin = runId("pin");
    await c.call("manage-types", { tag: `${ev}/meeting`, parent_names: [ev] });
    await c.call("create-note", { notes: [{ path: `${ev}-a`, content: "a", tags: [ev] }, { path: `${ev}-b`, content: "b", tags: [`${ev}/meeting`] }, { path: `${ev}-c`, content: "c", tags: [pin] }] });
    const paths = (r: any) => (Array.isArray(r) ? r : r.notes).map((n: any) => n.path).sort();
    expect(paths(await c.call("query-notes", { type: ev }))).toEqual([`${ev}-a`, `${ev}-b`]);
    expect(paths(await c.call("query-notes", { tag: ev }))).toEqual([`${ev}-a`, `${ev}-b`]);
    await expect(c.call("query-notes", { type: pin })).rejects.toThrow(/plain tag, not a type/);
    await c.close();
  });

  // A tag-scoped key sees and touches only its tags; `types` are memberships like any other (Codex review, #18).
  test("tag scope: types can't write, reveal or probe what the key can't see", async () => {
    const s = services();
    const c = await admin();
    const work = runId("work");
    const secret = runId("secret");
    await c.call("manage-types", { tag: secret, fields: { [runId("f").replace(/-/g, "_")]: { type: "string" } } });
    const shared = runId("shared");
    const sharedId = (await c.call("create-note", { path: shared, content: "both", tags: [work, secret] })).id;
    const tok = await pass({ level: "write", tags: [work] });
    const scoped = await mcp(`${s.vaultViaHub}/mcp`, tok);
    // Writes: a hidden type is refused like a hidden tag, by create and by update.
    const made = await scoped.call("create-note", { path: runId("w"), content: "w", tags: [work], types: [secret] }).catch((e) => e);
    expect(JSON.stringify(made)).toMatch(/tag_scope_violation|Forbidden|allowlist/);
    const upd = await scoped.call("update-note", { id: sharedId, types: { remove: [secret] }, force: true }).catch((e) => e);
    expect(JSON.stringify(upd)).toMatch(/tag_scope_violation|Forbidden|allowlist/);
    expect((await c.call("query-notes", { id: shared })).tags).toContain(secret);
    // Reads: the hidden type is scrubbed from types as from tags, over MCP and REST.
    const read = await scoped.call("query-notes", { id: shared });
    expect(read.tags).toEqual([work]);
    expect(read.types ?? []).toEqual([]);
    const viaRest = await rest(s.vaultViaHub, tok).get(`/notes/${enc(shared)}`);
    expect(viaRest.body.tags).toEqual([work]);
    expect(viaRest.body.types ?? []).toEqual([]);
    // A type inside the key's scope is still made a type over REST (Codex review, #18).
    const inScope = `${work}/kind`;
    const r = await rest(s.vaultViaHub, tok).post("/notes", { path: runId("in"), content: "in", types: [inScope] });
    expect(r.status).toBe(201);
    expect(r.body.types).toEqual([inScope]);
    // Queries: a hidden type and an absent name answer alike.
    const hidden = await scoped.call("query-notes", { type: secret }).catch((e) => String(e));
    const absent = await scoped.call("query-notes", { type: runId("absent") }).catch((e) => String(e));
    expect(JSON.stringify(hidden)).toBe(JSON.stringify(absent));
    await scoped.close();
    await c.close();
  });

  test("a #-prefixed type lands on the same bare record as everywhere else", async () => {
    const c = await admin();
    const t = runId("hash");
    const made = await c.call("create-note", { path: runId("h"), content: "h", types: [`#${t}`] });
    expect(made.tags).toEqual([t]);
    expect(made.types).toEqual([t]);
    await c.close();
  });
});

