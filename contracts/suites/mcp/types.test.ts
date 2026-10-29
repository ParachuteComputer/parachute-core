// Types and tags (T-318 design §8a): one membership store, an explicit kind on each tag record. A note returns
// `types` (the subset of its tags that are types) beside `tags` (every name, unchanged through 0.9, so Prism's and
// Uni's readers keep working). Writes accept `types`; an old client's tags: ["task"] lands as the type it is. Queries
// gain `type` (with subtypes); `tag` on a type keeps today's expansion. Fields and parents belong to types.
import { describe, expect, test } from "bun:test";
import { enc, mcp, operator, runId, services } from "../lib.ts";

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
});
