/**
 * Export with history (0.9.4, T-471): a record's native versions as one JSON-lines file in an export,
 * `.parachute/history/<record id>.jsonl`, and the import that reads it back behind the current records.
 *
 * One line per version, oldest first: its number, op, times, the write stamp (actor, via, via_kind), the write set
 * that superseded it and that set's reason, its path, extension, fields, types, tags and outgoing links, and its body
 * (`content`, null for an overflow tombstone, whose bytes were never kept). The writer reads versions through the
 * Store's version reads (history.ts), which decode compressed and delta bodies, so the file holds plain text.
 *
 * Out of scope: versions brought in from git (negative version_ix, origin git-import) are not exported, and nothing
 * of the change log (record_changes) is. Erased history is gone, so it can't be exported.
 */
import type { Database } from "bun:sqlite";
import type { Store } from "./types.js";
import { byteLength, hashContent, historyTablesPresent, VERSION_MAX_BYTES, type VersionRow } from "./history.js";

/** The history folder under the export's `.parachute/`. */
export const HISTORY_DIR = "history";

/** One version as a line of the history file. The key order is fixed, so the same history gives the same bytes. */
export interface HistoryLine {
  version_ix: number;
  op: string;
  superseded_at: string;
  created_at: string | null;
  actor: string | null;
  via: string | null;
  via_kind: string | null;
  write_set: string | null;
  why: string | null;
  path: string | null;
  extension: string | null;
  metadata: Record<string, unknown>;
  types: string[] | null;
  tags: string[] | null;
  links: { target: string; relationship: string; metadata: unknown }[] | null;
  content_hash: string | null;
  content_len: number;
  content: string | null;
}

export function historyLine(v: VersionRow & { content: string | null }): string {
  const line: HistoryLine = {
    version_ix: v.version_ix,
    op: v.op,
    superseded_at: v.superseded_at,
    created_at: v.created_at ?? null,
    actor: v.actor ?? null,
    via: v.via ?? null,
    via_kind: v.via_kind ?? null,
    write_set: v.write_set ?? null,
    why: v.why ?? null,
    path: v.path ?? null,
    extension: v.extension ?? null,
    metadata: v.metadata ?? {},
    types: v.types ?? null,
    tags: v.tags ?? null,
    links: v.links ?? null,
    content_hash: v.content_hash ?? null,
    content_len: v.content_len,
    content: v.content,
  };
  return JSON.stringify(line);
}

const PAGE = 200;

/**
 * One record's history file, or null when it has no native version. A version whose body can't be rebuilt (a broken
 * delta) is left out and named in `skipped`; the rest of the record's history still goes.
 */
export async function recordHistoryFile(
  store: Store,
  id: string,
): Promise<{ text: string; versions: number; skipped: Array<{ version_ix: number; reason: string }> } | null> {
  const rows: VersionRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await store.listNoteVersions(id, { limit: PAGE, offset });
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  const native = rows.filter((r) => r.version_ix >= 0).sort((a, b) => a.version_ix - b.version_ix);
  if (native.length === 0) return null;
  const lines: string[] = [];
  const skipped: Array<{ version_ix: number; reason: string }> = [];
  for (const row of native) {
    let full: (VersionRow & { content: string | null }) | null;
    try {
      full = await store.getNoteVersion(id, row.version_ix);
    } catch (err) {
      skipped.push({ version_ix: row.version_ix, reason: (err as Error).message });
      continue;
    }
    if (!full) continue; // pruned while the export ran
    lines.push(historyLine(full));
  }
  if (lines.length === 0) return null;
  return { text: lines.join("\n") + "\n", versions: lines.length, skipped };
}

/** Whether `store` keeps history at all (a bare test database may not). */
export function storeKeepsHistory(store: Store): boolean {
  try {
    return historyTablesPresent(store.db);
  } catch {
    return false;
  }
}

/** A record id taken from a history file's name: the name less `.jsonl`, and no path in it. */
export function recordIdOfHistoryFile(name: string): string | null {
  if (!name.endsWith(".jsonl")) return null;
  const id = name.slice(0, -".jsonl".length);
  if (id === "" || id.startsWith(".") || /[/\\\0]/.test(id)) return null;
  return id;
}

export interface HistoryImportResult {
  added: number;
  /** Lines already in the vault (same time, op and body): an import of the same export twice adds nothing. */
  present: number;
  skipped: Array<{ line: number; reason: string }>;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const list = (v: unknown): string | null => (Array.isArray(v) ? JSON.stringify(v) : null);

const revisionColumns = new WeakMap<Database, boolean>();
function hasRevisionColumns(db: Database): boolean {
  let known = revisionColumns.get(db);
  if (known === undefined) {
    const cols = new Set((db.prepare("PRAGMA table_info(note_versions)").all() as { name: string }[]).map((c) => c.name));
    known = cols.has("write_set") && cols.has("links") && cols.has("via_kind") && cols.has("created_at");
    revisionColumns.set(db, known);
  }
  return known;
}

/**
 * Reads one record's history file into `db`: each version lands behind the record's current state, with its stamps,
 * write set and why (both on the version itself, as #114 keeps them) and body (stored as a captured version stores
 * its body, deduplicated by hash). No write_sets row is made: a set from another vault has nothing to undo here.
 *
 * Append, never overwrite: a line the vault already holds (same `superseded_at`, op and body hash) is skipped, so
 * importing the same export twice adds nothing. Into a record with no versions the lines keep their numbers; into
 * one that has some, they are numbered after its newest. The vault's own retention still applies afterwards.
 */
export function importHistoryFile(db: Database, noteId: string, text: string): HistoryImportResult {
  const out: HistoryImportResult = { added: 0, present: 0, skipped: [] };
  if (!historyTablesPresent(db) || !hasRevisionColumns(db)) {
    out.skipped.push({ line: 0, reason: "this vault keeps no history" });
    return out;
  }
  const parsed: Array<{ n: number; v: Record<string, unknown> }> = [];
  text.split("\n").forEach((raw, i) => {
    if (raw.trim() === "") return;
    try {
      const v = JSON.parse(raw);
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
      if (!Number.isSafeInteger(v.version_ix) || v.version_ix < 0) throw new Error("version_ix is not a whole number ≥ 0");
      if (typeof v.op !== "string" || typeof v.superseded_at !== "string") throw new Error("op and superseded_at are required");
      parsed.push({ n: i + 1, v });
    } catch (err) {
      out.skipped.push({ line: i + 1, reason: (err as Error).message });
    }
  });
  parsed.sort((a, b) => (a.v.version_ix as number) - (b.v.version_ix as number));

  const existing = db
    .prepare("SELECT version_ix, superseded_at, op, content_hash, actor, via, write_set, metadata FROM note_versions WHERE note_id = ?")
    .all(noteId) as { version_ix: number; superseded_at: string; op: string; content_hash: string | null; actor: string | null; via: string | null; write_set: string | null; metadata: string | null }[];
  // A version is the same as one the record already holds when all of these agree. Only rows held before this import
  // count: two lines of one file are two versions, even when they look alike (same time, a fields-only change).
  const keyOf = (at: string, op: string, hash: string | null, actor: unknown, via: unknown, set: unknown, metadata: string | null) =>
    [at, op, hash ?? "", actor ?? "", via ?? "", set ?? "", metadata ?? ""].join("\u0000");
  const held = new Set(existing.map((r) => keyOf(r.superseded_at, r.op, r.content_hash, r.actor, r.via, r.write_set, r.metadata)));
  // History lands behind the record's own: a line older than its newest version is not slipped under it (version
  // numbers are the order, and retention keeps the highest).
  const newest = existing.filter((r) => r.version_ix >= 0).reduce<string | null>((m, r) => (m === null || r.superseded_at > m ? r.superseded_at : m), null);
  const usedIx = new Set(existing.map((r) => r.version_ix));
  const keepNumbers = !existing.some((r) => r.version_ix >= 0);
  let next = Math.max(-1, ...existing.map((r) => r.version_ix)) + 1;

  const insertBlob = db.prepare("INSERT OR IGNORE INTO note_blobs (hash, content, byte_size) VALUES (?, ?, ?)");
  const insertVersion = db.prepare(
    `INSERT INTO note_versions (note_id, version_ix, content_hash, path, metadata, extension, superseded_at, actor, via,
      via_kind, op, content_len, encoding, created_at, write_set, why, types, tags, links)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const { n, v } of parsed) {
    const content = v.content;
    let hash: string | null;
    let len: number;
    let encoding: string | null = null;
    if (typeof content === "string") {
      len = byteLength(content);
      if (len > VERSION_MAX_BYTES) {
        out.skipped.push({ line: n, reason: `body of ${len} bytes is over the version limit` });
        continue;
      }
      hash = hashContent(content);
      if (v.content_hash != null && v.content_hash !== hash) {
        out.skipped.push({ line: n, reason: "the body does not match its content_hash" });
        continue;
      }
    } else if (content === null && v.op === "delete") {
      // An overflow tombstone: the record's existence, size and place, never its bytes.
      hash = null;
      len = Number.isSafeInteger(v.content_len) ? (v.content_len as number) : 0;
      encoding = "overflow";
    } else {
      out.skipped.push({ line: n, reason: "no body" });
      continue;
    }
    const at = v.superseded_at as string;
    const metadataText = v.metadata && typeof v.metadata === "object" && !Array.isArray(v.metadata) ? JSON.stringify(v.metadata) : null;
    const key = keyOf(at, v.op as string, hash, str(v.actor), str(v.via), str(v.write_set), metadataText);
    if (held.has(key)) {
      out.present++;
      continue;
    }
    if (newest !== null && at <= newest) {
      out.skipped.push({ line: n, reason: "older than this record's own history (it would land under newer versions)" });
      continue;
    }
    let ix = v.version_ix as number;
    if (!keepNumbers || usedIx.has(ix)) ix = next;
    next = Math.max(next, ix + 1);
    usedIx.add(ix);
    if (hash !== null) insertBlob.run(hash, content as string, len);
    const writeSet = str(v.write_set);
    insertVersion.run(
      noteId,
      ix,
      hash,
      str(v.path),
      metadataText,
      str(v.extension),
      at,
      str(v.actor),
      str(v.via),
      str(v.via_kind),
      v.op as string,
      len,
      encoding,
      str(v.created_at),
      writeSet,
      str(v.why),
      list(v.types),
      list(v.tags),
      list(v.links),
    );
    out.added++;
  }
  return out;
}
