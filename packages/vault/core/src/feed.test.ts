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
const row = (over: Partial<FeedRow>): FeedRow => ({ pos: 1, note_id: "n", write_set: "ws_x", existed: 1, before_tags: '["in"]', at: "", ...over });
const inScope = (tags: string[]) => tags.includes("in");

describe("feed: which change a reader is told", () => {
  test("unscoped: there now is an upsert; gone is a delete, unless the page never saw it standing", () => {
    expect(feedOp([row({ existed: 0 })], { tags: [] }, { tags: [] }, null)).toBe("upsert");
    expect(feedOp([row({})], null, null, null)).toBe("delete");
    expect(feedOp([row({ existed: 0, pos: 5 })], null, null, null)).toBe(null);
    // Made and later written in the page, then gone: a reader that read an earlier page uncommitted may hold it.
    expect(feedOp([row({ existed: 0, pos: 5 }), row({ pos: 6 })], null, null, null)).toBe("delete");
  });

  test("scoped: in scope now is an upsert; moved out is removed; gone from scope is a delete; never in scope is nothing", () => {
    expect(feedOp([row({ before_tags: '["out"]' })], { tags: ["in"] }, { tags: ["in"] }, inScope)).toBe("upsert");
    expect(feedOp([row({})], { tags: ["out"] }, { tags: ["out"] }, inScope)).toBe("removed");
    expect(feedOp([row({})], null, null, inScope)).toBe("delete");
    expect(feedOp([row({ before_tags: '["out"]' })], null, null, inScope)).toBe(null);
    expect(feedOp([row({ before_tags: '["out"]' })], { tags: ["out"] }, { tags: ["out"] }, inScope)).toBe(null);
    expect(feedOp([row({ existed: 0, before_tags: null })], { tags: ["out"] }, { tags: ["out"] }, inScope)).toBe(null);
  });

  test("gone is told when the record was visible at any point the page covers", () => {
    // The record was in scope at the reader's position; a write moved it out; a later one edited it, still out.
    expect(feedOp([row({ pos: 5, before_tags: '["in"]' }), row({ pos: 7, before_tags: '["out"]' })], { tags: ["out"] }, { tags: ["out"] }, inScope)).toBe("removed");
    // Out of scope at the position; brought in, then out again, inside the page: a reader that read it then (an
    // earlier page, not committed) holds it, so it is named as removed (it was in scope: nothing new is told).
    expect(feedOp([row({ pos: 5, before_tags: '["out"]' }), row({ pos: 7, before_tags: '["in"]' })], { tags: ["out"] }, { tags: ["out"] }, inScope)).toBe("removed");
    // Never in scope in the page: never named.
    expect(feedOp([row({ pos: 5, before_tags: '["out"]' }), row({ pos: 7, before_tags: '["out2"]' })], { tags: ["out"] }, { tags: ["out"] }, inScope)).toBe(null);
  });

  test("a row with no saved tags for a record that existed is not visible to a scoped reader (none is written today)", () => {
    expect(feedOp([row({ write_set: null, before_tags: null })], { tags: ["out"] }, { tags: ["out"] }, inScope)).toBe(null);
    expect(feedOp([row({ write_set: null, before_tags: null })], null, null, inScope)).toBe(null);
    expect(feedOp([row({ write_set: null, before_tags: null })], null, null, null)).toBe("delete");
  });
});

describe("feed: a reader more than one page behind (each page judged at its own end)", () => {
  /** A reader that holds what it's told and commits each page it reads. */
  function reader(db: Database, start: number, limit: number, scope: ((tags: string[]) => boolean) | null, held = new Set<string>()) {
    let pos = start;
    const one = (size = limit) => {
      const page = readFeedPage(db, pos, size, scope);
      for (const c of page.changes) c.op === "upsert" ? held.add(c.id) : held.delete(c.id);
      pos = page.next_position;
      return page.more;
    };
    // Catching up reads big pages, as a reader back from a pause does.
    return { held, one, drain: () => { for (let i = 0; i < 1000 && one(500); i++); } };
  }

  test("scoped: made out of scope and brought in, a page read, then deleted: the reader ends without it", async () => {
    const { db, store } = fresh();
    const r1 = reader(db, newestPosition(db), 1, inScope);
    const r = await store.createNote("x", { path: "r", tags: ["out"] });
    await store.tagNote(r.id, ["in"]);
    expect(r1.one()).toBe(true); // a page of one, more after it
    await store.deleteNote(r.id);
    r1.drain();
    expect([...r1.held]).toEqual([]);
  });

  test("scoped: brought in, a page read, then moved out: the reader ends without it", async () => {
    const { db, store } = fresh();
    const r1 = reader(db, newestPosition(db), 1, inScope);
    const r = await store.createNote("x", { path: "r", tags: ["out"] });
    await store.tagNote(r.id, ["in"]);
    expect(r1.one()).toBe(true);
    await store.untagNote(r.id, ["in"]);
    r1.drain();
    expect([...r1.held]).toEqual([]);
  });

  test("unscoped: an id deleted and made again, a page read, then deleted again: the reader ends without it", async () => {
    const { db, store } = fresh();
    const r = await store.createNote("x", { path: "r" });
    const r1 = reader(db, newestPosition(db), 1, null, new Set([r.id]));
    await store.deleteNote(r.id);
    await store.createNote("again", { id: r.id, path: "r2" });
    expect(r1.one()).toBe(true);
    await store.deleteNote(r.id);
    r1.drain();
    expect([...r1.held]).toEqual([]);
  });

  test("whatever the page size, readers that read between writes end up holding the same records", async () => {
    const { db, store } = fresh();
    const start = newestPosition(db);
    const scopes = [inScope, null];
    const readers = scopes.flatMap((scope) => [500, 1, 2, 3].map((limit) => ({ scope, limit, r: reader(db, start, limit, scope) })));
    const ids: string[] = [];
    const steps: (() => Promise<unknown>)[] = [];
    for (let i = 0; i < 6; i++) steps.push(async () => ids.push((await store.createNote(`n${i}`, { path: `n${i}`, tags: i % 2 ? ["in"] : ["out"] })).id));
    steps.push(
      () => store.tagNote(ids[0]!, ["in"]),
      () => store.untagNote(ids[1]!, ["in"]),
      () => store.deleteNote(ids[3]!),
      () => store.tagNote(ids[2]!, ["in"]),
      () => store.deleteNote(ids[2]!),
      () => store.updateNote(ids[5]!, { content: "edited" }),
      () => store.untagNote(ids[0]!, ["in"]),
      () => store.tagNote(ids[0]!, ["in"]),
      () => store.untagNote(ids[5]!, ["in"]),
    );
    for (const step of steps) {
      await step();
      for (const x of readers) x.r.one(); // one page each, then the next write
    }
    for (const x of readers) x.r.drain();
    for (const scope of scopes) {
      const own = readers.filter((x) => x.scope === scope).map((x) => [...x.r.held].sort());
      for (const h of own) expect(h).toEqual(own[0]!);
    }
  });
});

describe("feed: positions", () => {
  test("a set's later transaction writes its own row after a reader committed past the first", async () => {
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
    // The first row stayed where it was placed.
    expect((db.prepare("SELECT MIN(position) AS f FROM record_changes WHERE write_set = 'ws_long00001'").get() as { f: number }).f).toBeLessThan(committed);
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
