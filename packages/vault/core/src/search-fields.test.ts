/**
 * Field values in search (0.9.2): the index step that adds a `fields` column to notes_fts without a schema number, and
 * the triggers that keep it right. The cross-engine part (a 0.9.2 engine editing a vault this build migrated) is
 * proven against a real build of the previous code, see the PR; here a vault in the 0.9.2 shape is made by hand.
 */
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema, SCHEMA_VERSION, unnumberedStepsDone } from "./schema.js";
import * as noteOps from "./notes.js";

/** A vault the way a 0.9.2 engine leaves it: two-column index, triggers that watch content and path only. */
function vaultAsLeftBy092(): Database {
  const db = new Database(":memory:");
  initSchema(db);
  db.exec(`
    DROP TRIGGER notes_fts_insert; DROP TRIGGER notes_fts_delete; DROP TRIGGER notes_fts_update;
    DROP TABLE notes_fts; DROP VIEW notes_fts_source; DROP TABLE notes_field_text;
    CREATE VIRTUAL TABLE notes_fts USING fts5(path, content, content='notes', content_rowid='rowid', tokenize='porter unicode61');
    CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(rowid, path, content) VALUES (new.rowid, COALESCE(new.path, ''), new.content);
    END;
    CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, path, content) VALUES('delete', old.rowid, COALESCE(old.path, ''), old.content);
    END;
    CREATE TRIGGER notes_fts_update AFTER UPDATE OF content, path ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, path, content) VALUES('delete', old.rowid, COALESCE(old.path, ''), old.content);
      INSERT INTO notes_fts(rowid, path, content) VALUES (new.rowid, COALESCE(new.path, ''), new.content);
    END;
  `);
  return db;
}

const ids = (db: Database, q: string) => noteOps.searchNotes(db, q).map((n) => n.id);

describe("notes_fts field values", () => {
  it("an older-shaped vault is brought over without a schema number and every record's fields are indexed", () => {
    const db = vaultAsLeftBy092();
    noteOps.createNote(db, "plain", { id: "a", path: "r/a", metadata: { stage: "quokkaone" } });
    noteOps.createNote(db, "plain", { id: "b", path: "r/b", metadata: { kinds: ["x", "quokkatwo"], n: 48172, nest: { deep: { s: "quokkathree" } } } });
    expect(ids(db, "quokkaone")).toEqual([]);
    expect(unnumberedStepsDone(db)).toBe(false);

    const before = (db.prepare("SELECT MAX(version) v FROM schema_version").get() as { v: number }).v;
    initSchema(db);
    expect((db.prepare("SELECT MAX(version) v FROM schema_version").get() as { v: number }).v).toBe(before);
    expect(before).toBe(SCHEMA_VERSION);
    expect(unnumberedStepsDone(db)).toBe(true);

    expect(ids(db, "quokkaone")).toEqual(["a"]);
    expect(ids(db, "quokkatwo")).toEqual(["b"]);
    expect(ids(db, "quokkathree")).toEqual(["b"]);
    expect(ids(db, "48172")).toEqual(["b"]);
    expect(ids(db, "deep")).toEqual([]); // names aren't searched, values are
    db.exec("INSERT INTO notes_fts(notes_fts) VALUES('integrity-check')");
  });

  it("a metadata-only edit re-indexes at once; the old word stops matching; delete leaves nothing", () => {
    const db = vaultAsLeftBy092();
    initSchema(db);
    noteOps.createNote(db, "plain", { id: "a", path: "r/a", metadata: { stage: "tapirold" } });
    expect(ids(db, "tapirold")).toEqual(["a"]);
    noteOps.updateNote(db, "a", { metadata: { stage: "lemurnew" } });
    expect(ids(db, "lemurnew")).toEqual(["a"]);
    expect(ids(db, "tapirold")).toEqual([]);
    db.exec("INSERT INTO notes_fts(notes_fts) VALUES('integrity-check')");
    noteOps.deleteNote(db, "a");
    expect(ids(db, "lemurnew")).toEqual([]);
    expect(db.prepare("SELECT count(*) c FROM notes_field_text").get()).toEqual({ c: 0 });
    db.exec("INSERT INTO notes_fts(notes_fts) VALUES('integrity-check')");
  });

  it("'rebuild' and 'integrity-check' work, so the index can always be rebuilt from the notes", () => {
    const db = new Database(":memory:");
    initSchema(db);
    noteOps.createNote(db, "plain", { id: "a", metadata: { stage: "gnuone" } });
    db.exec("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')");
    db.exec("INSERT INTO notes_fts(notes_fts) VALUES('integrity-check')");
    expect(ids(db, "gnuone")).toEqual(["a"]);
  });

  it("malformed metadata can't make a write fail", () => {
    const db = new Database(":memory:");
    initSchema(db);
    db.prepare("INSERT INTO notes (id, content, metadata, created_at) VALUES ('m', 'x', 'not json', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("UPDATE notes SET metadata = '{oops' WHERE id = 'm'").run();
    db.prepare("UPDATE notes SET metadata = '{\"a\":\"fixedword\"}' WHERE id = 'm'").run();
    expect(ids(db, "fixedword")).toEqual(["m"]);
  });

  it("a field-only hit ranks below a body hit and a path hit", () => {
    const db = new Database(":memory:");
    initSchema(db);
    noteOps.createNote(db, "", { id: "f", path: "r/f", metadata: { line: "okapiz" } });
    noteOps.createNote(db, "an opening line\n\na later line that says okapiz once among other plain words", { id: "b", path: "r/b" });
    noteOps.createNote(db, "", { id: "t", path: "r/okapiz" });
    expect(ids(db, "okapiz")).toEqual(["t", "b", "f"]);
  });

  it("a long body hit still ranks above a field hit in a short record (bm25 alone would not)", () => {
    const db = new Database(":memory:");
    initSchema(db);
    noteOps.createNote(db, "", { id: "f", path: "r/f", metadata: { line: "narwhalq" } });
    noteOps.createNote(db, `intro\n\n${"filler words about nothing much ".repeat(300)} narwhalq`, { id: "b", path: "r/b" });
    expect(ids(db, "narwhalq")).toEqual(["b", "f"]);
  });

  it("a scoped search (throwaway index over visible notes) finds field words and hides the rest", () => {
    const db = new Database(":memory:");
    initSchema(db);
    noteOps.createNote(db, "", { id: "v", path: "r/v", tags: ["mine"], metadata: { line: "zebuword" } });
    noteOps.createNote(db, "", { id: "h", path: "r/h", tags: ["other"], metadata: { line: "zebuword" } });
    const got = noteOps.searchNotes(db, "zebuword", { visible: (n) => n.tags?.includes("mine") ?? false });
    expect(got.map((n) => n.id)).toEqual(["v"]);
  });
});
