/**
 * The change log (0.9.4, T-471): which records one write changed, from what, and in what order.
 *
 * One mechanism serves three needs. The feed reads `record_changes` in `seq` order; undo reads a write set's
 * `before_*` columns; a revision names its write set, so it can say who and why.
 *
 * - `write_sets`: one row per write. A write set is one request (a REST call, an MCP tool call), or several when the
 *   client sends the same `Parachute-Write-Set` id.
 * - `record_changes`: one row per record per write set, written by SQLite triggers on `notes`, `note_tags` and
 *   `links`, so every write path is covered (including those that capture no version: create, merge-tags, batch
 *   tagging) and a Durable Object running core's schema gets the same rows. The first touch of a record in a set
 *   saves what undo needs: the body only when the set changes it, the rest of the row, the types and tags, and the
 *   outgoing links as they were.
 * - `write_context`: one row, slot 1. The app sets it at the start of the outermost Store transaction and clears it at
 *   the end; the triggers read it. A write made with no context (a raw statement outside the Store) is logged with a
 *   NULL write set: it reaches the feed and counts as a later write for undo, but can't itself be undone.
 *
 * Additive, with no schema number (ensureChangeLog, checked in unnumberedStepsDone): an older engine ignores the
 * tables, and its writes, which the triggers still see, are logged with a NULL write set.
 *
 * Field snapshots are stored compressed (T-471), as history stores version bodies (blob-codec.ts): the triggers can't
 * compress, so they write JSON text, and the end of the transaction (settleChangeLogPositions) re-encodes it.
 * - `before_row` (a record's fields, path and stamps) long enough to gain: a Fossil delta, deflated, against a whole
 *   snapshot of the same record in `record_change_bases` (`before_base` names it). Depth one: a base is always whole.
 *   A record's writes mostly change a field or two, so the delta is a few dozen bytes. A new base is made when the
 *   record has none, or when the delta against its newest one is no longer small.
 * - `before_links`: deflated whole (it changes only on a link write).
 * - Short snapshots stay text. The column's type says which: TEXT is the JSON, a BLOB is compressed.
 * Readers go through {@link setRecordStates}, so undo and the write-set routes see byte-equal text either way.
 * `before_tags` stays text: the feed reads it on every page. A base is freed by the sweep once no row of its record can
 * name it, re-based where a remaining row still does (so no base outlives the horizon), and with the record's past
 * (forgetLoggedPast).
 */
import type { Database } from "bun:sqlite";
import { deflateBytes, inflateBytes, wholeText, BlobDecodeError, type StoredContent } from "./blob-codec.js";
import { applyDeltaBytes, createDeltaBytes } from "./delta.js";
import { kindOfVia } from "./write-stamp.js";

/** Rows older than this many days are swept (the feed's and undo's horizon). */
export const CHANGE_LOG_DAYS_DEFAULT = 30;
/** `why` is a short reason, not a document. */
export const WHY_MAX_CHARS = 280;

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
/**
 * The context row, joined once. SQLite compiles every trigger into each statement that writes its table, so each
 * trigger is one short statement (a statement that writes a note compiles in ~20 µs more, not ~75).
 */
const CTX = `(SELECT 1) LEFT JOIN write_context c ON c.slot = 1`;
/** Bodies are kept for a set's undo only: a write outside any set can't be undone, so its body isn't kept. */
const KEEP = `(c.write_set IS NOT NULL AND COALESCE(c.keep_before, 1) = 1)`;

/** The row columns undo puts back (not the body, which is saved only when the set changes it). */
const rowJson = (r: string) =>
  `json_object('path', ${r}.path, 'extension', ${r}.extension, 'metadata', ${r}.metadata, 'created_at', ${r}.created_at, 'created_by', ${r}.created_by, 'created_via', ${r}.created_via)`;
const TAGS_OF = (id: string, extra = "") =>
  `(SELECT json_group_array(tag_name) FROM (SELECT tag_name FROM note_tags WHERE note_id = ${id}${extra} ORDER BY 1))`;
const LINK_JSON = `json_object('target', target_id, 'relationship', relationship, 'metadata', json(COALESCE(metadata, '{}')))`;
const LINKS_OF = (id: string, extra = "") =>
  `(SELECT json_group_array(${LINK_JSON}) FROM (SELECT target_id, relationship, metadata FROM links WHERE source_id = ${id}${extra} ORDER BY 1, 2))`;

/**
 * A touch from a tag or link row. Each trigger saves only what its own write changes, the first time the set changes
 * it (COALESCE keeps the first): tags (always, as the feed judges scope by them) and, from a link row, the links, each
 * list as today's with this one change undone. The row's fields are saved by the row's own trigger, the first time
 * the set changes the row; a set that never changes the row leaves them null (undo leaves the row as it is). With no
 * context the row's write set is NULL, which never conflicts: one row per change.
 */
function childTouch(noteId: string, tagsBefore: string, linksBefore: string | null): string {
  return `INSERT INTO record_changes (write_set, txn, note_id, op, existed, at, before_tags${linksBefore ? ", before_links" : ""})
    SELECT c.write_set, c.txn, n.id, 'update', 1, ${NOW}, ${tagsBefore}${linksBefore ? `, ${linksBefore}` : ""}
    FROM notes n LEFT JOIN write_context c ON c.slot = 1 WHERE n.id = ${noteId}
    ON CONFLICT (write_set, note_id, txn) DO UPDATE SET touched = 1,
      before_tags = COALESCE(before_tags, excluded.before_tags)${linksBefore ? ",\n      before_links = COALESCE(before_links, excluded.before_links)" : ""};`;
}

/**
 * Stages a record's body for undo the first time a set changes it (or deletes the record): only in a set, only when
 * bodies are kept, never for a record the set created, never twice (a body saved earlier in the set, in this
 * transaction or a settled one, stands). Runs before the log row's own statement, which then marks it saved.
 */
function stageBody(when: string): string {
  return `INSERT OR IGNORE INTO record_change_bodies (write_set, note_id, content)
    SELECT c.write_set, OLD.id, OLD.content FROM write_context c
    WHERE c.slot = 1 AND ${KEEP} AND ${when}
      AND NOT EXISTS (SELECT 1 FROM record_changes r WHERE r.write_set = c.write_set AND r.note_id = OLD.id AND (r.content_saved = 1 OR r.existed = 0))
      AND NOT EXISTS (SELECT 1 FROM record_change_bodies b WHERE b.write_set = c.write_set AND b.note_id = OLD.id);`;
}

/** The tables, indexes and triggers. Idempotent. */
export const CHANGE_LOG_SQL = `
CREATE TABLE IF NOT EXISTS write_context (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  write_set TEXT,
  actor TEXT,
  via TEXT,
  via_kind TEXT,
  why TEXT,
  undoes TEXT,
  keep_before INTEGER NOT NULL DEFAULT 1,
  -- One token per Store transaction: a set's later transaction writes its own row for a record, never moving one
  -- already placed in the log's order (a placed row's snapshot is what readers at that position saw).
  txn TEXT
);
CREATE TABLE IF NOT EXISTS write_sets (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT,
  via TEXT,
  via_kind TEXT,
  why TEXT,
  undoes TEXT
);
CREATE INDEX IF NOT EXISTS idx_write_sets_via_at ON write_sets(via, at);
CREATE INDEX IF NOT EXISTS idx_write_sets_at ON write_sets(at);
CREATE INDEX IF NOT EXISTS idx_write_sets_undoes ON write_sets(undoes) WHERE undoes IS NOT NULL;
CREATE TABLE IF NOT EXISTS record_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  write_set TEXT,
  note_id TEXT NOT NULL,
  op TEXT NOT NULL,
  existed INTEGER NOT NULL,
  at TEXT NOT NULL,
  before_hash TEXT,
  content_saved INTEGER NOT NULL DEFAULT 0,
  before_row TEXT,
  before_tags TEXT,
  before_links TEXT,
  -- The transaction that wrote the row: one row per record per set per transaction. A set that spans several
  -- transactions (requests sharing one Parachute-Write-Set id) has several rows for a record, in seq order; each
  -- row's snapshot is the record as that transaction found it, so a set's "before" is the first non-null of each.
  txn TEXT,
  -- The log's order (0.9.4): given once, at the end of the writing transaction (settleChangeLogPositions), and never
  -- moved. NULL until then; touched marks a row still to be placed. The feed reads in this order; undo's conflict
  -- check compares it.
  position INTEGER,
  touched INTEGER NOT NULL DEFAULT 1,
  -- The whole snapshot before_row is a delta against (record_change_bases.id), or NULL when before_row stands alone.
  before_base INTEGER,
  UNIQUE (write_set, note_id, txn)
);
-- Whole field snapshots that before_row deltas are taken against (T-471): one record's each, made by settle, freed by
-- the sweep once no row of the record can name them. content is the JSON deflated (a BLOB) or, when short, the text.
CREATE TABLE IF NOT EXISTS record_change_bases (
  id INTEGER PRIMARY KEY,
  note_id TEXT NOT NULL,
  content NOT NULL,
  -- How many rows were stored against it: past BASE_MAX_USES a record's next row makes a new base, so the sweep, which
  -- re-encodes the rows still naming a base whose first row it drops, never has many to do.
  uses INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_record_change_bases_note ON record_change_bases(note_id, id);
CREATE INDEX IF NOT EXISTS idx_record_changes_position ON record_changes(position);
-- A body undo needs, staged here by the triggers for the length of the writing transaction; its end moves it into
-- note_blobs (history.ts settleLogBodies) and empties this table. Kept apart from record_changes so a log row is
-- written once at its final size: a row that shrank after its body moved out left most of its page empty.
CREATE TABLE IF NOT EXISTS record_change_bodies (
  write_set TEXT NOT NULL,
  note_id TEXT NOT NULL,
  content TEXT,
  PRIMARY KEY (write_set, note_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_record_changes_touched ON record_changes(seq) WHERE touched = 1;
CREATE TABLE IF NOT EXISTS change_log_state (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  newest INTEGER NOT NULL DEFAULT 0,
  -- The highest position the sweep has dropped: a feed reader below it may have missed changes.
  horizon INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO change_log_state (slot, newest, horizon) VALUES (1, 0, 0);
CREATE INDEX IF NOT EXISTS idx_record_changes_note ON record_changes(note_id, seq);
CREATE INDEX IF NOT EXISTS idx_record_changes_hash ON record_changes(before_hash) WHERE before_hash IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS rc_notes_insert AFTER INSERT ON notes BEGIN
  INSERT INTO record_changes (write_set, txn, note_id, op, existed, at)
  SELECT c.write_set, c.txn, NEW.id, 'create', 0, ${NOW} FROM ${CTX} WHERE true
  ON CONFLICT (write_set, note_id, txn) DO UPDATE SET op = CASE WHEN existed = 1 THEN 'update' ELSE 'create' END, touched = 1;
END;

CREATE TRIGGER IF NOT EXISTS rc_notes_update BEFORE UPDATE ON notes
WHEN OLD.content IS NOT NEW.content OR OLD.metadata IS NOT NEW.metadata OR OLD.path IS NOT NEW.path
  OR OLD.extension IS NOT NEW.extension OR OLD.updated_at IS NOT NEW.updated_at OR OLD.created_at IS NOT NEW.created_at
BEGIN
  ${stageBody("OLD.content IS NOT NEW.content")}
  INSERT INTO record_changes (write_set, txn, note_id, op, existed, at, content_saved, before_row, before_tags)
  SELECT c.write_set, c.txn, OLD.id, 'update', 1, ${NOW},
    OLD.content IS NOT NEW.content AND ${KEEP},
    ${rowJson("OLD")}, ${TAGS_OF("OLD.id")}
  FROM ${CTX} WHERE true
  ON CONFLICT (write_set, note_id, txn) DO UPDATE SET touched = 1,
    before_row = COALESCE(before_row, excluded.before_row),
    before_tags = COALESCE(before_tags, excluded.before_tags),
    content_saved = CASE WHEN existed = 1 AND content_saved = 0 THEN excluded.content_saved ELSE content_saved END;
END;

CREATE TRIGGER IF NOT EXISTS rc_notes_delete BEFORE DELETE ON notes BEGIN
  ${stageBody("1")}
  INSERT INTO record_changes (write_set, txn, note_id, op, existed, at, content_saved, before_row, before_tags, before_links)
  SELECT c.write_set, c.txn, OLD.id, 'delete', 1, ${NOW},
    ${KEEP},
    ${rowJson("OLD")}, ${TAGS_OF("OLD.id")}, ${LINKS_OF("OLD.id")}
  FROM ${CTX} WHERE true
  ON CONFLICT (write_set, note_id, txn) DO UPDATE SET op = 'delete', touched = 1,
    before_row = COALESCE(before_row, excluded.before_row),
    before_tags = COALESCE(before_tags, excluded.before_tags),
    before_links = COALESCE(before_links, excluded.before_links),
    content_saved = CASE WHEN existed = 1 AND content_saved = 0 THEN excluded.content_saved ELSE content_saved END;
END;

CREATE TRIGGER IF NOT EXISTS rc_note_tags_insert AFTER INSERT ON note_tags BEGIN
  ${childTouch("NEW.note_id", TAGS_OF("NEW.note_id", " AND tag_name IS NOT NEW.tag_name"), null)}
END;

CREATE TRIGGER IF NOT EXISTS rc_note_tags_delete AFTER DELETE ON note_tags BEGIN
  ${childTouch("OLD.note_id", `(SELECT json_group_array(tag_name) FROM (SELECT tag_name FROM note_tags WHERE note_id = OLD.note_id UNION SELECT OLD.tag_name ORDER BY 1))`, null)}
END;

CREATE TRIGGER IF NOT EXISTS rc_note_tags_update AFTER UPDATE ON note_tags
WHEN OLD.note_id IS NOT NEW.note_id OR OLD.tag_name IS NOT NEW.tag_name
BEGIN
  ${childTouch("NEW.note_id", `(SELECT json_group_array(tag_name) FROM (SELECT tag_name FROM note_tags WHERE note_id = NEW.note_id AND tag_name IS NOT NEW.tag_name UNION SELECT OLD.tag_name WHERE OLD.note_id = NEW.note_id ORDER BY 1))`, null)}
END;

CREATE TRIGGER IF NOT EXISTS rc_links_insert AFTER INSERT ON links BEGIN
  ${childTouch("NEW.source_id", TAGS_OF("NEW.source_id"), LINKS_OF("NEW.source_id", " AND NOT (target_id = NEW.target_id AND relationship = NEW.relationship)"))}
END;

CREATE TRIGGER IF NOT EXISTS rc_links_delete AFTER DELETE ON links BEGIN
  ${childTouch("OLD.source_id", TAGS_OF("OLD.source_id"), `(SELECT json_group_array(${LINK_JSON}) FROM (SELECT target_id, relationship, metadata FROM links WHERE source_id = OLD.source_id UNION ALL SELECT OLD.target_id, OLD.relationship, OLD.metadata ORDER BY 1, 2))`)}
END;

CREATE TRIGGER IF NOT EXISTS rc_links_update AFTER UPDATE ON links
WHEN OLD.target_id IS NOT NEW.target_id OR OLD.relationship IS NOT NEW.relationship OR OLD.metadata IS NOT NEW.metadata OR OLD.source_id IS NOT NEW.source_id
BEGIN
  ${childTouch("NEW.source_id", TAGS_OF("NEW.source_id"), `(SELECT json_group_array(${LINK_JSON}) FROM (SELECT target_id, relationship, metadata FROM links WHERE source_id = NEW.source_id AND NOT (target_id = NEW.target_id AND relationship = NEW.relationship) UNION ALL SELECT OLD.target_id, OLD.relationship, OLD.metadata WHERE OLD.source_id = NEW.source_id ORDER BY 1, 2))`)}
END;
`;

/** The triggers this file creates, by name: the un-numbered step's check looks for every one. */
export const CHANGE_LOG_TRIGGERS = [
  "rc_notes_insert",
  "rc_notes_update",
  "rc_notes_delete",
  "rc_note_tags_insert",
  "rc_note_tags_delete",
  "rc_note_tags_update",
  "rc_links_insert",
  "rc_links_delete",
  "rc_links_update",
] as const;

/** Whether the change log's tables and triggers are all present. */
export function changeLogPresent(db: Database): boolean {
  const names = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger') AND (name IN ('write_context', 'write_sets', 'record_changes', 'record_change_bodies', 'record_change_bases', 'change_log_state') OR name LIKE 'rc\\_%' ESCAPE '\\')").all() as { name: string }[]).map((r) => r.name),
  );
  return ["write_context", "write_sets", "record_changes", "record_change_bodies", "record_change_bases", "change_log_state", ...CHANGE_LOG_TRIGGERS].every((n) => names.has(n))
    && hasBeforeBase(db);
}

function hasBeforeBase(db: Database): boolean {
  return !!db.prepare("SELECT 1 FROM pragma_table_info('record_changes') WHERE name = 'before_base'").get();
}

/** The un-numbered step: creates the change log on a vault that lacks it (no-op otherwise). */
export function ensureChangeLog(db: Database): void {
  if (changeLogPresent(db)) return;
  // A log made by an earlier 0.9.4 build has no before_base (CREATE TABLE IF NOT EXISTS would leave its table as it
  // is). The column goes first, and changeLogPresent checks it, so a step cut short is redone at the next open.
  const hasLog = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'record_changes'").get();
  if (hasLog && !hasBeforeBase(db)) db.exec("ALTER TABLE record_changes ADD COLUMN before_base INTEGER");
  db.exec(CHANGE_LOG_SQL);
}

/** What one write says about itself. */
export interface WriteSetContext {
  /** The set's id. Supplied by the request edge; a fresh one is made per Store transaction when absent. */
  id?: string;
  actor?: string | null;
  via?: string | null;
  why?: string | null;
  /** The set this one undoes (undo only). */
  undoes?: string | null;
  /** False for bulk operator work (a blow-away import): the log keeps which records changed, not their bodies. */
  keepBefore?: boolean;
}

/** A new write set id: `ws_` and 20 base-32 characters. */
export function newWriteSetId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let out = "ws_";
  for (const b of bytes) out += alphabet[b & 31];
  return out;
}

/** A client-supplied write set id is short and plain. */
export const WRITE_SET_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const statements = new WeakMap<Database, Map<string, ReturnType<Database["prepare"]>>>();
/** A prepared statement kept per connection: these run in every Store transaction. */
function cached(db: Database, sql: string): ReturnType<Database["prepare"]> {
  let m = statements.get(db);
  if (!m) statements.set(db, (m = new Map()));
  let st = m.get(sql);
  if (!st) m.set(sql, (st = db.prepare(sql)));
  return st;
}

/** Sets the context row the triggers read; returns the id used. */
export function setWriteContext(db: Database, ctx: WriteSetContext): string {
  const id = ctx.id ?? newWriteSetId();
  const via = ctx.via ?? null;
  cached(
    db,
    `INSERT INTO write_context (slot, write_set, actor, via, via_kind, why, undoes, keep_before, txn) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (slot) DO UPDATE SET write_set = excluded.write_set, actor = excluded.actor, via = excluded.via,
       via_kind = excluded.via_kind, why = excluded.why, undoes = excluded.undoes, keep_before = excluded.keep_before,
       txn = excluded.txn`,
  ).run(id, ctx.actor ?? null, via, kindOfVia(via), ctx.why ?? null, ctx.undoes ?? null, ctx.keepBefore === false ? 0 : 1, newWriteSetId().slice(3, 15));
  return id;
}

/**
 * Ends the context: records the write set itself when it changed a record (once; a set spanning several
 * transactions keeps its first time), then clears the row so a later write outside any context isn't counted in.
 */
export function clearWriteContext(db: Database, recordSet = true): void {
  if (recordSet) cached(
    db,
    `INSERT OR IGNORE INTO write_sets (id, at, actor, via, via_kind, why, undoes)
     SELECT c.write_set, (SELECT MIN(at) FROM record_changes WHERE write_set = c.write_set), c.actor, c.via, c.via_kind, c.why, c.undoes
     FROM write_context c WHERE c.slot = 1 AND c.write_set IS NOT NULL AND EXISTS (SELECT 1 FROM record_changes WHERE write_set = c.write_set)`,
  ).run();
  cached(db, "DELETE FROM write_context WHERE slot = 1").run();
}

/** Snapshots shorter than this stay text: deflate's own framing would eat most of the saving (as for version bodies). */
export const SNAPSHOT_COMPRESS_MIN_BYTES = 128;
/** A delta is kept while it is under this share of the snapshot's own deflate; past it, the snapshot becomes a base. */
const DELTA_MAX_SHARE = 0.25;
/** Rows stored against one base at most: what the sweep may have to re-encode when it drops the base's first row. */
const BASE_MAX_USES = 16;
/** A guard against a corrupt stream, far above any real snapshot (a record's fields, path and stamps; its links). */
const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
const utf8 = new TextEncoder();

/** A snapshot as stored whole: its deflate as bytes when that is shorter, else the text itself. */
export function encodeSnapshot(text: string): string | Uint8Array {
  const bytes = utf8.encode(text);
  if (bytes.length < SNAPSHOT_COMPRESS_MIN_BYTES) return text;
  const z = deflateBytes(bytes);
  return z.length < bytes.length ? z : text;
}

/** A whole stored snapshot's JSON text: TEXT as it is, a BLOB inflated. Throws BlobDecodeError on a bad stream. */
export function snapshotText(stored: StoredContent | null): string | null {
  if (stored === null || typeof stored === "string") return stored;
  return wholeText(stored, "deflate", SNAPSHOT_MAX_BYTES);
}

/**
 * A row's `before_row` as the JSON text the trigger wrote: whole, or its delta applied to its base. Throws
 * BlobDecodeError when the base is gone or the delta doesn't apply (never a wrong snapshot: Fossil deltas carry a
 * checksum).
 */
export function rowSnapshotText(db: Database, stored: StoredContent | null, base: number | null, bases?: Map<number, string>): string | null {
  // TEXT is always the snapshot itself (the trigger's own, or an earlier build's row).
  if (base === null || stored === null || typeof stored === "string") return snapshotText(stored);
  // `bases` keeps each base's text for the length of one call that reads many rows (a set, a sweep).
  let baseText = bases?.get(base);
  if (baseText === undefined) {
    const row = cached(db, "SELECT content FROM record_change_bases WHERE id = ?").get(base) as { content: StoredContent } | null;
    if (!row) throw new BlobDecodeError(`a change-log snapshot's base ${base} is gone`);
    baseText = snapshotText(row.content)!;
    bases?.set(base, baseText);
  }
  try {
    return applyDeltaBytes(baseText, inflateBytes(stored, SNAPSHOT_MAX_BYTES), SNAPSHOT_MAX_BYTES);
  } catch (err) {
    if (err instanceof BlobDecodeError) throw err;
    throw new BlobDecodeError(`a change-log snapshot's delta doesn't apply: ${(err as Error).message}`);
  }
}

/**
 * Stores one row's `before_row` text compressed: a delta against the base its record's nearest earlier compressed row
 * names, or, when there is none or the delta isn't small, against a new base made of this text (a delta of nothing, a
 * few bytes, so every compressed row reads the same way). A new base's text is always a row's own snapshot, so no base
 * holds anything older than the oldest row naming it.
 */
function storeRowSnapshot(db: Database, seq: number, noteId: string, text: string, links: string | Uint8Array | null): void {
  const update = cached(db, "UPDATE record_changes SET before_row = ?, before_links = ?, before_base = ? WHERE seq = ?");
  const whole = encodeSnapshot(text);
  const wholeSize = typeof whole === "string" ? utf8.encode(whole).length : whole.length;
  const prior = cached(
    db,
    `SELECT b.id, b.content, b.uses FROM record_change_bases b
     WHERE b.id = (SELECT before_base FROM record_changes WHERE note_id = ? AND seq < ? AND before_base IS NOT NULL ORDER BY seq DESC LIMIT 1)`,
  ).get(noteId, seq) as { id: number; content: StoredContent; uses: number } | null;
  if (prior && prior.uses < BASE_MAX_USES) {
    const delta = deflateBytes(createDeltaBytes(snapshotText(prior.content)!, text));
    if (delta.length < wholeSize * DELTA_MAX_SHARE) {
      update.run(delta, links, prior.id, seq);
      cached(db, "UPDATE record_change_bases SET uses = uses + 1 WHERE id = ?").run(prior.id);
      return;
    }
  }
  const id = Number(cached(db, "INSERT INTO record_change_bases (note_id, content) VALUES (?, ?)").run(noteId, whole).lastInsertRowid);
  update.run(deflateBytes(createDeltaBytes(text, text)), links, id, seq);
}

const asBytes = (v: StoredContent | null): string | Uint8Array | null => (v instanceof ArrayBuffer ? new Uint8Array(v) : v);

/**
 * Compresses the field snapshots of the rows still to be placed (the open transaction's), in seq order. Runs before
 * they're placed, inside the same transaction, while the rows sit at the table's end: a row that shrinks there leaves
 * its room to the next rows written, not a hole in a page already full.
 */
function compressTouchedSnapshots(db: Database): void {
  const rows = cached(
    db,
    `SELECT seq, note_id, before_row, before_base, before_links FROM record_changes WHERE touched = 1
       AND ((typeof(before_row) = 'text' AND length(CAST(before_row AS BLOB)) >= ${SNAPSHOT_COMPRESS_MIN_BYTES})
         OR (typeof(before_links) = 'text' AND length(CAST(before_links AS BLOB)) >= ${SNAPSHOT_COMPRESS_MIN_BYTES}))
     ORDER BY seq`,
  ).all() as { seq: number; note_id: string; before_row: StoredContent | null; before_base: number | null; before_links: StoredContent | null }[];
  if (!rows.length) return;
  for (const r of rows) {
    const links = typeof r.before_links === "string" ? encodeSnapshot(r.before_links) : asBytes(r.before_links);
    if (typeof r.before_row === "string" && utf8.encode(r.before_row).length >= SNAPSHOT_COMPRESS_MIN_BYTES) {
      storeRowSnapshot(db, r.seq, r.note_id, r.before_row, links);
    } else {
      // Fields short or already stored: left as they are, with the base they name (if any).
      cached(db, "UPDATE record_changes SET before_row = ?, before_links = ?, before_base = ? WHERE seq = ?").run(asBytes(r.before_row), links, r.before_base, r.seq);
    }
  }
}

/**
 * Gives every row a transaction touched the newest positions, in seq order (0.9.4): the feed's order, and what undo
 * compares. Runs at the end of each Store transaction (inside it), so positions follow commit order (one writer at a
 * time). Rows an older engine or a raw statement wrote (no Store transaction) get theirs at the next one; until then
 * they have no position, so a feed reader can't pass them by.
 */
export function settleChangeLogPositions(db: Database): void {
  const touched = (cached(db, "SELECT COUNT(*) AS n FROM record_changes WHERE touched = 1").get() as { n: number }).n;
  if (!touched) return;
  compressTouchedSnapshots(db);
  cached(
    db,
    `UPDATE record_changes SET position = s.newest + t.rn, touched = 0
     FROM (SELECT seq, ROW_NUMBER() OVER (ORDER BY seq) AS rn FROM record_changes WHERE touched = 1) AS t,
          (SELECT newest FROM change_log_state WHERE slot = 1) AS s
     WHERE record_changes.seq = t.seq`,
  ).run();
  cached(db, "UPDATE change_log_state SET newest = newest + ? WHERE slot = 1").run(touched);
}

/** The open transaction's write set and reason, if any (what a version captured now records). */
export function writeContextOf(db: Database): { write_set: string | null; why: string | null } {
  try {
    const row = cached(db, "SELECT write_set, why FROM write_context WHERE slot = 1").get() as { write_set: string | null; why: string | null } | null;
    return { write_set: row?.write_set ?? null, why: row?.why ?? null };
  } catch {
    return { write_set: null, why: null };
  }
}

/** The write set the open transaction writes under, if any. */
export function currentWriteSet(db: Database): string | null {
  try {
    const row = db.prepare("SELECT write_set FROM write_context WHERE slot = 1").get() as { write_set: string | null } | null;
    return row?.write_set ?? null;
  } catch {
    return null;
  }
}

export interface WriteSetRow {
  id: string;
  at: string;
  actor: string | null;
  via: string | null;
  via_kind: string | null;
  why: string | null;
  undoes: string | null;
}

export interface WriteSetSummary extends WriteSetRow {
  records: number;
  undone_by: string | null;
}

export function getWriteSet(db: Database, id: string): WriteSetRow | null {
  return (db.prepare("SELECT id, at, actor, via, via_kind, why, undoes FROM write_sets WHERE id = ?").get(id) as WriteSetRow | null) ?? null;
}

/** The sets that changed at least one record, newest first; `via` narrows to one credential. */
export function listWriteSets(
  db: Database,
  opts: { via?: string; limit?: number; before?: string; visible?: (setId: string) => boolean },
): WriteSetSummary[] {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  const where: string[] = ["EXISTS (SELECT 1 FROM record_changes rc WHERE rc.write_set = ws.id)"];
  const params: (string | number)[] = [];
  if (opts.via !== undefined) {
    where.push("ws.via = ?");
    params.push(opts.via);
  }
  if (opts.before !== undefined) {
    where.push("ws.at < ?");
    params.push(opts.before);
  }
  const out: WriteSetSummary[] = [];
  // A scoped reader skips sets it can't see whole: page until the limit is met or the log ends.
  let cursor: { at: string; id: string } | undefined;
  for (let page = 0; page < 50 && out.length < limit; page++) {
    // Keyset on (at, id): sets that share a millisecond are neither skipped nor repeated across pages.
    const pageWhere = cursor === undefined ? where : [...where, "(ws.at < ? OR (ws.at = ? AND ws.id < ?))"];
    const pageParams = cursor === undefined ? params : [...params, cursor.at, cursor.at, cursor.id];
    const rows = db
      .prepare(
        `SELECT ws.id, ws.at, ws.actor, ws.via, ws.via_kind, ws.why, ws.undoes,
          (SELECT COUNT(*) FROM (SELECT rc.note_id FROM record_changes rc WHERE rc.write_set = ws.id GROUP BY rc.note_id
             HAVING NOT (MIN(rc.seq) IS MIN(CASE WHEN rc.existed = 0 THEN rc.seq END)
               AND MAX(rc.seq) IS MAX(CASE WHEN rc.op = 'delete' THEN rc.seq END)))) AS records,
          (SELECT u.id FROM write_sets u WHERE u.undoes = ws.id ORDER BY u.at DESC LIMIT 1) AS undone_by
         FROM write_sets ws WHERE ${pageWhere.join(" AND ")} ORDER BY ws.at DESC, ws.id DESC LIMIT ?`,
      )
      .all(...pageParams, limit) as WriteSetSummary[];
    if (!rows.length) break;
    for (const r of rows) {
      if (out.length >= limit) break;
      if (opts.visible && !opts.visible(r.id)) continue;
      out.push(r);
    }
    if (rows.length < limit) break;
    cursor = { at: rows[rows.length - 1]!.at, id: rows[rows.length - 1]!.id };
  }
  return out;
}

export function writeSetRecordIds(db: Database, id: string): string[] {
  return (db.prepare("SELECT note_id FROM record_changes WHERE write_set = ? ORDER BY seq").all(id) as { note_id: string }[]).map((r) => r.note_id);
}

export interface WriteSetRecord {
  id: string;
  op: "create" | "update" | "delete";
  seq: number;
  /** The record's tags when the set first touched it (null for a record the set created). */
  tags_before: string[] | null;
}

/**
 * What one set did to one record, from its rows (one per transaction of the set that touched the record, in seq
 * order): whether it existed when the set first touched it, the last op, and the set's "before" — for each part, the
 * first row that saved it (a later row's snapshot is the record as that transaction found it, which for a part the
 * set hadn't changed yet is still the "before").
 */
export interface SetRecordState {
  note_id: string;
  first_seq: number;
  last_seq: number;
  /** The newest position among the set's rows for this record (null while one isn't placed yet). */
  last_position: number | null;
  existed: number;
  op: "create" | "update" | "delete";
  content_saved: number;
  before_hash: string | null;
  before_row: string | null;
  before_tags: string | null;
  before_links: string | null;
}

export function setRecordStates(db: Database, setId: string): SetRecordState[] {
  const rows = db
    .prepare("SELECT seq, position, note_id, op, existed, content_saved, before_hash, before_row, before_base, before_tags, before_links FROM record_changes WHERE write_set = ? ORDER BY seq")
    .all(setId) as { seq: number; position: number | null; note_id: string; op: SetRecordState["op"]; existed: number; content_saved: number; before_hash: string | null; before_row: StoredContent | null; before_base: number | null; before_tags: string | null; before_links: StoredContent | null }[];
  const by = new Map<string, SetRecordState>();
  const bases = new Map<number, string>();
  // A record whose snapshot can't be read (a damaged row): no later row's snapshot may stand in for it, since that is
  // the record part-way through the set. Its fields (or links) read as not kept: undo leaves them as they are.
  const lostRow = new Set<string>();
  const lostLinks = new Set<string>();
  const decode = (lost: Set<string>, noteId: string, read: () => string | null): string | null => {
    if (lost.has(noteId)) return null;
    try {
      return read();
    } catch (err) {
      if (!(err instanceof BlobDecodeError)) throw err;
      console.warn(`[vault] change log: a snapshot of ${noteId} in write set ${setId} can't be read (${err.message}); read as not kept`);
      lost.add(noteId);
      return null;
    }
  };
  for (const stored of rows) {
    // Snapshots may be stored compressed: read back as the JSON text the triggers wrote.
    const r = {
      ...stored,
      before_row: decode(lostRow, stored.note_id, () => rowSnapshotText(db, stored.before_row, stored.before_base, bases)),
      before_links: decode(lostLinks, stored.note_id, () => snapshotText(stored.before_links)),
    };
    const cur = by.get(r.note_id);
    if (!cur) {
      by.set(r.note_id, {
        note_id: r.note_id, first_seq: r.seq, last_seq: r.seq, last_position: r.position, existed: r.existed, op: r.op,
        content_saved: r.content_saved, before_hash: r.content_saved ? r.before_hash : null,
        before_row: r.before_row, before_tags: r.before_tags, before_links: r.before_links,
      });
      continue;
    }
    cur.last_seq = r.seq;
    cur.last_position = cur.last_position === null || r.position === null ? null : Math.max(cur.last_position, r.position);
    // The op across the set: a record it found missing and left standing was created; one it found standing and left
    // standing (even deleted and made again in between) was updated; one it left gone was deleted.
    cur.op = r.op === "delete" ? "delete" : cur.existed === 0 ? "create" : "update";
    if (!cur.content_saved && r.content_saved) {
      cur.content_saved = 1;
      cur.before_hash = r.before_hash;
    }
    cur.before_row ??= r.before_row;
    cur.before_tags ??= r.before_tags;
    cur.before_links ??= r.before_links;
  }
  return [...by.values()];
}

/** The records one set changed, in the order it first touched them. A record created and deleted in the set is left out. */
export function writeSetRecords(db: Database, id: string): WriteSetRecord[] {
  return setRecordStates(db, id)
    .filter((r) => !(r.op === "delete" && r.existed === 0))
    .map((r) => ({ id: r.note_id, op: r.op, seq: r.first_seq, tags_before: r.before_tags ? (JSON.parse(r.before_tags) as string[]) : null }));
}

/** Drops log rows older than `days` (and sets left with no rows). Returns the rows dropped. Call inside a transaction. */
export function pruneChangeLog(db: Database, days: number, now = new Date()): { changes: number; sets: number; hashes: string[] } {
  if (!changeLogPresent(db)) return { changes: 0, sets: 0, hashes: [] };
  // Place rows still waiting for a position first (an older engine's writes), so none is dropped below the horizon
  // unseen by a feed reader.
  settleChangeLogPositions(db);
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  // seq follows time (one writer at a time), so the rows past the horizon are a prefix of seq: found from the newest
  // end, with no index on at.
  const last = db.prepare("SELECT seq FROM record_changes WHERE at < ? ORDER BY seq DESC LIMIT 1").get(cutoff) as { seq: number } | null;
  // The bodies these rows held: the caller frees each blob nobody else holds (history.ts dropBlobsIfUnheld).
  const hashes = last
    ? (db.prepare("SELECT DISTINCT before_hash FROM record_changes WHERE seq <= ? AND before_hash IS NOT NULL").all(last.seq) as { before_hash: string }[]).map((r) => r.before_hash)
    : [];
  // The feed's horizon: the highest position dropped, kept in the same step (a row's position can be above its seq's
  // neighbours': its set touched the record again later, so it is the largest of the prefix's).
  if (last) db.prepare("UPDATE change_log_state SET horizon = MAX(horizon, COALESCE((SELECT MAX(position) FROM record_changes WHERE seq <= ?), 0)) WHERE slot = 1").run(last.seq);
  // The bases the rows going name: none may outlive them with what it holds (below).
  const swept = last
    ? (db.prepare("SELECT DISTINCT note_id, before_base FROM record_changes WHERE seq <= ? AND before_base IS NOT NULL").all(last.seq) as { note_id: string; before_base: number }[])
    : [];
  const changes = last ? db.prepare("DELETE FROM record_changes WHERE seq <= ?").run(last.seq).changes : 0;
  sweepBases(db, swept);
  const sets = db.prepare("DELETE FROM write_sets WHERE at < ? AND NOT EXISTS (SELECT 1 FROM record_changes rc WHERE rc.write_set = write_sets.id)").run(cutoff).changes;
  return { changes, sets, hashes };
}

/**
 * Forgets what the log kept of one record's past (erase history, forget): its bodies, fields, path and links. The
 * rows stay, with the tags they had, so the feed still reports the change to the readers who could see it. Returns
 * the blobs the rows held, for the caller to free.
 */
export function forgetLoggedPast(db: Database, noteId: string): string[] {
  if (!changeLogPresent(db)) return [];
  const hashes = (db.prepare("SELECT DISTINCT before_hash FROM record_changes WHERE note_id = ? AND before_hash IS NOT NULL").all(noteId) as { before_hash: string }[]).map((r) => r.before_hash);
  // content_saved stays as it is: a later transaction of the same set must not save an in-between body in its place.
  db.prepare("UPDATE record_changes SET before_hash = NULL, before_row = NULL, before_base = NULL, before_links = NULL WHERE note_id = ?").run(noteId);
  db.prepare("DELETE FROM record_change_bodies WHERE note_id = ?").run(noteId);
  // The record's whole snapshots go with the rest of its past.
  db.prepare("DELETE FROM record_change_bases WHERE note_id = ?").run(noteId);
  return hashes;
}

/**
 * After the sweep: a base a dropped row named holds a snapshot from past the horizon (a base is made of the first row
 * naming it). Where remaining rows still name it, they're re-encoded, in seq order, against bases made of their own
 * snapshots; then every base of these records that no remaining row names is freed. Each re-encoded row reads back the
 * same text. A row names only a base of its own record, so the work is per record (idx_record_changes_note), and at
 * most BASE_MAX_USES rows a stale base. Call inside a transaction (pruneChangeLog's caller's): between letting go of a
 * base and storing its rows again, they don't read.
 */
function sweepBases(db: Database, swept: { note_id: string; before_base: number }[]): void {
  if (!swept.length) return;
  const byNote = new Map<string, Set<number>>();
  for (const r of swept) (byNote.get(r.note_id) ?? byNote.set(r.note_id, new Set()).get(r.note_id)!).add(r.before_base);
  const naming = db.prepare("SELECT seq, before_row, before_base, before_links FROM record_changes WHERE note_id = ? AND before_base IS NOT NULL ORDER BY seq");
  const clear = db.prepare("UPDATE record_changes SET before_base = NULL WHERE seq = ?");
  const free = db.prepare(
    "DELETE FROM record_change_bases WHERE note_id = ? AND id NOT IN (SELECT before_base FROM record_changes WHERE note_id = ? AND before_base IS NOT NULL)",
  );
  for (const [noteId, stale] of byNote) {
    const rows = (naming.all(noteId) as { seq: number; before_row: StoredContent; before_base: number; before_links: StoredContent | null }[])
      .filter((r) => stale.has(r.before_base));
    // Read every text first (their bases are still there), then let go of the stale bases, then store them again.
    let texts: { seq: number; text: string; links: string | Uint8Array | null }[];
    try {
      const bases = new Map<number, string>();
      texts = rows.map((r) => ({ seq: r.seq, text: rowSnapshotText(db, r.before_row, r.before_base, bases)!, links: asBytes(r.before_links) }));
    } catch (err) {
      if (!(err instanceof BlobDecodeError)) throw err;
      // A damaged row: this record is left as it is (its stale base stays), so the rest of the sweep still runs.
      console.warn(`[vault] change log: the sweep can't re-encode ${noteId}'s snapshots (${err.message}); left as they are`);
      continue;
    }
    for (const r of texts) clear.run(r.seq);
    for (const r of texts) storeRowSnapshot(db, r.seq, noteId, r.text, r.links);
    free.run(noteId, noteId);
  }
}

/** Normalises a `why`: trimmed, at most WHY_MAX_CHARS characters, null when empty. Throws on a non-string. */
export function normaliseWhy(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw Object.assign(new Error("`why` must be a string: a short reason for this write."), { field: "why", error_type: "invalid_why" });
  const t = raw.trim();
  if (!t) return null;
  if ([...t].length > WHY_MAX_CHARS) {
    throw Object.assign(new Error(`\`why\` is at most ${WHY_MAX_CHARS} characters; this one is ${[...t].length}. Nothing was written.`), { field: "why", error_type: "invalid_why" });
  }
  return t;
}
