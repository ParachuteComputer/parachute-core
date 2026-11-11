// compat/types-rest: the record door over REST, and what it adds (SPEC §2.4, §5.1; ROADMAP 0.9.1 "/api/records").
//   - `/vault/<v>/api/records` answers as the MCP record tools do; Prism's probe (`GET /records?limit=1&include_body=false`)
//     is a 2xx JSON array (prism apps/server/src/vault-door.ts).
//   - The type additions land on /api/records only: `?type=` (a type and its subtypes; with ?tag, records carrying
//     both; a plain tag refused with the fix), `/api/types` (every type and tag with its `kind`, as list-types) and
//     `/api/types/<name>` (one in full, as list-types {name}; writing needs admin).
//   - The record door's `tags` hold plain labels: a type's name there is refused with the fix, on REST as on MCP,
//     and nothing is written. The note door keeps 0.8's behaviour.
//   - A body naming an old word beside its new one is refused (400), after auth, and nothing is written.
//   - Every /api/notes answer, success or error, carries `Deprecation` and a `Link` to its /api/records successor;
//     /api/records never does. /api/notes routes are still counted as deprecated, /api/records ones as adopted.
// Red on `next` before 0.9.1 (every /api/records and /api/types route is 404, and /api/notes has no header).
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { enc, mcp, pass, rest, runId, safeFetch, services } from "../lib.ts";

const s = services();
const R = runId("types-rest");
const keysOf = (o: unknown) => Object.keys((o ?? {}) as object).sort();

let readApi: ReturnType<typeof rest>;
let writeApi: ReturnType<typeof rest>;
let adminApi: ReturnType<typeof rest>;
let adminToken = "";

beforeAll(async () => {
  readApi = rest(s.vaultViaHub, await pass({ level: "read" }));
  writeApi = rest(s.vaultViaHub, await pass({ level: "write" }));
  adminToken = await pass({ level: "admin" });
  adminApi = rest(s.vaultViaHub, adminToken);
});

describe("compat/types-rest: /api/records", () => {
  test("Prism's probe: GET /records?limit=1&include_body=false is a 2xx JSON array of records", async () => {
    await writeApi.post("/notes", { path: `${R}/probe`, content: "x" });
    const r = await readApi.get("/records?limit=1&include_body=false");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") ?? "").toContain("application/json");
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.length).toBe(1);
    expect(r.body[0]).toHaveProperty("types");
    expect(r.body[0]).toHaveProperty("fields");
    expect(r.body[0]).not.toHaveProperty("metadata");
    expect(r.body[0]).not.toHaveProperty("content");
    expect(r.body[0]).not.toHaveProperty("body");
  });

  test("a body that names an old word beside its new one is refused after auth, and nothing is written", async () => {
    const path = `${R}/both`;
    const anon = await safeFetch(`${s.vaultViaHub}/api/records`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, body: "x", content: "y" }) });
    expect(anon.status).toBe(401);
    const both = await writeApi.post("/records", { path, body: "x", content: "y" });
    expect(both.status).toBe(400);
    expect(both.body.error_type).toBe("invalid_query");
    expect(both.body.field).toBe("body");
    expect((await readApi.get(`/records/${enc(path)}`)).status).toBe(404);
    const made = await writeApi.post("/records", { path, body: "kept", fields: { n: 1 } });
    expect(made.status).toBe(201);
    const clash = await writeApi.patch(`/records/${enc(path)}`, { fields: { n: 2 }, metadata: { n: 3 }, force: true });
    expect(clash.status).toBe(400);
    expect(clash.body.field).toBe("fields");
    expect((await readApi.get(`/records/${enc(path)}`)).body.fields).toEqual({ n: 1 });
    // Version rows point at their record with `record_id` (Prism's vault-door.ts reads it); `content_len` keeps its name.
    expect((await writeApi.patch(`/records/${enc(path)}`, { body: "changed", force: true })).status).toBe(200);
    const v = await readApi.get(`/records/${enc(path)}/versions`);
    expect(v.status).toBe(200);
    expect(v.body.total).toBeGreaterThanOrEqual(1);
    const row = v.body.versions[0];
    expect(row.record_id).toBe(made.body.id);
    expect(row).not.toHaveProperty("note_id");
    expect(typeof row.content_len).toBe("number");
    expect((await readApi.get(`/records/${enc(path)}/versions/${row.version_ix}`)).body.body).toBe("kept");
  });
});

describe("compat/types-rest: types", () => {
  const type = `${R}-visit`;
  const sub = `${type}/museum`;
  const label = `${R}-label`;

  test("/api/types lists every type and tag with its kind, as list-types; /api/types/<name> reads one, as list-types {name}", async () => {
    expect((await writeApi.put(`/types/${enc(type)}`, { fields: { city: { type: "string" } } })).status).toBe(403);
    expect((await adminApi.put(`/types/${enc(type)}`, { fields: { city: { type: "string" } } })).status).toBe(200);
    expect((await adminApi.put(`/types/${enc(sub)}`, { parent_names: [type] })).status).toBe(200);
    expect((await writeApi.post("/notes", { path: `${R}/labelled`, content: "x", tags: [label] })).status).toBe(201);

    const list = await readApi.get("/types");
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    const row = (n: string) => list.body.find((t: any) => t.name === n);
    expect(row(type)?.kind).toBe("type");
    expect(row(sub)?.kind).toBe("type");
    expect(row(label)?.kind).toBe("tag");

    const one = await readApi.get(`/types/${enc(type)}`);
    expect(one.status).toBe(200);
    expect(one.body.kind).toBe("type");
    expect(one.body.fields?.city?.type).toBe("string");
    expect((await readApi.get(`/types?name=${enc(type)}`)).body).toEqual(one.body);

    const c = await mcp(`${s.vaultViaHub}/mcp`, adminToken);
    try {
      const rows = await c.call("list-types", {});
      const mcpRow = rows.find((t: any) => t.name === type);
      expect(keysOf(row(type))).toEqual(keysOf(mcpRow));
      expect(row(type)).toEqual(mcpRow);
      const mcpOne = await c.call("list-types", { name: type });
      expect(keysOf(one.body)).toEqual(keysOf(mcpOne));
      expect({ ...one.body, created_at: null, updated_at: null }).toEqual({ ...mcpOne, created_at: null, updated_at: null });
    } finally {
      await c.close();
    }

    expect((await writeApi.del(`/types/${enc(label)}`)).status).toBe(403);
    expect((await readApi.get(`/types/${enc(`${R}-never`)}`)).status).toBe(404);
  });

  test("?type= finds a type and its subtypes; with ?tag, the records carrying both; a plain tag is refused with the fix", async () => {
    const a = await writeApi.post("/records", { path: `${R}/t/a`, body: "a", types: [type] });
    const b = await writeApi.post("/records", { path: `${R}/t/b`, body: "b", types: [sub] });
    const c = await writeApi.post("/records", { path: `${R}/t/c`, body: "c", types: [type], tags: ["pinned"] });
    const d = await writeApi.post("/records", { path: `${R}/t/d`, body: "d", tags: ["pinned"] });
    for (const r of [a, b, c, d]) expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(201);
    expect(c.body.types).toEqual([type]);
    expect(c.body.tags).toEqual(["pinned"]);

    const paths = (r: { body: any }) => (Array.isArray(r.body) ? r.body : r.body.records).map((x: any) => x.path).sort();
    const byType = await readApi.get(`/records?type=${enc(type)}&path_prefix=${enc(`${R}/t`)}`);
    expect(byType.status).toBe(200);
    expect(paths(byType)).toEqual([`${R}/t/a`, `${R}/t/b`, `${R}/t/c`]);
    expect(paths(await readApi.get(`/records?type=${enc(type)}&tag=pinned&path_prefix=${enc(`${R}/t`)}`))).toEqual([`${R}/t/c`]);
    expect(paths(await readApi.get(`/records?type=&path_prefix=${enc(`${R}/t`)}`))).toEqual([`${R}/t/a`, `${R}/t/b`, `${R}/t/c`, `${R}/t/d`]);

    const plain = await readApi.get(`/records?type=pinned`);
    expect(plain.status).toBe(422);
    expect(plain.body.error_type).toBe("tag_kind");
    expect(plain.body.hint).toContain("tag");

    const m = await mcp(`${s.vaultViaHub}/mcp`, adminToken);
    try {
      const viaMcp = await m.call("query-records", { type, path_prefix: `${R}/t` });
      expect((Array.isArray(viaMcp) ? viaMcp : viaMcp.records).map((x: any) => x.path).sort()).toEqual(paths(byType));
    } finally {
      await m.close();
    }
  });

  test("a type's name in tags is refused with the fix, on REST as on MCP, and nothing is written; the note door keeps 0.8's way", async () => {
    const path = `${R}/in-tags`;
    const made = await writeApi.post("/records", { path, body: "x", tags: [type, "pinned"] });
    expect(made.status).toBe(422);
    expect(made.body.error_type).toBe("tag_kind");
    expect(made.body.field).toBe("tags");
    expect(made.body.hint).toBe("types: [...]");
    expect(made.body.error).toContain(`types: ["${type}"]`);
    expect((await readApi.get(`/records/${enc(path)}`)).status).toBe(404);

    const batch = await writeApi.post("/records", { records: [{ path: `${path}-1`, body: "x" }, { path: `${path}-2`, body: "y", tags: [type] }] });
    expect(batch.status).toBe(422);
    expect((await readApi.get(`/records/${enc(`${path}-1`)}`)).status).toBe(404);

    // A name another record of the same batch makes a type is a type too.
    const fresh = `${R}-fresh-type`;
    const same = await writeApi.post("/records", { records: [{ path: `${path}-3`, body: "x", types: [fresh] }, { path: `${path}-4`, body: "y", tags: [fresh] }] });
    expect(same.status).toBe(422);
    expect((await readApi.get(`/records/${enc(`${path}-3`)}`)).status).toBe(404);

    const ok = await writeApi.post("/records", { path, body: "x", tags: ["pinned"] });
    expect(ok.status).toBe(201);
    const patched = await writeApi.patch(`/records/${enc(path)}`, { tags: { add: [type] }, force: true });
    expect(patched.status).toBe(422);
    expect(patched.body.hint).toBe("types: {add: [...]}");
    const fixed = await writeApi.patch(`/records/${enc(path)}`, { types: { add: [type] }, force: true });
    expect(fixed.status).toBe(200);
    expect(fixed.body.types).toEqual([type]);
    expect(fixed.body.tags).toEqual(["pinned"]);

    const c = await mcp(`${s.vaultViaHub}/mcp`, adminToken);
    try {
      const err: any = await c.client.callTool({ name: "create-record", arguments: { path: `${path}-mcp`, body: "x", tags: [type] } }).catch((e) => e);
      expect(err?.data?.error_type ?? err?.structuredContent?.error_type).toBe("tag_kind");
      expect((await c.call("query-records", { id: `${path}-mcp` })).error_type).toBe("not_found");
    } finally {
      await c.close();
    }

    const old = await writeApi.post("/notes", { path: `${path}-note`, content: "x", tags: [type] });
    expect(old.status).toBe(201);
    expect(old.body.types).toEqual([type]);
  });
});

describe("compat/types-rest: a tag-scoped pass", () => {
  test("learns nothing about a hidden name's kind: ?type= and a name in tags answer alike for a hidden type and a hidden tag", async () => {
    const work = `${R}-work`;
    const hiddenType = `${R}-secret-type`;
    const hiddenTag = `${R}-secret-tag`;
    expect((await adminApi.put(`/types/${enc(hiddenType)}`, { fields: { x: { type: "string" } } })).status).toBe(200);
    expect((await writeApi.post("/notes", { path: `${R}/hidden`, content: "x", tags: [hiddenTag] })).status).toBe(201);
    const scoped = rest(s.vaultViaHub, await pass({ level: "write", tags: [work] }));
    const answer = async (p: Promise<{ status: number; body: any }>) => {
      const r = await p;
      return { status: r.status, type: r.body?.error_type ?? null, n: Array.isArray(r.body) ? r.body.length : null };
    };
    const byType = await answer(scoped.get(`/records?type=${enc(hiddenType)}`));
    expect(byType.type).not.toBe("tag_kind");
    expect(await answer(scoped.get(`/records?type=${enc(hiddenTag)}`))).toEqual(byType);
    const inTags = await answer(scoped.post("/records", { path: `${R}/scoped-a`, body: "x", tags: [work, hiddenType] }));
    expect(inTags.type).not.toBe("tag_kind");
    expect(await answer(scoped.post("/records", { path: `${R}/scoped-b`, body: "x", tags: [work, hiddenTag] }))).toEqual(inTags);
    const m = await mcp(`${s.vaultViaHub}/mcp`, await pass({ level: "write", tags: [work] }));
    try {
      const viaMcp = async (name: string) => {
        const r: any = await m.client.callTool({ name: "create-record", arguments: { path: `${R}/scoped-mcp-${name}`, body: "x", tags: [work, name] } }).catch((e) => e);
        return r?.data?.error_type ?? (r?.isError ? "isError" : "ok");
      };
      const mcpType = await viaMcp(hiddenType);
      expect(mcpType).not.toBe("tag_kind");
      expect(await viaMcp(hiddenTag)).toBe(mcpType);
    } finally {
      await m.close();
    }
    // A name it can see is refused with the fix as for anyone.
    const visibleType = `${work}/kind`;
    expect((await adminApi.put(`/types/${enc(visibleType)}`, { fields: { y: { type: "string" } } })).status).toBe(200);
    expect(await answer(scoped.post("/records", { path: `${R}/scoped-c`, body: "x", tags: [work, visibleType] }))).toEqual({ status: 422, type: "tag_kind", n: null });
  });
});

describe("compat/types-rest: /api/notes is leaving", () => {
  test("every /api/notes answer, success or error, carries Deprecation and a Link to its /api/records successor; /api/records none", async () => {
    const base = `/vault/${s.vaultName}/api`;
    const made = await writeApi.post("/notes", { path: `${R}/leaving`, content: "x" });
    const answers = [
      ["list", await readApi.get("/notes?limit=1"), `${base}/records`],
      ["create", made, `${base}/records`],
      ["get", await readApi.get(`/notes/${enc(made.body.id)}`), `${base}/records/${enc(made.body.id)}`],
      ["versions", await readApi.get(`/notes/${enc(made.body.id)}/versions`), `${base}/records/${enc(made.body.id)}/versions`],
      ["not found", await readApi.get(`/notes/${enc(`${R}/missing`)}`), `${base}/records/${enc(`${R}/missing`)}`],
      ["forbidden", await readApi.patch(`/notes/${enc(made.body.id)}`, { content: "y", force: true }), `${base}/records/${enc(made.body.id)}`],
      ["no token", await safeFetch(`${s.vaultViaHub}/api/notes?limit=1`), `${base}/records`],
    ] as const;
    for (const [what, r, successor] of answers) {
      expect([what, r.headers.get("deprecation")]).toEqual([what, "true"]);
      expect([what, r.headers.get("link")]).toEqual([what, `<${successor}>; rel="successor-version"`]);
    }
    expect(answers.map(([, r]) => r.status)).toEqual([200, 201, 200, 200, 404, 403, 401]);
    for (const r of [await readApi.get("/records?limit=1"), await readApi.get(`/records/${enc(`${R}/missing`)}`), await safeFetch(`${s.vaultViaHub}/api/records`)]) {
      expect(r.headers.get("deprecation")).toBeNull();
    }
  });

  test("/api/notes routes are still counted as deprecated, and /api/records routes as adopted, never as deprecated", async () => {
    await readApi.get(`/notes/${enc(`${R}/probe`)}`);
    await readApi.get(`/records/${enc(`${R}/probe`)}`);
    await readApi.get("/records?limit=1");
    const file = join(s.home, "run", "deprecations.json");
    let log: any = {};
    const want = (l: any) => l?.names?.["rest GET /api/notes/:id"] && l?.adopted?.["rest GET /api/records/:id"] && l?.adopted?.["rest GET /api/records"];
    for (let i = 0; i < 40 && !want(log); i++) {
      await Bun.sleep(250); // the vault batches its writes (name-usage.ts FLUSH_MS)
      if (existsSync(file)) log = JSON.parse(readFileSync(file, "utf8"));
    }
    expect(log.names["rest GET /api/notes/:id"].count).toBeGreaterThanOrEqual(1);
    expect(log.adopted["rest GET /api/records/:id"].count).toBeGreaterThanOrEqual(1);
    expect(log.adopted["rest GET /api/records"].count).toBeGreaterThanOrEqual(1);
    expect(Object.keys(log.names).filter((k) => k.includes("/api/records") || k.includes("/api/types"))).toEqual([]);
  });
});
