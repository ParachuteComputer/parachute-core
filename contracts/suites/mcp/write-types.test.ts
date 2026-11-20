// Write access may add a new type (T-476; packages/vault/docs/contracts/write-defines-types.md).
//
// An AI holding the write access a person grants could make records but not say what they are: manage-types was
// admin-only, so it wasn't even in tools/list, and the AI fell back on note bodies the app couldn't read as fields
// (the audit's walk 4). Now a write credential may make a type nobody has defined yet, and add fields to a type it
// made itself (same `by` and `via` stamps as its writes), through MCP's manage-types. Changing or removing a field, any
// type it didn't make, parents, relationships, rename, merge, delete, prune and migrate stay admin. A tag-scoped
// credential gets none of it. REST's PUT /api/tags/:name stays admin.
// Default chosen by Uni; Aaron or Benjamin may overrule (a change to what a contract means).
import { describe, expect, test } from "bun:test";
import { enc, mcp, operator, pass, rest, runId, services } from "../lib.ts";

const field = () => runId("f").replace(/-/g, "_");

async function writer() {
  const s = services();
  return mcp(`${s.vaultViaHub}/mcp`, await pass({ level: "write" }));
}

describe("mcp/write-types: write access may add a new type", () => {
  test("a write session lists manage-types and makes a new type with fields; its records carry them", async () => {
    const c = await writer();
    expect(await c.tools()).toContain("manage-types");
    const book = runId("book");
    const status = field();
    await c.call("manage-types", { tag: book, fields: { [status]: { type: "string", enum: ["to-read", "reading", "read"] } } });
    const t = await c.call("list-types", { name: book });
    expect(t.kind).toBe("type");
    expect(Object.keys(t.fields ?? {})).toContain(status);
    const r = await c.call("create-record", { path: runId("b"), types: [book], fields: { [status]: "to-read" } });
    expect(r.types).toEqual([book]);
    expect(r.fields?.[status] ?? r.metadata?.[status]).toBe("to-read");
    await c.close();
  });

  test("it may define a type its records already named, and add fields to a type it made", async () => {
    const c = await writer();
    const book = runId("book");
    await c.call("create-record", { path: runId("b"), types: [book] }); // the name exists, nobody defined it
    const a = field();
    const b = field();
    await c.call("manage-types", { tag: book, description: "A book", fields: { [a]: { type: "string" } } });
    await c.call("manage-types", { tag: book, fields: { [b]: { type: "integer" } } });
    const t = await c.call("list-types", { name: book });
    expect(Object.keys(t.fields ?? {}).sort()).toEqual([a, b].sort());
    expect(t.fields[a].type).toBe("string");
    await c.close();
  });

  test("on its own type it may not change or remove a field, set parents or relationships", async () => {
    const c = await writer();
    const book = runId("book");
    const a = field();
    await c.call("manage-types", { tag: book, fields: { [a]: { type: "string" } } });
    await expect(c.call("manage-types", { tag: book, fields: { [a]: { type: "integer" } } })).rejects.toThrow(/admin/);
    await expect(c.call("manage-types", { tag: book, fields: { [a]: { type: "string", indexed: true } } })).rejects.toThrow(/admin/);
    await expect(c.call("manage-types", { tag: book, fields: null })).rejects.toThrow(/admin/);
    await expect(c.call("manage-types", { tag: runId("child"), parent_names: [book] })).rejects.toThrow(/admin/);
    await expect(c.call("manage-types", { tag: runId("rel"), relationships: { cites: {} } })).rejects.toThrow(/admin/);
    for (const [action, args] of [
      ["delete", { tag: book }],
      ["rename", { old_name: book, new_name: runId("other") }],
      ["merge", { sources: [book], target: runId("other") }],
      ["prune", {}],
      ["migrate", { tag: book, field: a, transform: { kind: "to_string" } }],
    ] as const) {
      await expect(c.call("manage-types", { action, ...args })).rejects.toThrow(/admin/);
    }
    const t = await c.call("list-types", { name: book });
    expect(t.fields[a].type).toBe("string");
    await c.close();
  });

  test("it may not add fields to a type someone else made", async () => {
    const theirs = runId("theirs");
    const put = await operator().put(`/tags/${enc(theirs)}`, { fields: { [field()]: { type: "string" } } });
    expect(put.status).toBe(200);
    const c = await writer();
    await expect(c.call("manage-types", { tag: theirs, fields: { [field()]: { type: "string" } } })).rejects.toThrow(/admin/);
    await c.close();
  });

  test("over REST, defining a type stays admin (Prism's compat suite pins a write pass's 403)", async () => {
    const w = rest(services().vaultViaHub, await pass({ level: "write" }));
    expect((await w.put(`/tags/${enc(runId("mine"))}`, { fields: { [field()]: { type: "string" } } })).status).toBe(403);
  });

  test("a tag-scoped write credential can't define types, and read can't either", async () => {
    const s = services();
    const scoped = await mcp(`${s.vaultViaHub}/mcp`, await pass({ level: "write", tags: [runId("scope")] }));
    await expect(scoped.call("manage-types", { tag: runId("book"), fields: { [field()]: { type: "string" } } })).rejects.toThrow(/admin|Unknown tool/);
    await scoped.close();
    const reader = await mcp(`${s.vaultViaHub}/mcp`, await pass({ level: "read" }));
    expect(await reader.tools()).not.toContain("manage-types");
    await reader.close();
  });
});
