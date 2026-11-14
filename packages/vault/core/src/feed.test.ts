// The feed (0.9.4, feed.ts): the rules the contracts can't reach from outside (a set that touches a record again
// after a reader committed, the horizon after a sweep, positions in the file across a reopen) and the visibility rule
// itself. Made-up data.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStore } from "./store.ts";
import { pruneChangeLog } from "./change-log.ts";
import { unnumberedStepsDone } from "./schema.ts";
import { feedOp, feedPresent, getPosition, newestPosition, placePending, positionExpired, readFeedPage, setPosition, type FeedRow } from "./feed.ts";

function fresh(db = new Database(":memory:")) {
  const store = new SqliteStore(db);
  let ctx: { id?: string; via?: string } | undefined;
  store.writeSetSource = () => ctx;
  return { db, store, as: (c: typeof ctx) => (ctx = c) };
}
const row = (over: Partial<FeedRow>): FeedRow => ({ pos: 1, first: 1, note_id: "n", write_set: "ws_x", existed: 1, before_tags: '["in"]', at: "", ...over });
const inScope = (tags: string[]) => tags.includes("in");

describe("feed: which change a reader is told", () => {
  test("unscoped: there now is an upsert; gone is a delete unless it was made in the page", () => {
    expect(feedOp([row({ existed: 0 })], 0, { tags: [] }, null)).toBe("upsert");
    expect(feedOp([row({})], 0, null, null)).toBe("delete");
    expect(feedOp([row({ existed: 0, first: 5 }), row({ first: 6 })], 4, null, null)).toBe(null);
  });

  test("scoped: in scope now is an upsert; moved out is removed; gone from scope is a delete; never in scope is nothing", () => {
    expect(feedOp([row({ before_tags: '["out"]' })], 0, { tags: ["in"] }, inScope)).toBe("upsert");
    expect(feedOp([row({})], 0, { tags: ["out"] }, inScope)).toBe("removed");
    expect(feedOp([row({})], 0, null, inScope)).toBe("delete");
    expect(feedOp([row({ before_tags: '["out"]' })], 0, null, inScope)).toBe(null);
    expect(feedOp([row({ before_tags: '["out"]' })], 0, { tags: ["out"] }, inScope)).toBe(null);
    expect(feedOp([row({ existed: 0, before_tags: null })], 0, { tags: ["out"] }, inScope)).toBe(null);
  });

  test("visible before is read from the row first written after the position, not the first in the page", () => {
    // Set A (first at 5) moved the record out; set B (at 7) wrote it again; A touched it once more and moved to 9.
    const a = row({ first: 5, pos: 9, before_tags: '["in"]' });
    const b = row({ first: 7, pos: 7, before_tags: '["out"]' });
    expect(feedOp([b, a], 4, { tags: ["out"] }, inScope)).toBe("removed"); // at 4 the reader saw it in scope
    expect(feedOp([b, a], 6, { tags: ["out"] }, inScope)).toBe(null); // at 6 it had already left
  });

  test("unknown is not visible to a scoped reader: a row with no saved tags, or only rows that began before the position", () => {
    expect(feedOp([row({ write_set: null, before_tags: null })], 0, { tags: ["out"] }, inScope)).toBe(null);
    expect(feedOp([row({ write_set: null, before_tags: null })], 0, null, inScope)).toBe(null);
    expect(feedOp([row({ first: 3, pos: 8 })], 5, { tags: ["out"] }, inScope)).toBe(null);
    // An unscoped reader is told of the delete either way.
    expect(feedOp([row({ write_set: null, before_tags: null })], 0, null, null)).toBe("delete");
  });
});

describe("feed: positions", () => {
  test("a set that touches a record again after a reader committed moves it past the reader", async () => {
    const { db, store, as } = fresh();
    as({ id: "ws_long00001", via: "key:a" });
    const n = await store.createNote("v1", { path: "n" });
    as({ id: "ws_other0001", via: "key:b" });
    await store.createNote("other", { path: "o" });
    const first = readFeedPage(db, 0, 100, null);
    expect(first.changes.map((c) => c.id)).toEqual([n.id, expect.any(String)]);
    const committed = first.next_position;
    // The same set, in a later transaction (a second request sending its id).
    as({ id: "ws_long00001", via: "key:a" });
    await store.updateNote(n.id, { content: "v2" });
    const next = readFeedPage(db, committed, 100, null);
    expect(next.changes.map((c) => [c.id, c.op, c.write_set])).toEqual([[n.id, "upsert", "ws_long00001"]]);
    // Where the set first touched it didn't move (the scope rule reads first_position).
    expect((db.prepare("SELECT first_position AS f FROM record_changes WHERE write_set = 'ws_long00001'").get() as { f: number }).f).toBeLessThan(committed);
    // Positions stay unique.
    const all = db.prepare("SELECT position FROM record_changes").all() as { position: number }[];
    expect(new Set(all.map((r) => r.position)).size).toBe(all.length);
    expect(newestPosition(db)).toBeGreaterThanOrEqual(Math.max(...all.map((r) => r.position)));
  });

  test("positions stay unique and at or below the newest through a delete that cascades to tags and links", async () => {
    const { db, store, as } = fresh();
    as({ id: "ws_mk0000001" });
    const target = await store.createNote("target", { path: "t" });
    const n = await store.createNote("see [[t]]", { path: "n", tags: ["a", "b"] });
    const held = newestPosition(db);
    as({ id: "ws_del000001" });
    await store.deleteNote(n.id);
    as({ id: "ws_after0001" });
    await store.updateNote(target.id, { content: "target, edited" });
    const all = db.prepare("SELECT position FROM record_changes").all() as { position: number }[];
    expect(new Set(all.map((r) => r.position)).size).toBe(all.length);
    expect(Math.max(...all.map((r) => r.position))).toBe(newestPosition(db));
    const page = readFeedPage(db, held, 100, null);
    expect(page.changes.map((c) => [c.id, c.op])).toEqual([[n.id, "delete"], [target.id, "upsert"]]);
    expect(page.next_position).toBe(newestPosition(db));
  });

  test("a write outside any write set is judged by the tags it saved: moved out is removed, never-in is nothing", async () => {
    const { db, store, as } = fresh();
    as({ id: "ws_seed000001" });
    const inside = await store.createNote("in", { path: "in", tags: ["in"] });
    const outside = await store.createNote("out", { path: "out", tags: ["out"] });
    const held = newestPosition(db);
    // Raw statements: no Store transaction, so no write context (write_set NULL).
    db.prepare("DELETE FROM note_tags WHERE note_id = ? AND tag_name = 'in'").run(inside.id);
    db.prepare("INSERT INTO note_tags (note_id, tag_name) VALUES (?, 'out')").run(inside.id);
    db.prepare("UPDATE notes SET content = 'still out' WHERE id = ?").run(outside.id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM record_changes WHERE write_set IS NULL").get() as { n: number }).n).toBe(3);
    // Not placed yet (no Store transaction ended): a page can't see them, and placing them is what a read does first.
    expect(readFeedPage(db, held, 100, inScope).changes).toEqual([]);
    placePending(store);
    expect((db.prepare("SELECT COUNT(*) AS n FROM write_sets").get() as { n: number }).n).toBe(1); // placing opened no set
    const page = readFeedPage(db, held, 100, inScope);
    expect(page.changes.map((c) => [c.id, c.op])).toEqual([[inside.id, "removed"]]);
  });

  test("a page reads past rows the reader isn't told of, the same as a scope-blind reader", async () => {
    const { db, store, as } = fresh();
    as({ id: "ws_blind0001" });
    await store.createNote("out", { path: "out", tags: ["out"] });
    const scoped = readFeedPage(db, 0, 1, inScope);
    const blind = readFeedPage(db, 0, 1, null);
    expect(scoped.changes).toEqual([]);
    expect([scoped.next_position, scoped.more]).toEqual([blind.next_position, blind.more]);
  });

  test("positions are kept in the vault file, per via and reader, across a reopen", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "feed-")), "vault.db");
    const one = fresh(new Database(file));
    await one.store.createNote("x", { path: "x" });
    setPosition(one.db, "key:a", "main", 1);
    setPosition(one.db, "key:b", "main", 0);
    one.db.close();
    const two = new Database(file);
    new SqliteStore(two);
    expect(getPosition(two, "key:a", "main")).toBe(1);
    expect(getPosition(two, "key:b", "main")).toBe(0);
    expect(getPosition(two, "key:a", "other")).toBe(0);
    two.close();
  });

  test("a sweep remembers the highest position it dropped; a held position below it has expired", async () => {
    const { db, store, as } = fresh();
    as({ id: "ws_old000001" });
    await store.createNote("old", { path: "old" });
    as({ id: "ws_old000002" });
    await store.createNote("older", { path: "older" });
    const dropped = newestPosition(db);
    db.prepare("UPDATE record_changes SET at = '2000-01-01T00:00:00.000Z'").run();
    as({ id: "ws_new000001" });
    await store.createNote("new", { path: "new" });
    expect(positionExpired(db, 1)).toBe(false);
    pruneChangeLog(db, 30);
    expect(positionExpired(db, 1)).toBe(true);
    expect(positionExpired(db, dropped)).toBe(false);
    expect(positionExpired(db, 0)).toBe(false); // 0: from the start of what is kept
    // A later sweep never lowers it.
    pruneChangeLog(db, 30);
    expect(positionExpired(db, 1)).toBe(true);
  });
});

describe("feed: an older engine's vault", () => {
  test("a vault with the change log but no readers' table (current stamp) gets it once, and positions start working", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "feed-old-")), "v.db");
    let db = new Database(file);
    const first = fresh(db);
    first.as({ id: "ws_before0001" });
    await first.store.createNote("before the feed", { path: "before" });
    db.exec("DROP TABLE feed_readers");
    expect(unnumberedStepsDone(db)).toBe(false);
    db.close();
    db = new Database(file);
    const { store, as } = fresh(db);
    expect(feedPresent(db)).toBe(true);
    expect(unnumberedStepsDone(db)).toBe(true);
    as({ id: "ws_after00001" });
    await store.createNote("after", { path: "after" });
    expect(readFeedPage(db, 0, 10, null).changes.map((c) => c.write_set)).toEqual(["ws_before0001", "ws_after00001"]);
    db.close();
  });
});
