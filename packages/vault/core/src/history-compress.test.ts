// T-460 release B: version bodies are written compressed, compaction is always on, and the bounded maintenance pass
// re-encodes a vault the older engine wrote (whole text and base64 deltas) without losing or changing a body.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteStore } from "./store.js";
import * as h from "./history.js";
import { initSchema } from "./schema.js";
import { encodeDelta } from "./delta.js";
import { auditHistoryBlobs } from "./doctor.js";

let db: Database, store: BunSqliteStore;
beforeEach(() => { db = new Database(":memory:"); store = new BunSqliteStore(db); });
afterEach(() => db.close());

const encodings = () => Object.fromEntries((db.prepare("SELECT COALESCE(encoding, 'text') AS e, COUNT(*) AS n FROM note_blobs GROUP BY e").all() as { e: string; n: number }[]).map((r) => [r.e, r.n]));
const stored = () => (db.prepare("SELECT COALESCE(SUM(byte_size), 0) AS n FROM note_blobs").get() as { n: number }).n;
async function everyBody() {
  const out = new Map<string, string>();
  for (const { id } of db.prepare("SELECT DISTINCT note_id AS id FROM note_versions").all() as { id: string }[])
    for (const v of await store.listNoteVersions(id, { limit: 1000 }))
      out.set(`${id}@${v.version_ix}`, (await store.getNoteVersion(id, v.version_ix))!.content!);
  return out;
}
const prose = (i: number) => `# Meeting ${i}\n\n` + Array.from({ length: 60 }, (_, k) => `- item ${k}: notes about the plan, owner ${k % 7}, due day ${(k * i) % 28}`).join("\n");

test("a capture stores a body deflated when that is smaller, and a short one as text", async () => {
  const n = await store.createNote(prose(0));
  await store.updateNote(n.id, { content: "short" });
  await store.updateNote(n.id, { content: prose(1) });
  const rows = db.prepare("SELECT b.encoding, b.byte_size, v.content_len FROM note_versions v JOIN note_blobs b ON b.hash = v.content_hash WHERE v.note_id = ? ORDER BY v.version_ix").all(n.id) as { encoding: string | null; byte_size: number; content_len: number }[];
  expect(rows[0]).toMatchObject({ encoding: "deflate" });
  expect(rows[0]!.byte_size).toBeLessThan(rows[0]!.content_len / 2);
  expect(rows[1]).toEqual({ encoding: null, byte_size: 5, content_len: 5 });
  expect((await store.getNoteVersion(n.id, 0))!.content).toBe(prose(0));
  expect((await store.getNoteVersion(n.id, 1))!.content).toBe("short");
});

/** A vault as the engine before T-460 left it: whole bodies as text, compacted notes as base64 deltas, stamped 32. */
async function legacyVault(notes: number, edits: number) {
  const old = h.resolveHistoryPolicy({ compact_ratio: 3, compact_min_versions: 10 });
  const ids: string[] = [];
  for (let i = 0; i < notes; i++) {
    const n = await store.createNote(prose(i * 100), { path: `legacy/${i}` });
    for (let k = 1; k <= edits; k++) await store.updateNote(n.id, { content: `${prose(i * 100)}\n- edit ${k}` });
    ids.push(n.id);
  }
  // One note with a single version: only the "holds legacy blobs" reason makes it a candidate.
  const single = await store.createNote(prose(5000), { path: "legacy/single" });
  await store.updateNote(single.id, { content: `${prose(5000)}\n- one edit` });
  // Rewrite every blob the old way: text, and for half the notes the old compactor's base64 deltas.
  for (const b of db.prepare("SELECT hash FROM note_blobs").all() as { hash: string }[]) {
    const text = h.readBlobContent(db, b.hash)!;
    db.prepare("UPDATE note_blobs SET content = ?, byte_size = ?, encoding = NULL, delta_of = NULL WHERE hash = ?").run(text, h.byteLength(text), b.hash);
  }
  for (const id of ids.slice(0, notes / 2)) {
    const rows = db.prepare("SELECT content_hash FROM note_versions WHERE note_id = ? ORDER BY version_ix DESC").all(id) as { content_hash: string }[];
    const base = rows[0]!.content_hash, baseText = h.readBlobContent(db, base)!;
    for (const r of rows.slice(1)) {
      const payload = encodeDelta(baseText, h.readBlobContent(db, r.content_hash)!);
      db.prepare("UPDATE note_blobs SET content = ?, byte_size = ?, encoding = 'fossil-delta', delta_of = ? WHERE hash = ?").run(payload, payload.length, base, r.content_hash);
    }
  }
  // The old hints table and stamp: what the v33 migration starts from.
  db.exec(`DROP TABLE history_compact_state; CREATE TABLE history_compact_state (note_id TEXT PRIMARY KEY, versions INTEGER NOT NULL,
    stored INTEGER NOT NULL, live INTEGER NOT NULL, refused INTEGER NOT NULL DEFAULT 0, refreshed_at INTEGER NOT NULL);
    INSERT INTO history_compact_state SELECT note_id, COUNT(*), 0, 0, 1, 0 FROM note_versions GROUP BY note_id;
    DELETE FROM schema_version; INSERT INTO schema_version (version, applied_at) VALUES (32, '2026-11-01T00:00:00.000Z');`);
  void old;
  return ids;
}

test("the maintenance pass re-encodes a legacy vault in bounded batches: nothing lost, every body exact, far smaller", async () => {
  await legacyVault(8, 6);
  const before = await everyBody();
  const bytesBefore = stored();
  expect(encodings()).toEqual({ text: 29, "fossil-delta": 20 });
  initSchema(db); // v33: the hints gain `legacy` and every refusal is cleared
  const passes: h.CompactSummary[] = [];
  for (let i = 0; i < 20; i++) {
    const p = store.compactHistory({ maxNotes: 3, budgetMs: null });
    passes.push(p);
    expect(p.notes_scanned).toBeLessThanOrEqual(3);
    expect(p.notes_failed).toBe(0);
    if (p.stopped_by === "complete" && p.notes_scanned === 0) break;
  }
  expect(passes.length).toBeLessThan(6);
  expect(passes.reduce((a, p) => a + p.notes_compacted, 0)).toBe(9);
  const after = encodings();
  expect(after.text ?? 0).toBe(0);
  expect(after["fossil-delta"] ?? 0).toBe(0);
  expect(after["fossil-delta-z"]).toBe(40);
  expect(after.deflate).toBe(9);
  expect(await everyBody()).toEqual(before);
  expect(stored()).toBeLessThan(bytesBefore / 4);
  expect(h.historyStorageStats(db).orphan_deltas).toBe(0);
  expect(auditHistoryBlobs(db, "", 500, 1000)).toMatchObject({ checked: 49, corrupt: 0 });
  // Converged: the next pass finds nothing, and a new edit makes its note a candidate again.
  expect(store.compactHistory({ maxNotes: null, budgetMs: null }).notes_scanned).toBe(0);
  const id = (db.prepare("SELECT id FROM notes WHERE path = 'legacy/3'").get() as { id: string }).id;
  await store.updateNote(id, { content: `${prose(300)}\n- edit 7` });
  const again = store.compactHistory({ maxNotes: null, budgetMs: null });
  expect(again).toMatchObject({ notes_scanned: 1, notes_failed: 0 });
  const now = await everyBody();
  for (const [k, text] of before) expect(now.get(k)).toBe(text);
});

test("an imported history is stored compressed too, and reads back exact", async () => {
  const { beginImportRun, applyImportedNote, importTargetDigest } = await import("./history-import.js");
  const n = await store.createNote(prose(7));
  const run = { run_id: "r", source_fingerprint: "s", tip: "t", options_digest: "o" };
  beginImportRun(db, run);
  const observations = [1, 2, 3].map((k) => ({ content: prose(k), path: null, metadata: {}, extension: "md", created_at: null, observed_at: `2020-0${k}-01T00:00:00.000Z`, commit: `c${k}`, blob: `b${k}` }));
  applyImportedNote(db, { run, noteId: n.id, targetDigest: importTargetDigest(db, n.id), policy: h.resolveHistoryPolicy({}), now: Date.now(), observations });
  expect(encodings().text ?? 0).toBe(0);
  const bodies = [...(await everyBody()).values()].sort();
  expect(bodies).toEqual([prose(1), prose(2), prose(3)].sort());
});

test("a pass after every write keeps the star: the base stays until it slides out of the newest run", async () => {
  const s2 = new BunSqliteStore(db, { history: { compact_budget_ms: 0, max_versions: 1000 } });
  const page = (k: number) => Array.from({ length: 500 }, (_, i) => `row ${i}: a made-up ledger line${i === k % 500 ? `, edited ${k}` : ""}`).join("\n");
  const n = await s2.createNote(page(0));
  for (let k = 1; k <= 96; k++) {
    await s2.updateNote(n.id, { content: page(k) });
    s2.compactHistory({ budgetMs: null, maxNotes: null });
  }
  const whole = (db.prepare("SELECT COUNT(*) AS n FROM note_blobs WHERE encoding IS NULL OR encoding = 'deflate'").get() as { n: number }).n;
  expect(whole).toBeLessThanOrEqual(6);
  for (let ix = 0; ix < 96; ix += 7) expect((await s2.getNoteVersion(n.id, ix))!.content).toBe(page(ix));
});

test("a note whose pass fails waits for its next write instead of taking every pass", async () => {
  const n = await store.createNote(prose(1));
  for (let k = 2; k <= 6; k++) await store.updateNote(n.id, { content: prose(k) });
  // A depth-two chain (damage the old engine could leave): compactNote refuses the note.
  const [a, b] = (db.prepare("SELECT content_hash AS h FROM note_versions WHERE note_id = ? ORDER BY version_ix DESC LIMIT 2").all(n.id) as { h: string }[]).map((r) => r.h);
  db.prepare("UPDATE note_blobs SET encoding = 'fossil-delta-z', delta_of = ? WHERE hash = ?").run(b, a);
  db.prepare("UPDATE note_blobs SET encoding = 'fossil-delta-z', delta_of = ? WHERE hash = ?").run(a, b);
  expect(store.compactHistory({ budgetMs: null, maxNotes: null })).toMatchObject({ notes_scanned: 1, notes_failed: 1 });
  expect(store.compactHistory({ budgetMs: null, maxNotes: null }).notes_scanned).toBe(0);
});

test("the hints table the engine before 33 rebuilt (no legacy column) is healed on the next open, and writes work", async () => {
  const n = await store.createNote(prose(1));
  await store.updateNote(n.id, { content: prose(2) });
  // What `history rebuild-state` on the engine before 33 leaves in a v33 vault: the old table, the stamp still 33.
  db.exec(`DROP TABLE history_compact_state; CREATE TABLE history_compact_state (note_id TEXT PRIMARY KEY, versions INTEGER NOT NULL,
    stored INTEGER NOT NULL, live INTEGER NOT NULL, refused INTEGER NOT NULL DEFAULT 0, refreshed_at INTEGER NOT NULL)`);
  initSchema(db);
  await store.updateNote(n.id, { content: prose(3) });
  expect(store.compactHistory({ budgetMs: null, maxNotes: null }).notes_failed).toBe(0);
  expect((await store.getNoteVersion(n.id, 0))!.content).toBe(prose(1));
});

test("a re-encode that doesn't read back is never written: the blob keeps its old bytes", async () => {
  const codec = await import("./blob-codec.js");
  await legacyVault(2, 4);
  const before = await everyBody();
  const raw = db.prepare("SELECT hash, content, encoding FROM note_blobs ORDER BY hash").all();
  const { spyOn } = await import("bun:test");
  const real = codec.deflateBytes;
  const mock = spyOn(codec, "deflateBytes").mockImplementation((b: Uint8Array) => real(b).subarray(0, 3));
  try {
    initSchema(db);
    const r = store.compactHistory({ budgetMs: null, maxNotes: null });
    expect(r.notes_failed).toBe(0);
    expect(r.blobs_compressed + r.blobs_deltified).toBe(0);
  } finally { mock.mockRestore(); }
  expect(db.prepare("SELECT hash, content, encoding FROM note_blobs ORDER BY hash").all()).toEqual(raw);
  expect(await everyBody()).toEqual(before);
});

test("pruning a hot note past its ceiling leaves no stranded bases: a freed delta's base goes too", async () => {
  const s2 = new BunSqliteStore(db, { history: { compact_budget_ms: 0, max_versions: 30, min_versions: 5 } });
  const page = (k: number) => Array.from({ length: 300 }, (_, i) => `row ${i}: a made-up ledger line${i === k % 300 ? `, edited ${k}` : ""}`).join("\n");
  const n = await s2.createNote(page(0));
  for (let k = 1; k <= 200; k++) {
    await s2.updateNote(n.id, { content: page(k) });
    s2.compactHistory({ budgetMs: null, maxNotes: null });
  }
  const stranded = db.prepare(`SELECT COUNT(*) AS n FROM note_blobs b WHERE NOT EXISTS (SELECT 1 FROM note_versions v WHERE v.content_hash = b.hash)
    AND NOT EXISTS (SELECT 1 FROM note_blobs d WHERE d.delta_of = b.hash)`).get() as { n: number };
  expect(stranded.n).toBe(0);
  expect(await s2.countNoteVersions(n.id)).toBe(30);
  for (const v of await s2.listNoteVersions(n.id, { limit: 100 })) expect((await s2.getNoteVersion(n.id, v.version_ix))!.content).toBe(page(v.version_ix));
});
