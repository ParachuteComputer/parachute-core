// HEAD on one note or record: GET's answer without the body, under GET's tag scope (0.9.3, T-463).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { BunStore } from "./vault-store.ts";
import { handleNotes, type TagScopeCtx } from "./routes.ts";

let db: Database;
let store: BunStore;
beforeEach(() => {
  db = new Database(":memory:");
  store = new BunStore(db);
});
afterEach(() => db.close());

const call = (method: string, id: string, scope?: TagScopeCtx) =>
  handleNotes(new Request(`http://localhost/api/notes/${id}`, { method }), store, `/${id}`, undefined, scope);

test("HEAD gives GET's status and headers, the length of GET's body, and no body", async () => {
  const n = await store.createNote("Head me, please.", { id: "h1", path: "a/h1" });
  const get = await call("GET", n.id);
  const getText = await get.text();
  const head = await call("HEAD", n.id);
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
  expect(head.headers.get("content-length")).toBe(String(new TextEncoder().encode(getText).length));
  expect(head.headers.get("etag")).toBe(get.headers.get("etag"));
  expect(head.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
  expect(head.headers.get("last-modified")).toBe(get.headers.get("last-modified"));
  expect(Number.isNaN(Date.parse(head.headers.get("last-modified")!))).toBe(false);
  await store.tagNote("h1", ["t"]);
  expect((await call("HEAD", n.id)).headers.get("etag")).not.toBe(get.headers.get("etag")); // a tag-only change moves the ETag
  expect((await call("HEAD", "a%2Fh1")).status).toBe(200); // by path, as GET
  expect((await call("HEAD", "missing")).status).toBe(404);
});

test("a note outside a tag-scoped key's tags is 404 to HEAD, as to GET", async () => {
  await store.createNote("in", { id: "in1", tags: ["mine"] });
  await store.createNote("out", { id: "out1", tags: ["theirs"] });
  const scope: TagScopeCtx = { allowed: new Set(["mine"]), raw: ["mine"] };
  expect((await call("HEAD", "in1", scope)).status).toBe(200);
  expect({ head: (await call("HEAD", "out1", scope)).status, get: (await call("GET", "out1", scope)).status }).toEqual({ head: 404, get: 404 });
});
