/**
 * The feed (0.9.4, T-471): the changes after a reader's position, read from the change log (change-log.ts).
 *
 * - **Positions** are the change log's own (`record_changes.position`): one row per record per Store transaction
 *   that changed it, placed once in log order when that transaction ends (settleChangeLogPositions), and never moved.
 *   A write set that spans several transactions writes a row in each, so a reader that committed between them still
 *   hears of the later change. Each row's snapshot (`existed`, `before_tags`) is the record as its transaction found
 *   it: exactly what a reader at the position just before that row saw. A row written outside any Store transaction
 *   (a raw statement, an older engine) has no position until the next one places it; the feed places pending rows
 *   before it reads (placePending), so they aren't hidden until the next write.
 * - **Readers** hold a position per owner and reader name in `feed_readers`, the feed's one table. The owner is the
 *   credential (feedOwner, in the server: a named key, else the credential kind and who it acts for, plus the tag
 *   scope of a scoped token), so different credentials never share a position. A read never moves it; a commit does.
 *   Readers untouched for longer than the log's horizon are swept (sweepReaders).
 * - **The horizon** is `change_log_state.horizon`: the highest position the change log's sweep has dropped, raised in
 *   the same step. A held position below it may have missed changes: the feed answers 410.
 *
 * Additive, with no schema number (ensureFeed, checked in unnumberedStepsDone).
 */
import type { Database } from "bun:sqlite";
import { settleChangeLogPositions } from "./change-log.js";
import type { Store } from "./types.js";

export const FEED_LIMIT_DEFAULT = 100;
export const FEED_LIMIT_MAX = 500;
/** A reader's name: what a client calls one of its readers (`default` when it doesn't say). */
export const FEED_READER_RE = /^[A-Za-z0-9_-]{1,64}$/;

const FEED_SQL = `
CREATE TABLE IF NOT EXISTS feed_readers (
  via TEXT NOT NULL,
  reader TEXT NOT NULL,
  position INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (via, reader)
) WITHOUT ROWID;
`;

/** Whether the feed's table is present. */
export function feedPresent(db: Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'feed_readers'").get();
}

/** The un-numbered step: adds the readers' table (no-op when present). */
export function ensureFeed(db: Database): void {
  if (!feedPresent(db)) db.exec(FEED_SQL);
}

/** The newest position given: every placed change is at or below it. 0 on an empty log. */
export function newestPosition(db: Database): number {
  const row = db.prepare("SELECT newest FROM change_log_state WHERE slot = 1").get() as { newest: number } | null;
  return row?.newest ?? 0;
}

/** The highest position the sweep has dropped (0 when nothing has been). */
export function feedHorizon(db: Database): number {
  const row = db.prepare("SELECT horizon FROM change_log_state WHERE slot = 1").get() as { horizon: number } | null;
  return row?.horizon ?? 0;
}

/**
 * Places rows written outside any Store transaction (a raw statement, an older engine), so a page doesn't stop short
 * of them until the next write. A read that finds such rows writes this bookkeeping (positions only, in one Store
 * transaction); a read that finds none writes nothing.
 */
export function placePending(store: Store): void {
  if (!store.db.prepare("SELECT 1 FROM record_changes WHERE touched = 1 LIMIT 1").get()) return;
  store.transaction(() => settleChangeLogPositions(store.db));
}

/** A position a reader holds that is no longer good: swept (unused for longer than the log keeps). */
export const EXPIRED_POSITION = -1;

/**
 * A held position that may have missed changes: below the sweep's horizon, or marked expired by sweepReaders. 0 means
 * "from the start of what the log keeps" and never expires.
 */
export function positionExpired(db: Database, position: number): boolean {
  return position < 0 || (position > 0 && position < feedHorizon(db));
}

export function getPosition(db: Database, owner: string, reader: string): number {
  const row = db.prepare("SELECT position FROM feed_readers WHERE via = ? AND reader = ?").get(owner, reader) as { position: number } | null;
  return row?.position ?? 0;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export function setPosition(db: Database, owner: string, reader: string, position: number): void {
  db.prepare(
    `INSERT INTO feed_readers (via, reader, position, updated_at) VALUES (?, ?, ?, ${NOW})
     ON CONFLICT (via, reader) DO UPDATE SET position = excluded.position, updated_at = excluded.updated_at`,
  ).run(owner, reader, position);
}

/** A read counts as use: the reader's row is touched, at most once a day, so the sweep leaves a reader in use alone. */
export function touchReader(db: Database, owner: string, reader: string, now = new Date()): void {
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
  db.prepare("UPDATE feed_readers SET updated_at = ? WHERE via = ? AND reader = ? AND updated_at < ? AND position >= 0").run(now.toISOString(), owner, reader, dayAgo);
}

/**
 * Marks readers unused (no read, no commit) for longer than the log keeps (`days`) as expired: their next read answers
 * 410 and they start again with "now". Marked, not deleted: a deleted reader would come back at 0 (the start of what
 * the log keeps) and silently miss the changes swept in between, where the mark says to resync. It also stops a key
 * name that is revoked and later reused from picking up the old key's position. Returns the readers marked.
 */
export function sweepReaders(db: Database, days: number, now = new Date()): number {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  return db.prepare("UPDATE feed_readers SET position = ? WHERE updated_at < ? AND position >= 0").run(EXPIRED_POSITION, cutoff).changes;
}

/** One change log row, as the feed reads it. */
export interface FeedRow {
  /** The row's position (placed once, at the end of its transaction). */
  pos: number;
  note_id: string;
  write_set: string | null;
  existed: number;
  before_tags: string | null;
  at: string;
}

/** What the record is now: null when it no longer exists. */
export type RecordNow = { tags: string[] } | null;

export type FeedOp = "upsert" | "delete" | "removed";

/**
 * Which change, if any, a reader is told about one record, from its rows in the page and what it is now.
 *
 * `inScope` is the reader's tag scope (null: unscoped, every record is in it).
 *
 * - *Visible now*: the record exists and its tags are in scope.
 * - *Visible before* (at the reader's position): the record's first row in the page (rows after the position, in
 *   position order). Its `existed` and `before_tags` are the record as that row's transaction found it, and nothing
 *   changed the record between the position and that row, so they are the record as the reader saw it. Writes outside
 *   any write set (write_set NULL) get one row per change with the tags saved, so they are judged the same way. A row
 *   with no saved tags for a record that existed isn't written today; were one met, a scoped reader would count it as
 *   not visible (the feed never names a record it can't show the reader could see).
 *
 * Then: visible now → `upsert`; else gone and visible before → `delete`; else still there, visible before →
 * `removed`; else nothing. A record that was never in scope across the page leaves no trace.
 *
 * `rows` are the record's rows in the page, in position order.
 */
export function feedOp(rows: FeedRow[], now: RecordNow, inScope: ((tags: string[]) => boolean) | null): FeedOp | null {
  if (now !== null && (inScope === null || inScope(now.tags))) return "upsert";
  const before = rows[0];
  if (!before || before.existed !== 1) return null;
  if (inScope !== null && (before.before_tags === null || !inScope(parseTags(before.before_tags)))) return null;
  return now === null ? "delete" : "removed";
}

function parseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export interface FeedChange {
  /** The feed position of the record's newest change in the page. */
  seq: number;
  op: FeedOp;
  id: string;
  write_set: string | null;
  by: string | null;
  via: string | null;
  at: string;
}

export interface FeedPage {
  changes: FeedChange[];
  /** The position after this page: past every row the page read, whether or not the reader was told of it. */
  next_position: number;
  more: boolean;
}

/**
 * The page after `position`: up to `limit` change log rows in position order, grouped by record. Each record appears
 * once, at its newest row in the page; entries are in position order. `next_position` and `more` depend only on the
 * log (never on the reader's scope), so an empty page from a scoped reader says nothing a scope-blind reader of the
 * same log wouldn't learn.
 */
export function readFeedPage(
  db: Database,
  position: number,
  limit: number,
  inScope: ((tags: string[]) => boolean) | null,
): FeedPage {
  const rows = db
    .prepare(
      `SELECT position AS pos, note_id, write_set, existed, before_tags, at FROM record_changes
       WHERE position > ? ORDER BY position LIMIT ?`,
    )
    .all(position, limit + 1) as FeedRow[];
  const more = rows.length > limit;
  if (more) rows.length = limit;
  const byNote = new Map<string, FeedRow[]>();
  for (const r of rows) {
    const list = byNote.get(r.note_id);
    if (list) list.push(r);
    else byNote.set(r.note_id, [r]);
  }
  const tagsOf = db.prepare("SELECT tag_name FROM note_tags WHERE note_id = ? ORDER BY tag_name");
  const exists = db.prepare("SELECT 1 FROM notes WHERE id = ?");
  const setOf = db.prepare("SELECT actor, via FROM write_sets WHERE id = ?");
  const changes: FeedChange[] = [];
  for (const [id, list] of byNote) {
    const now: RecordNow = exists.get(id) ? { tags: (tagsOf.all(id) as { tag_name: string }[]).map((t) => t.tag_name) } : null;
    const op = feedOp(list, now, inScope);
    if (op === null) continue;
    const newest = list[list.length - 1]!;
    const set = newest.write_set ? (setOf.get(newest.write_set) as { actor: string | null; via: string | null } | null) : null;
    changes.push({ seq: newest.pos, op, id, write_set: newest.write_set, by: set?.actor ?? null, via: set?.via ?? null, at: newest.at });
  }
  changes.sort((a, b) => a.seq - b.seq);
  return { changes, next_position: rows.length ? rows[rows.length - 1]!.pos : position, more };
}
