// v094/write-sets: revisions say who and why (ROADMAP 0.9.4 row 2; T-471, PLAN-0.9.4 PR 1). Every write is a write
// set: one REST call or one MCP tool call (or several calls sending the same Parachute-Write-Set id), stamped with
// the key that made it and, when given, why. `GET /api/write-sets` lists a key's sets; each revision names its set and
// keeps the types, tags and links the record had. Black box: HTTP and MCP to the candidate's hub, keys minted by
// name. Made-up data.
// Red on next f22b5cea: /api/write-sets is 404, `why` is an unknown parameter on create-record, and revisions carry
// no write_set, types, tags or links.
import { beforeAll, describe, expect, test } from "bun:test";
import { mcp, must, pass, rest, services } from "../lib.ts";
import { adminPass, enc, mcpUrl, mintKey, shortId, type Key } from "./_keys.ts";

let writer: Key; // a write key, as an AI's
let other: Key; // another write key
let admin: Key;

beforeAll(async () => {
  writer = await mintKey("ws-claude", "write");
  other = await mintKey("ws-other", "write");
  admin = await adminPass();
});

const sets = async (k: Key, query = "by=me") => {
  const r = await k.api("GET", `/write-sets?${query}`);
  must(r.status === 200, `GET /write-sets?${query}: ${r.status} ${r.text.slice(0, 300)}`);
  return r.body.write_sets as any[];
};
const one = async (k: Key, id: string) => (await k.api("GET", `/write-sets/${enc(id)}`));
const recordIds = (set: any) => (set.records as any[]).map((r) => r.id).sort();

describe("v094/write-sets: one call, one set, who and why", () => {
  test("an MCP create-record with why is one set: by, via key:<name>, why, one record", async () => {
    const m = await mcp(mcpUrl(), writer.token);
    try {
      const path = `ws/${shortId()}`;
      const made: any = await m.call("create-record", { path, content: "first draft", types: ["memo"], why: "Sam asked to keep the meeting notes" });
      const id = made.id as string;
      const [newest] = await sets(writer);
      expect(newest).toMatchObject({ via: `key:${writer.name}`, why: "Sam asked to keep the meeting notes", records: 1, undoes: null });
      const got = await one(writer, newest.id);
      expect(got.status).toBe(200);
      expect(got.body.records).toEqual([{ id, op: "create", path }]);
    } finally {
      await m.close();
    }
  });

  test("a batch create of three records is one set; two calls are two sets", async () => {
    const tag = `ws${shortId()}`;
    const batch = await writer.api("POST", "/notes", { notes: [1, 2, 3].map((i) => ({ path: `${tag}/b${i}`, content: `b${i}`, tags: [tag] })) });
    must(batch.status === 201, `batch: ${batch.status} ${batch.text.slice(0, 200)}`);
    const [b] = await sets(writer);
    expect(b.records).toBe(3);
    await writer.api("POST", "/notes", { path: `${tag}/s1`, content: "s1" });
    await writer.api("POST", "/notes", { path: `${tag}/s2`, content: "s2" });
    const [s2, s1] = await sets(writer);
    expect(s1.id).not.toBe(s2.id);
    expect([s1.records, s2.records]).toEqual([1, 1]);
    expect(s1.id).not.toBe(b.id);
  });

  test("two REST calls with the same Parachute-Write-Set id are one set; another key can't add to it", async () => {
    const id = `client-${shortId()}${shortId()}`;
    const h = { "Parachute-Write-Set": id, "Parachute-Why": "importing%20the%20reading%20list%20%E2%80%94%20part%201" };
    expect((await writer.api("POST", "/notes", { path: `grp/${shortId()}`, content: "a" }, h)).status).toBe(201);
    expect((await writer.api("POST", "/notes", { path: `grp/${shortId()}`, content: "b" }, h)).status).toBe(201);
    const got = await one(writer, id);
    expect(got.body).toMatchObject({ id, via: `key:${writer.name}`, why: "importing the reading list — part 1" });
    expect(got.body.records.length).toBe(2);
    const theirs = await other.api("POST", "/notes", { path: `grp/${shortId()}`, content: "c" }, { "Parachute-Write-Set": id });
    expect(theirs.status).toBe(409);
    expect(theirs.body.error_type).toBe("write_set_not_yours");
    expect((await one(writer, id)).body.records.length).toBe(2);
  });

  test("why is a short reason: over 280 characters is refused and nothing is written", async () => {
    const path = `long/${shortId()}`;
    const r = await writer.api("POST", "/notes", { path, content: "x" }, { "Parachute-Why": "a".repeat(281) });
    expect(r.status).toBe(400);
    expect(r.body.error_type).toBe("invalid_why");
    expect((await writer.api("GET", `/notes/${enc(path)}`)).status).toBe(404);
    const m = await mcp(mcpUrl(), writer.token);
    try {
      await expect(m.call("create-record", { path, content: "x", why: "b".repeat(281) })).rejects.toThrow(/280/);
    } finally {
      await m.close();
    }
  });
});

describe("v094/write-sets: revisions say who and why, with the types, tags and links they had", () => {
  test("a version names the set that replaced it and keeps the record's types, tags and links from before", async () => {
    const t = `rv${shortId()}`;
    const target = await writer.api("POST", "/notes", { path: `${t}/target`, content: "target" });
    const made = await writer.api("POST", "/records", { path: `${t}/r`, content: "v1", types: [`${t}type`], tags: [`${t}label`], links: [{ target: target.body.id, relationship: "cites" }] });
    must(made.status === 201, `create: ${made.status} ${made.text.slice(0, 300)}`);
    const id = made.body.id as string;
    // Declare the type so it reads as a type (a name with fields is a type).
    const changed = await writer.api("PATCH", `/notes/${id}`, { content: "v2", tags: { add: [`${t}new`], remove: [`${t}label`] }, force: true }, { "Parachute-Why": "fixing the summary" });
    must(changed.status === 200, `update: ${changed.status} ${changed.text.slice(0, 300)}`);
    const [set] = await sets(writer);
    const v = (await writer.api("GET", `/records/${id}/versions`)).body.versions as any[];
    expect(v.length).toBe(1);
    expect(v[0]).toMatchObject({ write_set: set.id, why: "fixing the summary", types: [`${t}type`], tags: [`${t}label`] });
    // The record door says `fields` where the note door says `metadata`, inside a link too.
    expect(v[0].links).toEqual([{ target: target.body.id, relationship: "cites", fields: {} }]);
    const asNote = (await writer.api("GET", `/notes/${id}/versions`)).body.versions as any[];
    expect(asNote[0].links).toEqual([{ target: target.body.id, relationship: "cites", metadata: {} }]);
    const single = (await writer.api("GET", `/notes/${id}/versions/${v[0].version_ix}`)).body;
    expect(single).toMatchObject({ write_set: set.id, why: "fixing the summary", content: "v1" });
  });

  test("a tag-scoped reader sees a record's versions but not who, why, the set, the links or tags outside its scope", async () => {
    const t = `sc${shortId()}`;
    const made = await writer.api("POST", "/notes", { path: `${t}/r`, content: "v1", tags: [t, `hidden${t}`] });
    await writer.api("PATCH", `/notes/${made.body.id}`, { content: "v2", force: true }, { "Parachute-Why": "private reason" });
    const scoped = rest(services().vaultViaHub, await pass({ level: "read", tags: [t] }));
    const v = (await scoped.get(`/notes/${made.body.id}/versions`)).body.versions as any[];
    expect(v.length).toBe(1);
    for (const k of ["actor", "via", "write_set", "why", "links"]) expect(Object.keys(v[0])).not.toContain(k);
    // A version's tags are scrubbed to the scope, as the live record's are: no tag name outside it.
    expect((await scoped.get(`/notes/${made.body.id}`)).body.tags).toEqual([t]);
    expect(v[0].tags).toEqual([t]);
    const one = (await scoped.get(`/notes/${made.body.id}/versions/${v[0].version_ix}`)).body;
    expect(one.tags).toEqual([t]);
  });
});

describe("v094/write-sets: writes no record call made, and who may read the list", () => {
  test("a tag rename that changes five records is one set with those five records", async () => {
    const t = `rn${shortId()}`;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await writer.api("POST", "/notes", { path: `${t}/n${i}`, content: `n${i}`, tags: [t] })).body.id);
    const r = await admin.api("POST", `/tags/${t}/rename`, { new_name: `${t}-renamed` });
    must(r.status === 200, `rename: ${r.status} ${r.text.slice(0, 300)}`);
    const [set] = await sets(admin);
    const got = await one(admin, set.id);
    expect(recordIds(got.body)).toEqual([...ids].sort());
    expect(got.body.records.every((x: any) => x.op === "update")).toBe(true);
  });

  test("a delete is listed as a delete, with the path it had", async () => {
    const path = `del/${shortId()}`;
    const id = (await writer.api("POST", "/notes", { path, content: "gone soon" })).body.id;
    expect((await writer.api("DELETE", `/notes/${id}`)).status).toBe(200);
    const [set] = await sets(writer);
    expect((await one(writer, set.id)).body.records).toEqual([{ id, op: "delete", path }]);
  });

  test("a key lists its own sets; another key's are hidden from it; admin lists any key's", async () => {
    await other.api("POST", "/notes", { path: `own/${shortId()}`, content: "mine" });
    const [theirs] = await sets(other);
    expect((await sets(writer)).some((x) => x.id === theirs.id)).toBe(false);
    expect((await one(writer, theirs.id)).status).toBe(404);
    expect((await writer.api("GET", `/write-sets?by=${enc(other.name)}`)).status).toBe(403);
    expect((await sets(admin, `by=${enc(other.name)}`)).some((x) => x.id === theirs.id)).toBe(true);
    expect((await one(admin, theirs.id)).status).toBe(200);
  });

  test("a tag-scoped key's set drops out of its list once a record in it leaves the scope", async () => {
    const t = `sk${shortId()}`;
    const scopedToken = await pass({ level: "write", tags: [t] });
    const scoped = rest(services().vaultViaHub, scopedToken);
    const made = await scoped.post("/notes", { path: `${t}/r`, content: "in scope", tags: [t] });
    must(made.status === 201, `scoped create: ${made.status}`);
    const mine = (await scoped.get("/write-sets?by=me")).body.write_sets as any[];
    expect(mine.length).toBeGreaterThan(0);
    const setId = mine[0].id;
    await admin.api("PATCH", `/notes/${made.body.id}`, { tags: { remove: [t], add: [`${t}-elsewhere`] }, force: true });
    expect(((await scoped.get("/write-sets?by=me")).body.write_sets as any[]).some((x) => x.id === setId)).toBe(false);
    expect((await scoped.get(`/write-sets/${enc(setId)}`)).status).toBe(404);
  });
});
