// T-460 burst collapse: edits by one named writer within the window make one version, holding the body from before
// the burst. Everything else (other writers, no actor, renames, deletes, restores, a window passed or a newest row
// from the future, an oversized body) captures as before.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteStore } from "./store.js";
import { resolveHistoryPolicy, DEFAULT_HISTORY_POLICY, VERSION_MAX_BYTES } from "./history.js";

let db: Database, store: BunSqliteStore;
beforeEach(() => { db = new Database(":memory:"); store = new BunSqliteStore(db); });
afterEach(() => db.close());

const ann = { actor: "ann", via: "key:a" };
const count = (id: string) => (db.prepare("SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?").get(id) as { n: number }).n;
const ageNewest = (id: string, ms: number) =>
  db.prepare("UPDATE note_versions SET superseded_at = ? WHERE note_id = ? AND version_ix = (SELECT MAX(version_ix) FROM note_versions WHERE note_id = ?)")
    .run(new Date(Date.now() - ms).toISOString(), id, id);

test("the default window is 15 minutes, and 0 turns it off", () => {
  expect(DEFAULT_HISTORY_POLICY.burst_window_seconds).toBe(900);
  expect(resolveHistoryPolicy({ burst_window_seconds: -5 }).burst_window_seconds).toBe(0);
  expect(resolveHistoryPolicy({ burst_window_seconds: 10 ** 9 }).burst_window_seconds).toBe(86_400);
});

test("one writer's burst of edits leaves one version: the body from before the burst", async () => {
  const n = await store.createNote("v0", ann);
  for (let i = 1; i <= 20; i++) await store.updateNote(n.id, { content: `v${i}`, ...ann });
  await store.updateNote(n.id, { append: " and more", ...ann });
  await store.updateNote(n.id, { prepend: "so: ", ...ann });
  expect(count(n.id)).toBe(1);
  const [only] = await store.listNoteVersions(n.id);
  expect((await store.getNoteVersion(n.id, only!.version_ix))!.content).toBe("v0");
  expect((await store.getNote(n.id))!.content).toBe("so: v20 and more");
  // Off: every edit captures, as before.
  const off = new BunSqliteStore(new Database(":memory:"), { history: { burst_window_seconds: 0 } });
  const m = await off.createNote("w0", ann);
  for (let i = 1; i <= 5; i++) await off.updateNote(m.id, { content: `w${i}`, ...ann });
  expect((await off.listNoteVersions(m.id)).length).toBe(5);
});

test("another writer, another key, or no actor at all starts a new version", async () => {
  const n = await store.createNote("v0", ann);
  await store.updateNote(n.id, { content: "v1", ...ann });
  await store.updateNote(n.id, { content: "v2", ...ann }); // collapsed into v0's row
  await store.updateNote(n.id, { content: "v3", actor: "bob", via: "key:a" });
  await store.updateNote(n.id, { content: "v4", actor: "ann", via: "key:b" });
  await store.updateNote(n.id, { content: "v5" }); // no actor: an API writer, never collapsed
  await store.updateNote(n.id, { content: "v6" });
  const bodies = await Promise.all((await store.listNoteVersions(n.id)).reverse().map(async (v) => (await store.getNoteVersion(n.id, v.version_ix))!.content));
  expect(bodies).toEqual(["v0", "v2", "v3", "v4", "v5"]);
});

test("a rename through update, a delete and a restore always capture", async () => {
  const n = await store.createNote("v0", { path: "a", ...ann });
  await store.updateNote(n.id, { content: "v1", ...ann });
  await store.updateNote(n.id, { content: "v2", path: "b", ...ann }); // renames: captured
  await store.updateNote(n.id, { content: "v3", ...ann }); // newest row has path "a", the note is at "b": captured
  expect(count(n.id)).toBe(3);
  await store.updateNote(n.id, { content: "v4", ...ann }); // a burst again, at "b"
  expect(count(n.id)).toBe(3);
  await store.restoreNoteVersion(n.id, 0, { ...ann, if_updated_at: (await store.getNote(n.id))!.updatedAt });
  expect(count(n.id)).toBe(4);
  await store.updateNote(n.id, { content: "v5", ...ann }); // the newest row is a restore: captured
  expect(count(n.id)).toBe(5);
  await store.deleteNote(n.id, ann);
  expect(count(n.id)).toBe(6);
});

test("the window is measured from the newest version, and a newest version from the future never starts a skip", async () => {
  const n = await store.createNote("v0", ann);
  await store.updateNote(n.id, { content: "v1", ...ann });
  ageNewest(n.id, 899_000);
  await store.updateNote(n.id, { content: "v2", ...ann });
  expect(count(n.id)).toBe(1);
  ageNewest(n.id, 901_000);
  await store.updateNote(n.id, { content: "v3", ...ann });
  expect(count(n.id)).toBe(2);
  ageNewest(n.id, -60_000); // a clock ahead of ours wrote it
  await store.updateNote(n.id, { content: "v4", ...ann });
  expect(count(n.id)).toBe(3);
});

test("an oversized body still fails the write inside a burst", async () => {
  const big = "x".repeat(VERSION_MAX_BYTES + 1);
  const n = await store.createNote("v0", ann);
  await store.updateNote(n.id, { content: big, ...ann });
  await expect(store.updateNote(n.id, { content: "small again", ...ann })).rejects.toMatchObject({ code: "HISTORY_OVERFLOW" });
  expect((await store.getNote(n.id))!.content).toBe(big);
});

test("only a via that names one credential makes a burst: a channel, the operator or a legacy token never does", async () => {
  for (const via of ["api", "mcp", "operator", "token:abc123"]) {
    const n = await store.createNote("v0");
    for (let i = 1; i <= 3; i++) await store.updateNote(n.id, { content: `v${i}`, actor: "hub-user", via });
    expect(count(n.id)).toBe(3);
  }
  const n = await store.createNote("v0");
  for (let i = 1; i <= 3; i++) await store.updateNote(n.id, { content: `v${i}`, actor: "nostr:ab12", via: "nostr:ab12" });
  expect(count(n.id)).toBe(1);
});

test("after a cascade-rename row, an extension change, an imported-only history, or a delete and re-create, the next edit captures", async () => {
  // A cascade-rename capture: renaming B rewrites A's [[B]] link.
  const b = await store.createNote("target", { path: "B" });
  const a = await store.createNote("see [[B]]", { path: "A", ...ann });
  await store.updateNote(a.id, { content: "see [[B]] again", ...ann });
  await store.updateNote(b.id, { path: "C", ...ann });
  const ops = () => (db.prepare("SELECT op FROM note_versions WHERE note_id = ? ORDER BY version_ix").all(a.id) as { op: string }[]).map((r) => r.op);
  expect(ops().at(-1)).toBe("cascade-rename");
  const before = count(a.id);
  await store.updateNote(a.id, { content: "see [[C]] now", ...ann });
  expect(count(a.id)).toBe(before + 1);
  // An extension-only change.
  const e = await store.createNote("x0", ann);
  await store.updateNote(e.id, { content: "x1", ...ann });
  await store.updateNote(e.id, { extension: "txt", ...ann });
  expect(count(e.id)).toBe(2);
  // A note whose only rows are imported (actor NULL, negative index): the first named edit captures.
  const i = await store.createNote("i0");
  db.prepare(`INSERT INTO note_blobs (hash, content, byte_size) VALUES ('${"0".repeat(64)}', 'old', 3)`).run();
  db.prepare(`INSERT INTO note_versions (note_id, version_ix, content_hash, path, metadata, extension, superseded_at, actor, via, op, content_len, encoding, created_at)
    VALUES (?, -1, '${"0".repeat(64)}', NULL, '{}', 'md', ?, NULL, 'git-import', 'import', 3, NULL, NULL)`).run(i.id, new Date().toISOString());
  await store.updateNote(i.id, { content: "i1", ...ann });
  expect(count(i.id)).toBe(2);
  // Delete, then re-create with the same id: the newest row is the tombstone.
  const d = await store.createNote("d0", { id: "same-id", ...ann });
  await store.updateNote(d.id, { content: "d1", ...ann });
  await store.deleteNote(d.id, ann);
  await store.createNote("d2", { id: "same-id", ...ann });
  await store.updateNote("same-id", { content: "d3", ...ann });
  expect(count("same-id")).toBe(3);
});
