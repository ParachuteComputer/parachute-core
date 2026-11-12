/**
 * `note_vectors` CRUD — the small, pure-SQL surface the embed-on-write
 * hook (registered in `src/`, self-host; the DO-alarm drain, cloud) uses
 * to apply a `StalenessPlan` (see `staleness.ts`). Kept separate from
 * `notes.ts`'s read-side `semanticSearchNotes` scan so the write-path
 * helpers here have no dependency on the ranking/cosine code, and vice
 * versa.
 */

import { Database } from "bun:sqlite";
import { decodeVector, encodeInt8, int8Model, baseModel, INT8_MODEL_SUFFIX } from "./vector-codec.js";
import type { Chunk } from "./chunker.js";
import type { ExistingVectorRow } from "./staleness.js";
import { transaction } from "../txn.js";

/**
 * SQL fragment: `<colRef>` (a `content` column reference — bare `content`
 * or an aliased `n.content`) is non-blank. A blank/whitespace-only note
 * has nothing embeddable (see `embedding-worker.ts`'s chunk filter) and
 * NEVER gets a `note_vectors` row, so every "which notes still need
 * embedding" query — the backfill-sweep candidate list
 * (`getNotesPendingEmbedding`), the progress count
 * (`countNotesPendingEmbedding`), and the semantic-search scan's own
 * `pendingCount` (`notes.ts:semanticSearchNotes`) — must exclude it, or a
 * vault with even one blank note carries a permanent phantom "pending"
 * count that never drains.
 *
 * SQLite's `TRIM(x)` (no second arg) only strips literal SPACE
 * characters, unlike JS's `.trim()` — a note that's only tabs/newlines
 * would slip through a bare `TRIM(content) = ''` check. `TRIM(x, y)`'s
 * second-argument form strips every character IN `y` from both ends, so
 * passing the space/tab/LF/VT/FF/CR set (`char(32,9,10,11,12,13)`) makes
 * this match JS whitespace semantics closely enough for a "nothing here"
 * check (exotic Unicode whitespace isn't covered — not worth the
 * complexity for a defensive filter, not user-facing validation).
 */
export function nonBlankContentClause(colRef: string): string {
  return `TRIM(COALESCE(${colRef}, ''), char(32,9,10,11,12,13)) != ''`;
}

/**
 * Read a note's existing `note_vectors` rows — the shape `planStaleness` diffs against. A row's model is given
 * without the int8 marker (T-460): an int8 row is as fresh as the float32 row it replaced.
 */
export function getNoteVectorRows(db: Database, noteId: string): ExistingVectorRow[] {
  return (db
    .prepare("SELECT chunk_ix, model, content_hash FROM note_vectors WHERE note_id = ?")
    .all(noteId) as ExistingVectorRow[]).map((r) => ({ ...r, model: baseModel(r.model) }));
}

/** The SQL test for a row that isn't int8 yet: what the conversion walks, and its partial index's WHERE. */
export const FLOAT32_ROW_SQL = `model NOT LIKE '%${INT8_MODEL_SUFFIX}'`;

/**
 * Delete specific obsolete chunk rows for a note — the "cheap sync write"
 * that keeps a shrunk note (or a model change) from leaving a ghost
 * vector that `semanticSearchNotes` would otherwise still rank against.
 * No-op on an empty list (avoids an `IN ()` syntax error).
 */
export function deleteObsoleteVectorRows(db: Database, noteId: string, obsoleteIxs: number[]): void {
  if (obsoleteIxs.length === 0) return;
  const placeholders = obsoleteIxs.map(() => "?").join(", ");
  db.prepare(`DELETE FROM note_vectors WHERE note_id = ? AND chunk_ix IN (${placeholders})`).run(
    noteId,
    ...obsoleteIxs,
  );
}

/**
 * Write (insert or replace) one chunk's embedded vector. Replace-by-PK
 * semantics — a re-embed (content changed, or the model changed)
 * overwrites the existing `(note_id, chunk_ix)` row in place; a vault
 * never carries two models' vectors for the same chunk simultaneously
 * (see the `note_vectors` schema doc comment).
 */
export function upsertNoteVector(
  db: Database,
  noteId: string,
  chunk: Chunk,
  vector: Float32Array,
  model: string,
  contentHash: string,
): void {
  db.prepare(
    `INSERT INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (note_id, chunk_ix) DO UPDATE SET
       vector = excluded.vector,
       dims = excluded.dims,
       model = excluded.model,
       content_hash = excluded.content_hash,
       embedded_at = excluded.embedded_at`,
  ).run(noteId, chunk.ix, encodeInt8(vector), vector.length, int8Model(model), contentHash, new Date().toISOString());
}

/**
 * Convert float32 rows to int8 in place (T-460), part of the bounded maintenance pass: up to `maxRows` rows, stopping
 * once `budgetMs` is spent (checked between batches of 100). Each row is re-encoded from its own stored float32, so
 * nothing is re-embedded; the row moves to its model's int8 name (vector-codec.ts). A row that doesn't decode (a length
 * that isn't whole floats, a non-finite value) is left as it is and counted in `failed`: search already leaves it
 * out, and it never stops the rest. Walks the partial index of float32 rows in key order (empty once converted).
 * Returns how many it converted, how many failed, and how many float32 rows are left (the failed ones included).
 */
export function convertVectorsToInt8(db: Database, opts: { budgetMs: number | null; maxRows: number }): { converted: number; failed: number; remaining: number } {
  const started = performance.now();
  const select = db.prepare(`SELECT note_id, chunk_ix, vector, model FROM note_vectors INDEXED BY idx_note_vectors_float32
    WHERE ${FLOAT32_ROW_SQL} AND (note_id, chunk_ix) > (?, ?) ORDER BY note_id, chunk_ix LIMIT ?`);
  const update = db.prepare(`UPDATE note_vectors SET vector = ?, model = ? WHERE note_id = ? AND chunk_ix = ? AND model = ?`);
  let converted = 0, failed = 0, afterNote = "", afterIx = -1;
  while (converted + failed < opts.maxRows) {
    const rows = select.all(afterNote, afterIx, Math.min(100, opts.maxRows - converted - failed)) as { note_id: string; chunk_ix: number; vector: Uint8Array; model: string }[];
    if (rows.length === 0) break;
    transaction(db, () => {
      for (const r of rows) {
        afterNote = r.note_id;
        afterIx = r.chunk_ix;
        let bytes: Uint8Array;
        try {
          bytes = encodeInt8(decodeVector(new Uint8Array(r.vector)));
        } catch {
          failed++;
          continue;
        }
        if (update.run(bytes, int8Model(r.model), r.note_id, r.chunk_ix, r.model).changes > 0) converted++;
      }
    });
    if (opts.budgetMs !== null && performance.now() - started >= opts.budgetMs) break;
  }
  const remaining = (db.prepare(`SELECT COUNT(*) AS n FROM note_vectors INDEXED BY idx_note_vectors_float32 WHERE ${FLOAT32_ROW_SQL}`).get() as { n: number }).n;
  return { converted, failed, remaining };
}

/**
 * Count notes that have zero `note_vectors` rows under `model` — the same
 * "pending" definition `semanticSearchNotes`/`getNotesPendingEmbedding`
 * use (see `nonBlankContentClause`'s doc for why blank notes are excluded
 * from `total`, not just `pending` — otherwise `pending` could go
 * negative, or a vault with only blank notes would report 100% pending
 * forever). Used by the `embeddings` capability field (`GET /api/vault`)
 * to report backfill progress without a full semantic scan.
 */
export function countNotesPendingEmbedding(db: Database, model: string): { total: number; pending: number } {
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM notes WHERE ${nonBlankContentClause("content")}`).get() as { n: number }
  ).n;
  const embedded = (
    db
      .prepare("SELECT COUNT(DISTINCT note_id) AS n FROM note_vectors WHERE model IN (?, ?)")
      .get(model, int8Model(model)) as { n: number }
  ).n;
  return { total, pending: Math.max(0, total - embedded) };
}

/**
 * Notes with zero `note_vectors` rows under `model` — the actual
 * candidate list (not just a count) the self-host in-process drain and
 * the cloud DO-alarm drain walk to backfill/catch up a vault. A note with
 * SOME but not all chunks embedded (a partial prior embed, e.g. a crash
 * mid-drain) is NOT returned here — see the module doc on
 * `countNotesPendingEmbedding` for the same coarse-but-honest tradeoff;
 * the embed-on-write hook re-derives full freshness per note via
 * `planStaleness`, so a partially-embedded note self-heals on its next
 * edit even if the sweep doesn't re-visit it.
 *
 * Excludes blank/whitespace-only notes — see `nonBlankContentClause`'s
 * doc comment for why (they'd otherwise be "pending" FOREVER, hammering
 * the provider with empty input every sweep pass forever).
 */
export function getNotesPendingEmbedding(
  db: Database,
  model: string,
  limit?: number,
): { id: string; content: string }[] {
  const sql = `SELECT id, content FROM notes
    WHERE id NOT IN (SELECT DISTINCT note_id FROM note_vectors WHERE model IN (?, ?))
      AND ${nonBlankContentClause("content")}${typeof limit === "number" ? " LIMIT ?" : ""}`;
  const params: (string | number)[] = typeof limit === "number" ? [model, int8Model(model), limit] : [model, int8Model(model)];
  return db.prepare(sql).all(...params) as { id: string; content: string }[];
}
