// T-460: what this engine reads ahead of the release that writes it (schema 34): search vectors stored as int8, and
// marked versions, which pruning and the byte ceiling must keep, so that release can be rolled back to this one.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { encodeInt8, decodeInt8, normalize, dot } from "./embedding/vector-codec.js";
import { resolveHistoryPolicy, pruneVersions, compactNote } from "./history.js";
import type { EmbeddingProvider, EmbedInput, EmbedResult } from "./embedding/provider.js";

const DIMS = 64;
/** A made-up embedding: deterministic per text, so a query ranks notes the same way every run. */
function fakeVector(text: string): Float32Array {
  const v = new Float32Array(DIMS);
  for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 31 + i) % DIMS]! += ((text.charCodeAt(i) % 7) - 3) / 3;
  return v;
}
class Fake implements EmbeddingProvider {
  readonly name = "fake"; readonly model = "fake-model"; readonly dims = DIMS;
  async embed(input: EmbedInput): Promise<EmbedResult> { return { vectors: input.texts.map(fakeVector), model: this.model, dims: DIMS }; }
  async available() { return { ok: true as const }; }
}

test("int8 round trip: a float32 scale then signed bytes, within half a step of the original", () => {
  const v = normalize(fakeVector("a made-up sentence about the plan"));
  const bytes = encodeInt8(v);
  expect(bytes.byteLength).toBe(4 + DIMS);
  const back = decodeInt8(bytes.slice().buffer);
  const step = Math.max(...v.map(Math.abs)) / 127;
  for (let i = 0; i < DIMS; i++) expect(Math.abs(back[i]! - v[i]!)).toBeLessThanOrEqual(step / 2 + 1e-7);
  expect(dot(back, v)).toBeGreaterThan(0.99);
  expect(() => decodeInt8(new Uint8Array(3))).toThrow();
});

test("search reads int8 rows once the codec column exists, ranks as float32 did, and leaves out a row it can't read", async () => {
  const db = new Database(":memory:");
  const store = new SqliteStore(db, { embeddingProvider: new Fake() });
  const words = ["garden soil compost", "invoice payment due", "meeting notes plan", "garden tomatoes water", "travel train tickets", "plan budget review"];
  for (const [i, w] of words.entries()) {
    const n = await store.createNote(`${w} ${i}`, { path: `n${i}` });
    db.prepare(`INSERT INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at) VALUES (?, 0, ?, ?, 'fake-model', 'x', 'now')`)
      .run(n.id, new Uint8Array(new Float32Array(normalize(fakeVector(`${w} ${i}`))).buffer), DIMS);
  }
  // The scored notes, best first (a note with no readable vector comes back unscored, as pending).
  const ranking = async (q: string) => (await store.semanticSearch(q, { limit: 6 })).notes.filter((n) => n.score !== undefined).map((n) => n.path);
  const before = [await ranking("garden water"), await ranking("plan review")];
  db.exec("ALTER TABLE note_vectors ADD COLUMN codec TEXT");
  for (const r of db.prepare("SELECT rowid, vector FROM note_vectors").all() as { rowid: number; vector: Uint8Array }[]) {
    const f = new Float32Array(new Uint8Array(r.vector).buffer);
    db.prepare("UPDATE note_vectors SET vector = ?, codec = 'int8' WHERE rowid = ?").run(encodeInt8(f), r.rowid);
  }
  expect([await ranking("garden water"), await ranking("plan review")]).toEqual(before);
  db.prepare("UPDATE note_vectors SET codec = 'pq4' WHERE note_id = (SELECT id FROM notes WHERE path = 'n0')").run();
  const after = await ranking("garden water");
  expect(after).not.toContain("n0");
  expect(after.length).toBe(5);
});

test("a marked version survives pruning and the byte ceiling once the marks column exists", async () => {
  const db = new Database(":memory:");
  const store = new SqliteStore(db, { history: { burst_window_seconds: 0 } as never });
  // Random hex: it doesn't compress much, so the ceiling (compressed bytes) is really reached.
  const big = (k: number) => `${k} ` + Buffer.from(crypto.getRandomValues(new Uint8Array(30_000))).toString("hex");
  const n = await store.createNote(big(0));
  for (let k = 1; k <= 12; k++) await store.updateNote(n.id, { content: big(k) });
  db.exec("ALTER TABLE note_versions ADD COLUMN marked_at TEXT; ALTER TABLE note_versions ADD COLUMN marked_by TEXT");
  db.prepare("UPDATE note_versions SET marked_at = 'now', marked_by = 'ann' WHERE note_id = ? AND version_ix = 1").run(n.id);
  pruneVersions(db, n.id, resolveHistoryPolicy({ min_versions: 1, max_versions: 3 }));
  const left = () => (db.prepare("SELECT version_ix FROM note_versions WHERE note_id = ? ORDER BY version_ix").all(n.id) as { version_ix: number }[]).map((r) => r.version_ix);
  expect(left()).toEqual([1, 9, 10, 11]);
  compactNote(db, n.id, resolveHistoryPolicy({ min_versions: 1, max_bytes_per_note: 65_536 }));
  expect(left()).toContain(1);
  expect(left()).not.toContain(9);
  expect((await store.getNoteVersion(n.id, 1))!.content!.startsWith("1 ")).toBe(true);
});

test("this release re-embedding over a row the newer release stored as int8 writes float32 and says so", async () => {
  const { upsertNoteVector } = await import("./embedding/vectors.js");
  const db = new Database(":memory:");
  const store = new SqliteStore(db, { embeddingProvider: new Fake() });
  db.exec("ALTER TABLE note_vectors ADD COLUMN codec TEXT");
  const words = ["garden soil compost", "invoice payment due", "meeting notes plan"];
  for (const [i, w] of words.entries()) {
    const n = await store.createNote(`${w} ${i}`, { path: `n${i}` });
    db.prepare(`INSERT INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at, codec) VALUES (?, 0, ?, ?, 'fake-model', 'x', 'now', 'int8')`)
      .run(n.id, encodeInt8(normalize(fakeVector(`${w} ${i}`))), DIMS);
  }
  const n0 = (db.prepare("SELECT id FROM notes WHERE path = 'n0'").get() as { id: string }).id;
  upsertNoteVector(db, n0, { ix: 0, text: "garden soil compost 0" }, normalize(fakeVector("garden soil compost 0")), "fake-model", "y");
  expect(db.prepare("SELECT codec, length(vector) AS len FROM note_vectors WHERE note_id = ?").get(n0)).toEqual({ codec: null, len: DIMS * 4 });
  const r = await store.semanticSearch("garden soil", { limit: 3 });
  expect(r.notes.filter((n) => n.score !== undefined).length).toBe(3);
  expect(r.notes[0]!.path).toBe("n0");
});

test("a vector whose length doesn't match its row's dims is never scored: left out and counted pending", async () => {
  const db = new Database(":memory:");
  const store = new SqliteStore(db, { embeddingProvider: new Fake() });
  db.exec("ALTER TABLE note_vectors ADD COLUMN codec TEXT");
  for (const [i, w] of ["alpha beta", "gamma delta"].entries()) {
    const n = await store.createNote(w, { path: `m${i}` });
    // m1: float32 bytes labelled int8, the shape a mislabelled row would have.
    const bytes = i === 0 ? encodeInt8(normalize(fakeVector(w))) : new Uint8Array(new Float32Array(normalize(fakeVector(w))).buffer);
    db.prepare(`INSERT INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at, codec) VALUES (?, 0, ?, ?, 'fake-model', 'x', 'now', 'int8')`).run(n.id, bytes, DIMS);
  }
  const r = await store.semanticSearch("alpha", { limit: 5 });
  expect(r.notes.filter((n) => n.score !== undefined).map((n) => n.path)).toEqual(["m0"]);
  expect(r.pendingCount).toBe(1);
  expect(() => encodeInt8(new Float32Array([0.5, NaN]))).toThrow();
});

test("the deleted-history sweep keeps a marked version", async () => {
  const { sweepDeletedHistory } = await import("./history.js");
  const db = new Database(":memory:");
  const store = new SqliteStore(db);
  const n = await store.createNote("v0");
  await store.updateNote(n.id, { content: "v1" });
  await store.updateNote(n.id, { content: "v2" });
  await store.deleteNote(n.id);
  db.exec("ALTER TABLE note_versions ADD COLUMN marked_at TEXT; ALTER TABLE note_versions ADD COLUMN marked_by TEXT");
  db.prepare("UPDATE note_versions SET marked_at = 'now' WHERE note_id = ? AND version_ix = 0").run(n.id);
  sweepDeletedHistory(db, resolveHistoryPolicy({ deleted_retention_days: 1 }), new Date(Date.now() + 3 * 86_400_000));
  expect((db.prepare("SELECT version_ix FROM note_versions WHERE note_id = ?").all(n.id) as { version_ix: number }[]).map((r) => r.version_ix)).toEqual([0]);
  expect((await store.getNoteVersion(n.id, 0))!.content).toBe("v0");
});
