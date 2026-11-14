// The change log (0.9.4, change-log.ts): the trigger rules that the contracts see only from outside. Made-up data.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStore } from "./store.ts";
import { SCHEMA_VERSION } from "./schema.ts";
import { pruneChangeLog, setRecordStates, writeSetRecords } from "./change-log.ts";
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
