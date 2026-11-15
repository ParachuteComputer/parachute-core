// T-412: forgetNote deletes a note and every version of it, and the stored blobs only it used.
//
// The contract (contracts/suites/safety/forget.test.ts) sees versions over HTTP; this checks what it can't: that
// the bytes themselves leave note_blobs, that a blob another note still uses stays, and that compaction's deltas are
// cleaned up base and all. Blobs are shared by content hash, so a wrong refcount either leaks a forgotten note's
// words or breaks another note's history. Real SQLite, real engine.
import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { SqliteStore } from "./store.ts";

let db: Database;
let store: SqliteStore;
beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

const blobCount = () => (db.query("SELECT COUNT(*) AS n FROM note_blobs").get() as { n: number }).n;
const blobsHolding = (needle: string) =>
  (db.query("SELECT COUNT(*) AS n FROM note_blobs WHERE instr(content, ?) > 0").get(needle) as { n: number }).n;

/** A note edited `n` times over a long shared body, so compaction stores deltas against a base. */
async function longHistory(word: string, n: number): Promise<string> {
  const body = `${"made up shared paragraph. ".repeat(200)}\n`;
  const note = await store.createNote(`${body}${word} 0`, { path: `forget/${word}` });
  for (let i = 1; i <= n; i++) await store.updateNote(note.id, { content: `${body}${word} ${i}` });
  return note.id;
}

test("removes the note, its versions and every blob only it used, deltas included", async () => {
  const id = await longHistory("zebrafinch", 14);
  store.compactNote(id);
  expect((db.query("SELECT COUNT(*) AS n FROM note_blobs WHERE delta_of IS NOT NULL").get() as { n: number }).n).toBeGreaterThan(0);
  expect(blobsHolding("zebrafinch")).toBeGreaterThan(0);

  const versionsBefore = await store.countNoteVersions(id);
  expect(versionsBefore).toBeGreaterThanOrEqual(14);
  const r = await store.forgetNote(id);
  expect(r.deleted).toBe(true);
  expect(r.versionsDeleted).toBe(versionsBefore);
  expect(await store.getNote(id)).toBeNull();
  expect(await store.countNoteVersions(id)).toBe(0);
  expect(blobCount()).toBe(0);
  expect((await store.listDeletedNotes()).total).toBe(0);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("keeps a blob another note's history still holds, and that history still reads", async () => {
  const keep = await store.createNote("made up words both notes once had", { path: "forget/keep" });
  await store.updateNote(keep.id, { content: "keep moved on" });
  const gone = await store.createNote("made up words both notes once had", { path: "forget/gone" });
  await store.updateNote(gone.id, { content: "only the forgotten note said quokka" });
  await store.updateNote(gone.id, { content: "and then something else" });

  const blobsBefore = blobCount();
  const r = await store.forgetNote(gone.id);
  expect(blobsHolding("quokka")).toBe(0);
  // The reported count is what left the table (Bun's `.changes` overstated it).
  expect(r.blobsDeleted).toBe(blobsBefore - blobCount());
  const versions = await store.listNoteVersions(keep.id);
  const v = await store.getNoteVersion(keep.id, versions[versions.length - 1]!.version_ix);
  expect(v?.content).toBe("made up words both notes once had");
});

test("on an id already deleted, erases the history it left, and says nothing was deleted", async () => {
  const id = await longHistory("pangolin", 3);
  await store.deleteNote(id);
  const listed = await store.listDeletedNotes();
  expect(listed.total).toBe(1);
  expect(listed.notes[0]).toMatchObject({ id, path: "forget/pangolin", extension: "md" });
  expect(listed.notes[0]!.versions).toBeGreaterThanOrEqual(4);
  expect(typeof listed.notes[0]!.deleted_at).toBe("string");

  const r = await store.forgetNote(id);
  expect(r.deleted).toBe(false);
  expect(r.versionsDeleted).toBeGreaterThanOrEqual(4);
  expect(blobsHolding("pangolin")).toBe(0);
  expect((await store.listDeletedNotes()).total).toBe(0);
});

test("fires the deleted hook once, as a plain delete does, and writes no tombstone", async () => {
  const seen: string[] = [];
  store.hooks.onNote({ name: "t412", event: ["deleted"], handler: async (n: any) => { seen.push(n.id); } });
  const id = await longHistory("axolotl", 1);
  await store.forgetNote(id);
  await new Promise((r) => setTimeout(r, 10));
  expect(seen).toEqual([id]);
  expect((db.query("SELECT COUNT(*) AS n FROM note_versions WHERE op = 'delete'").get() as { n: number }).n).toBe(0);
});

test("the deleted-notes listing pages newest first and counts all of them on every page", async () => {
  const ids: string[] = [];
  for (const w of ["kea", "kakapo", "takahe"]) {
    const id = await longHistory(w, 1);
    await store.deleteNote(id);
    ids.push(id);
    await new Promise((r) => setTimeout(r, 5));
  }
  const page1 = await store.listDeletedNotes({ limit: 2 });
  expect(page1.total).toBe(3);
  expect(page1.notes.map((n) => n.id)).toEqual([ids[2], ids[1]]);
  const page2 = await store.listDeletedNotes({ limit: 2, offset: 2 });
  expect(page2).toMatchObject({ total: 3, notes: [{ id: ids[0], path: "forget/kea", extension: "md" }] });
  expect((await store.listDeletedNotes({ limit: 2, offset: 9 })).total).toBe(3);
  expect(await store.listDeletedNotes({ limit: 0 })).toEqual({ notes: [], total: 3 });
});
