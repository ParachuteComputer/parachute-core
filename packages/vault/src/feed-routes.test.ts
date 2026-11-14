// The feed's routes (0.9.4, feed-routes.ts): what the contracts can't reach from outside. The 410 answer after the
// change log's sweep (a suite can't age rows), a reader swept for disuse, and whose positions a credential holds.
// Made-up data.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "../core/src/store.ts";
import { pruneChangeLog } from "../core/src/change-log.ts";
import { setPosition, sweepReaders } from "../core/src/feed.ts";
import { feedOwner, handleFeed } from "./feed-routes.ts";

const UNSCOPED = { allowed: null, raw: null };
const OWNER = "key:feed-test";

function fresh() {
  const db = new Database(":memory:");
  const store = new SqliteStore(db);
  let n = 0;
  store.writeSetSource = () => ({ id: `ws_routetest${String(++n).padStart(4, "0")}`, via: OWNER });
  return { db, store };
}
async function call(store: SqliteStore, method: string, path: string, body?: unknown) {
  const req = new Request(`http://box/vault/v/api/feed${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
  const sub = new URL(req.url).pathname.slice("/vault/v/api/feed".length);
  const res = (await handleFeed(req, store, "v", sub, OWNER, UNSCOPED))!;
  return { status: res.status, body: (await res.json()) as any };
}

describe("feed routes: an expired position", () => {
  test("below the horizon: 410 with reader, position, horizon and a hint that commits now first; ack too; now resyncs", async () => {
    const { db, store } = fresh();
    await store.createNote("one", { path: "one" });
    await store.createNote("two", { path: "two" });
    setPosition(db, OWNER, "main", 1);
    db.prepare("UPDATE record_changes SET at = '2000-01-01T00:00:00.000Z'").run();
    await store.createNote("three", { path: "three" });
    pruneChangeLog(db, 30);
    const r = await call(store, "GET", "?reader=main");
    expect(r.status).toBe(410);
    expect(r.body).toMatchObject({ error_type: "feed_position_expired", reader: "main", position: 1, horizon: expect.any(Number) });
    expect(r.body.hint).toMatch(/^first POST \/api\/feed\/position .*"now".*then read the records/);
    expect((await call(store, "GET", "?reader=other&ack=1")).status).toBe(410);
    expect((await call(store, "POST", "/position", { reader: "main", position: "now" })).status).toBe(200);
    expect((await call(store, "GET", "?reader=main")).status).toBe(200);
  });

  test("a reader unused for longer than the log keeps is marked expired, not reset to 0; one in use is kept", async () => {
    const { db, store } = fresh();
    await store.createNote("one", { path: "one" });
    setPosition(db, OWNER, "idle", 1);
    setPosition(db, OWNER, "busy", 1);
    db.prepare("UPDATE feed_readers SET updated_at = '2000-01-01T00:00:00.000Z'").run();
    // A read touches the reader it reads, then runs the day's sweep, which marks the other.
    expect((await call(store, "GET", "?reader=busy")).status).toBe(200);
    expect(sweepReaders(db, 30)).toBe(0);
    const idle = await call(store, "GET", "?reader=idle");
    expect(idle.status).toBe(410);
    expect(idle.body.position).toBeNull();
    expect((await call(store, "GET", "?reader=busy")).status).toBe(200);
    expect((await call(store, "POST", "/position", { reader: "idle", position: "now" })).status).toBe(200);
    expect((await call(store, "GET", "?reader=idle")).status).toBe(200);
  });
});

describe("feed routes: whose positions", () => {
  test("a named key by its name; any other credential by kind and principal; a tag-scoped one also by its scope", () => {
    expect(feedOwner("key:claude", "u1", null)).toBe("key:claude");
    expect(feedOwner("api", "u1", null)).not.toBe(feedOwner("api", "u2", null));
    expect(feedOwner("api", "u1", null)).not.toBe(feedOwner("operator", "u1", null));
    expect(feedOwner("api", "token:abc", null)).not.toBe(feedOwner("api", "token:def", null));
    const scoped = feedOwner("api", "u1", ["work", "home"]);
    expect(scoped).not.toBe(feedOwner("api", "u1", null));
    expect(scoped).toBe(feedOwner("api", "u1", ["home", "work"]));
    expect(scoped).not.toBe(feedOwner("api", "u1", ["work"]));
    expect(feedOwner("key:claude", "u1", ["work"])).not.toBe("key:claude");
  });
});
