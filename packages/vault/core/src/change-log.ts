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
 */
import type { Database } from "bun:sqlite";
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
 * A first touch from a tag or link row. The note row is unchanged so far in this set, so it is read as it is; the
 * tag or link list is today's with this one change undone. A later touch in the same set is ignored (the first
 * snapshot stands). With no context the row's write set is NULL, which never conflicts: one row per change.
 */
function childTouch(noteId: string, tagsBefore: string, linksBefore: string): string {
  return `INSERT OR IGNORE INTO record_changes (write_set, note_id, op, existed, at, before_row, before_tags, before_links)
    SELECT c.write_set, n.id, 'update', 1, ${NOW}, ${rowJson("n")}, ${tagsBefore}, ${linksBefore}
    FROM notes n LEFT JOIN write_context c ON c.slot = 1 WHERE n.id = ${noteId};`;
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
  keep_before INTEGER NOT NULL DEFAULT 1
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
  before_content TEXT,
  content_saved INTEGER NOT NULL DEFAULT 0,
  before_row TEXT,
  before_tags TEXT,
  before_links TEXT,
  UNIQUE (write_set, note_id)
);
CREATE INDEX IF NOT EXISTS idx_record_changes_note ON record_changes(note_id, seq);

CREATE TRIGGER IF NOT EXISTS rc_notes_insert AFTER INSERT ON notes BEGIN
  INSERT INTO record_changes (write_set, note_id, op, existed, at)
  SELECT c.write_set, NEW.id, 'create', 0, ${NOW} FROM ${CTX} WHERE true
  ON CONFLICT (write_set, note_id) DO UPDATE SET op = CASE WHEN existed = 1 THEN 'update' ELSE 'create' END;
END;

CREATE TRIGGER IF NOT EXISTS rc_notes_update BEFORE UPDATE ON notes
WHEN OLD.content IS NOT NEW.content OR OLD.metadata IS NOT NEW.metadata OR OLD.path IS NOT NEW.path
  OR OLD.extension IS NOT NEW.extension OR OLD.updated_at IS NOT NEW.updated_at OR OLD.created_at IS NOT NEW.created_at
BEGIN
  INSERT INTO record_changes (write_set, note_id, op, existed, at, before_content, content_saved, before_row, before_tags, before_links)
  SELECT c.write_set, OLD.id, 'update', 1, ${NOW},
    CASE WHEN OLD.content IS NOT NEW.content AND ${KEEP} THEN OLD.content END,
    OLD.content IS NOT NEW.content AND ${KEEP},
    ${rowJson("OLD")}, ${TAGS_OF("OLD.id")}, ${LINKS_OF("OLD.id")}
  FROM ${CTX} WHERE true
  ON CONFLICT (write_set, note_id) DO UPDATE SET
    before_content = CASE WHEN existed = 1 AND content_saved = 0 THEN excluded.before_content ELSE before_content END,
    content_saved = CASE WHEN existed = 1 AND content_saved = 0 THEN excluded.content_saved ELSE content_saved END;
END;

CREATE TRIGGER IF NOT EXISTS rc_notes_delete BEFORE DELETE ON notes BEGIN
  INSERT INTO record_changes (write_set, note_id, op, existed, at, before_content, content_saved, before_row, before_tags, before_links)
  SELECT c.write_set, OLD.id, 'delete', 1, ${NOW},
    CASE WHEN ${KEEP} THEN OLD.content END, ${KEEP},
    ${rowJson("OLD")}, ${TAGS_OF("OLD.id")}, ${LINKS_OF("OLD.id")}
  FROM ${CTX} WHERE true
  ON CONFLICT (write_set, note_id) DO UPDATE SET op = 'delete',
    before_content = CASE WHEN existed = 1 AND content_saved = 0 THEN excluded.before_content ELSE before_content END,
    content_saved = CASE WHEN existed = 1 AND content_saved = 0 THEN excluded.content_saved ELSE content_saved END;
END;

CREATE TRIGGER IF NOT EXISTS rc_note_tags_insert AFTER INSERT ON note_tags BEGIN
  ${childTouch("NEW.note_id", TAGS_OF("NEW.note_id", " AND tag_name IS NOT NEW.tag_name"), LINKS_OF("NEW.note_id"))}
END;

CREATE TRIGGER IF NOT EXISTS rc_note_tags_delete AFTER DELETE ON note_tags BEGIN
  ${childTouch("OLD.note_id", `(SELECT json_group_array(tag_name) FROM (SELECT tag_name FROM note_tags WHERE note_id = OLD.note_id UNION SELECT OLD.tag_name ORDER BY 1))`, LINKS_OF("OLD.note_id"))}
END;

CREATE TRIGGER IF NOT EXISTS rc_note_tags_update AFTER UPDATE ON note_tags
WHEN OLD.note_id IS NOT NEW.note_id OR OLD.tag_name IS NOT NEW.tag_name
BEGIN
  ${childTouch("NEW.note_id", `(SELECT json_group_array(tag_name) FROM (SELECT tag_name FROM note_tags WHERE note_id = NEW.note_id AND tag_name IS NOT NEW.tag_name UNION SELECT OLD.tag_name WHERE OLD.note_id = NEW.note_id ORDER BY 1))`, LINKS_OF("NEW.note_id"))}
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
    (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger') AND (name IN ('write_context', 'write_sets', 'record_changes') OR name LIKE 'rc\\_%' ESCAPE '\\')").all() as { name: string }[]).map((r) => r.name),
  );
  return ["write_context", "write_sets", "record_changes", ...CHANGE_LOG_TRIGGERS].every((n) => names.has(n));
}

/** The un-numbered step: creates the change log on a vault that lacks it (no-op otherwise). */
export function ensureChangeLog(db: Database): void {
  if (changeLogPresent(db)) return;
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
    `INSERT INTO write_context (slot, write_set, actor, via, via_kind, why, undoes, keep_before) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (slot) DO UPDATE SET write_set = excluded.write_set, actor = excluded.actor, via = excluded.via,
       via_kind = excluded.via_kind, why = excluded.why, undoes = excluded.undoes, keep_before = excluded.keep_before`,
  ).run(id, ctx.actor ?? null, via, kindOfVia(via), ctx.why ?? null, ctx.undoes ?? null, ctx.keepBefore === false ? 0 : 1);
  return id;
}

/**
 * Ends the context: records the write set itself when it changed a record (once; a set spanning several
 * transactions keeps its first time), then clears the row so a later write outside any context isn't counted in.
 */
export function clearWriteContext(db: Database): void {
  cached(
    db,
    `INSERT OR IGNORE INTO write_sets (id, at, actor, via, via_kind, why, undoes)
     SELECT c.write_set, (SELECT MIN(at) FROM record_changes WHERE write_set = c.write_set), c.actor, c.via, c.via_kind, c.why, c.undoes
     FROM write_context c WHERE c.slot = 1 AND c.write_set IS NOT NULL AND EXISTS (SELECT 1 FROM record_changes WHERE write_set = c.write_set)`,
  ).run();
  cached(db, "DELETE FROM write_context WHERE slot = 1").run();
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
  let cursor: string | undefined;
  for (let page = 0; page < 50 && out.length < limit; page++) {
    const pageWhere = cursor === undefined ? where : [...where, "ws.at < ?"];
    const pageParams = cursor === undefined ? params : [...params, cursor];
    const rows = db
      .prepare(
        `SELECT ws.id, ws.at, ws.actor, ws.via, ws.via_kind, ws.why, ws.undoes,
          (SELECT COUNT(*) FROM record_changes rc WHERE rc.write_set = ws.id) AS records,
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
    cursor = rows[rows.length - 1]!.at;
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

/** The records one set changed, in the order it first touched them. A record created and deleted in the set is left out. */
export function writeSetRecords(db: Database, id: string): WriteSetRecord[] {
  const rows = db
    .prepare("SELECT note_id, op, existed, seq, before_tags FROM record_changes WHERE write_set = ? ORDER BY seq")
    .all(id) as { note_id: string; op: WriteSetRecord["op"]; existed: number; seq: number; before_tags: string | null }[];
  return rows
    .filter((r) => !(r.op === "delete" && r.existed === 0))
    .map((r) => ({ id: r.note_id, op: r.op, seq: r.seq, tags_before: r.before_tags ? (JSON.parse(r.before_tags) as string[]) : null }));
}

/** Drops log rows older than `days` (and sets left with no rows). Returns the rows dropped. */
export function pruneChangeLog(db: Database, days: number, now = new Date()): { changes: number; sets: number } {
  if (!changeLogPresent(db)) return { changes: 0, sets: 0 };
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  // seq follows time (one writer at a time), so the rows past the horizon are a prefix of seq: found from the newest
  // end, with no index on at.
  const last = db.prepare("SELECT seq FROM record_changes WHERE at < ? ORDER BY seq DESC LIMIT 1").get(cutoff) as { seq: number } | null;
  const changes = last ? db.prepare("DELETE FROM record_changes WHERE seq <= ?").run(last.seq).changes : 0;
  const sets = db.prepare("DELETE FROM write_sets WHERE at < ? AND NOT EXISTS (SELECT 1 FROM record_changes rc WHERE rc.write_set = write_sets.id)").run(cutoff).changes;
  return { changes, sets };
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
