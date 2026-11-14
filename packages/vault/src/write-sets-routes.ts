/**
 * `/api/write-sets` (0.9.4, T-471): which writes a key made, with who, why and the records each changed.
 *
 * - `GET /api/write-sets?by=me|<key name>&limit=&before=`: newest first. A key that isn't admin sees its own sets
 *   only (`by` defaults to `me`); admin sees any, and every key's when `by` is left out.
 * - `GET /api/write-sets/<id>`: one set and its records (`id`, `op`, `path`).
 * - `POST /api/write-sets/<id>/undo`: undo it (handleUndo).
 *
 * A tag-scoped key sees a set only when it can see every record in it: a record that still exists by its tags now,
 * a deleted one by the tags it had. Anything else answers as if the set weren't there.
 */
import type { Database } from "bun:sqlite";
import { getWriteSet, listWriteSets, newWriteSetId, setRecordStates, normaliseWhy, writeSetRecords, type WriteSetRow } from "../core/src/change-log.ts";
import { standingUndo, undoWriteSet, UndoRefusal, type UndoConflict } from "../core/src/undo.ts";
import type { Store } from "../core/src/types.ts";
import { WHY_HEADER, withWriteSet } from "./write-set-edge.ts";
import type { Note } from "../core/src/types.ts";
import { noteWithinTagScope } from "./tag-scope.ts";
import type { TagScopeCtx } from "./routes.ts";

export interface WriteSetsAuth {
  /** The caller's credential, as revisions stamp it (`key:<name>`, `api`, …). */
  via: string | null;
  admin: boolean;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** Whether a scoped caller can see every record of a set. */
export function setVisible(db: Database, id: string, tagScope: TagScopeCtx): boolean {
  if (tagScope.raw === null) return true;
  for (const r of writeSetRecords(db, id)) {
    const tags = currentTags(db, r.id) ?? r.tags_before ?? [];
    if (!noteWithinTagScope({ tags } as unknown as Note, tagScope.allowed, tagScope.raw)) return false;
  }
  return true;
}

function currentTags(db: Database, id: string): string[] | null {
  if (!db.prepare("SELECT 1 FROM notes WHERE id = ?").get(id)) return null;
  return (db.prepare("SELECT tag_name FROM note_tags WHERE note_id = ? ORDER BY tag_name").all(id) as { tag_name: string }[]).map((r) => r.tag_name);
}

/** Whether this caller may read (or undo) this set at all, before scope. */
export function setOwnedOrAdmin(set: WriteSetRow, auth: WriteSetsAuth): boolean {
  return auth.admin || (auth.via !== null && set.via === auth.via);
}

function project(db: Database, set: WriteSetRow & { records?: number; undone_by?: string | null }) {
  // The undo that stands (undo, redo, undo again … : the same rule undo itself uses), not merely the newest.
  const undoneBy = standingUndo(db, set.id);
  return {
    id: set.id,
    at: set.at,
    by: set.actor,
    via: set.via,
    via_kind: set.via_kind,
    why: set.why,
    ...(set.records !== undefined ? { records: set.records } : {}),
    undoes: set.undoes,
    undone_by: undoneBy,
  };
}

function recordPath(db: Database, id: string, beforeRow: string | null): string | null {
  const now = db.prepare("SELECT path FROM notes WHERE id = ?").get(id) as { path: string | null } | null;
  if (now) return now.path;
  try {
    return beforeRow ? ((JSON.parse(beforeRow) as { path?: string | null }).path ?? null) : null;
  } catch {
    return null;
  }
}

export function handleWriteSets(req: Request, db: Database, subpath: string, auth: WriteSetsAuth, tagScope: TagScopeCtx): Response | null {
  const url = new URL(req.url);
  if (subpath === "" || subpath === "/") {
    if (req.method !== "GET") return null;
    const by = url.searchParams.get("by");
    let via: string | undefined;
    if (by === null) via = auth.admin ? undefined : (auth.via ?? "\u0000none");
    else if (by === "me") via = auth.via ?? "\u0000none";
    else {
      via = `key:${by}`;
      if (!auth.admin && via !== auth.via) {
        return json({ error: "Only an admin key lists another key's write sets.", error_type: "insufficient_scope", hint: "use by=me" }, 403);
      }
    }
    const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
    const limit = Number.isNaN(limitRaw) ? 20 : Math.min(200, Math.max(1, limitRaw));
    const before = url.searchParams.get("before") ?? undefined;
    const sets = listWriteSets(db, {
      ...(via !== undefined ? { via } : {}),
      limit,
      ...(before ? { before } : {}),
      ...(tagScope.raw !== null ? { visible: (setId: string) => setVisible(db, setId, tagScope) } : {}),
    });
    return json({ write_sets: sets.map((s) => project(db, s)) });
  }
  const m = subpath.match(/^\/([^/]+)$/);
  if (!m || req.method !== "GET") return null;
  const id = decodeURIComponent(m[1]!);
  const set = getWriteSet(db, id);
  if (!set || !setOwnedOrAdmin(set, auth) || !setVisible(db, id, tagScope)) {
    return json({ error: "Not found", error_type: "not_found" }, 404);
  }
  // One entry per record (a set spanning several transactions has a row per transaction for a record).
  const rows = setRecordStates(db, id);
  const records = rows
    .filter((r) => !(r.op === "delete" && r.existed === 0))
    .map((r) => ({ id: r.note_id, op: r.op, path: recordPath(db, r.note_id, r.before_row) }));
  return json({ ...project(db, set), records });
}

/**
 * `POST /api/write-sets/<id>/undo {force?, why?}` (0.9.4): undo one set, as a write set of its own. Own sets only,
 * or admin; a tag-scoped key only a set it can see whole (else 404, as GET answers).
 */
export async function handleUndo(
  req: Request,
  store: Store,
  id: string,
  auth: WriteSetsAuth & { actor: string | null },
  tagScope: TagScopeCtx,
): Promise<Response> {
  const db = store.db;
  const set = getWriteSet(db, id);
  if (!set || !setOwnedOrAdmin(set, auth) || !setVisible(db, id, tagScope)) {
    return json({ error: `No write set ${id} that this key may undo (or it is older than the change log keeps).`, error_type: "not_found" }, 404);
  }
  let body: Record<string, unknown> = {};
  const text = await req.text();
  if (text.trim()) {
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      return json({ error: "The body is a JSON object: {force?, why?}.", error_type: "invalid_request" }, 400);
    }
  }
  for (const k of Object.keys(body)) {
    if (k !== "force" && k !== "why") return json({ error: `undo takes force and why, not ${k}.`, error_type: "unknown_parameter", field: k }, 400);
  }
  if (body.force !== undefined && typeof body.force !== "boolean") return json({ error: "force is true or false.", error_type: "invalid_request", field: "force" }, 400);
  let why: string | null;
  try {
    why = normaliseWhy(body.why) ?? normaliseWhy(req.headers.get(WHY_HEADER));
  } catch (e) {
    return json({ error: (e as Error).message, error_type: "invalid_why", field: "why" }, 400);
  }
  const undoId = newWriteSetId();
  try {
    const result = await withWriteSet(store, { id: undoId, actor: auth.actor, via: auth.via, why, undoes: id }, () =>
      undoWriteSet(store, id, { force: body.force === true, actor: auth.actor, via: auth.via }),
    );
    if (tagScope.raw !== null) {
      // A scoped caller learns nothing beyond its scope: no other key's provenance on a forced write, and no id of a
      // missing link target (it may have been a record outside the scope), only how many links were skipped.
      return json({
        write_set: undoId,
        ...result,
        forced: result.forced.map((c) => ({ id: c.id, path: c.path, at: c.at })),
        links_skipped: result.links_skipped.length,
      });
    }
    return json({ write_set: undoId, ...result });
  } catch (e) {
    if (e instanceof UndoRefusal) {
      // A scoped caller never learns about records outside its scope through a conflict (it can see the whole set,
      // but a later write's key is provenance, which scoped reads don't show).
      const extra = tagScope.raw !== null && Array.isArray(e.extra.conflicts)
        ? { conflicts: (e.extra.conflicts as UndoConflict[]).map((c) => ({ id: c.id, path: c.path, at: c.at })) }
        : e.extra;
      return json({ error: e.message, error_type: e.error_type, ...extra }, e.status);
    }
    throw e;
  }
}
