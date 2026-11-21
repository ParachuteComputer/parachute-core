// compat/types-write-rest: write access may add a new type over REST too, on the record door's /api/types (T-476;
// packages/vault/docs/contracts/write-defines-types.md, "REST").
//
// The app holds the write access a person grants, and it talks REST. So that it can apply a pack of types with no AI
// (a newcomer's one tap), `PUT /api/types/:name` takes the rule MCP's manage-types already has: a write credential with
// no tag scope may make a type nobody has defined yet, and add fields to a type it made itself (the same `by` and `via`
// stamp; REST's via is `api`). Changing or removing a field, a type it didn't make, a plain label, parents,
// relationships, replacing the field map, delete, rename, merge and migrate stay admin, and say so.
// `PUT /api/tags/:name` is unchanged: admin only (Prism calls it; its compat suite pins a write pass's 403).
// Default chosen by Uni; Aaron or Benjamin may overrule (a change to what a contract means).
// Red before this change: every write PUT on /api/types answered 403.
import { describe, expect, test } from "bun:test";
import { enc, mcp, operator, pass, rest, runId, services } from "../lib.ts";

const field = () => runId("f").replace(/-/g, "_");
const writer = async () => rest(services().vaultViaHub, await pass({ level: "write" }));

describe("compat/types-write-rest: write access may add a new type over REST", () => {
  test("a write pass makes a new type with fields on /api/types; its records carry them", async () => {
    const w = await writer();
    const book = runId("book");
    const status = field();
    const put = await w.put(`/types/${enc(book)}`, { kind: "type", description: "A book", fields: { [status]: { type: "string", enum: ["to-read", "read"], default: "to-read" } } });
    expect(put.status).toBe(200);
    const t = await w.get(`/types/${enc(book)}`);
    expect(t.body.kind).toBe("type");
    expect(t.body.description).toBe("A book");
    expect(t.body.fields?.[status]?.type).toBe("string");
    const r = await w.post("/records", { path: runId("b"), body: "x", types: [book] });
    expect(r.status).toBe(201);
    expect(r.body.fields?.[status]).toBe("to-read");
  });

  test("the same pass adds fields to its own type, and the same definition again changes nothing", async () => {
    const w = await writer();
    const book = runId("book");
    const a = field();
    const b = field();
    expect((await w.put(`/types/${enc(book)}`, { fields: { [a]: { type: "string" } } })).status).toBe(200);
    expect((await w.put(`/types/${enc(book)}`, { fields: { [b]: { type: "date" } } })).status).toBe(200);
    expect((await w.put(`/types/${enc(book)}`, { fields: { [a]: { type: "string" } } })).status).toBe(200);
    const t = await w.get(`/types/${enc(book)}`);
    expect(Object.keys(t.body.fields ?? {}).sort()).toEqual([a, b].sort());
  });

  test("a type its records already named, with no definition, is a type nobody defined yet", async () => {
    const w = await writer();
    const book = runId("book");
    expect((await w.post("/records", { path: runId("b"), body: "x", types: [book] })).status).toBe(201);
    expect((await w.put(`/types/${enc(book)}`, { fields: { [field()]: { type: "string" } } })).status).toBe(200);
  });

  test("on its own type it may not change or remove a field, replace the map, set parents, relationships or kind tag", async () => {
    const w = await writer();
    const book = runId("book");
    const a = field();
    expect((await w.put(`/types/${enc(book)}`, { fields: { [a]: { type: "string" } } })).status).toBe(200);
    for (const body of [
      { fields: { [a]: { type: "integer" } } },
      { fields: { [a]: { type: "string", indexed: true } } },
      { fields: null },
      { fields: { [field()]: { type: "string" } }, replace_fields: true },
      { parent_names: [runId("p")] },
      { relationships: { cites: {} } },
      { kind: "tag" },
    ]) {
      const r = await w.put(`/types/${enc(book)}`, body);
      expect([JSON.stringify(body), r.status]).toEqual([JSON.stringify(body), 403]);
      expect(String(r.body?.message ?? "")).toMatch(/needs admin/);
    }
    const t = await w.get(`/types/${enc(book)}`);
    expect(Object.keys(t.body.fields ?? {})).toEqual([a]);
    expect(t.body.fields[a].type).toBe("string");
    // a refusal lands nothing: not the description either
    expect((await w.put(`/types/${enc(book)}`, { description: "changed", fields: { [a]: { type: "integer" } } })).status).toBe(403);
    expect((await w.get(`/types/${enc(book)}`)).body.description ?? null).toBeNull();
    // what stays admin on any type
    expect((await w.post(`/types/${enc(book)}/migrate`, { field: a, transform: { kind: "to_string" } })).status).toBe(403);
    expect((await w.del(`/types/${enc(book)}`)).status).toBe(403);
    expect((await w.post(`/types/${enc(book)}/rename`, { new_name: runId("other") })).status).toBe(403);
    expect((await w.post("/types/merge", { sources: [book], target: runId("other") })).status).toBe(403);
  });

  test("it may not add fields to a type someone else made, a plain label, _default or another type's parent", async () => {
    const w = await writer();
    const theirs = runId("theirs");
    expect((await operator().put(`/types/${enc(theirs)}`, { fields: { [field()]: { type: "string" } } })).status).toBe(200);
    const label = runId("label");
    expect((await w.post("/records", { path: runId("n"), body: "x", tags: [label] })).status).toBe(201);
    const child = runId("child");
    const parent = runId("parent");
    expect((await operator().put(`/types/${enc(child)}`, { parent_names: [parent] })).status).toBe(200);
    // `#name` is the same name: `#_default` is `_default`
    for (const name of [theirs, label, "_default", "#_default", `#${theirs}`, parent]) {
      const r = await w.put(`/types/${enc(name)}`, { kind: "type", fields: { [field()]: { type: "string" } } });
      expect([name, r.status]).toEqual([name, 403]);
    }
    expect(Object.keys((await w.get(`/types/${enc(theirs)}`)).body.fields ?? {})).toHaveLength(1);
  });

  test("a named key has one stamp on both doors: a type it made over MCP takes its new fields over REST", async () => {
    const s = services();
    const token = await pass({ level: "write" });
    const c = await mcp(`${s.vaultViaHub}/mcp`, token);
    const book = runId("book");
    await c.call("manage-types", { tag: book, fields: { [field()]: { type: "string" } } });
    await c.close();
    expect((await rest(s.vaultViaHub, token).put(`/types/${enc(book)}`, { fields: { [field()]: { type: "string" } } })).status).toBe(200);
    expect(Object.keys((await operator().get(`/types/${enc(book)}`)).body.fields ?? {})).toHaveLength(2);
  });

  test("a malformed fields shape is refused as malformed, and nothing in the call lands", async () => {
    const w = await writer();
    const book = runId("book");
    const r = await w.put(`/types/${enc(book)}`, { description: "x", fields: [] });
    expect(r.status).toBe(400);
    expect(String(r.body?.message ?? r.body?.error ?? "")).not.toMatch(/admin/);
    expect((await w.get(`/types/${enc(book)}`)).status).toBe(404);
  });

  test("PUT /api/tags/:name stays admin for a write pass (Prism pins it); read and a tag-scoped write can't use /api/types", async () => {
    const s = services();
    expect((await (await writer()).put(`/tags/${enc(runId("mine"))}`, { fields: { [field()]: { type: "string" } } })).status).toBe(403);
    const reader = rest(s.vaultViaHub, await pass({ level: "read" }));
    expect((await reader.put(`/types/${enc(runId("mine"))}`, { fields: { [field()]: { type: "string" } } })).status).toBe(403);
    const scoped = rest(s.vaultViaHub, await pass({ level: "write", tags: [runId("scope")] }));
    expect((await scoped.put(`/types/${enc(runId("mine"))}`, { fields: { [field()]: { type: "string" } } })).status).toBe(403);
  });
});
