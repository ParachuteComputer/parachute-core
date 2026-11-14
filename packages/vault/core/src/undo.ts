/**
 * Undo by write set (0.9.4, T-471). Puts back every record one write set changed, as the change log saved it
 * (change-log.ts), and nothing else:
 *
 * - a record the set created is deleted (its tombstone kept, so undoing the undo brings it back);
 * - a record the set deleted is made again with its id, body, fields, path, types and tags, links and creation stamp;
 * - a record the set changed gets back its body (when the set changed it), fields, path, extension, tags and links.
 *
 * The undo is itself a write set (`undoes` names the one it undoes), written through the Store under the caller's
 * write set source, so undoing it puts the changes back. It is all or nothing: one transaction.
 *
 * If a later write changed one of the records, undo refuses and lists the conflicts, unless `force`; forcing puts
 * the set's "before" back over the later write (which stays in history and in the log, so it can be undone in turn).
 */
import type { Database } from "bun:sqlite";
import type { Store } from "./types.js";
import { transactionAsync } from "./txn.js";
import { getWriteSet, type WriteSetRow } from "./change-log.js";
import { readBlobText } from "./history.js";

export interface UndoConflict {
  id: string;
  path: string | null;
  /** The later write: its set (null for a write outside any set), who, through which key, when. */
  write_set: string | null;
  by: string | null;
  via: string | null;
  at: string;
}

export interface UndoResult {
  undoes: string;
  records: { id: string; op: "deleted" | "recreated" | "reverted" | "unchanged" }[];
  /** Later writes that `force` put the set's "before" over. */
  forced: UndoConflict[];
  /** Links the set's records had that couldn't be put back (their target no longer exists). */
  links_skipped: { id: string; target: string; relationship: string }[];
}

export class UndoRefusal extends Error {
  constructor(
    readonly status: number,
    readonly error_type: "not_found" | "already_undone" | "undo_conflict" | "nothing_to_undo" | "undo_path_taken",
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

interface ChangeRow {
  seq: number;
  position: number | null;
  note_id: string;
  op: "create" | "update" | "delete";
  existed: number;
  before_content: string | null;
  before_hash: string | null;
  content_saved: number;
  before_row: string | null;
  before_tags: string | null;
  before_links: string | null;
}

interface BeforeRow {
  path: string | null;
  extension: string | null;
  metadata: string | null;
  created_at: string | null;
  created_by: string | null;
  created_via: string | null;
}

type LinkSpec = { target: string; relationship: string; metadata: Record<string, unknown> | null };

function rowsOf(db: Database, setId: string): ChangeRow[] {
  return db
    .prepare(
      "SELECT seq, position, note_id, op, existed, before_content, before_hash, content_saved, before_row, before_tags, before_links FROM record_changes WHERE write_set = ? ORDER BY seq",
    )
    .all(setId) as ChangeRow[];
}

/**
 * The set that undid this one, if that undo still stands: an undo stands unless it is itself undone by an undo that
 * stands, and so on down the chain (undo, redo, undo again …). Bounded: a chain longer than 64 is read as standing.
 */
export function standingUndo(db: Database, setId: string, depth = 0): string | null {
  if (depth > 64) return null;
  const undos = db.prepare("SELECT id FROM write_sets WHERE undoes = ? ORDER BY at DESC, id DESC").all(setId) as { id: string }[];
  for (const u of undos) {
    if (standingUndo(db, u.id, depth + 1) === null) return u.id;
  }
  return null;
}

/**
 * Later writes to the set's records: any change by another set (or by none) placed after this set's newest touch of
 * the record in the log's order (positions move with every touch, so a set opened earlier that writes again later
 * counts). A row not yet placed (a raw write since the last Store transaction) counts when it came after.
 */
export function undoConflicts(db: Database, setId: string): UndoConflict[] {
  const out: UndoConflict[] = [];
  for (const r of rowsOf(db, setId)) {
    if (r.op === "delete" && r.existed === 0) continue;
    const later = db
      .prepare(
        `SELECT rc.write_set, rc.at, ws.actor, ws.via FROM record_changes rc LEFT JOIN write_sets ws ON ws.id = rc.write_set
         WHERE rc.note_id = ? AND (rc.write_set IS NULL OR rc.write_set <> ?)
           AND (rc.position > ? OR (rc.position IS NULL AND rc.seq > ?))
         ORDER BY COALESCE(rc.position, 9e18) DESC LIMIT 1`,
      )
      .get(r.note_id, setId, r.position ?? r.seq, r.seq) as { write_set: string | null; at: string; actor: string | null; via: string | null } | null;
    if (!later) continue;
    out.push({ id: r.note_id, path: pathNowOrBefore(db, r), write_set: later.write_set, by: later.actor, via: later.via, at: later.at });
  }
  return out;
}

function pathNowOrBefore(db: Database, r: ChangeRow): string | null {
  const now = db.prepare("SELECT path FROM notes WHERE id = ?").get(r.note_id) as { path: string | null } | null;
  if (now) return now.path;
  return parseBefore(r)?.path ?? null;
}

function parseBefore(r: ChangeRow): BeforeRow | null {
  if (!r.before_row) return null;
  try {
    return JSON.parse(r.before_row) as BeforeRow;
  } catch {
    return null;
  }
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const linkKey = (target: string, relationship: string) => `${target}\u0000${relationship}`;

/**
 * Undoes one write set. The caller has already decided the caller may (its own set, or admin; a scoped caller only
 * a set it can see whole) and has set the Store's write set source to the undo's own set (`undoes: setId`).
 */
export async function undoWriteSet(store: Store, setId: string, opts: { force?: boolean; actor?: string | null; via?: string | null } = {}): Promise<UndoResult> {
  const db = store.db;
  // Everything is read inside the transaction, so no write can land between a check and the undo.
  return transactionAsync(db, async () => {
    const set: WriteSetRow | null = getWriteSet(db, setId);
    if (!set) throw new UndoRefusal(404, "not_found", `No write set ${setId} (or it is older than the change log keeps).`);
    const undoneBy = standingUndo(db, setId);
    if (undoneBy) {
      throw new UndoRefusal(409, "already_undone", `Write set ${setId} is already undone, by ${undoneBy}. Undo that set to put these changes back.`, { undone_by: undoneBy });
    }
    const rows = rowsOf(db, setId).filter((r) => !(r.op === "delete" && r.existed === 0));
    if (!rows.length) throw new UndoRefusal(409, "nothing_to_undo", `Write set ${setId} changed no record that is still in the log.`);
    const conflicts = undoConflicts(db, setId);
    if (conflicts.length && !opts.force) {
      throw new UndoRefusal(
        409,
        "undo_conflict",
        `${conflicts.length} record(s) changed after write set ${setId}, so undoing it would also undo those later writes. Nothing was changed. Undo the later sets first, or send force: true to put this set's "before" back anyway.`,
        { conflicts },
      );
    }
    const stamp = { actor: opts.actor ?? null, via: opts.via ?? null };
    const result: UndoResult = { undoes: setId, records: [], forced: opts.force ? conflicts : [], links_skipped: [] };
    const exists = (id: string) => !!db.prepare("SELECT 1 FROM notes WHERE id = ?").get(id);
    // A path the undo puts back may be held by another record by now: refused with the record, never a bare error.
    const guardPath = async <T,>(r: ChangeRow, path: string | null | undefined, write: () => Promise<T>): Promise<T> => {
      try {
        return await write();
      } catch (e) {
        if ((e as { error_type?: string }).error_type === "path_conflict" || (e as { code?: string }).code === "PATH_CONFLICT") {
          throw new UndoRefusal(409, "undo_path_taken", `Undoing ${setId} would put record ${r.note_id} back at "${path}", which another record holds now. Nothing was changed. Move that record first.`, { id: r.note_id, path: path ?? null });
        }
        throw e;
      }
    };

    // Records first (deleted ones made again before links point at them), then links, then the set's creations go.
    const linkWork: { id: string; links: LinkSpec[] }[] = [];
    for (const r of rows) {
      if (r.existed === 0) continue;
      const before = parseBefore(r);
      const tags = parseJson<string[]>(r.before_tags, []);
      // Null after the record's history was erased: what is gone isn't put back (its links are left as they are).
      const links = r.before_links === null ? null : parseJson<LinkSpec[]>(r.before_links, []);
      if (!exists(r.note_id)) {
        // The set deleted it (or, forced, a later write did). Its body: saved by the set, else the newest tombstone's.
        const content = r.content_saved ? savedBody(db, r) : await tombstoneBody(store, r.note_id);
        if (content === null || before === null) {
          result.records.push({ id: r.note_id, op: "unchanged" });
          continue;
        }
        await guardPath(r, before.path, () =>
          store.createNote(content, {
            id: r.note_id,
            ...(before.path ? { path: before.path } : {}),
            ...(before.extension ? { extension: before.extension } : {}),
            metadata: parseJson<Record<string, unknown>>(before.metadata, {}),
            ...(before.created_at ? { created_at: before.created_at } : {}),
            tags,
            ...stamp,
          }),
        );
        // The creation stamp is the original writer's, not the undoer's.
        store.transaction(() =>
          db.prepare("UPDATE notes SET created_by = ?, created_via = ? WHERE id = ?").run(before.created_by ?? null, before.created_via ?? null, r.note_id),
        );
        result.records.push({ id: r.note_id, op: "recreated" });
      } else {
        const updates: Record<string, unknown> = { ...stamp };
        if (r.content_saved) {
          const body = savedBody(db, r);
          if (body !== null) updates.content = body;
        }
        if (before) {
          updates.metadata = parseJson<Record<string, unknown>>(before.metadata, {});
          // A path the set gave a record that had none is taken away again (null clears it).
          updates.path = before.path;
          if (before.extension) updates.extension = before.extension;
        }
        await guardPath(r, before?.path, () => store.updateNote(r.note_id, updates as Parameters<Store["updateNote"]>[1]));
        if (r.before_tags !== null) {
          const now = (db.prepare("SELECT tag_name FROM note_tags WHERE note_id = ?").all(r.note_id) as { tag_name: string }[]).map((t) => t.tag_name);
          const extra = now.filter((t) => !tags.includes(t));
          const missing = tags.filter((t) => !now.includes(t));
          if (extra.length) await store.untagNote(r.note_id, extra);
          if (missing.length) await store.tagNote(r.note_id, missing);
        }
        result.records.push({ id: r.note_id, op: "reverted" });
      }
      if (links !== null) linkWork.push({ id: r.note_id, links });
    }
    for (const { id, links } of linkWork) {
      const now = db.prepare("SELECT target_id, relationship, metadata FROM links WHERE source_id = ?").all(id) as { target_id: string; relationship: string; metadata: string | null }[];
      const want = new Map(links.map((l) => [linkKey(l.target, l.relationship), l]));
      for (const l of now) {
        const w = want.get(linkKey(l.target_id, l.relationship));
        if (!w || canonical(parseJson(l.metadata, {})) !== canonical(w.metadata ?? {})) await store.deleteLink(id, l.target_id, l.relationship);
      }
      const after = new Set((db.prepare("SELECT target_id, relationship FROM links WHERE source_id = ?").all(id) as { target_id: string; relationship: string }[]).map((l) => linkKey(l.target_id, l.relationship)));
      for (const l of links) {
        if (after.has(linkKey(l.target, l.relationship))) continue;
        if (!exists(l.target)) {
          result.links_skipped.push({ id, target: l.target, relationship: l.relationship });
          continue;
        }
        await store.createLink(id, l.target, l.relationship, l.metadata && Object.keys(l.metadata).length ? l.metadata : undefined);
      }
    }
    for (const r of rows) {
      if (r.existed !== 0) continue;
      if (exists(r.note_id)) {
        await store.deleteNote(r.note_id, stamp);
        result.records.push({ id: r.note_id, op: "deleted" });
      } else {
        result.records.push({ id: r.note_id, op: "unchanged" });
      }
    }
    return result;
  });
}

/** The body the set saved: a blob once its transaction ended (inline only inside it). Null if it is gone. */
function savedBody(db: Database, r: ChangeRow): string | null {
  if (r.before_hash) return readBlobText(db, r.before_hash);
  return r.before_content;
}

/** A deleted record's last body, from its newest tombstone (null when there is none, or it was too big to keep). */
async function tombstoneBody(store: Store, id: string): Promise<string | null> {
  const row = store.db.prepare("SELECT version_ix FROM note_versions WHERE note_id = ? AND op = 'delete' ORDER BY version_ix DESC LIMIT 1").get(id) as { version_ix: number } | null;
  if (!row) return null;
  try {
    return (await store.getNoteVersion(id, row.version_ix))?.content ?? null;
  } catch {
    return null;
  }
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
