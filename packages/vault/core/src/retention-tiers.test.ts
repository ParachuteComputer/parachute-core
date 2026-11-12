// T-460 (1.0): the retention tiers. Every version for 90 days, then the first of each UTC day to a year, then the
// first of each ISO week; the newest 20, delete tombstones and marked versions always kept; applied at capture and
// by a once-a-day sweep that reaches notes nobody edits.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { tierKeepers, pruneVersions, resolveHistoryPolicy, DEFAULT_HISTORY_POLICY } from "./history.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const iso = (t: number) => new Date(t).toISOString();

test("the rule: all within 90 days, the earliest per UTC day to a year, the earliest per Monday-to-Sunday week after", () => {
  const rows = [
    { version_ix: 1, superseded_at: iso(NOW - 10 * DAY) },
    { version_ix: 2, superseded_at: iso(NOW - 10 * DAY + 3600_000) }, // same day, inside 90 days: kept too
    { version_ix: 3, superseded_at: "2026-07-01T08:00:00.000Z" }, // 133 days: daily
    { version_ix: 4, superseded_at: "2026-07-01T23:59:00.000Z" }, //   same UTC day, later: thinned
    { version_ix: 5, superseded_at: "2026-07-02T00:01:00.000Z" }, //   next day: kept
    { version_ix: 6, superseded_at: "2025-06-02T10:00:00.000Z" }, // >1 year, Monday: weekly
    { version_ix: 7, superseded_at: "2025-06-08T22:00:00.000Z" }, //   Sunday of the same ISO week: thinned
    { version_ix: 8, superseded_at: "2025-06-09T01:00:00.000Z" }, //   next Monday: kept
    { version_ix: 9, superseded_at: "not a time" }, // unreadable: kept
  ];
  expect([...tierKeepers(rows, DEFAULT_HISTORY_POLICY, NOW)].sort((a, b) => a - b)).toEqual([1, 2, 3, 5, 6, 8, 9]);
  expect(DEFAULT_HISTORY_POLICY).toMatchObject({ keep_all_days: 90, keep_daily_days: 365, min_versions: 20 });
});

/** A note with `days` days of history, three versions a day, the newest today: rows written directly, as captures would. */
async function longNote(store: SqliteStore, db: Database, days: number) {
  const n = await store.createNote("now");
  const total = days * 3;
  const { hashContent } = await import("./history.js");
  const { refreshCompactState } = await import("./history-compact-state.js");
  db.transaction(() => {
    for (let k = 0; k < total; k++) {
      const body = `v${k}`, hash = hashContent(body);
      const age = Math.floor((total - 1 - k) / 3);
      db.prepare("INSERT OR IGNORE INTO note_blobs (hash, content, byte_size) VALUES (?, ?, ?)").run(hash, body, body.length);
      db.prepare(`INSERT INTO note_versions (note_id, version_ix, content_hash, path, metadata, extension, superseded_at, actor, via, op, content_len, encoding, created_at)
        VALUES (?, ?, ?, NULL, '{}', 'md', ?, NULL, 'api', 'update', ?, NULL, NULL)`).run(n.id, k, hash, iso(Date.now() - age * DAY - (2 - (k % 3)) * 3600_000), body.length);
    }
    refreshCompactState(db, n.id);
  })();
  return n.id;
}

test("two years of edits thin to: all of 90 days, one a day to a year, one a week after; marks and tombstones kept", async () => {
  const db = new Database(":memory:");
  const store = new SqliteStore(db);
  const id = await longNote(store, db, 730);
  const marked = 5; // a version from about two years ago
  await store.markNoteVersion(id, marked, { marked: true, actor: "ann" });
  pruneVersions(db, id, resolveHistoryPolicy({}), Date.now());
  const left = (db.prepare("SELECT version_ix, superseded_at FROM note_versions WHERE note_id = ?").all(id) as { version_ix: number; superseded_at: string }[]);
  const age = (r: { superseded_at: string }) => (Date.now() - Date.parse(r.superseded_at)) / DAY;
  const recent = left.filter((r) => age(r) < 90).length, daily = left.filter((r) => age(r) >= 90 && age(r) < 365).length, weekly = left.filter((r) => age(r) >= 365).length;
  expect(recent).toBeGreaterThanOrEqual(89 * 3);
  expect(daily).toBeGreaterThanOrEqual(272);
  expect(daily).toBeLessThanOrEqual(276);
  expect(weekly).toBeGreaterThanOrEqual(52);
  expect(weekly).toBeLessThanOrEqual(55);
  expect(left.some((r) => r.version_ix === marked)).toBe(true);
  // Every kept version still reads back.
  for (const r of left.slice(0, 40)) expect((await store.getNoteVersion(id, r.version_ix))!.content).toBe(`v${r.version_ix}`);
  // A delete tombstone is kept however old.
  await store.deleteNote(id);
  db.prepare("UPDATE note_versions SET superseded_at = ? WHERE note_id = ? AND op = 'delete'").run(iso(Date.now() - 900 * DAY), id);
  pruneVersions(db, id, resolveHistoryPolicy({}), Date.now());
  expect(db.prepare("SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ? AND op = 'delete'").get(id)).toEqual({ n: 1 });
});

test("the sweep reaches a note nobody edits, once a day, oldest-swept first, and thins it", async () => {
  const db = new Database(":memory:");
  const store = new SqliteStore(db, { history: { compact_budget_ms: 250 } });
  const id = await longNote(store, db, 200);
  const before = (db.prepare("SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?").get(id) as { n: number }).n;
  expect(before).toBe(600);
  // Nobody edits it; a day passes.
  db.prepare("UPDATE history_compact_state SET refreshed_at = ? WHERE note_id = ?").run(Date.now() - 2 * DAY, id);
  const pass = store.compactHistory({ maxNotes: null });
  expect(pass).toMatchObject({ notes_thinned: 1, thin_remaining: 0 });
  const after = (db.prepare("SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?").get(id) as { n: number }).n;
  expect(after).toBeLessThan(before - 200);
  expect(pass.versions_thinned).toBe(before - after);
  // Swept today: the next pass leaves it alone.
  expect(store.compactHistory({ maxNotes: null }).notes_thinned).toBe(0);
  expect((db.prepare("SELECT refreshed_at FROM history_compact_state WHERE note_id = ?").get(id) as { refreshed_at: number }).refreshed_at).toBeGreaterThan(Date.now() - DAY);
});

test("a policy without the tier keys (a history import planned before 1.0) prunes as it was planned; null turns tiers off", async () => {
  const db = new Database(":memory:");
  const store = new SqliteStore(db);
  const id = await longNote(store, db, 200);
  const { keep_all_days: _a, keep_daily_days: _b, ...planned } = resolveHistoryPolicy({ max_versions: 1_000_000, max_age_days: 36_500 });
  pruneVersions(db, id, planned as never, Date.now());
  expect((db.prepare("SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?").get(id) as { n: number }).n).toBe(600);
  pruneVersions(db, id, resolveHistoryPolicy({ keep_all_days: null }), Date.now());
  expect((db.prepare("SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?").get(id) as { n: number }).n).toBe(600);
  // A vault that sets a count cap still gets it, on top of the tiers.
  pruneVersions(db, id, resolveHistoryPolicy({ max_versions: 50 }), Date.now());
  expect((db.prepare("SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?").get(id) as { n: number }).n).toBe(50);
});

test("marking: set, kept by the byte ceiling, shown on reads, cleared; a missing version is null", async () => {
  const db = new Database(":memory:");
  const store = new SqliteStore(db);
  const n = await store.createNote("v0");
  for (let k = 1; k <= 3; k++) await store.updateNote(n.id, { content: `v${k}` });
  const row = await store.markNoteVersion(n.id, 0, { marked: true, actor: "ann" });
  expect(row).toMatchObject({ version_ix: 0, marked_by: "ann" });
  expect(typeof row!.marked_at).toBe("string");
  // Marking again keeps the first mark.
  expect(await store.markNoteVersion(n.id, 0, { marked: true, actor: "bob" })).toMatchObject({ marked_by: "ann" });
  expect((await store.getNoteVersion(n.id, 0))).toMatchObject({ marked_by: "ann" });
  expect((await store.listNoteVersions(n.id)).find((v) => v.version_ix === 0)).toMatchObject({ marked_by: "ann" });
  expect("marked_at" in (await store.listNoteVersions(n.id)).find((v) => v.version_ix === 1)!).toBe(false);
  const cleared = await store.markNoteVersion(n.id, 0, { marked: false });
  expect(cleared && "marked_at" in cleared).toBe(false);
  expect(await store.markNoteVersion(n.id, 99, { marked: true })).toBeNull();
});
