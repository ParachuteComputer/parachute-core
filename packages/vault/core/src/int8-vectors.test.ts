// T-460 (1.0, no schema change): search vectors are written int8 under their model's int8 name, and the maintenance pass converts a vault's float32 rows
// in place, in bounded steps, from their own stored values (no re-embedding), without changing what search finds.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { initSchema } from "./schema.js";
import { normalize } from "./embedding/vector-codec.js";
import type { EmbeddingProvider, EmbedInput, EmbedResult } from "./embedding/provider.js";

const DIMS = 1024;
function fakeVector(text: string): Float32Array {
  const v = new Float32Array(DIMS);
  for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 131 + i * 7) % DIMS]! += ((text.charCodeAt(i) % 11) - 5) / 5;
  return v;
}
let embedded = 0;
class Fake implements EmbeddingProvider {
  readonly name = "fake"; readonly model = "fake-bge"; readonly dims = DIMS;
  async embed(input: EmbedInput): Promise<EmbedResult> { embedded += input.texts.length; return { vectors: input.texts.map(fakeVector), model: this.model, dims: DIMS }; }
  async available() { return { ok: true as const }; }
}
const topics = Array.from({ length: 300 }, (_, i) => `note ${i} about ${["gardens", "invoices", "trains", "meetings", "budgets", "recipes"][i % 6]} and ${["spring", "autumn", "travel", "tax", "plans"][i % 5]} ${i * 7}`);

test("a vault's float32 vectors are converted to int8 by the maintenance pass, in bounded steps, and search finds the same", async () => {
  const db = new Database(":memory:");
  const store = new SqliteStore(db, { embeddingProvider: new Fake(), history: { compact_budget_ms: 250 } });
  // The vault before: float32 rows under the plain model name, as the engine before wrote them.
  for (const [i, t] of topics.entries()) {
    const n = await store.createNote(t, { path: `t${i}` });
    db.prepare(`INSERT OR REPLACE INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at) VALUES (?, 0, ?, ?, 'fake-bge', 'x', 'now')`)
      .run(n.id, new Uint8Array(new Float32Array(normalize(fakeVector(t))).buffer), DIMS);
  }
  const bytes = () => (db.prepare("SELECT SUM(length(vector)) AS n FROM note_vectors").get() as { n: number }).n;
  const before = bytes();
  const rank = async (q: string) => (await store.semanticSearch(q, { limit: 10 })).notes.map((n) => n.path);
  const queries = ["gardens in spring", "tax invoices", "travel by train", "budget plans", "autumn recipes"];
  const ranked = await Promise.all(queries.map(rank));
  embedded = 0;
  const first = store.compactHistory({ budgetMs: null, maxNotes: null });
  expect(first.vectors_converted).toBe(300);
  expect(first.vectors_remaining).toBe(0);
  expect(embedded).toBe(0); // converted from what was stored, nothing re-embedded
  expect(db.prepare("SELECT COUNT(*) AS n FROM note_vectors WHERE model = 'fake-bge::int8' AND length(vector) = ?").get(4 + DIMS)).toEqual({ n: 300 });
  expect(bytes()).toBeLessThan(before / 3.9);
  const after = await Promise.all(queries.map(rank));
  // Same notes in each top 10; exact order may differ only where two scores sit within a quantisation step.
  for (let q = 0; q < queries.length; q++) expect(new Set(after[q])).toEqual(new Set(ranked[q]));
  expect(store.compactHistory({ budgetMs: null, maxNotes: null }).vectors_converted).toBe(0);
});

test("a pass with no budget converts nothing; a note's own pass converts no vectors; new embeddings are int8", async () => {
  const db = new Database(":memory:");
  const store = new SqliteStore(db, { embeddingProvider: new Fake() });
  const n = await store.createNote("one note", { path: "x" });
  db.prepare(`INSERT OR REPLACE INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at) VALUES (?, 0, ?, ?, 'fake-bge', 'x', 'now')`)
    .run(n.id, new Uint8Array(new Float32Array(normalize(fakeVector("one note"))).buffer), DIMS);
  expect(store.compactHistory({ budgetMs: 0, maxNotes: null }).vectors_converted).toBeUndefined();
  expect(store.compactHistory({ noteId: n.id }).vectors_converted).toBeUndefined();
  const { upsertNoteVector } = await import("./embedding/vectors.js");
  upsertNoteVector(db, n.id, { ix: 1, text: "more" }, normalize(fakeVector("more")), "fake-bge", "y");
  expect(db.prepare("SELECT model, length(vector) AS len FROM note_vectors WHERE note_id = ? AND chunk_ix = 1").get(n.id)).toEqual({ model: "fake-bge::int8", len: 4 + DIMS });
});

test("no schema change: the stamp stays, no column is added, and the index the conversion walks is an un-numbered step", () => {
  const db = new Database(":memory:");
  initSchema(db);
  const stamp = () => (db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v;
  expect(stamp()).toBe(32);
  db.exec("DROP INDEX idx_note_vectors_float32");
  initSchema(db); // the fast path notices the missing index and runs the step
  expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_note_vectors_float32'").get()).not.toBeNull();
  expect(stamp()).toBe(32);
  expect((db.prepare("SELECT name FROM pragma_table_info('note_vectors')").all() as { name: string }[]).map((c) => c.name).sort())
    .toEqual(["chunk_ix", "content_hash", "dims", "embedded_at", "model", "note_id", "vector"]);
});

test("search and the pending counts see a note's int8 rows: a converted note is neither pending nor stale", async () => {
  const { countNotesPendingEmbedding, getNotesPendingEmbedding, getNoteVectorRows, upsertNoteVector } = await import("./embedding/vectors.js");
  const { planStaleness, contentHash } = await import("./embedding/staleness.js");
  const { chunkNoteContent } = await import("./embedding/chunker.js");
  const db = new Database(":memory:");
  const store = new SqliteStore(db, { embeddingProvider: new Fake() });
  const n = await store.createNote("a note about gardens", { path: "g" });
  const chunks = chunkNoteContent("a note about gardens");
  for (const c of chunks) upsertNoteVector(db, n.id, c, normalize(fakeVector(c.text)), "fake-bge", contentHash(c.text));
  expect(countNotesPendingEmbedding(db, "fake-bge").pending).toBe(0);
  expect(getNotesPendingEmbedding(db, "fake-bge")).toEqual([]);
  expect(planStaleness(getNoteVectorRows(db, n.id), chunks, "fake-bge").stale).toEqual([]);
  expect((await store.semanticSearch("gardens", { limit: 3 })).notes[0]!.path).toBe("g");
  // Another active model still sees it as not embedded.
  expect(getNotesPendingEmbedding(db, "other-model").length).toBe(1);
});

test("a row that doesn't decode is left as it is and never stops the rest, over budgeted passes", async () => {
  const db = new Database(":memory:");
  const store = new SqliteStore(db, { embeddingProvider: new Fake() });
  for (const [i, t] of topics.slice(0, 250).entries()) {
    const n = await store.createNote(t, { path: `t${i}` });
    let bytes = new Uint8Array(new Float32Array(normalize(fakeVector(t))).buffer);
    if (i === 30) bytes = bytes.subarray(0, bytes.length - 1); // not whole floats
    if (i === 140) { const f = new Float32Array(normalize(fakeVector(t))); f[3] = NaN; bytes = new Uint8Array(f.buffer); }
    db.prepare(`INSERT OR REPLACE INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at) VALUES (?, 0, ?, ?, 'fake-bge', 'x', 'now')`).run(n.id, bytes, DIMS);
  }
  let converted = 0, failed = 0, passes = 0;
  for (; passes < 50; passes++) {
    const r = store.compactHistory({ budgetMs: 1, maxNotes: null });
    converted += r.vectors_converted ?? 0;
    failed += r.vectors_failed ?? 0;
    if (r.vectors_remaining === 2 && (r.vectors_converted ?? 0) === 0) break;
  }
  expect(converted).toBe(248);
  expect(passes).toBeGreaterThan(0);
  expect(db.prepare("SELECT COUNT(*) AS n FROM note_vectors WHERE model = 'fake-bge'").get()).toEqual({ n: 2 });
  expect((await store.semanticSearch("gardens", { limit: 5 })).notes.length).toBe(5);
});
