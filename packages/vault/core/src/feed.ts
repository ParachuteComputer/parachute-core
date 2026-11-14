/**
 * The feed (0.9.4, T-471): the changes after a reader's position, read from the change log (change-log.ts).
 *
 * - **Positions** are numbers in the change log's order. Each `record_changes` row carries `feed_seq`: the next
 *   position when it is written (also kept, unmoved, as `feed_first`), and a new, higher one each time its write set touches the record again. A write set is
 *   one row per record, so without this a set that spans several transactions (several requests sending one
 *   `Parachute-Write-Set` id, or one request with several Store transactions) would change a record after a reader
 *   had committed past the set's row, and the reader would never hear of it. Numbers come from one counter
 *   (`feed_state.newest`), so positions are unique and in commit order (one writer at a time). Not from
 *   AUTOINCREMENT's `sqlite_sequence`: SQLite writes that only at the end of the outermost statement, so a trigger
 *   reading it mid-statement sees a stale number. `seq` itself never moves: undo and "the order a set first touched
 *   its records" read it.
 * - **Readers** hold a position per (credential `via`, reader name) in `feed_readers`. A read never moves it; a
 *   commit does. A key can only name its own positions (they are keyed by the `via` it authenticates as).
 * - **The horizon** is the highest position the change log's sweep has dropped (`feed_state.horizon`, written in the same
 *   step as the sweep). A held position below it may have missed changes: the feed answers 410.
 *
 * Additive, with no schema number (ensureFeed, checked in unnumberedStepsDone).
 */
import type { Database } from "bun:sqlite";
import { changeLogPresent } from "./change-log.js";

export const FEED_LIMIT_DEFAULT = 100;
export const FEED_LIMIT_MAX = 500;
/** A reader's name: what a client calls one of its readers (`default` when it doesn't say). */
export const FEED_READER_RE = /^[A-Za-z0-9_-]{1,64}$/;

const CTX_SET = `(SELECT write_set FROM write_context WHERE slot = 1)`;
const NEWEST = `(SELECT newest FROM feed_state WHERE slot = 1)`;

/**
 * Moves the current write set's row for a record to a new, newest position. Runs on every touch: on a first touch the
 * row may already be newest, and a number is spent for nothing; that keeps the rule simple (no case where a reader that
 * committed this row's position misses a later change in the same set). A write outside any set writes a fresh row
 * each time, so it needs nothing here.
 */
function bump(noteId: string): string {
  return `
    UPDATE feed_state SET newest = newest + 1 WHERE slot = 1
      AND EXISTS (SELECT 1 FROM record_changes WHERE write_set = ${CTX_SET} AND note_id = ${noteId});
    UPDATE record_changes SET feed_seq = ${NEWEST} WHERE write_set = ${CTX_SET} AND note_id = ${noteId};`;
}

export const FEED_TRIGGERS = [
  "rcf_position",
  "rcf_notes_insert",
  "rcf_notes_update",
  "rcf_notes_delete",
  "rcf_note_tags_insert",
  "rcf_note_tags_delete",
  "rcf_note_tags_update",
  "rcf_links_insert",
  "rcf_links_delete",
  "rcf_links_update",
] as const;

/** Tables, the index and the triggers, after `feed_seq` and `feed_first` exist on record_changes. Idempotent. */
const FEED_SQL = `
CREATE TABLE IF NOT EXISTS feed_readers (
  via TEXT NOT NULL,
  reader TEXT NOT NULL,
  position INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (via, reader)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS feed_state (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  newest INTEGER NOT NULL,
  horizon INTEGER NOT NULL DEFAULT 0
);
UPDATE record_changes SET feed_seq = seq WHERE feed_seq IS NULL;
UPDATE record_changes SET feed_first = seq WHERE feed_first IS NULL;
INSERT OR IGNORE INTO feed_state (slot, newest, horizon)
  VALUES (1, COALESCE((SELECT MAX(feed_seq) FROM record_changes), (SELECT seq FROM sqlite_sequence WHERE name = 'record_changes'), 0), 0);
CREATE INDEX IF NOT EXISTS idx_record_changes_feed ON record_changes(feed_seq);

CREATE TRIGGER IF NOT EXISTS rcf_position AFTER INSERT ON record_changes WHEN NEW.feed_seq IS NULL BEGIN
  UPDATE feed_state SET newest = newest + 1 WHERE slot = 1;
  UPDATE record_changes SET feed_seq = ${NEWEST}, feed_first = ${NEWEST} WHERE seq = NEW.seq;
END;
CREATE TRIGGER IF NOT EXISTS rcf_notes_insert AFTER INSERT ON notes BEGIN ${bump("NEW.id")} END;
CREATE TRIGGER IF NOT EXISTS rcf_notes_update AFTER UPDATE ON notes
WHEN OLD.content IS NOT NEW.content OR OLD.metadata IS NOT NEW.metadata OR OLD.path IS NOT NEW.path
  OR OLD.extension IS NOT NEW.extension OR OLD.updated_at IS NOT NEW.updated_at OR OLD.created_at IS NOT NEW.created_at
BEGIN ${bump("NEW.id")} END;
CREATE TRIGGER IF NOT EXISTS rcf_notes_delete AFTER DELETE ON notes BEGIN ${bump("OLD.id")} END;
CREATE TRIGGER IF NOT EXISTS rcf_note_tags_insert AFTER INSERT ON note_tags BEGIN ${bump("NEW.note_id")} END;
CREATE TRIGGER IF NOT EXISTS rcf_note_tags_delete AFTER DELETE ON note_tags BEGIN ${bump("OLD.note_id")} END;
CREATE TRIGGER IF NOT EXISTS rcf_note_tags_update AFTER UPDATE ON note_tags
WHEN OLD.note_id IS NOT NEW.note_id OR OLD.tag_name IS NOT NEW.tag_name
BEGIN ${bump("NEW.note_id")} END;
CREATE TRIGGER IF NOT EXISTS rcf_links_insert AFTER INSERT ON links BEGIN ${bump("NEW.source_id")} END;
CREATE TRIGGER IF NOT EXISTS rcf_links_delete AFTER DELETE ON links BEGIN ${bump("OLD.source_id")} END;
CREATE TRIGGER IF NOT EXISTS rcf_links_update AFTER UPDATE ON links
WHEN OLD.target_id IS NOT NEW.target_id OR OLD.relationship IS NOT NEW.relationship OR OLD.metadata IS NOT NEW.metadata OR OLD.source_id IS NOT NEW.source_id
BEGIN ${bump("NEW.source_id")} END;
`;

function hasFeedColumns(db: Database): boolean {
  return (db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('record_changes') WHERE name IN ('feed_seq', 'feed_first')").get() as { n: number }).n === 2;
}

/** Whether the feed's column, tables and triggers are all present. */
export function feedPresent(db: Database): boolean {
  if (!hasFeedColumns(db)) return false;
  const names = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE name IN ('feed_readers', 'feed_state') OR name LIKE 'rcf\\_%' ESCAPE '\\'").all() as { name: string }[]).map((r) => r.name),
  );
  return ["feed_readers", "feed_state", ...FEED_TRIGGERS].every((n) => names.has(n));
}

/** The un-numbered step: adds the feed to a vault whose change log lacks it (no-op otherwise). */
export function ensureFeed(db: Database): void {
  if (!changeLogPresent(db) || feedPresent(db)) return;
  for (const c of ["feed_seq", "feed_first"]) {
    if (!db.prepare("SELECT 1 FROM pragma_table_info('record_changes') WHERE name = ?").get(c)) db.exec(`ALTER TABLE record_changes ADD COLUMN ${c} INTEGER`);
  }
  db.exec(FEED_SQL);
}

/** The newest position: every change so far is at or below it. 0 on an empty log. */
export function newestPosition(db: Database): number {
  const row = db.prepare("SELECT newest FROM feed_state WHERE slot = 1").get() as { newest: number } | null;
  return row?.newest ?? 0;
}

/** The highest position the sweep has dropped (0 when nothing has been). */
export function feedHorizon(db: Database): number {
  const row = db.prepare("SELECT horizon FROM feed_state WHERE slot = 1").get() as { horizon: number } | null;
  return row?.horizon ?? 0;
}

/** A held position that may have missed changes the sweep dropped. 0 means "from the start of what is kept". */
export function positionExpired(db: Database, position: number): boolean {
  return position > 0 && position < feedHorizon(db);
}

export function getPosition(db: Database, via: string, reader: string): number {
  const row = db.prepare("SELECT position FROM feed_readers WHERE via = ? AND reader = ?").get(via, reader) as { position: number } | null;
  return row?.position ?? 0;
}

export function setPosition(db: Database, via: string, reader: string, position: number): void {
  db.prepare(
    `INSERT INTO feed_readers (via, reader, position, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT (via, reader) DO UPDATE SET position = excluded.position, updated_at = excluded.updated_at`,
  ).run(via, reader, position);
}

/** One change log row, as the feed reads it. */
export interface FeedRow {
  /** The row's feed position. */
  pos: number;
  /** The position the row was given when its write set first touched the record (never moves). */
  first: number;
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
 * - *Visible before* (at the reader's position): read from the record's row with the smallest `first` above the
 *   position; that row's `existed` and `before_tags` are the record as it was there. A row whose `first` is at or below
 *   the position is a write set that began before it and touched the record again later: its `before_tags` describe
 *   an older state. When no row says what the record was at the position, or the row has no `before_tags` (a write
 *   made outside any write set, by a raw statement or an older engine), the state is unknown, and a scoped reader
 *   counts it as not visible: the feed never names a record it can't show the reader could see. The cost is a missed
 *   `removed` (or `delete`) for a record the reader held, in those rare cases. An unscoped reader sees every record,
 *   so for it "before" is only whether the record existed (unknown counts as existing: a delete of something it may
 *   hold is safe to send).
 *
 * Then: visible now → `upsert`; else gone and visible before → `delete`; else still there, visible before →
 * `removed`; else nothing. A record that was never in scope across the page leaves no trace.
 */
export function feedOp(rows: FeedRow[], position: number, now: RecordNow, inScope: ((tags: string[]) => boolean) | null): FeedOp | null {
  if (now !== null && (inScope === null || inScope(now.tags))) return "upsert";
  let before: FeedRow | null = null;
  for (const r of rows) if (r.first > position && (before === null || r.first < before.first)) before = r;
  let visibleBefore: boolean;
  if (inScope === null) visibleBefore = before === null ? true : before.existed === 1;
  else if (before === null || before.existed !== 1 || before.before_tags === null) visibleBefore = false;
  else visibleBefore = inScope(parseTags(before.before_tags));
  if (!visibleBefore) return null;
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
      `SELECT feed_seq AS pos, feed_first AS first, note_id, write_set, existed, before_tags, at FROM record_changes
       WHERE feed_seq > ? ORDER BY feed_seq LIMIT ?`,
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
    const op = feedOp(list, position, now, inScope);
    if (op === null) continue;
    const newest = list[list.length - 1]!;
    const set = newest.write_set ? (setOf.get(newest.write_set) as { actor: string | null; via: string | null } | null) : null;
    changes.push({ seq: newest.pos, op, id, write_set: newest.write_set, by: set?.actor ?? null, via: set?.via ?? null, at: newest.at });
  }
  changes.sort((a, b) => a.seq - b.seq);
  return { changes, next_position: rows.length ? rows[rows.length - 1]!.pos : position, more };
}
