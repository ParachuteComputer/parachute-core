/**
 * Note history stores prior note-row states, inside the caller's write
 * transaction. captureVersion, appendRestoreMarker and pruneVersions open
 * no explicit transaction of their own. Live reads still use notes.content.
 * NULL content is recorded as an empty string; metadata bytes are preserved.
 *
 * Capture sites: Store.updateNote (including SQL append/prepend, transitions,
 * and skipUpdatedAt metadata writes), Store.deleteNote, cascadeRename, and
 * renameTag's content/path rewrites. Creates have no prior state. Schema
 * migrations, restoreNoteTimestamps, mergeTags' timestamp bump, deleteTag's
 * untagging, and blow-away deletion deliberately do not capture.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { applyDeltaBytes, createDeltaBytes, fromBase64 } from "./delta.js";
import { isWhole, isDelta, wholeText, deltaBytes, wholeSql, deflateBytes, BlobDecodeError, COMPRESS_MIN_BYTES, LEGACY_BLOB_SQL, type StoredContent } from "./blob-codec.js";
import { kindOfVia } from "./write-stamp.js";
import { transaction } from "./txn.js";
import { refreshCompactState } from "./history-compact-state.js";

export type HistoryOp =
  | "import"
  | "update"
  | "append"
  | "prepend"
  | "delete"
  | "restore"
  | "tag-rename"
  | "cascade-rename";
export interface HistoryPolicy {
  enabled: boolean;
  min_versions: number;
  max_versions: number;
  max_age_days: number;
  deleted_retention_days: number | null;
  compact_enabled: boolean;
  compact_ratio: number;
  compact_min_versions: number;
  compact_run_length: number;
  max_bytes_per_note: number | null;
  compact_budget_ms: number;
  compact_max_notes: number;
  /**
   * Burst collapse (T-460): an edit by the same writer through the same named key (actor and a `via` of `key:` or
   * `nostr:`) within this many seconds of the note's newest version captures nothing, so a burst of edits leaves one
   * version (the body from before the burst). 0 is off. Never applied to deletes, restores, renames, imports, writers
   * with no actor, or a shared channel (`api`, `mcp`, the operator, a legacy token).
   */
  burst_window_seconds: number;
}
export const DEFAULT_HISTORY_POLICY: HistoryPolicy = {
  enabled: true,
  min_versions: 20,
  max_versions: 100,
  max_age_days: 180,
  deleted_retention_days: null,
  compact_enabled: true,
  // T-460: always on. A note with two versions whose bodies add up to more than its live body is a candidate; the
  // pass compresses every blob and stores the rest of each run of 24 as a delta against its first.
  compact_ratio: 1,
  compact_min_versions: 2,
  compact_run_length: 24,
  max_bytes_per_note: 8_388_608,
  compact_budget_ms: 250,
  compact_max_notes: 50,
  burst_window_seconds: 900,
};
export function resolveHistoryPolicy(
  partial?: Partial<HistoryPolicy>,
): HistoryPolicy {
  const p = { ...DEFAULT_HISTORY_POLICY, ...partial };
  // The floor is the retention promise: clamp the ceiling up, never down.
  p.max_versions = Math.max(1, p.max_versions, p.min_versions);
  p.max_age_days = Math.min(p.max_age_days, 36500);
  if (p.deleted_retention_days !== null)
    p.deleted_retention_days = Math.min(p.deleted_retention_days, 36500);
  p.compact_ratio = Math.max(1, p.compact_ratio);
  p.compact_min_versions = Math.max(2, p.compact_min_versions);
  p.compact_run_length = Math.min(100, Math.max(2, p.compact_run_length));
  if (p.max_bytes_per_note !== null) p.max_bytes_per_note = Math.max(65_536, p.max_bytes_per_note);
  p.compact_budget_ms = Math.min(60_000, Math.max(0, p.compact_budget_ms));
  p.compact_max_notes = Math.min(10_000, Math.max(0, p.compact_max_notes));
  // An untyped caller may pass a string or null: "0" and null turn it off; anything unreadable keeps the default.
  const burst = p.burst_window_seconds === null ? 0 : Number(p.burst_window_seconds);
  p.burst_window_seconds = Number.isFinite(burst) ? Math.floor(Math.min(86_400, Math.max(0, burst))) : DEFAULT_HISTORY_POLICY.burst_window_seconds;
  return p;
}
export const VERSION_MAX_BYTES = 2_000_000;
export interface PriorNoteRow {
  id: string;
  content: string | null;
  path: string | null;
  metadata: string | null;
  extension: string | null;
  created_at: string | null;
}
export interface VersionRow {
  note_id: string;
  version_ix: number;
  content_hash: string | null;
  path: string | null;
  metadata: Record<string, unknown>;
  extension: string | null;
  created_at: string | null;
  superseded_at: string;
  actor: string | null;
  via: string | null;
  /** The kind of the key in `via` (person, agent, app, service), or null: the write stamp (write-stamp.ts). */
  via_kind: string | null;
  op: HistoryOp;
  content_len: number;
  encoding: string | null;
}
type RawVersionRow = Omit<VersionRow, "metadata"> & { metadata: string | null };
export class HistoryOverflowError extends Error {
  readonly code = "HISTORY_OVERFLOW";
  constructor(
    readonly note_id: string,
    readonly byte_size: number,
    readonly limit: number,
  ) {
    super(
      `Note history exceeds ${limit} bytes: "${note_id}" (${byte_size} bytes)`,
    );
    this.name = "HistoryOverflowError";
  }
}
export class HistoryUnrecoverableError extends Error {
  readonly error_type = "history_unrecoverable";
  readonly code = "HISTORY_UNRECOVERABLE";
  constructor(
    readonly note_id: string,
    readonly version_ix: number,
    readonly reason: "overflow" | "delta_orphan" = "overflow",
  ) {
    super(`Version content is unrecoverable: "${note_id}"@${version_ix}`);
    this.name = "HistoryUnrecoverableError";
  }
}
export class HistoryPreconditionRequiredError extends Error {
  readonly code = "PRECONDITION_REQUIRED";
  readonly error_type = "precondition_required";
  constructor(readonly note_id: string) {
    super("Restoring an existing note requires if_updated_at from the note you reviewed.");
  }
}

export class HistoryNotFoundError extends Error {
  code = "HISTORY_NOT_FOUND" as const;
  note_id: string;
  version_ix: number | null;
  constructor(noteId: string, versionIx: number | null) {
    super(
      versionIx === null
        ? `Note not found: "${noteId}"`
        : `Version not found: "${noteId}"@${versionIx}`,
    );
    this.name = "HistoryNotFoundError";
    this.note_id = noteId;
    this.version_ix = versionIx;
  }
}
export function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
/** A whole body as stored (T-460): deflated when that is smaller, else text. */
export function encodeWhole(text: string, size = byteLength(text)): { content: string | Uint8Array; byte_size: number; encoding: "deflate" | null } {
  if (size >= COMPRESS_MIN_BYTES) {
    const z = deflateBytes(new TextEncoder().encode(text));
    if (z.byteLength < size) return { content: z, byte_size: z.byteLength, encoding: "deflate" };
  }
  return { content: text, byte_size: size, encoding: null };
}
/** Store a whole body under its hash, unless the vault already holds that hash (in any encoding). */
export function insertWholeBlob(db: Database, hash: string, text: string, size = byteLength(text)): void {
  if (db.prepare("SELECT 1 FROM note_blobs WHERE hash = ?").get(hash)) return;
  const w = encodeWhole(text, size);
  db.prepare("INSERT OR IGNORE INTO note_blobs (hash, content, byte_size, encoding) VALUES (?, ?, ?, ?)").run(hash, w.content, w.byte_size, w.encoding);
}

const present = new WeakMap<Database, boolean>();
export function historyTablesPresent(db: Database): boolean {
  if (present.get(db)) return true;
  const exists = !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get("note_versions");
  if (exists) present.set(db, true);
  return exists;
}
export function readPriorNoteRow(
  db: Database,
  id: string,
): PriorNoteRow | null {
  return db
    .prepare(
      "SELECT id, content, path, metadata, extension, created_at FROM notes WHERE id = ?",
    )
    .get(id) as PriorNoteRow | null;
}
function nextIndex(db: Database, noteId: string): number {
  return (
    db
      .prepare(
        "SELECT COALESCE(MAX(version_ix), -1) + 1 AS ix FROM note_versions WHERE note_id = ? AND version_ix >= 0",
      )
      .get(noteId) as { ix: number }
  ).ix;
}
/**
 * `createNote` does no capture, so a note larger than `VERSION_MAX_BYTES` can exist in any vault (probe H counts them). Every later `updateNote` throws `HistoryOverflowError` **inside** `store.ts:635`'s transaction and rolls the write back — correct, loud, and exactly what CodexJi asked for. But change 9 puts `deleteNote`'s capture inside a transaction too, and if a delete threw the same way the note would be **permanently undeletable**: no update can shrink it, and the only escape (`captureHistory: false`) is exposed on no door. An un-updatable note is a nuisance; an un-deletable one is a trap. So a `delete` capture **always succeeds**: it writes the tombstone with `content_hash = NULL`, the real `content_len`, and `encoding = 'overflow'`. The note's *existence*, size, path, metadata and deletion time are recorded; its bytes are not, and were never recordable. **Updates still throw — unchanged.** (ClaudeJi ruling 6, 2026-09-14 20:35Z.)
 */
export function captureVersion(
  db: Database,
  prior: PriorNoteRow,
  opts: {
    actor: string | null;
    via: string | null;
    op: HistoryOp;
    policy: HistoryPolicy;
    /** The path and extension this write sets, when it sets them: a rename is never part of a burst. */
    next?: { path?: string | null; extension?: string | null };
  },
): void {
  if (!opts.policy.enabled) return;
  if (!historyTablesPresent(db)) return;
  const text = prior.content ?? "";
  const size = byteLength(text);
  if (size > VERSION_MAX_BYTES) {
    if (opts.op !== "delete")
      throw new HistoryOverflowError(prior.id, size, VERSION_MAX_BYTES);
    const ix = nextIndex(db, prior.id);
    db.prepare(
      `INSERT INTO note_versions (note_id, version_ix, content_hash, path, metadata, extension,
      superseded_at, actor, via, via_kind, op, content_len, encoding, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'delete', ?, 'overflow', ?)`,
    ).run(
      prior.id,
      ix,
      prior.path,
      prior.metadata,
      prior.extension,
      new Date().toISOString(),
      opts.actor,
      opts.via,
      kindOfVia(opts.via),
      size,
      prior.created_at,
    );
    pruneVersions(db, prior.id, opts.policy, Date.now(), false);
    return;
  }
  // After the size refusal, so an oversized body still fails the write.
  if (inBurst(db, prior, opts, Date.now())) return;
  const hash = hashContent(text);
  insertWholeBlob(db, hash, text, size);
  const ix = nextIndex(db, prior.id);
  db.prepare(
    `INSERT INTO note_versions (note_id, version_ix, content_hash, path, metadata, extension,
    superseded_at, actor, via, via_kind, op, content_len, encoding, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    prior.id,
    ix,
    hash,
    prior.path,
    prior.metadata,
    prior.extension,
    new Date().toISOString(),
    opts.actor,
    opts.via,
    kindOfVia(opts.via),
    opts.op,
    size,
    prior.created_at,
  );
  pruneVersions(db, prior.id, opts.policy, Date.now(), false);
}
const BURST_OPS: ReadonlySet<string> = new Set(["update", "append", "prepend"]);
/**
 * Whether a write stamp's `via` names one credential (write-stamp.ts): a named key (`key:<name>`) or a Nostr key
 * (`nostr:<pubkey>`). Other vias are a channel (`api`, `mcp`) or a class (`operator`, a legacy `token:<hash>`) that
 * several writers can share under one actor, so they never make a burst.
 */
function namesOneCredential(via: string | null): boolean {
  return via !== null && (via.startsWith("key:") || via.startsWith("nostr:"));
}
/**
 * Whether this capture is part of a burst and writes nothing (T-460). All must hold: a window is set; this write and
 * the note's newest version are both an update, append or prepend; both by the same non-null actor through the same
 * via, and that via names one credential (a named key or a Nostr key); this write keeps the path and extension, which the newest version also had; and the newest version was
 * captured no more than the window ago, and not in the future (a row from a clock ahead, a grafted box's say, never
 * starts a skip run). The newest row holds the body from before the burst, so a read "as of" a time inside the burst
 * is late by at most one burst.
 */
function inBurst(
  db: Database,
  prior: PriorNoteRow,
  opts: { actor: string | null; via: string | null; op: HistoryOp; policy: HistoryPolicy; next?: { path?: string | null; extension?: string | null } },
  now: number,
): boolean {
  const window = opts.policy.burst_window_seconds * 1000;
  if (!(window > 0) || opts.actor === null || !BURST_OPS.has(opts.op) || !namesOneCredential(opts.via)) return false;
  if (opts.next?.path !== undefined && opts.next.path !== prior.path) return false;
  if (opts.next?.extension !== undefined && opts.next.extension !== prior.extension) return false;
  const newest = db.prepare(
    "SELECT actor, via, op, path, extension, superseded_at FROM note_versions WHERE note_id = ? ORDER BY version_ix DESC LIMIT 1",
  ).get(prior.id) as { actor: string | null; via: string | null; op: string; path: string | null; extension: string | null; superseded_at: string } | null;
  if (!newest || newest.actor !== opts.actor || newest.via !== opts.via || !BURST_OPS.has(newest.op)) return false;
  if (newest.path !== prior.path || newest.extension !== prior.extension) return false;
  const age = now - Date.parse(newest.superseded_at);
  return age >= 0 && age <= window;
}
export function appendRestoreMarker(
  db: Database,
  noteId: string,
  tombstone: VersionRow,
  attr: { actor: string | null; via: string | null },
  policy: HistoryPolicy,
): void {
  // Copy in SQL so the raw metadata TEXT is not parsed and re-serialized.
  const ix = nextIndex(db, noteId);
  db.prepare(
    `INSERT INTO note_versions (note_id, version_ix, content_hash, path, metadata, extension,
    superseded_at, actor, via, via_kind, op, content_len, encoding, created_at)
    SELECT note_id, ?, content_hash, path, metadata, extension, ?, ?, ?, ?, 'restore', content_len, encoding, created_at
      FROM note_versions WHERE note_id = ? AND version_ix = ?`,
  ).run(
    ix,
    new Date().toISOString(),
    attr.actor,
    attr.via,
    kindOfVia(attr.via),
    noteId,
    tombstone.version_ix,
  );
  pruneVersions(db, noteId, policy, Date.now(), false);
}
export function pruneVersions(
  db: Database,
  noteId: string,
  policy: HistoryPolicy,
  now = Date.now(),
  refresh = true,
): { versionsDeleted: number; blobsDeleted: number } {
  const rows = db
    .prepare(
      `SELECT version_ix, superseded_at, op, content_hash, ${markedSql(db)} AS marked FROM note_versions WHERE note_id = ? ORDER BY version_ix DESC`,
    )
    .all(noteId) as (Pick<
    VersionRow,
    "version_ix" | "superseded_at" | "op" | "content_hash"
  > & { marked: number })[];
  const cutoff = new Date(
    now - policy.max_age_days * 86_400_000,
  ).toISOString();
  const doomed = rows.filter(
    (r, i) =>
      i >= policy.min_versions &&
      r.op !== "delete" &&
      !r.marked &&
      (i >= policy.max_versions || r.superseded_at < cutoff),
  );
  let versionsDeleted = 0,
    blobsDeleted = 0;
  for (const r of doomed)
    versionsDeleted += db
      .prepare("DELETE FROM note_versions WHERE note_id = ? AND version_ix = ?")
      .run(noteId, r.version_ix).changes;
  for (const hash of new Set(
    doomed.map((r) => r.content_hash).filter((h) => h !== null),
  ))
    blobsDeleted += dropUnusedBlob(db, hash);
  if (refresh) refreshCompactState(db, noteId);
  return { versionsDeleted, blobsDeleted };
}
/**
 * Delete a blob no version holds and no delta rests on; when it was a delta, then try its base the same way (T-460).
 * A base whose own version was pruned while deltas still rested on it would otherwise stay for good: with compaction
 * always on, every hot note left one behind per run. Counted by looking, not by `.changes` (see eraseNoteVersions).
 * Returns how many blobs went (0, 1 or 2).
 */
function dropUnusedBlob(db: Database, hash: string): number {
  const get = db.prepare("SELECT delta_of FROM note_blobs WHERE hash = ?");
  const drop = db.prepare(
    "DELETE FROM note_blobs WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM note_versions WHERE content_hash = ?) AND NOT EXISTS (SELECT 1 FROM note_blobs WHERE delta_of = ?)",
  );
  let gone = 0;
  let next: string | null = hash;
  for (let depth = 0; depth < 2 && next; depth++) {
    const row = get.get(next) as { delta_of: string | null } | null;
    if (!row) break;
    drop.run(next, next, next);
    if (get.get(next)) break;
    gone++;
    next = row.delta_of;
  }
  return gone;
}
const marksSeen = new WeakMap<Database, boolean>();
/**
 * The SQL for "this version is marked": `marked_at IS NOT NULL` once `note_versions` has the column (the 1.0 marks,
 * an additive column), else 0. Read here, a release before marks are written already keeps a marked version through
 * pruning and the byte ceiling, so a rollback from the release that writes them keeps what its people marked.
 */
export function markedSql(db: Database): string {
  if (!marksSeen.get(db)) {
    const has = (db.prepare("SELECT name FROM pragma_table_info('note_versions')").all() as { name: string }[]).some((c) => c.name === "marked_at");
    if (!has) return "0";
    marksSeen.set(db, true);
  }
  return "(marked_at IS NOT NULL)";
}
export function gcBlobs(db: Database): { blobsDeleted: number } {
  let blobsDeleted = 0;
  // Depth one needs two deletion waves; bounded even in a corrupt database.
  for (let pass = 0; pass < 4; pass++) {
    const changed = db.prepare("DELETE FROM note_blobs WHERE hash NOT IN (SELECT content_hash FROM note_versions WHERE content_hash IS NOT NULL) AND hash NOT IN (SELECT delta_of FROM note_blobs WHERE delta_of IS NOT NULL)").run().changes;
    blobsDeleted += changed;
    if (!changed) break;
  }
  return { blobsDeleted };
}
export function sweepDeletedHistory(
  db: Database,
  policy: HistoryPolicy,
  now = new Date(),
): { notesSwept: number; versionsDeleted: number; blobsDeleted: number } {
  if (policy.deleted_retention_days === null)
    return { notesSwept: 0, versionsDeleted: 0, blobsDeleted: 0 };
  const cutoff = new Date(
    now.getTime() - policy.deleted_retention_days * 86_400_000,
  ).toISOString();
  const victims = db
    .prepare(
      `SELECT v.note_id, MAX(v.superseded_at) AS last FROM note_versions v
    LEFT JOIN notes n ON n.id = v.note_id WHERE n.id IS NULL GROUP BY v.note_id HAVING last < ?`,
    )
    .all(cutoff) as { note_id: string }[];
  return transaction(db, () => {
    let versionsDeleted = 0;
    for (const v of victims) {
      // A marked version is kept for good, past a deleted note's retention too (T-460); its note's other rows go.
      versionsDeleted += db
        .prepare(`DELETE FROM note_versions WHERE note_id = ? AND NOT ${markedSql(db)}`)
        .run(v.note_id).changes;
      if (!db.prepare("SELECT 1 FROM note_versions WHERE note_id = ? LIMIT 1").get(v.note_id))
        db.prepare("DELETE FROM history_compact_state WHERE note_id=?").run(v.note_id);
      else refreshCompactState(db, v.note_id);
    }
    return { notesSwept: victims.length, versionsDeleted, ...gcBlobs(db) };
  });
}
const columns =
  "note_id, version_ix, content_hash, path, metadata, extension, superseded_at, actor, via, via_kind, op, content_len, encoding, created_at";
function parseRow(row: RawVersionRow): VersionRow {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = row.metadata ? JSON.parse(row.metadata) : {};
  } catch {}
  return { ...row, metadata };
}
export function listVersions(
  db: Database,
  noteId: string,
  opts?: { limit?: number; offset?: number },
): VersionRow[] {
  return (
    db
      .prepare(
        `SELECT ${columns} FROM note_versions WHERE note_id = ? ORDER BY version_ix DESC LIMIT ? OFFSET ?`,
      )
      .all(noteId, opts?.limit ?? 50, opts?.offset ?? 0) as RawVersionRow[]
  ).map(parseRow);
}
export function getVersion(
  db: Database,
  noteId: string,
  versionIx: number,
): (VersionRow & { content: string | null }) | null {
  const row = db
    .prepare(
      `SELECT ${columns
        .split(", ")
        .map((c) => "v." + c)
        .join(", ")}, b.content, b.encoding AS blob_encoding, b.delta_of
    FROM note_versions v LEFT JOIN note_blobs b ON b.hash = v.content_hash WHERE v.note_id = ? AND v.version_ix = ?`,
    )
    .get(noteId, versionIx) as
    | (RawVersionRow & BlobReadRow)
    | null;
  if (!row) return null;
  const { content, blob_encoding, delta_of, ...verCols } = row;
  try {
    const reconstructed = materialise(db, verCols.content_hash!, { content, blob_encoding, delta_of });
    return { ...parseRow(verCols), content: reconstructed, encoding: verCols.encoding ?? blob_encoding };
  } catch (err) {
    if (!(err instanceof HistoryDeltaOrphanError)) throw err;
    console.warn("[history] unrecoverable delta", { hash: err.hash, delta_of: err.delta_of, reason: err.reason });
    throw new HistoryUnrecoverableError(noteId, versionIx, "delta_orphan");
  }
}
export function latestTombstone(
  db: Database,
  noteId: string,
): VersionRow | null {
  const row = db
    .prepare(
      `SELECT ${columns} FROM note_versions WHERE note_id = ? AND op = 'delete' ORDER BY version_ix DESC LIMIT 1`,
    )
    .get(noteId) as RawVersionRow | null;
  return row ? parseRow(row) : null;
}
export function eraseHistory(
  db: Database,
  noteId: string,
): { versionsDeleted: number; blobsDeleted: number } {
  // The targeted erase, then the full sweep this endpoint has always run (it also collects orphans other paths left).
  return transaction(db, () => {
    const erased = eraseNoteVersions(db, noteId);
    return { versionsDeleted: erased.versionsDeleted, blobsDeleted: erased.blobsDeleted + gcBlobs(db).blobsDeleted };
  });
}
/**
 * Delete every version of one note, its compaction state, and the blobs only those versions used (T-412). Blobs are
 * shared by content, so a blob goes only when no other version holds it and no other blob is a delta against it; a
 * freed delta's base is then tried too (deltas are depth one). Reads grow with this note's history, not with the
 * vault's, unlike {@link gcBlobs}, which {@link eraseHistory} still runs (it also sweeps orphans other paths left).
 * Call inside a transaction.
 */
export function eraseNoteVersions(
  db: Database,
  noteId: string,
): { versionsDeleted: number; blobsDeleted: number } {
  const hashes = (db
    .prepare("SELECT DISTINCT content_hash FROM note_versions WHERE note_id = ? AND content_hash IS NOT NULL")
    .all(noteId) as { content_hash: string }[]).map((r) => r.content_hash);
  const versionsDeleted = db.prepare("DELETE FROM note_versions WHERE note_id = ?").run(noteId).changes;
  db.prepare("DELETE FROM history_compact_state WHERE note_id=?").run(noteId);
  const baseOf = db.prepare("SELECT delta_of FROM note_blobs WHERE hash = ?");
  const drop = db.prepare(
    "DELETE FROM note_blobs WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM note_versions WHERE content_hash = ?) AND NOT EXISTS (SELECT 1 FROM note_blobs WHERE delta_of = ?)",
  );
  let blobsDeleted = 0;
  let wave = [...new Set(hashes)];
  // Bounded like gcBlobs: two waves suffice at depth one; four even in a corrupt chain.
  for (let pass = 0; pass < 4 && wave.length > 0; pass++) {
    const next = new Set<string>();
    for (const hash of wave) {
      const row = baseOf.get(hash) as { delta_of: string | null } | null;
      if (!row) continue;
      drop.run(hash, hash, hash);
      // Counted by looking, not by `.changes`: under Bun 1.4 this DELETE, when it removed nothing, reported the
      // previous statement's count, which overstated blobs_deleted.
      if (baseOf.get(hash)) continue;
      blobsDeleted++;
      if (row.delta_of) next.add(row.delta_of);
    }
    wave = [...next];
  }
  return { versionsDeleted, blobsDeleted };
}
/** One deleted note that still has history: what `GET /history/deleted` lists. */
export interface DeletedNoteRow {
  id: string;
  /** The path its newest version had. */
  path: string | null;
  extension: string | null;
  /** When it was deleted (its newest tombstone), or null when no tombstone is left (an interrupted erase, an import). */
  deleted_at: string | null;
  versions: number;
}
/**
 * Notes that are gone but whose versions are not (T-412): every plain delete leaves one, and so does a "delete
 * everything" interrupted between deleting and erasing. Newest deletion first. Reads every version row once, so it
 * is an admin listing, not a hot path.
 */
export function listDeletedNotes(
  db: Database,
  opts?: { limit?: number; offset?: number },
): { notes: DeletedNoteRow[]; total: number } {
  if (!historyTablesPresent(db)) return { notes: [], total: 0 };
  const limit = Math.min(1000, Math.max(0, opts?.limit ?? 100));
  const offset = Math.max(0, opts?.offset ?? 0);
  // One walk of note_versions in note_id order (idx_note_versions_note), one probe of notes per note id, the total
  // from a window over the groups, and the newest path read for the page's rows only: the listing reads each
  // version row once, not once per page twice.
  const rows = db
    .prepare(
      `SELECT p.id, p.versions, p.deleted_at, p.total,
        (SELECT x.path FROM note_versions x WHERE x.note_id = p.id ORDER BY x.version_ix DESC LIMIT 1) AS path,
        (SELECT x.extension FROM note_versions x WHERE x.note_id = p.id ORDER BY x.version_ix DESC LIMIT 1) AS extension
      FROM (
        SELECT g.*, COUNT(*) OVER () AS total FROM (
          SELECT v.note_id AS id, COUNT(*) AS versions, MAX(v.superseded_at) AS last_at,
            MAX(CASE WHEN v.op = 'delete' THEN v.superseded_at END) AS deleted_at
          FROM note_versions v GROUP BY v.note_id
          HAVING NOT EXISTS (SELECT 1 FROM notes n WHERE n.id = v.note_id)
        ) g ORDER BY g.last_at DESC, g.id ASC LIMIT ? OFFSET ?
      ) p ORDER BY p.last_at DESC, p.id ASC`,
    )
    .all(limit, offset) as (DeletedNoteRow & { total: number })[];
  let total = rows[0]?.total;
  if (total === undefined) {
    // An empty page (past the end, or limit 0) has no row to carry the window's count.
    total = offset === 0 && limit > 0 ? 0 : (db
      .prepare("SELECT COUNT(*) AS n FROM (SELECT 1 FROM note_versions v GROUP BY v.note_id HAVING NOT EXISTS (SELECT 1 FROM notes n WHERE n.id = v.note_id))")
      .get() as { n: number }).n;
  }
  const notes = rows.map(({ total: _t, ...row }) => ({ id: row.id, path: row.path, extension: row.extension, deleted_at: row.deleted_at, versions: row.versions }));
  return { notes, total };
}
export function deletedHistoryStats(db: Database): {
  notes: number;
  versions: number;
  bytes: number;
  overflow_tombstones: number;
} {
  return db
    .prepare(
      `SELECT COUNT(DISTINCT v.note_id) AS notes, COUNT(*) AS versions,
    COALESCE(SUM(b.byte_size), 0) AS bytes,
    COALESCE(SUM(CASE WHEN v.encoding = 'overflow' THEN 1 ELSE 0 END), 0) AS overflow_tombstones
    FROM note_versions v LEFT JOIN notes n ON n.id = v.note_id
    LEFT JOIN note_blobs b ON b.hash = v.content_hash WHERE n.id IS NULL`,
    )
    .get() as {
    notes: number;
    versions: number;
    bytes: number;
    overflow_tombstones: number;
  };
}

export class HistoryDeltaOrphanError extends Error {
  readonly code = "HISTORY_UNRECOVERABLE";
  constructor(readonly hash: string, readonly delta_of: string | null, readonly reason: "unknown_encoding" | "base_missing" | "base_not_whole" | "bad_delta" | "bad_encoding" | "identity_mismatch") {
    super(`History delta cannot be reconstructed: ${reason}`);
    this.name = "HistoryDeltaOrphanError";
  }
}
interface BlobReadRow {
  content: StoredContent | null;
  blob_encoding: string | null;
  delta_of: string | null;
}
/**
 * Decode one blob to its body (blob-codec.ts lists the encodings): inflate when deflated, refuse a body over
 * VERSION_MAX_BYTES, apply the delta against its whole base when there is one, then check the hash.
 */
function materialise(db: Database, hash: string, row: BlobReadRow): string | null {
  if (row.content === null)
    return null;
  let text: string;
  if (isWhole(row.blob_encoding)) {
    try {
      text = wholeText(row.content, row.blob_encoding, VERSION_MAX_BYTES);
    }
    catch {
      throw new HistoryDeltaOrphanError(hash, row.delta_of, "bad_encoding");
    }
  }
  else {
    if (!isDelta(row.blob_encoding))
      throw new HistoryDeltaOrphanError(hash, row.delta_of, "unknown_encoding");
    const base = row.delta_of ? db.prepare("SELECT content, encoding FROM note_blobs WHERE hash = ?").get(row.delta_of) as {
      content: StoredContent;
      encoding: string | null;
    } | null : null;
    if (!base)
      throw new HistoryDeltaOrphanError(hash, row.delta_of, "base_missing");
    if (!isWhole(base.encoding))
      throw new HistoryDeltaOrphanError(hash, row.delta_of, "base_not_whole");
    let baseText: string, delta: Uint8Array;
    try {
      baseText = wholeText(base.content, base.encoding, VERSION_MAX_BYTES);
      delta = deltaBytes(row.content, row.blob_encoding!, VERSION_MAX_BYTES + DELTA_SLACK_BYTES);
    }
    catch (err) {
      if (!(err instanceof BlobDecodeError)) throw err;
      throw new HistoryDeltaOrphanError(hash, row.delta_of, "bad_encoding");
    }
    try {
      text = applyDeltaBytes(baseText, delta, VERSION_MAX_BYTES);
    }
    catch {
      throw new HistoryDeltaOrphanError(hash, row.delta_of, "bad_delta");
    }
  }
  if (hashContent(text) !== hash)
    throw new HistoryDeltaOrphanError(hash, row.delta_of, "identity_mismatch");
  return text;
}
/** A delta of a body under VERSION_MAX_BYTES can carry a little more than the body itself (headers, a checksum). */
const DELTA_SLACK_BYTES = 65_536;
export function readBlobContent(db: Database, hash: string): string | null {
  const row = db.prepare("SELECT content, encoding AS blob_encoding, delta_of FROM note_blobs WHERE hash = ?").get(hash) as BlobReadRow | null;
  return row ? materialise(db, hash, row) : null;
}
export function countNoteVersions(db: Database, noteId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?").get(noteId) as {
    n: number;
  }).n;
}
/** Attribution: each directly referenced blob once, excluding indirect bases. */
export function noteHistoryBytes(db: Database, noteId: string): number {
  return (db.prepare(`SELECT COALESCE(SUM(b.byte_size),0) AS n FROM
  (SELECT DISTINCT content_hash FROM note_versions WHERE note_id = ? AND content_hash IS NOT NULL) v
  JOIN note_blobs b ON b.hash = v.content_hash`).get(noteId) as {
    n: number;
  }).n;
}
export function historyStorageStats(db: Database) {
  const stats = { whole_blobs: 0, whole_bytes: 0, delta_blobs: 0, delta_bytes: 0, orphan_deltas: 0, unknown_encoding_blobs: 0 };
  if (!historyTablesPresent(db))
    return stats;
  const groups = db.prepare("SELECT encoding, COUNT(*) AS n, COALESCE(SUM(byte_size),0) AS bytes FROM note_blobs GROUP BY encoding").all() as {
    encoding: string | null;
    n: number;
    bytes: number;
  }[];
  for (const g of groups) {
    if (isWhole(g.encoding)) {
      stats.whole_blobs += g.n;
      stats.whole_bytes += g.bytes;
    }
    else if (isDelta(g.encoding)) {
      stats.delta_blobs += g.n;
      stats.delta_bytes += g.bytes;
    }
    else
      stats.unknown_encoding_blobs += g.n;
  }
  stats.orphan_deltas = (db.prepare(`SELECT COUNT(*) AS n FROM note_blobs d WHERE d.encoding IN ('fossil-delta', 'fossil-delta-z')
  AND (d.delta_of IS NULL OR NOT EXISTS (SELECT 1 FROM note_blobs b WHERE b.hash = d.delta_of AND ${wholeSql("b")}))`).get() as {
    n: number;
  }).n;
  return stats;
}
export function topNotesByHistoryBytes(db: Database, limit: number): {
  note_id: string;
  bytes: number;
  versions: number;
}[] {
  return db.prepare(`SELECT v.note_id, SUM(b.byte_size) AS bytes,
  (SELECT COUNT(*) FROM note_versions n WHERE n.note_id = v.note_id) AS versions
  FROM (SELECT DISTINCT note_id, content_hash FROM note_versions WHERE content_hash IS NOT NULL) v
  JOIN note_blobs b ON b.hash = v.content_hash GROUP BY v.note_id ORDER BY bytes DESC LIMIT ?`).all(limit) as {
    note_id: string;
    bytes: number;
    versions: number;
  }[];
}
export interface CompactResult {
  /** Blobs stored as a delta against their run's base this pass. */
  blobs_deltified: number;
  /** Blobs re-stored compressed this pass: a whole body deflated, or an old base64 delta as deflated bytes (T-460). */
  blobs_compressed: number;
  blobs_skipped_too_large: number;
  versions_dropped: number;
  bytes_before: number;
  bytes_after: number;
}
export interface CompactSummary {
  notes_scanned: number;
  notes_compacted: number;
  notes_failed: number;
  blobs_deltified: number;
  blobs_compressed: number;
  versions_dropped: number;
  bytes_before: number;
  bytes_after: number;
  remaining_candidates: number;
  duration_ms: number;
  stopped_by: "complete" | "budget" | "max_notes" | "disabled";
}
export function compactNote(db: Database, noteId: string, policy: HistoryPolicy): CompactResult {
  const result: CompactResult = { blobs_deltified: 0, blobs_compressed: 0, blobs_skipped_too_large: 0, versions_dropped: 0, bytes_before: 0, bytes_after: 0 };
  if (!policy.enabled || !policy.compact_enabled || !historyTablesPresent(db))
    return result;
  return transaction(db, () => {
  const changedHashes = new Set<string>();
  const finish = () => {
    // A blob can be referenced by several notes. Refresh each affected hint,
    // without treating another note's compaction as a new history write.
    const affected = new Set<string>();
    for (const hash of changedHashes) {
      for (const row of db.prepare("SELECT DISTINCT note_id FROM note_versions WHERE content_hash=?").all(hash) as { note_id: string }[]) affected.add(row.note_id);
    }
    for (const id of affected) {
      if (id === noteId) continue;
      const prior = db.prepare("SELECT refused FROM history_compact_state WHERE note_id=?").get(id) as { refused: number } | null;
      refreshCompactState(db, id, { refused: prior?.refused === 1 });
    }
    // A pass leaves the note as compact as these rules make it, so it waits for its next write (T-460: the logical
    // trigger would otherwise keep a compacted note a candidate for ever).
    refreshCompactState(db, noteId, { refused: true });
    return result;
  };
  const rows = db.prepare("SELECT version_ix, content_hash, content_len FROM note_versions WHERE note_id = ? AND content_hash IS NOT NULL ORDER BY version_ix DESC").all(noteId) as {
    version_ix: number;
    content_hash: string;
    content_len: number;
  }[];
  const stored = noteHistoryBytes(db, noteId);
  result.bytes_before = result.bytes_after = stored;
  const current = db.prepare("SELECT content FROM notes WHERE id = ?").get(noteId) as {
    content: string | null;
  } | null;
  const newest = current?.content == null
    ? db.prepare("SELECT content_len FROM note_versions WHERE note_id = ? ORDER BY version_ix DESC LIMIT 1").get(noteId) as { content_len: number } | null
    : null;
  const live = current?.content == null ? newest?.content_len ?? 0 : byteLength(current.content);
  const overBytes = policy.max_bytes_per_note !== null && stored > policy.max_bytes_per_note;
  // Logical sizes (T-460): stored bytes are compressed, so comparing them with the live body would rarely fire.
  const logical = (db.prepare(`SELECT COALESCE(SUM(content_len), 0) AS n FROM (SELECT DISTINCT content_hash, content_len
    FROM note_versions WHERE note_id = ? AND content_hash IS NOT NULL)`).get(noteId) as { n: number }).n;
  const legacy = !!db.prepare(`SELECT 1 FROM note_versions v JOIN note_blobs b ON b.hash = v.content_hash
    WHERE v.note_id = ? AND ${LEGACY_BLOB_SQL} LIMIT 1`).get(noteId);
  const due = rows.length >= policy.compact_min_versions && logical > policy.compact_ratio * Math.max(live, 1);
  if (!overBytes && !legacy && !due)
    return finish();
  type Blob = { hash: string; content: StoredContent; byte_size: number; encoding: string | null; delta_of: string | null };
  const getBlob = db.prepare("SELECT hash, content, byte_size, encoding, delta_of FROM note_blobs WHERE hash = ?");
  const getEncoding = db.prepare("SELECT encoding FROM note_blobs WHERE hash = ?");
  const isBase = db.prepare("SELECT 1 FROM note_blobs WHERE delta_of = ? LIMIT 1");
  /**
   * Overwrite a blob in place, but only once the new bytes have been read back through the read path itself
   * (materialise: decode, apply, hash): a codec fault then skips a blob instead of damaging its only copy.
   */
  const store = (hash: string, before: Blob, content: Uint8Array, size: number, encoding: string, deltaOf: string | null) => {
    try {
      if (materialise(db, hash, { content, blob_encoding: encoding, delta_of: deltaOf }) === null) return false;
    }
    catch (err) {
      if (!(err instanceof HistoryDeltaOrphanError)) throw err;
      console.warn("[history] a re-encoded blob did not read back; left as it was", { hash, encoding, reason: err.reason });
      return false;
    }
    // Guarded on what was read, so a row changed under us (never, inside this transaction) is left alone.
    const changed = db.prepare("UPDATE note_blobs SET content = ?, byte_size = ?, encoding = ?, delta_of = ? WHERE hash = ? AND encoding IS ? AND byte_size = ?")
      .run(content, size, encoding, deltaOf, hash, before.encoding, before.byte_size).changes;
    if (changed) changedHashes.add(hash);
    return changed > 0;
  };
  /** Re-store a whole blob deflated when it is text and deflate is smaller. */
  const compressWhole = (b: Blob, text: string) => {
    if (b.encoding !== null) return;
    const w = encodeWhole(text, b.byte_size);
    if (w.encoding === "deflate" && store(b.hash, b, w.content as Uint8Array, w.byte_size, w.encoding, null)) result.blobs_compressed++;
  };
  // Runs of 24, newest first. A run's base is a whole blob in it that deltas already rest on, if there is one, else
  // its newest body. Reusing a standing base keeps the star when passes come after every write or two (as on Cloud,
  // one per wake): otherwise each pass made its newest version a new base and left every second version whole. The
  // base moves on once the standing one has slid out of the newest run, about every 24 versions.
  const standing = (run: typeof rows) => run.find((r) => isBase.get(r.content_hash) && isWhole((getEncoding.get(r.content_hash) as { encoding: string | null } | null)?.encoding ?? "missing"));
  const seen = new Set<string>();
  for (let start = 0; start < rows.length; start += policy.compact_run_length) {
    const run = rows.slice(start, start + policy.compact_run_length);
    // The run's newest body must resolve to a whole base before anything in the run is touched: a pre-existing
    // depth-two chain stops the note (P23), whichever base the run then uses.
    const first = getBlob.get(run[0]!.content_hash) as Blob | null;
    const firstBase = first ? (isWhole(first.encoding) ? first : first.delta_of ? getBlob.get(first.delta_of) as Blob | null : null) : null;
    if (first && firstBase && !isWhole(firstBase.encoding))
      throw new HistoryDeltaOrphanError(first.hash, firstBase.hash, "base_not_whole");
    const pick = standing(run);
    const baseRow = pick ? getBlob.get(pick.content_hash) as Blob | null : first;
    if (!baseRow)
      continue;
    const baseHash = isWhole(baseRow.encoding) ? baseRow.hash : baseRow.delta_of;
    if (!baseHash)
      continue;
    const base = getBlob.get(baseHash) as Blob | null;
    if (!base)
      continue;
    // Never propagate a pre-existing depth-two chain into healthy blobs.
    if (!isWhole(base.encoding))
      throw new HistoryDeltaOrphanError(baseRow.hash, baseHash, "base_not_whole");
    const text = readBlobContent(db, baseHash);
    if (text === null)
      continue;
    if (!seen.has(baseHash)) {
      seen.add(baseHash);
      compressWhole(base, text);
    }
    for (const r of run) {
      if (r.content_hash === baseHash || seen.has(r.content_hash))
        continue;
      seen.add(r.content_hash);
      // Settled blobs (compressed deltas) are passed over without loading their bytes.
      const encoding = (getEncoding.get(r.content_hash) as { encoding: string | null } | null)?.encoding;
      if (encoding === undefined || encoding === "fossil-delta-z")
        continue;
      const b = getBlob.get(r.content_hash) as Blob;
      if (b.encoding === "fossil-delta") {
        // A legacy delta keeps its base; only its bytes move: base64 text to raw bytes, deflated.
        if (typeof b.content !== "string") continue;
        const z = deflateBytes(fromBase64(b.content));
        if (store(b.hash, b, z, z.byteLength, "fossil-delta-z", b.delta_of)) result.blobs_compressed++;
        continue;
      }
      if (!isWhole(b.encoding))
        continue;
      const body = readBlobContent(db, b.hash);
      if (body === null)
        continue;
      // A blob other deltas rest on stays whole (depth one); it can still be compressed.
      if (isBase.get(b.hash)) {
        compressWhole(b, body);
        continue;
      }
      const wholeSize = b.encoding === "deflate" ? b.byte_size : encodeWhole(body, byteLength(body)).byte_size;
      const dz = deflateBytes(createDeltaBytes(text, body));
      if (dz.byteLength < wholeSize * 0.9) {
        if (store(b.hash, b, dz, dz.byteLength, "fossil-delta-z", baseHash)) result.blobs_deltified++;
      }
      else {
        result.blobs_skipped_too_large++;
        compressWhole(b, body);
      }
    }
  }
    if (policy.max_bytes_per_note !== null)
      result.versions_dropped = enforceByteCeiling(db, noteId, policy);
    result.bytes_after = noteHistoryBytes(db, noteId);
    return finish();
  });
}
function enforceByteCeiling(db: Database, noteId: string, policy: HistoryPolicy): number {
  let dropped = 0;
  while (policy.max_bytes_per_note !== null && noteHistoryBytes(db, noteId) > policy.max_bytes_per_note) {
    const rows = db.prepare(`SELECT version_ix, op, content_hash, ${markedSql(db)} AS marked FROM note_versions WHERE note_id = ? ORDER BY version_ix ASC`).all(noteId) as (Pick<VersionRow, "version_ix" | "op" | "content_hash"> & { marked: number })[];
    const victim = rows.find((r, i) => r.op !== "delete" && !r.marked && rows.length - 1 - i >= policy.min_versions);
    if (!victim)
      break;
    dropped += db.prepare("DELETE FROM note_versions WHERE note_id = ? AND version_ix = ?").run(noteId, victim.version_ix).changes;
    if (victim.content_hash) dropUnusedBlob(db, victim.content_hash);
  }
  return dropped;
}
export function compactVault(db: Database, policy: HistoryPolicy, opts?: {
  noteId?: string;
  budgetMs?: number | null;
  maxNotes?: number | null;
}): CompactSummary {
  const result: CompactSummary = { notes_scanned: 0, notes_compacted: 0, notes_failed: 0, blobs_deltified: 0, blobs_compressed: 0, versions_dropped: 0, bytes_before: 0, bytes_after: 0, remaining_candidates: 0, duration_ms: 0, stopped_by: "complete" };
  if (!historyTablesPresent(db) || !policy.enabled || !policy.compact_enabled)
    return { ...result, stopped_by: "disabled" };
  const budget = opts?.budgetMs === undefined ? policy.compact_budget_ms : opts.budgetMs;
  const max = opts?.maxNotes === undefined ? policy.compact_max_notes : opts.maxNotes;
  if (max !== null && max <= 0)
    return { ...result, stopped_by: "max_notes" };
  if (budget !== null && budget <= 0)
    return { ...result, stopped_by: "budget" };
  const started = performance.now();
  // Always on (T-460): a note with enough versions is a candidate until a pass leaves it refused; compactNote applies
  // the size rule on logical sizes itself, so the hints refreshed on every write stay cheap. `legacy` (v33) adds
  // notes holding blobs stored the old way, whatever their count.
  const predicate = `refused=0 AND (legacy > 0 OR (live>0 AND versions >= ?) OR (? IS NOT NULL AND stored > ?))`;
  const args = [policy.compact_min_versions, policy.max_bytes_per_note, policy.max_bytes_per_note];
  const total = opts?.noteId !== undefined ? 1 : (db.prepare(`SELECT COUNT(*) AS n FROM history_compact_state WHERE ${predicate}`).get(...args) as { n: number }).n;
  const candidates = opts?.noteId !== undefined ? [{ note_id: opts.noteId }] : db.prepare(`SELECT note_id FROM history_compact_state WHERE ${predicate} ORDER BY stored DESC LIMIT ?`).all(...args, max === null ? -1 : max * 4) as {
    note_id: string;
  }[];
  for (const candidate of candidates) {
    if (max !== null && result.notes_scanned >= max) {
      result.stopped_by = "max_notes";
      break;
    }
    // Always attempt one candidate, even when the candidate scan used the budget.
    if (result.notes_scanned > 0 && budget !== null && performance.now() - started >= budget) {
      result.stopped_by = "budget";
      break;
    }
    result.notes_scanned++;
    try {
      const r = compactNote(db, candidate.note_id, policy);
      if (r.blobs_deltified || r.blobs_compressed || r.versions_dropped)
        result.notes_compacted++;
      result.blobs_deltified += r.blobs_deltified;
      result.blobs_compressed += r.blobs_compressed;
      result.versions_dropped += r.versions_dropped;
      result.bytes_before += r.bytes_before;
      result.bytes_after += r.bytes_after;
    }
    catch (err) {
      result.notes_failed++;
      console.warn("[history] compaction failed", candidate.note_id, err);
      // Not again until the note's next write: a note that always fails must not take every pass's budget.
      try {
        db.prepare("UPDATE history_compact_state SET refused = 1 WHERE note_id = ?").run(candidate.note_id);
      }
      catch {}
    }
  }
  result.remaining_candidates = total - result.notes_scanned;
  result.duration_ms = performance.now() - started;
  return result;
}
