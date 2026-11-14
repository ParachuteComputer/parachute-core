// The change log (0.9.4, change-log.ts): the trigger rules that the contracts see only from outside. Made-up data.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStore } from "./store.ts";
import { SCHEMA_VERSION } from "./schema.ts";
import { pruneChangeLog, writeSetRecords } from "./change-log.ts";
import { FEED_TRIGGERS } from "./feed.ts";

function fresh() {
  const db = new Database(":memory:");
  const store = new SqliteStore(db);
  let ctx: { id?: string; actor?: string; via?: string; why?: string; keepBefore?: boolean } | undefined;
  store.writeSetSource = () => ctx;
  return { db, store, as: (c: typeof ctx) => (ctx = c) };
}
const rows = (db: Database, set: string | null) =>
  db.prepare(`SELECT note_id, op, existed, content_saved, before_content, before_tags FROM record_changes WHERE write_set ${set === null ? "IS NULL" : "= ?"} ORDER BY seq`).all(...(set === null ? [] : [set])) as any[];

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

describe("change log: the horizon", () => {
  test("rows past the horizon are swept, with sets left empty; newer ones stay", async () => {
    const { db, store, as } = fresh();
    as({ id: "ws_old000001" });
    await store.createNote("old", { path: "old" });
    as({ id: "ws_new000001" });
    await store.createNote("new", { path: "new" });
    db.prepare("UPDATE record_changes SET at = '2000-01-01T00:00:00.000Z' WHERE write_set = 'ws_old000001'").run();
    db.prepare("UPDATE write_sets SET at = '2000-01-01T00:00:00.000Z' WHERE id = 'ws_old000001'").run();
    expect(pruneChangeLog(db, 30)).toEqual({ changes: 1, sets: 1 });
    expect((db.prepare("SELECT id FROM write_sets").all() as any[]).map((r) => r.id)).toEqual(["ws_new000001"]);
  });
});

describe("change log: an older engine's vault", () => {
  test("a vault 0.9.3 opened last (current stamp, no change log) gets it once, and later writes are logged", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "changelog-")), "v.db");
    let db = new Database(file);
    new SqliteStore(db);
    // A 0.9.3 vault has neither the change log nor the feed that rides on it (feed.ts).
    for (const t of FEED_TRIGGERS) db.exec(`DROP TRIGGER ${t}`);
    for (const t of ["feed_readers", "feed_state"]) db.exec(`DROP TABLE ${t}`);
    for (const t of ["rc_notes_insert", "rc_notes_update", "rc_notes_delete", "rc_note_tags_insert", "rc_note_tags_delete", "rc_note_tags_update", "rc_links_insert", "rc_links_delete", "rc_links_update"]) db.exec(`DROP TRIGGER ${t}`);
    for (const t of ["record_changes", "write_sets", "write_context"]) db.exec(`DROP TABLE ${t}`);
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
