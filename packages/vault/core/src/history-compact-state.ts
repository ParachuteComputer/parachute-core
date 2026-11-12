import type { Database } from "bun:sqlite";
import { transaction } from "./txn.js";

/** Rebuild derived hints only, atomically; authoritative history is untouched. */
export function rebuildCompactState(db: Database): number {
  return transaction(db, () => {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_compact_state'").get()) {
      db.exec("DROP TABLE history_compact_state");
    }
    db.exec(`CREATE TABLE history_compact_state (
      note_id TEXT PRIMARY KEY, versions INTEGER NOT NULL, stored INTEGER NOT NULL,
      live INTEGER NOT NULL, refused INTEGER NOT NULL DEFAULT 0, refreshed_at INTEGER NOT NULL
    );
    CREATE INDEX idx_history_compact_candidates ON history_compact_state(refused, stored DESC);
    CREATE INDEX IF NOT EXISTS idx_note_versions_note_hash ON note_versions(note_id, content_hash);`);
    db.prepare(`INSERT INTO history_compact_state(note_id,versions,stored,live,refused,refreshed_at)
      SELECT note_id,versions,stored,live,0,? FROM (${COMPACT_STATE_AGGREGATE.replace("__FILTER__", "")})`).run(Date.now());
    return (db.prepare("SELECT COUNT(*) AS n FROM history_compact_state").get() as { n: number }).n;
  });
}

// Scheduling hints only. History remains authoritative, including for deleted notes.
export const COMPACT_STATE_AGGREGATE = `SELECT v.note_id,
  (SELECT COUNT(*) FROM note_versions n WHERE n.note_id=v.note_id AND n.content_hash IS NOT NULL) AS versions,
  SUM(b.byte_size) AS stored,
  COALESCE(LENGTH(CAST(live_note.content AS BLOB)),
    (SELECT content_len FROM note_versions newest WHERE newest.note_id=v.note_id ORDER BY version_ix DESC LIMIT 1),0) AS live
  FROM (SELECT DISTINCT note_id,content_hash FROM note_versions WHERE content_hash IS NOT NULL __FILTER__) v
  JOIN note_blobs b ON b.hash=v.content_hash LEFT JOIN notes live_note ON live_note.id=v.note_id
  GROUP BY v.note_id`;

export interface CompactState { note_id: string; versions: number; stored: number; live: number }
export function readCompactState(db: Database, noteId: string): CompactState | null {
  return db.prepare(COMPACT_STATE_AGGREGATE.replace("__FILTER__", "AND note_id=?")).get(noteId) as CompactState | null;
}

/**
 * Every note's hint row against what history says it should be (the full audit `scanCompactStateDrift` in doctor.ts
 * only samples). Read-only. A hint row for a note with no history, or a missing one, counts as drift. The `refused`
 * flag is a real decision, not derived, so it is not compared. The two reads are NOT one snapshot by themselves:
 * the caller runs this inside a read transaction (a write between them would count as drift).
 */
export function compactStateDrift(db: Database): { checked: number; drifted: number } {
  const has = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (!has("note_versions") || !has("note_blobs")) return { checked: 0, drifted: 0 };
  const actual = db.prepare(COMPACT_STATE_AGGREGATE.replace("__FILTER__", "")).all() as CompactState[];
  const stored = new Map<string, CompactState>();
  if (has("history_compact_state")) {
    for (const row of db.prepare("SELECT note_id,versions,stored,live FROM history_compact_state").all() as CompactState[]) stored.set(row.note_id, row);
  }
  let drifted = 0;
  for (const a of actual) {
    const s = stored.get(a.note_id);
    if (!s || s.versions !== a.versions || s.stored !== a.stored || s.live !== a.live) drifted++;
    stored.delete(a.note_id);
  }
  return { checked: actual.length, drifted: drifted + stored.size };
}

/** Caller owns the enclosing write transaction; run after the live-row mutation. */
export function refreshCompactState(db: Database, noteId: string, opts?: { refused?: boolean }): void {
  // Keep the existing graceful behavior of writes before history tables exist.
  const tables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('note_versions','note_blobs','history_compact_state')").get() as { n: number };
  if (tables.n !== 3) return;
  const state = readCompactState(db, noteId);
  if (!state) {
    db.prepare("DELETE FROM history_compact_state WHERE note_id=?").run(noteId);
    return;
  }
  db.prepare(`INSERT INTO history_compact_state(note_id,versions,stored,live,refused,refreshed_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(note_id) DO UPDATE SET
    versions=excluded.versions,stored=excluded.stored,live=excluded.live,
    refused=excluded.refused,refreshed_at=excluded.refreshed_at`)
    .run(noteId, state.versions, state.stored, state.live, opts?.refused ? 1 : 0, Date.now());
}
