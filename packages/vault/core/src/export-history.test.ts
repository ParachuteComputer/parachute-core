// Export with history (0.9.4, T-471): the history file's writer and reader. The black-box round trip lives in
// contracts/suites/v094/export-history.test.ts; here, what only the logic shows: compressed bodies and overflow
// tombstones come out as text and back, a second import adds nothing, a vault's own history is appended to, never
// overwritten, and bad lines are left out with a reason.
import { afterEach, beforeEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BunSqliteStore } from "./store.js";
import { exportVaultToDir, FsImportSource, importVault } from "./portable-md.js";
import { importHistoryFile } from "./export-history.js";
import { VERSION_MAX_BYTES } from "./history.js";

let dir: string;
let src: BunSqliteStore;
let dst: BunSqliteStore;
let srcDb: Database;
let dstDb: Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "export-history-"));
  srcDb = new Database(":memory:");
  dstDb = new Database(":memory:");
  src = new BunSqliteStore(srcDb);
  dst = new BunSqliteStore(dstDb);
});
afterEach(() => {
  srcDb.close();
  dstDb.close();
  rmSync(dir, { recursive: true, force: true });
});

const as = (store: BunSqliteStore, via: string, why: string | null, fn: () => Promise<unknown>) => {
  store.writeSetSource = () => ({ actor: "sam", via, why });
  return fn().finally(() => (store.writeSetSource = undefined));
};
const versionsOf = async (store: BunSqliteStore, id: string) => {
  const rows = (await store.listNoteVersions(id, { limit: 500 })).reverse();
  return Promise.all(rows.map(async (r) => ({ ...r, content: (await store.getNoteVersion(id, r.version_ix))!.content })));
};
const count = (db: Database) => (db.prepare("SELECT COUNT(*) AS n FROM note_versions").get() as { n: number }).n;

async function fixture() {
  const a = await src.createNote("one\n".repeat(400), { path: "a", tags: ["memo"] });
  // Enough versions for compaction to store them as deltas (two keys take turns, so none folds into a burst).
  for (let i = 0; i < 10; i++) await src.updateNote(a.id, { content: `line ${i}\n` + "one\n".repeat(400), actor: "sam", via: i % 2 ? "key:x" : "key:y" });
  await as(src, "key:one", "first pass", () => src.updateNote(a.id, { content: "two\n".repeat(400), actor: "sam", via: "key:one" }));
  await as(src, "key:two", "second pass", () => src.updateNote(a.id, { content: "two\n".repeat(399) + "three\n", metadata: { k: 1 }, actor: "sam", via: "key:two" }));
  await as(src, "key:one", "a clearer name", () => src.updateNote(a.id, { path: "a-renamed", actor: "sam", via: "key:one" }));
  // Older versions compressed and stored as deltas: the export still writes their text.
  src.compactHistory({ noteId: a.id });
  expect((srcDb.prepare("SELECT COUNT(*) AS n FROM note_blobs WHERE encoding IS NOT NULL").get() as { n: number }).n).toBeGreaterThan(0);
  const big = await src.createNote("x".repeat(VERSION_MAX_BYTES + 10), { path: "big" });
  await as(src, "key:one", "too big to keep", () => src.deleteNote(big.id, { actor: "sam", via: "key:one" }));
  return { a: a.id, big: big.id };
}

it("round trip: every version's body, stamps, why, set, path and fields come back, overflow tombstones too", async () => {
  const ids = await fixture();
  const stats = await exportVaultToDir(src, { outDir: dir, history: true, exportedAt: "2027-01-01T00:00:00.000Z" });
  expect(stats.history).toMatchObject({ records: 2, versions: 14, skipped: [] });
  const file = readFileSync(join(dir, ".parachute", "history", `${ids.big}.jsonl`), "utf8");
  expect(JSON.parse(file)).toMatchObject({ op: "delete", content: null, content_hash: null, why: "too big to keep" });

  const imported = await importVault(dst, new FsImportSource({ inDir: dir }));
  expect(imported).toMatchObject({ history_versions_added: 14, history_versions_present: 0, skipped_history: [] });
  const strip = (v: Record<string, unknown>) => ({ ...v, encoding: v.encoding === "overflow" ? "overflow" : null });
  expect((await versionsOf(dst, ids.a)).map(strip)).toEqual((await versionsOf(src, ids.a)).map(strip));
  const tomb = await dst.listNoteVersions(ids.big);
  expect(tomb).toHaveLength(1);
  expect(tomb[0]).toMatchObject({ op: "delete", content_hash: null, encoding: "overflow", content_len: VERSION_MAX_BYTES + 10, why: "too big to keep" });
  expect((await versionsOf(dst, ids.a)).slice(-3).map((v) => v.why)).toEqual(["first pass", "second pass", "a clearer name"]);
});

it("importing the same export twice adds no versions", async () => {
  await fixture();
  await exportVaultToDir(src, { outDir: dir, history: true });
  await importVault(dst, new FsImportSource({ inDir: dir }), { blowAway: true });
  const first = count(dstDb);
  const again = await importVault(dst, new FsImportSource({ inDir: dir }), { blowAway: true });
  expect(again.history_versions_added).toBe(0);
  expect(again.history_versions_present).toBe(14);
  expect(count(dstDb)).toBe(first);
});

it("into a record that has history already: only lines newer than its own land, after it; older ones are left out with a reason", async () => {
  const n = await dst.createNote("mine v0", { id: "01J0000000000000000000000A" });
  await dst.updateNote(n.id, { content: "mine v1" });
  const line = (ix: number, at: string, content: string) =>
    JSON.stringify({ version_ix: ix, op: "update", superseded_at: at, actor: "sam", via: "key:one", write_set: `ws_${ix}`, why: `w${ix}`, path: null, metadata: {}, content });
  const r = importHistoryFile(dstDb, n.id, [line(0, "2026-01-01T00:00:00.000Z", "theirs 0"), line(1, "2999-01-02T00:00:00.000Z", "theirs 1")].join("\n"));
  expect(r).toMatchObject({ added: 1, present: 0 });
  expect(r.skipped.map((x) => x.line)).toEqual([1]);
  expect(r.skipped[0]!.reason).toContain("older than this record's own history");
  const rows = (await dst.listNoteVersions(n.id)).reverse();
  expect(rows.map((v) => v.version_ix)).toEqual([0, 1]);
  expect((await dst.getNoteVersion(n.id, 0))!.content).toBe("mine v0");
  expect((await dst.getNoteVersion(n.id, 1))!.content).toBe("theirs 1");
  expect(rows[1]!.why).toBe("w1");
});

it("versions that look alike (same time, op and body; a fields-only change by different keys) all land, and a re-import adds none", () => {
  const id = "01J0000000000000000000000C";
  const lines = Array.from({ length: 6 }, (_, i) =>
    JSON.stringify({ version_ix: i, op: "update", superseded_at: "2026-01-01T00:00:00.000Z", actor: `k${i % 3}`, via: `key:k${i % 3}`, metadata: { n: i }, content: "same body" }),
  ).join("\n");
  expect(importHistoryFile(dstDb, id, lines)).toMatchObject({ added: 6, present: 0 });
  expect(importHistoryFile(dstDb, id, lines)).toMatchObject({ added: 0, present: 6 });
});

it("bad lines are left out with a reason; the good ones land", () => {
  const ok = JSON.stringify({ version_ix: 0, op: "update", superseded_at: "2026-01-01T00:00:00.000Z", content: "fine" });
  const text = [
    "not json",
    JSON.stringify({ version_ix: -1, op: "import", superseded_at: "2026-01-01T00:00:00.000Z", content: "git" }),
    JSON.stringify({ version_ix: 1, op: "update", superseded_at: "2026-01-02T00:00:00.000Z", content: "tampered", content_hash: "00" }),
    JSON.stringify({ version_ix: 2, op: "update", superseded_at: "2026-01-03T00:00:00.000Z", content: null }),
    ok,
  ].join("\n");
  const r = importHistoryFile(dstDb, "01J0000000000000000000000B", text);
  expect(r.added).toBe(1);
  expect(r.skipped.map((s) => s.line)).toEqual([1, 2, 3, 4]);
});

it("off by default, and a later export clears history an earlier one left in the folder", async () => {
  await fixture();
  await exportVaultToDir(src, { outDir: dir, history: true });
  expect(existsSync(join(dir, ".parachute", "history"))).toBe(true);
  const stats = await exportVaultToDir(src, { outDir: dir });
  expect(stats.history).toBeUndefined();
  expect(existsSync(join(dir, ".parachute", "history"))).toBe(false);
  // An export from before 0.9.4 (no history folder) imports as it did.
  mkdirSync(join(dir, "x"), { recursive: true });
  writeFileSync(join(dir, "x", "n.md"), "---\nid: 01J0000000000000000000000C\npath: x/n\n---\nbody\n");
  const r = await importVault(dst, new FsImportSource({ inDir: dir }));
  expect(r).toMatchObject({ history_versions_added: 0, skipped_history: [] });
});

it("a folder export never deletes history through a .parachute that links outside the folder", async () => {
  const outside = join(dir, "elsewhere");
  mkdirSync(join(outside, "history"), { recursive: true });
  writeFileSync(join(outside, "history", "precious.txt"), "keep me");
  const out = join(dir, "out-link");
  mkdirSync(out);
  symlinkSync(outside, join(out, ".parachute"));
  await src.createNote("a", { path: "a" });
  await exportVaultToDir(src, { outDir: out });
  expect(readFileSync(join(outside, "history", "precious.txt"), "utf8")).toBe("keep me");
});

it("a history file for a record the vault doesn't hold is left out, unless it ends in a delete", async () => {
  const out = join(dir, "orphans");
  await src.createNote("a", { path: "a" });
  await exportVaultToDir(src, { outDir: out });
  mkdirSync(join(out, ".parachute", "history"), { recursive: true });
  const line = (op: string) => JSON.stringify({ version_ix: 0, op, superseded_at: "2026-01-01T00:00:00.000Z", content: "x" });
  writeFileSync(join(out, ".parachute", "history", "01J0000000000000000000NOPE.jsonl"), line("update"));
  writeFileSync(join(out, ".parachute", "history", "01J0000000000000000000GONE.jsonl"), line("delete"));
  const stats = await importVault(dst, new FsImportSource({ inDir: out }), {});
  expect(stats.skipped_history.map((s) => s.file)).toEqual(["01J0000000000000000000NOPE.jsonl"]);
  expect((dstDb.prepare("SELECT note_id FROM note_versions").all() as { note_id: string }[]).map((r) => r.note_id)).toEqual(["01J0000000000000000000GONE"]);
});
