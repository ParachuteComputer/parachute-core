// Surface H: the record door (0.9). "Record" is the noun: `body`, `fields`, `types`, plain `tags`. The note door of
// 0.8 keeps answering over the same data through 0.9. Runs only on a 0.9 door.
import { describe, expect, test } from "bun:test";
import { door, enc, fp, lacks, mcp, refusal, rest, runId, safeFetch, sha, shape, token, vaultUrl } from "./_door.ts";

const is09 = door().release.startsWith("0.9");
const one = (r: any) => (Array.isArray(r) ? r[0] : r);

describe.skipIf(!is09)("the record door over MCP", () => {
  test("the record tools lead the list, and the note tools still answer", async () => {
    const c = await mcp("admin");
    try {
      const tools = await c.tools();
      const names = tools.map((t) => t.name);
      for (const t of ["query-records", "create-record", "update-record", "delete-record", "list-types"]) expect(names).toContain(t);
      for (const t of ["query-notes", "create-note", "update-note", "delete-note", "list-tags"]) expect(names).toContain(t);
      const listed = (await c.client.listTools()).tools.map((t) => t.name);
      // The order a model reads them in. A box's own key tools are named apart (deliberate.json).
      fp("records/mcp.order", listed.filter((n) => n !== "manage-keys" && n !== "manage-token"));
    } finally {
      await c.close();
    }
  });

  test("a record made in record words reads back in record words, and in note words through the old tool", async () => {
    const c = await mcp("admin");
    try {
      const type = runId("trip");
      const miles = "door_trip_miles"; // a fixed name: each door has its own vault, and the shapes are compared
      const declared = await c.call("manage-types", { tag: type, fields: { [miles]: { type: "integer", indexed: true } } }).then(
        (r) => ({ ok: true, shape: shape(r) }),
        (e) => ({ ok: false, why: String(e.message).slice(0, 80) }),
      );
      fp("records/mcp.manage-types", declared.ok ? (declared as { shape: unknown }).shape : "refused");
      expect(declared.ok, JSON.stringify(declared)).toBe(true);
      const path = `records/${runId("r")}`;
      const made = await c.call("create-record", { path, types: [type], tags: ["pinned"], fields: { [miles]: 12, content: "a field of mine" }, body: "Drove north." });
      expect(made.body).toBe("Drove north.");
      expect(made.content).toBeUndefined();
      fp("records/mcp.create-record.shape", shape(made));
      const r = one(await c.call("query-records", { id: path }));
      expect(r.body).toBe("Drove north.");
      expect(r.fields).toEqual({ [miles]: 12, content: "a field of mine" });
      expect(r.types).toEqual([type]);
      expect(r.tags).toEqual(["pinned"]);
      fp("records/mcp.query-records.shape", shape(r));
      const n = one(await c.call("query-notes", { id: path }));
      expect(n.content).toBe("Drove north.");
      expect(n.metadata).toEqual({ [miles]: 12, content: "a field of mine" });
      expect([...n.tags].sort()).toEqual(["pinned", type].sort());
      const list = await c.call("query-records", { type, fields: { [miles]: { gte: 10 } } });
      expect(list.map((x: any) => x.path)).toEqual([path]);
      const t = await c.call("list-types", { name: type });
      expect(t.kind).toBe("type");
      fp("records/mcp.list-types.shape", shape(t));
      const clash: any = await c.client.callTool({ name: "create-record", arguments: { path: `${path}-x`, body: "x", content: "y" } }).then((r: any) => r, (e) => e);
      fp("records/mcp.old-word-beside-new", { refused: !!(clash?.code || clash?.isError), code: clash?.code ?? null, type: clash?.data?.error_type ?? null });
    } finally {
      await c.close();
    }
  });
});

describe.skipIf(!is09 || lacks("records-over-rest"))("the record door over REST", () => {
  const api = rest("write");
  const admin = rest("admin");

  test("create, read, filter by type and delete a record at /api/records", async () => {
    const type = runId("visit");
    expect((await admin.put(`/tags/${enc(type)}`, { fields: { city: { type: "string" } } })).status).toBe(200);
    const path = `records/${runId("r")}`;
    const made = await api.post("/records", { path, body: "Went there.", types: [type], tags: ["pinned"], fields: { city: "Lyon" } });
    fp("records/rest.create.status", made.status);
    expect(made.status, JSON.stringify(made.body).slice(0, 300)).toBe(201);
    fp("records/rest.create.shape", shape({ ...made.body, warnings: undefined }));
    const got = await api.get(`/records/${made.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body.body).toBe("Went there.");
    expect(got.body.fields).toEqual({ city: "Lyon" });
    expect(got.body.types).toEqual([type]);
    expect(got.body.tags).toEqual(["pinned"]);
    fp("records/rest.get.shape", shape(got.body));
    const byType = await api.get(`/records?type=${enc(type)}`);
    expect(byType.status).toBe(200);
    expect((Array.isArray(byType.body) ? byType.body : byType.body.records).map((r: any) => r.path)).toEqual([path]);
    const asNote = await api.get(`/notes/${made.body.id}`);
    expect(asNote.status).toBe(200);
    expect(asNote.body.content).toBe("Went there.");
    fp("records/rest.note-alias.says-leaving", { deprecation: asNote.headers.get("deprecation") ?? null, body: asNote.body.deprecation !== undefined });
    const both = await api.post("/records", { path: `${path}-x`, body: "x", content: "y" });
    expect(both.status).toBe(400);
    fp("records/rest.refusal.old-word-beside-new", refusal(both));
    const del = await api.del(`/records/${made.body.id}`);
    expect(del.status).toBe(200);
    expect((await api.get(`/records/${made.body.id}`)).status).toBe(404);
  });

  test("a type's name in `tags` on the record door answers the same way", async () => {
    const type = runId("kind");
    expect((await admin.put(`/tags/${enc(type)}`, { fields: { a: { type: "string" } } })).status).toBe(200);
    const r = await api.post("/records", { path: `records/${runId("r")}`, body: "x", tags: [type] });
    // The spec refuses it with the fix. Recorded rather than required, so a door that still accepts it shows up in
    // the comparison instead of failing alone.
    fp("records/rest.type-in-tags", { status: r.status, type: r.body?.error_type ?? null, hint: typeof r.body?.hint === "string" ? sha(r.body.hint) : null });
    expect(r.status).toBeLessThan(500);
  });
});

// HEAD on one record: the same answer as GET without the body, so a client can ask "is it there, and has it changed?"
// cheaply. Same keys as GET (0.9.3, T-463). The tag-scope case (hidden is 404) is in packages/vault/src/head-record.test.ts.
describe.skipIf(!is09 || lacks("records-over-rest"))("HEAD on one record", () => {
  const api = rest("write");
  // `identity`: the length compared is the representation's own. A door behind a compressing edge (Cloudflare brotli)
  // sends no Content-Length for a compressed answer, on GET and HEAD alike.
  const plain = { "accept-encoding": "identity" };
  const head = async (path: string, bearer: string | null) => {
    const r = await safeFetch(`${vaultUrl()}/api${path}`, { method: "HEAD", headers: bearer ? { authorization: `Bearer ${bearer}`, ...plain } : plain });
    return { status: r.status, headers: r.headers, text: await r.text() };
  };

  test("HEAD answers 200 with GET's headers and an empty body, on both doors, and 404 for a missing id", async () => {
    const made = await api.post("/records", { path: `records/${runId("h")}`, body: "Head me, please." });
    expect(made.status).toBe(201);
    const bearer = await token("read");
    for (const door of ["records", "notes"]) {
      const url = `${vaultUrl()}/api/${door}/${made.body.id}`;
      const get = await safeFetch(url, { headers: { authorization: `Bearer ${bearer}`, ...plain } });
      const getText = await get.text();
      const h = await head(`/${door}/${made.body.id}`, bearer);
      expect({ door, status: h.status }).toEqual({ door, status: 200 });
      expect(h.text).toBe("");
      expect(h.headers.get("content-type")).toBe(get.headers.get("content-type"));
      expect(h.headers.get("content-length")).toBe(String(new TextEncoder().encode(getText).length));
      expect(get.headers.get("etag") ?? "").toMatch(/^"[0-9a-f]+"$/);
      expect(Number.isNaN(Date.parse(get.headers.get("last-modified") ?? ""))).toBe(false);
      for (const name of ["etag", "last-modified"]) expect(h.headers.get(name)).toBe(get.headers.get(name));
      expect((await head(`/${door}/no-such-${runId("x")}`, bearer)).status).toBe(404);
    }
  });

  test("the ETag and Last-Modified change when the record is changed", async () => {
    const made = await api.post("/records", { path: `records/${runId("v")}`, body: "first" });
    expect(made.status).toBe(201);
    const bearer = await token("read");
    const before = await head(`/records/${made.body.id}`, bearer);
    await new Promise((r) => setTimeout(r, 1100)); // Last-Modified counts whole seconds
    expect((await api.patch(`/records/${made.body.id}`, { body: "second", if_updated_at: (await api.get(`/records/${made.body.id}`)).body.updatedAt })).status).toBe(200);
    const after = await head(`/records/${made.body.id}`, bearer);
    expect(after.headers.get("etag")).not.toBe(before.headers.get("etag"));
    expect(Date.parse(after.headers.get("last-modified")!)).toBeGreaterThan(Date.parse(before.headers.get("last-modified")!));
    const again = await head(`/records/${made.body.id}`, bearer);
    expect(again.headers.get("etag")).toBe(after.headers.get("etag"));
  });

  test("HEAD needs a credential", async () => {
    const made = await api.post("/records", { path: `records/${runId("h")}`, body: "private" });
    expect(made.status).toBe(201);
    expect((await head(`/records/${made.body.id}`, null)).status).toBe(401);
  });
});
