// T-460 release A: every engine reads the compact encodings (deflate, fossil-delta-z) before any engine writes them,
// so rolling a release back still reads every version. These tests write the new encodings by hand, as the next
// release will, and read them through the store's own doors.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteStore } from "./store.js";
import * as h from "./history.js";
import { auditHistoryBlobs } from "./doctor.js";
import { deflateBytes } from "./blob-codec.js";
import { createDeltaBytes, encodeDelta } from "./delta.js";

let db: Database, store: BunSqliteStore;
beforeEach(() => { db = new Database(":memory:"); store = new BunSqliteStore(db); });
afterEach(() => db.close());

const utf8 = (s: string) => new TextEncoder().encode(s);
const set = (hash: string, content: string | Uint8Array, encoding: string | null, deltaOf: string | null) =>
  db.prepare("UPDATE note_blobs SET content = ?, byte_size = ?, encoding = ?, delta_of = ? WHERE hash = ?")
    .run(content, typeof content === "string" ? content.length : content.byteLength, encoding, deltaOf, hash);

/** A note with `count` prior versions, each body a few kB of text with an emoji and an accent in it. */
async function seed(count: number) {
  const body = "Ünïcode café ☕ line\n".repeat(400);
  const n = await store.createNote(body, { path: "codec" });
  for (let i = 0; i < count; i++) await store.updateNote(n.id, { content: body + `edit ${i} 🪂\n`.repeat(i + 1) });
  const versions = (await store.listNoteVersions(n.id, { limit: 100 })).sort((a, b) => a.version_ix - b.version_ix);
  const bodies = new Map<number, string>();
  for (const v of versions) bodies.set(v.version_ix, (await store.getNoteVersion(n.id, v.version_ix))!.content!);
  return { id: n.id, versions, bodies };
}
async function readAll(id: string, ixs: number[]) {
  return new Map(await Promise.all(ixs.map(async (ix) => [ix, (await store.getNoteVersion(id, ix))!.content!] as const)));
}

test("every encoding reads back to the exact body: deflate, fossil-delta-z, and fossil-delta on a deflated base", async () => {
  const { id, versions, bodies } = await seed(5);
  const [v0, v1, v2, v3, v4] = versions.map((v) => ({ ix: v.version_ix, hash: v.content_hash!, text: bodies.get(v.version_ix)! }));
  set(v0!.hash, deflateBytes(utf8(v0!.text)), "deflate", null);
  set(v1!.hash, deflateBytes(createDeltaBytes(v0!.text, v1!.text)), "fossil-delta-z", v0!.hash);
  set(v2!.hash, encodeDelta(v0!.text, v2!.text), "fossil-delta", v0!.hash);
  set(v3!.hash, deflateBytes(utf8(v3!.text)), "deflate", null);
  // v4 stays NULL (whole text); a delta-z against a NULL base reads too.
  const extra = await store.createNote(v4!.text + "x");
  await store.updateNote(extra.id, { content: "short now" });
  const xv = (await store.listNoteVersions(extra.id))[0]!;
  set(xv.content_hash!, deflateBytes(createDeltaBytes(v4!.text, v4!.text + "x")), "fossil-delta-z", v4!.hash);

  expect(await readAll(id, [...bodies.keys()])).toEqual(bodies);
  expect((await store.getNoteVersion(extra.id, xv.version_ix))!.content).toBe(v4!.text + "x");
  expect(h.readBlobContent(db, v1!.hash)).toBe(v1!.text);
  const stats = h.historyStorageStats(db);
  expect(stats).toMatchObject({ whole_blobs: 3, delta_blobs: 3, orphan_deltas: 0, unknown_encoding_blobs: 0 });
  // The stored bytes are the compressed ones.
  expect(stats.whole_bytes).toBeLessThan(utf8(v0!.text).length + utf8(v3!.text).length + utf8(v4!.text).length);
  expect(auditHistoryBlobs(db, "", 500, 1000)).toMatchObject({ checked: 6, corrupt: 0 });
});

test("a damaged or oversized compressed blob is refused, never misread", async () => {
  const { id, versions, bodies } = await seed(4);
  const [v0, v1, v2, v3] = versions.map((v) => ({ ix: v.version_ix, hash: v.content_hash!, text: bodies.get(v.version_ix)! }));
  const good = deflateBytes(utf8(v0!.text));
  set(v0!.hash, good.subarray(0, good.length >> 1), "deflate", null); // truncated stream
  // A stream that inflates past VERSION_MAX_BYTES is refused before it is built, not decoded and then hashed.
  set(v1!.hash, deflateBytes(new Uint8Array(h.VERSION_MAX_BYTES + 1).fill(97)), "deflate", null);
  set(v2!.hash, deflateBytes(utf8(v2!.text.replace("café", "cafe"))), "deflate", null); // decodes, wrong body
  set(v3!.hash, "not bytes", "fossil-delta-z", null); // a delta-z with no base and text where bytes belong
  for (const v of [v0!, v1!, v2!, v3!])
    await expect(store.getNoteVersion(id, v.ix)).rejects.toMatchObject({ code: "HISTORY_UNRECOVERABLE" });
  expect(() => h.readBlobContent(db, v1!.hash)).toThrow(expect.objectContaining({ reason: "bad_encoding" }));
  expect(auditHistoryBlobs(db, "", 500, 1000)).toMatchObject({ checked: 4, corrupt: 4 });
  expect(h.historyStorageStats(db)).toMatchObject({ whole_blobs: 3, delta_blobs: 1, orphan_deltas: 1 });
  // An encoding this engine doesn't know is counted as such and refused.
  set(v2!.hash, deflateBytes(utf8(v2!.text)), "zstd", null);
  expect(h.historyStorageStats(db).unknown_encoding_blobs).toBe(1);
  await expect(store.getNoteVersion(id, v2!.ix)).rejects.toMatchObject({ code: "HISTORY_UNRECOVERABLE" });
});

test("a delta-z whose base is itself a delta is refused (depth one), and so is a bad delta", async () => {
  const { id, versions, bodies } = await seed(3);
  const [v0, v1, v2] = versions.map((v) => ({ ix: v.version_ix, hash: v.content_hash!, text: bodies.get(v.version_ix)! }));
  set(v1!.hash, deflateBytes(createDeltaBytes(v0!.text, v1!.text)), "fossil-delta-z", v0!.hash);
  set(v2!.hash, deflateBytes(createDeltaBytes(v1!.text, v2!.text)), "fossil-delta-z", v1!.hash);
  expect((await store.getNoteVersion(id, v1!.ix))!.content).toBe(v1!.text);
  expect(() => h.readBlobContent(db, v2!.hash)).toThrow(expect.objectContaining({ reason: "base_not_whole" }));
  set(v2!.hash, deflateBytes(utf8("garbage, not a delta")), "fossil-delta-z", v0!.hash);
  expect(() => h.readBlobContent(db, v2!.hash)).toThrow(expect.objectContaining({ reason: "bad_delta" }));
});

test("this release's compaction works on a history the next release wrote: deflated bases stay, bodies stay", async () => {
  // A vault the next release wrote (deflated whole blobs), then rolled back to this one: compaction must treat a
  // deflated blob as a whole base, not as damage, and every body must read back.
  const { id, versions, bodies } = await seed(14);
  const newest = versions[versions.length - 1]!;
  set(newest.content_hash!, deflateBytes(utf8(bodies.get(newest.version_ix)!)), "deflate", null);
  const r = h.compactNote(db, id, h.resolveHistoryPolicy({ compact_min_versions: 2, compact_ratio: 1 }));
  expect(r.blobs_deltified).toBeGreaterThan(0);
  const base = db.prepare("SELECT encoding FROM note_blobs WHERE hash = ?").get(newest.content_hash!) as { encoding: string };
  expect(base.encoding).toBe("deflate");
  expect(db.prepare("SELECT COUNT(*) AS n FROM note_blobs WHERE delta_of = ?").get(newest.content_hash!)).toEqual({ n: r.blobs_deltified });
  expect(await readAll(id, [...bodies.keys()])).toEqual(bodies);
  expect(h.historyStorageStats(db).orphan_deltas).toBe(0);
});

test("a Durable Object hands BLOBs back as an ArrayBuffer (and a Uint8Array may be a view): both decode", async () => {
  const { wholeText, deltaBytes } = await import("./blob-codec.js");
  const text = "a body from a DO, with ☕ in it\n".repeat(50);
  const z = deflateBytes(utf8(text));
  const padded = new Uint8Array(z.byteLength + 8);
  padded.set(z, 4);
  expect(wholeText(z.slice().buffer, "deflate", 1 << 20)).toBe(text);
  expect(wholeText(padded.subarray(4, 4 + z.byteLength), "deflate", 1 << 20)).toBe(text);
  const d = createDeltaBytes(text, text + "more");
  expect([...deltaBytes(deflateBytes(d).slice().buffer, "fossil-delta-z", 1 << 20)]).toEqual([...d]);
  expect(wholeText(utf8(text).slice().buffer, null, 1 << 20)).toBe(text);
});

test("this release writing into a vault the next release stamped 33: edits, restore and compaction read back, the stamp stays", async () => {
  const { initSchema, READABLE_SCHEMA_VERSION } = await import("./schema.js");
  const { id, versions, bodies } = await seed(12);
  // What the next release leaves: every whole blob deflated, the vault stamped 33.
  for (const v of versions) set(v.content_hash!, deflateBytes(utf8(bodies.get(v.version_ix)!)), "deflate", null);
  db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(READABLE_SCHEMA_VERSION, "2999-01-01T00:00:00.000Z");
  const stamps = () => db.prepare("SELECT version, applied_at FROM schema_version ORDER BY version").all();
  const before = stamps();
  initSchema(db);
  // Re-capturing a body the vault already holds deflated, a new body, and a restore.
  const oldest = versions[0]!;
  await store.updateNote(id, { content: bodies.get(oldest.version_ix)! });
  await store.updateNote(id, { content: "a new body after the rollback" });
  const latest = (await store.listNoteVersions(id))[0]!;
  await store.restoreNoteVersion(id, latest.version_ix, { if_updated_at: (await store.getNote(id))!.updatedAt });
  h.compactNote(db, id, h.resolveHistoryPolicy({ compact_min_versions: 2, compact_ratio: 1 }));
  const all = (await store.listNoteVersions(id, { limit: 100 })).map((v) => v.version_ix);
  const read = await readAll(id, all);
  for (const [ix, text] of bodies) expect(read.get(ix)).toBe(text);
  expect(h.historyStorageStats(db).orphan_deltas).toBe(0);
  expect(auditHistoryBlobs(db, "", 500, 1000).corrupt).toBe(0);
  initSchema(db);
  expect(stamps()).toEqual(before);
});
