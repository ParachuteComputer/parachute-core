// The change log (0.9.4, change-log.ts): the trigger rules that the contracts see only from outside. Made-up data.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStore } from "./store.ts";
import { SCHEMA_VERSION } from "./schema.ts";
import { encodeSnapshot, forgetLoggedPast, pruneChangeLog, setRecordStates, snapshotText, writeSetRecords } from "./change-log.ts";
import { readBlobText } from "./history.ts";

function fresh() {
  const db = new Database(":memory:");
  const store = new SqliteStore(db);
  let ctx: { id?: string; actor?: string; via?: string; why?: string; keepBefore?: boolean } | undefined;
  store.writeSetSource = () => ctx;
  return { db, store, as: (c: typeof ctx) => (ctx = c) };
}
/**
 * What a set did to each record (its rows aggregated, as undo reads them: setRecordStates), the saved body read back
 * from its blob; for writes outside any set (NULL), the raw rows.
 */
const rows = (db: Database, set: string | null) =>
  set === null
    ? (db.prepare("SELECT note_id, op, existed, content_saved, before_hash, before_tags FROM record_changes WHERE write_set IS NULL ORDER BY seq").all() as any[]).map(
        ({ before_hash, ...r }) => ({ ...r, before_content: before_hash ? readBlobText(db, before_hash) : null }),
      )
    : setRecordStates(db, set).map((r) => ({
        note_id: r.note_id, op: r.op, existed: r.existed, content_saved: r.content_saved,
        before_content: r.before_hash ? readBlobText(db, r.before_hash) : null, before_tags: r.before_tags,
      }));

describe("change log: what one write set records", () => {
  test("the body is kept only when the set changes it, from before the set's first change", async () => {
    const { db, store, as } = fresh();
    as({ id: "ws_create0001" });
    const n = await store.createNote("v1", { path: "a", tags: ["t"] });
    as({ id: "ws_meta00001" });
    await store.updateNote(n.id, { metadata: { k: 1 } });
    expect(rows(db, "ws_meta00001")).toEqual([{ note_id: n.id, op: "update", existed: 1, content_saved: 0, before_content: null, before_tags: '["t"]' }]);
    as({ id: "ws_body00001" });
    await store.tagNote(n.id, ["u"]); // first touch by a tag: the body is still v1 and not yet saved
    await store.updateNote(n.id, { content: "v2" });
    await store.updateNote(n.id, { content: "v3" });
    expect(rows(db, "ws_body00001")).toEqual([{ note_id: n.id, op: "update", existed: 1, content_saved: 1, before_content: "v1", before_tags: '["t"]' }]);
  });

  test("a record made and deleted in one set is not one of its records; a delete keeps the whole body", async () => {
    const { db, store, as } = fresh();
    as({ id: "ws_both00001" });
    const tmp = await store.createNote("brief", { path: "tmp" });
    await store.deleteNote(tmp.id);
    expect(writeSetRecords(db, "ws_both00001")).toEqual([]);
    as({ id: "ws_make00001" });
    const keep = await store.createNote("kept body", { path: "keep", tags: ["x"] });
    as({ id: "ws_drop00001" });
    await store.deleteNote(keep.id);
    expect(rows(db, "ws_drop00001")).toEqual([{ note_id: keep.id, op: "delete", existed: 1, content_saved: 1, before_content: "kept body", before_tags: '["x"]' }]);
  });

  test("bulk operator work (keepBefore false) logs which records changed, not their bodies", async () => {
    const { db, store, as } = fresh();
    as({ id: "ws_seed00001" });
    const n = await store.createNote("big body", { path: "b" });
    as({ id: "ws_bulk00001", keepBefore: false });
    await store.updateNote(n.id, { content: "replaced" });
    expect(rows(db, "ws_bulk00001")[0]).toMatchObject({ op: "update", content_saved: 0, before_content: null });
  });

  test("a write outside any Store transaction is logged with no set, and the context never outlives its transaction", async () => {
    const { db, store, as } = fresh();
    as({ id: "ws_ctx000001" });
    const n = await store.createNote("x", { path: "raw" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM write_context").get()).toEqual({ n: 0 });
    db.prepare("UPDATE notes SET content = 'raw edit', updated_at = 'later' WHERE id = ?").run(n.id); // an older engine's write
    // Its tags as they were are kept (the feed reads them for scope); its body isn't (no set: nothing to undo).
    expect(rows(db, null)).toEqual([{ note_id: n.id, op: "update", existed: 1, content_saved: 0, before_content: null, before_tags: "[]" }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM write_sets WHERE id IS NULL").get()).toEqual({ n: 0 });
  });

  test("with no source each Store transaction is its own set, stamped with nothing", async () => {
    const { db, store } = fresh();
    await store.createNote("one", { path: "one" });
    await store.createNote("two", { path: "two" });
    const sets = db.prepare("SELECT id, actor, via FROM write_sets").all() as any[];
    expect(sets.length).toBe(2);
    expect(sets.every((s) => /^ws_[a-z2-7]{20}$/.test(s.id) && s.actor === null && s.via === null)).toBe(true);
  });
});

describe("change log: bodies are blobs", () => {
  test("a saved body is a blob shared with the version holding the same text, and the sweep frees only what nobody holds", async () => {
    const { db, store, as } = fresh();
    as({ id: "ws_mk0000001" });
    const n = await store.createNote("first body", { path: "b" });
    as({ id: "ws_ed0000001" });
    await store.updateNote(n.id, { content: "second body", actor: "u", via: "api" });
    const [row] = db.prepare("SELECT before_hash FROM record_changes WHERE write_set = 'ws_ed0000001'").all() as any[];
    expect((db.prepare("SELECT COUNT(*) AS n FROM record_change_bodies").get() as any).n).toBe(0); // staged only within the transaction
    const version = (db.prepare("SELECT content_hash FROM note_versions").get() as any).content_hash;
    expect(row.before_hash).toBe(version); // one blob, held twice
    expect((db.prepare("SELECT COUNT(*) AS n FROM note_blobs").get() as any).n).toBe(1);
    db.exec("DELETE FROM note_versions"); // as if history pruned it: the log still holds the body
    db.exec("DELETE FROM note_blobs WHERE 0"); // (nothing else frees it)
    expect(readBlobText(db, row.before_hash)).toBe("first body");
    db.prepare("UPDATE record_changes SET at = '2000-01-01T00:00:00.000Z'").run();
    (store as any).changeLogPrunedAt = 0;
    store.pruneChangeLogDaily();
    expect((db.prepare("SELECT COUNT(*) AS n FROM note_blobs").get() as any).n).toBe(0);
  });

  test("erasing a record's history forgets the log's copy of its past too", async () => {
    const { db, store, as } = fresh();
    as({ id: "ws_mk0000002" });
    const n = await store.createNote("private first draft", { path: "p", metadata: { k: "secret" } });
    as({ id: "ws_ed0000002" });
    await store.updateNote(n.id, { content: "public", metadata: {} });
    await store.eraseNoteHistory(n.id);
    const [row] = db.prepare("SELECT before_hash, before_row, content_saved FROM record_changes WHERE write_set = 'ws_ed0000002'").all() as any[];
    // Still marked saved, so a later transaction of the same set can't save an in-between body in its place.
    expect(row).toEqual({ before_hash: null, before_row: null, content_saved: 1 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM note_blobs").get() as any).n).toBe(0);
  });
});

describe("change log: positions and what history keeps", () => {
  test("a set that writes a record again in a later transaction adds a row after the other set's; placed rows never move", async () => {
    const { db, store, as } = fresh();
    as({ id: "ws_first0001" });
    const n = await store.createNote("x", { path: "pos" });
    const placed = (db.prepare("SELECT position, before_tags FROM record_changes WHERE write_set = 'ws_first0001'").get() as any);
    as({ id: "ws_second001" });
    await store.updateNote(n.id, { content: "y" });
    as({ id: "ws_first0001" }); // the first set again (several requests sharing one Parachute-Write-Set id)
    await store.updateNote(n.id, { content: "z" });
    const first = db.prepare("SELECT position, touched FROM record_changes WHERE write_set = 'ws_first0001' ORDER BY seq").all() as any[];
    const second = (db.prepare("SELECT position FROM record_changes WHERE write_set = 'ws_second001'").get() as any).position;
    expect(first.length).toBe(2);
    expect(first[0].position).toBe(placed.position); // never moved
    expect(first[1].position).toBeGreaterThan(second);
    expect(first.every((r) => r.touched === 0)).toBe(true);
    // A raw write (an older engine) waits for the next Store transaction to get its position, then sorts after.
    db.prepare("UPDATE notes SET content = 'raw', updated_at = 'later' WHERE id = ?").run(n.id);
    expect((db.prepare("SELECT position FROM record_changes WHERE write_set IS NULL").get() as any).position).toBeNull();
    as({ id: "ws_third0001" });
    await store.createNote("other", { path: "pos2" });
    const raw = (db.prepare("SELECT position FROM record_changes WHERE write_set IS NULL").get() as any).position;
    expect(raw).toBeGreaterThan(first[1].position);
    expect((db.prepare("SELECT position FROM record_changes WHERE write_set = 'ws_third0001'").get() as any).position).toBeGreaterThan(raw);
  });

  test("each write saves only what it changes: a tag write keeps no fields or links; a later row change in the set keeps the row from before the set", async () => {
    const { db, store, as } = fresh();
    as({ id: "ws_seed00002" });
    const target = await store.createNote("t", { path: "target" });
    const n = await store.createNote("body", { path: "p", tags: ["a"], metadata: { k: 1 } });
    await store.createLink(n.id, target.id, "cites");
    as({ id: "ws_tagonly01" });
    await store.tagNote(n.id, ["b"]);
    const row = () => {
      const [r] = setRecordStates(db, "ws_tagonly01");
      return { before_row: r!.before_row, before_tags: r!.before_tags, before_links: r!.before_links };
    };
    expect(row()).toEqual({ before_row: null, before_tags: '["a"]', before_links: null });
    await store.updateNote(n.id, { metadata: { k: 2 } });
    expect(JSON.parse(row().before_row).metadata).toBe('{"k":1}');
    expect(row().before_tags).toBe('["a"]'); // the first snapshot stands
    await store.deleteLink(n.id, target.id, "cites");
    expect(JSON.parse(row().before_links)).toEqual([{ target: target.id, relationship: "cites", metadata: {} }]);
  });

  test("field snapshots are stored compressed and read back as the same text", async () => {
    const { db, store, as } = fresh();
    as({ id: "ws_seedz0001" });
    const target = await store.createNote("t", { path: "target" });
    const big = { summary: "a field long enough to compress ".repeat(12), status: "open", owner: "someone" };
    const n = await store.createNote("body", { path: "zipped", tags: ["a"], metadata: big });
    for (let i = 0; i < 6; i++) await store.createLink(n.id, target.id, `cites-${i}`);
    const small = await store.createNote("s", { path: "s", metadata: { k: 1 } });
    // What the triggers would have written as text, read before the set changes anything.
    const rowText = db.prepare("SELECT json_object('path', path, 'extension', extension, 'metadata', metadata, 'created_at', created_at, 'created_by', created_by, 'created_via', created_via) AS j FROM notes WHERE id = ?");
    const want = (rowText.get(n.id) as { j: string }).j;
    const wantSmall = (rowText.get(small.id) as { j: string }).j;
    as({ id: "ws_zipped001" });
    await store.updateNote(n.id, { metadata: { ...big, status: "done" } });
    await store.deleteLink(n.id, target.id, "cites-0");
    await store.updateNote(small.id, { metadata: { k: 2 } });
    const stored = db
      .prepare("SELECT note_id, typeof(before_row) AS row_type, length(before_row) AS row_len, typeof(before_links) AS links_type FROM record_changes WHERE write_set = 'ws_zipped001' ORDER BY seq")
      .all() as { note_id: string; row_type: string; row_len: number; links_type: string }[];
    // Each request of the set is its own transaction: the fields' row, then the links' row.
    const [fieldsRow, linksRow] = stored.filter((r) => r.note_id === n.id);
    expect(fieldsRow!.row_type).toBe("blob");
    expect(fieldsRow!.row_len).toBeLessThan(Buffer.byteLength(want));
    expect(linksRow!.links_type).toBe("blob");
    // Under 128 bytes, deflate gains little: kept as text.
    expect(encodeSnapshot('{"path":"s"}')).toBe('{"path":"s"}');
    const states = new Map(setRecordStates(db, "ws_zipped001").map((r) => [r.note_id, r]));
    expect(states.get(n.id)!.before_row).toBe(want);
    expect(JSON.parse(states.get(n.id)!.before_links!)).toHaveLength(6);
    expect(states.get(small.id)!.before_row).toBe(wantSmall);
  });

  test("a record's later snapshots are deltas against one whole base; each reads back as the text the trigger wrote", async () => {
    const { db, store, as } = fresh();
    as({ id: "ws_dseed00001" });
    // Text deflate can't shrink much on its own (as a real record's fields), the same on every write.
    const prose = Array.from({ length: 90 }, (_, k) => ((k * 7919) % 104729).toString(36)).join(" ");
    const fields = (i: number) => ({ summary: prose, step: i, status: i % 2 ? "open" : "done" });
    const n = await store.createNote("b", { path: "deltas", metadata: fields(0) });
    const rowText = db.prepare("SELECT json_object('path', path, 'extension', extension, 'metadata', metadata, 'created_at', created_at, 'created_by', created_by, 'created_via', created_via) AS j FROM notes WHERE id = ?");
    const want: string[] = [];
    for (let i = 1; i <= 8; i++) {
      want.push((rowText.get(n.id) as { j: string }).j);
      as({ id: `ws_delta0000${i}` });
      await store.updateNote(n.id, { metadata: fields(i) });
    }
    const stored = db.prepare("SELECT before_base, length(before_row) AS len FROM record_changes WHERE write_set LIKE 'ws_delta%' ORDER BY seq").all() as { before_base: number; len: number }[];
    expect(new Set(stored.map((r) => r.before_base)).size).toBe(1); // one base serves them all
    expect((db.prepare("SELECT COUNT(*) AS n FROM record_change_bases").get() as { n: number }).n).toBe(1);
    for (const r of stored) expect(r.len).toBeLessThan(60); // a few dozen bytes, not the ~600 of the text
    for (let i = 1; i <= 8; i++) expect(setRecordStates(db, `ws_delta0000${i}`)[0]!.before_row).toBe(want[i - 1]);
  });

  test("a snapshot that drifted from its base becomes the record's new base", async () => {
    const { db, store, as } = fresh();
    as({ id: "ws_drift0001" });
    const n = await store.createNote("b", { path: "drift", metadata: { a: "x".repeat(400) } });
    as({ id: "ws_drift0002" });
    await store.updateNote(n.id, { metadata: { b: "lorem ipsum dolor sit amet, consectetur ".repeat(20) } });
    as({ id: "ws_drift0003" });
    await store.updateNote(n.id, { metadata: { c: 1 } });
    const bases = db.prepare("SELECT before_base FROM record_changes WHERE write_set IN ('ws_drift0002', 'ws_drift0003') ORDER BY seq").all() as { before_base: number }[];
    expect(bases[0]!.before_base).not.toBe(bases[1]!.before_base);
    expect(JSON.parse(setRecordStates(db, "ws_drift0003")[0]!.before_row!).metadata).toContain("lorem ipsum");
  });

  test("the sweep keeps no snapshot past the horizon in a base: rows still naming one are re-based; erasing a record's history frees its bases", async () => {
    const { db, store, as } = fresh();
    const prose = Array.from({ length: 90 }, (_, k) => ((k * 7919) % 104729).toString(36)).join(" ");
    const fields = (i: number) => ({ summary: prose, step: i, ...(i === 0 ? { gone: "only-before-the-horizon" } : {}) });
    as({ id: "ws_sweep0000" });
    const n = await store.createNote("b", { path: "sweep", metadata: fields(0) });
    const other = await store.createNote("o", { path: "other", metadata: fields(0) });
    for (let i = 1; i <= 4; i++) {
      as({ id: `ws_sweep000${i}` });
      await store.updateNote(n.id, { metadata: fields(i) });
      await store.updateNote(other.id, { metadata: fields(i) });
    }
    const baseOf = (set: string, id: string) => (db.prepare("SELECT before_base AS b FROM record_changes WHERE write_set = ? AND note_id = ?").get(set, id) as { b: number }).b;
    const base = baseOf("ws_sweep0001", n.id);
    expect(baseOf("ws_sweep0004", n.id)).toBe(base);
    const before = setRecordStates(db, "ws_sweep0004").map((r) => r.before_row);
    // The first two sets age past the horizon: the row the base was made of goes, and later rows still name the base.
    db.prepare("UPDATE record_changes SET at = '2000-01-01T00:00:00.000Z' WHERE write_set IN ('ws_sweep0000', 'ws_sweep0001', 'ws_sweep0002')").run();
    db.prepare("UPDATE write_sets SET at = '2000-01-01T00:00:00.000Z' WHERE id IN ('ws_sweep0000', 'ws_sweep0001', 'ws_sweep0002')").run();
    pruneChangeLog(db, 30);
    // The old base is gone; what the remaining rows read is unchanged; no base holds the value only the swept rows had.
    expect(db.prepare("SELECT id FROM record_change_bases WHERE id = ?").get(base)).toBeNull();
    expect(setRecordStates(db, "ws_sweep0004").map((r) => r.before_row)).toEqual(before);
    expect(JSON.parse(JSON.parse(before[0]!).metadata).step).toBe(3);
    const bases = db.prepare("SELECT content FROM record_change_bases").all() as { content: Uint8Array | string }[];
    expect(bases.length).toBeGreaterThan(0);
    for (const b of bases) expect(snapshotText(b.content)).not.toContain("only-before-the-horizon");
    // Every row past the horizon: the bases go too.
    pruneChangeLog(db, 1, new Date(Date.now() + 3 * 86_400_000));
    expect((db.prepare("SELECT COUNT(*) AS n FROM record_change_bases").get() as { n: number }).n).toBe(0);
    // Erasing a record's history takes its bases with it, and leaves another record's.
    as({ id: "ws_sweep0005" });
    await store.updateNote(n.id, { metadata: fields(5) });
    await store.updateNote(other.id, { metadata: fields(5) });
    expect((db.prepare("SELECT COUNT(*) AS n FROM record_change_bases").get() as { n: number }).n).toBe(2);
    forgetLoggedPast(db, n.id);
    expect(db.prepare("SELECT note_id FROM record_change_bases").all()).toEqual([{ note_id: other.id }]);
  });

  test("a log made by an earlier 0.9.4 build gets the bases table and column on open", async () => {
    const db = new Database(":memory:");
    new SqliteStore(db);
    db.exec("DROP INDEX idx_record_change_bases_note; DROP TABLE record_change_bases; ALTER TABLE record_changes DROP COLUMN before_base;");
    const store = new SqliteStore(db);
    store.writeSetSource = () => ({ id: "ws_upgrade01" });
    const n = await store.createNote("b", { path: "up", metadata: { a: "y".repeat(300) } });
    store.writeSetSource = () => ({ id: "ws_upgrade02" });
    await store.updateNote(n.id, { metadata: { a: "z" } });
    expect(JSON.parse(JSON.parse(setRecordStates(db, "ws_upgrade02")[0]!.before_row!).metadata).a).toBe("y".repeat(300));
  });

  test("an upgrade cut short after the bases table, before the column, is finished at the next open", async () => {
    const db = new Database(":memory:");
    new SqliteStore(db);
    db.exec("ALTER TABLE record_changes DROP COLUMN before_base;");
    const store = new SqliteStore(db);
    store.writeSetSource = () => ({ id: "ws_cutshort1" });
    const n = await store.createNote("b", { path: "cut", metadata: { a: "y".repeat(300) } });
    store.writeSetSource = () => ({ id: "ws_cutshort2" });
    await store.updateNote(n.id, { metadata: { a: "z" } });
    expect(JSON.parse(JSON.parse(setRecordStates(db, "ws_cutshort2")[0]!.before_row!).metadata).a).toBe("y".repeat(300));
  });

  test("a compressed row settled again keeps the base it names", async () => {
    const { db, store, as } = fresh();
    as({ id: "ws_again0001" });
    const n = await store.createNote("b", { path: "again", metadata: { a: "q".repeat(300) } });
    as({ id: "ws_again0002" });
    await store.updateNote(n.id, { metadata: { a: "r" } });
    const want = setRecordStates(db, "ws_again0002")[0]!.before_row;
    // As if the row were touched again: long links text to compress, its fields already a delta.
    db.prepare("UPDATE record_changes SET touched = 1, before_links = ? WHERE write_set = 'ws_again0002'").run(JSON.stringify([{ target: "x".repeat(200) }]));
    as({ id: "ws_again0003" });
    await store.createNote("c", { path: "other" });
    expect(setRecordStates(db, "ws_again0002")[0]!.before_row).toBe(want);
  });

  test("a snapshot written as text (an older engine's row) still reads", async () => {
    const { db, store, as } = fresh();
    as({ id: "ws_oldtext01" });
    const n = await store.createNote("b", { path: "old", metadata: { k: 1 } });
    as({ id: "ws_oldtext02" });
    await store.updateNote(n.id, { metadata: { k: 2 } });
    const text = JSON.stringify({ path: "old", metadata: "x".repeat(500) });
    db.prepare("UPDATE record_changes SET before_row = ?, before_base = NULL WHERE write_set = 'ws_oldtext02'").run(text);
    expect(setRecordStates(db, "ws_oldtext02")[0]!.before_row).toBe(text);
  });

  test("with history off the log keeps no old bodies; an import keeps none either", async () => {
    const db = new Database(":memory:");
    const off = new SqliteStore(db, { history: { enabled: false } });
    const n = await off.createNote("secret v1", { path: "h" });
    await off.updateNote(n.id, { content: "v2" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM record_changes WHERE content_saved = 1").get() as any).n).toBe(0);
    const { db: db2, store } = fresh();
    const m = await store.createNote("old body", { path: "imp" });
    await store.bulkWrites(async () => {
      await store.updateNote(m.id, { content: "imported body" });
    });
    expect((db2.prepare("SELECT COUNT(*) AS n FROM record_changes WHERE content_saved = 1").get() as any).n).toBe(0);
  });
});

describe("change log: the horizon", () => {
  test("rows past the horizon are swept, with sets left empty; newer ones stay", async () => {
    const { db, store, as } = fresh();
    as({ id: "ws_old000001" });
    await store.createNote("old", { path: "old" });
    as({ id: "ws_new000001" });
    await store.createNote("new", { path: "new" });
    db.prepare("UPDATE record_changes SET at = '2000-01-01T00:00:00.000Z' WHERE write_set = 'ws_old000001'").run();
    db.prepare("UPDATE write_sets SET at = '2000-01-01T00:00:00.000Z' WHERE id = 'ws_old000001'").run();
    expect(pruneChangeLog(db, 30)).toMatchObject({ changes: 1, sets: 1 });
    expect((db.prepare("SELECT id FROM write_sets").all() as any[]).map((r) => r.id)).toEqual(["ws_new000001"]);
  });
});

describe("change log: review round 2", () => {
  test("a record deleted and made again across two transactions of a set reads as an update", async () => {
    const { db, store, as } = fresh();
    as({ id: "ws_mk0000004" });
    const n = await store.createNote("one", { id: "01JXREMADE00000000000000AA", path: "remade" });
    as({ id: "ws_remade001" });
    await store.deleteNote(n.id);
    await store.createNote("two", { id: n.id, path: "remade" });
    expect(writeSetRecords(db, "ws_remade001").map((r) => r.op)).toEqual(["update"]);
  });

  test("restoring an imported note's timestamps is part of the import's set, not a write by nobody", async () => {
    const { db, store, as } = fresh();
    as({ id: "ws_import001" });
    const n = await store.createNote("imported", { path: "imp2" });
    await store.restoreNoteTimestamps(n.id, "2020-01-01T00:00:00.000Z", "2020-01-02T00:00:00.000Z");
    expect((db.prepare("SELECT COUNT(*) AS n FROM record_changes WHERE write_set IS NULL").get() as any).n).toBe(0);
  });
});

describe("change log: what outlives the horizon", () => {
  test("a version keeps its write set's why after the log is swept", async () => {
    const { db, store, as } = fresh();
    as({ id: "ws_mk0000003" });
    const n = await store.createNote("one", { path: "w" });
    as({ id: "ws_why000001", why: "fixing a typo" });
    await store.updateNote(n.id, { content: "two", actor: "u", via: "api" });
    db.prepare("UPDATE record_changes SET at = '2000-01-01T00:00:00.000Z'").run();
    db.prepare("UPDATE write_sets SET at = '2000-01-01T00:00:00.000Z'").run();
    (store as any).changeLogPrunedAt = 0;
    store.pruneChangeLogDaily();
    expect((db.prepare("SELECT COUNT(*) AS n FROM write_sets").get() as any).n).toBe(0);
    const [v] = await store.listNoteVersions(n.id);
    expect(v).toMatchObject({ write_set: "ws_why000001", why: "fixing a typo" });
  });
});

describe("change log: an older engine's vault", () => {
  test("a vault 0.9.3 opened last (current stamp, no change log) gets it once, and later writes are logged", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "changelog-")), "v.db");
    let db = new Database(file);
    new SqliteStore(db);
    for (const t of ["rc_notes_insert", "rc_notes_update", "rc_notes_delete", "rc_note_tags_insert", "rc_note_tags_delete", "rc_note_tags_update", "rc_links_insert", "rc_links_delete", "rc_links_update"]) db.exec(`DROP TRIGGER ${t}`);
    for (const t of ["record_changes", "record_change_bodies", "write_sets", "write_context", "change_log_state"]) db.exec(`DROP TABLE ${t}`);
    for (const c of ["write_set", "types", "tags", "links"]) db.exec(`ALTER TABLE note_versions DROP COLUMN ${c}`);
    db.query("INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)").run(SCHEMA_VERSION, "2999-01-01T00:00:00.000Z");
    db.close();
    db = new Database(file);
    const store = new SqliteStore(db);
    const n = await store.createNote("x", { path: "p" });
    await store.updateNote(n.id, { content: "y", actor: "u", via: "api" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM record_changes").get() as any).n).toBe(2);
    expect((db.prepare("SELECT tags FROM note_versions").get() as any).tags).toBe("[]");
    db.close();
  });
});
