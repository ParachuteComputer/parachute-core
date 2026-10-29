// Types and tags (T-318 §8a): the v33 migration's rule, both ways, and the kind rules on writes and queries.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { initSchema, SCHEMA_VERSION } from "./schema.js";
import { generateMcpTools } from "./mcp.js";
import { tagKinds, typeKindReport } from "./tag-kind.js";

function fresh() {
  const db = new Database(":memory:");
  initSchema(db);
  return { db, store: new SqliteStore(db), tools: generateMcpTools(new SqliteStore(db)) };
}
const tool = (tools: ReturnType<typeof generateMcpTools>, name: string) => tools.find((t) => t.name === name)!;

describe("every tag record gets a kind (an additive column, no schema number)", () => {
  test("fields or parents or being a parent make a type; everything else is a tag; idempotent; same columns as fresh", async () => {
    const { db, store } = fresh();
    await store.upsertTagRecord("person", { fields: { email: { type: "string" } } });
    await store.upsertTagRecord("event/meeting", { parent_names: ["event"] });
    await store.upsertTagRecord("described", { description: "only a description" });
    await store.createNote("x", { tags: ["pinned", "project/alder", "person", "event/meeting", "event"] });
    // A file as a 0.7/0.8 vault leaves it: no kind column.
    db.exec("ALTER TABLE tags DROP COLUMN kind");
    initSchema(db);
    initSchema(db);
    expect(Object.fromEntries(tagKinds(db))).toEqual({
      person: "type",
      "event/meeting": "type",
      event: "type", // named as a parent, with no fields of its own (its row came from tagging a note)
      described: "tag",
      pinned: "tag",
      "project/alder": "tag", // a slash name stays a flat tag
    });
    const stored = db.prepare("SELECT name, kind FROM tags ORDER BY name").all() as { name: string; kind: string }[];
    expect(stored.every((r) => r.kind === "type" || r.kind === "tag")).toBe(true);
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(SCHEMA_VERSION);
    const cols = (d: Database) => (d.prepare("PRAGMA table_info(tags)").all() as { name: string }[]).map((c) => c.name);
    expect(cols(db)).toEqual(cols(fresh().db));
    // Membership is untouched.
    expect((db.prepare("SELECT COUNT(*) AS n FROM note_tags").get() as { n: number }).n).toBe(5);
    db.close();
  });

  test("an older program that gives a recorded tag fields makes it read as a type, and the next open records it", async () => {
    const { db, store } = fresh();
    await store.createNote("x", { tags: ["label"] });
    initSchema(db);
    expect((db.prepare("SELECT kind FROM tags WHERE name = 'label'").get() as { kind: string }).kind).toBe("tag");
    db.prepare(`UPDATE tags SET fields = '{"a":{"type":"string"}}' WHERE name = 'label'`).run(); // as a 0.8 vault would
    expect(tagKinds(db).get("label")).toBe("type");
    initSchema(db);
    expect((db.prepare("SELECT kind FROM tags WHERE name = 'label'").get() as { kind: string }).kind).toBe("type");
    db.close();
  });

  test("the other way: the file keeps its schema number, and an older vault's own writes still work on it", async () => {
    const { db, store } = fresh();
    await store.upsertTagRecord("task", { fields: { state: { type: "string" } } });
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(32);
    // What a 0.7/0.8 vault writes: it names its columns and knows nothing of kind.
    db.prepare("INSERT INTO tags (name, description, fields, relationships, parent_names, created_at, updated_at) VALUES ('older', NULL, '{\"a\":{\"type\":\"string\"}}', NULL, NULL, 'x', 'x')").run();
    db.prepare("INSERT OR IGNORE INTO tags (name) VALUES ('label')").run();
    expect(tagKinds(db).get("older")).toBe("type"); // read by the rule while unrecorded
    initSchema(db); // the next open records it
    expect(db.prepare("SELECT name, kind FROM tags WHERE name IN ('older', 'label') ORDER BY name").all()).toEqual([
      { name: "label", kind: "tag" },
      { name: "older", kind: "type" },
    ]);
    db.close();
  });

  test("the dry-run report lists plain tags used like types, by count", async () => {
    const { db, store } = fresh();
    await store.upsertTagRecord("task", { fields: { state: { type: "string" } } });
    for (let i = 0; i < 3; i++) await store.createNote(`n${i}`, { tags: ["reading", "task", ...(i ? [] : ["once"])] });
    expect(typeKindReport(db, 2)).toEqual({ types: 1, tags: 2, look_like_types: [{ name: "reading", notes: 3 }], slash_tags: 0 });
    db.close();
  });
});

describe("kind rules", () => {
  test("a parent's own record is never written: not by naming it, not by editing it; kind tag on a parent is refused", async () => {
    const { db, store } = fresh();
    await store.upsertTagRecord("child", { parent_names: ["parent"] });
    await store.createNote("p", { tags: ["parent"] });
    await store.upsertTagRecord("parent", { description: "edited" });
    expect((db.prepare("SELECT kind FROM tags WHERE name = 'parent'").get() as { kind: string | null }).kind).toBeNull();
    expect(tagKinds(db).get("parent")).toBe("type");
    await expect(store.upsertTagRecord("parent", { kind: "tag" })).rejects.toThrow(/another tag's parent/);
    // Drop the child's parent: the parent reads as a tag again, the same on any vault.
    await store.upsertTagRecord("child", { parent_names: [] });
    expect(tagKinds(db).get("parent")).toBe("tag");
    db.close();
  });

  test("a batch that fails leaves no type behind, and a write that succeeds marks its types", async () => {
    const { db, store, tools } = fresh();
    await store.createNote("a", { path: "A" });
    const upd = tool(tools, "update-note");
    await expect(Promise.resolve().then(() => upd.execute({ notes: [{ id: "A", types: { add: ["newtype"] }, force: true }, { id: "missing", content: "x", force: true }] }))).rejects.toThrow();
    expect(tagKinds(db).has("newtype")).toBe(false);
    await expect(Promise.resolve().then(() => tool(tools, "create-note").execute({ notes: [{ path: "B", content: "b", types: ["newtype2"] }, { path: "A", content: "dup" }] }))).rejects.toThrow();
    expect(tagKinds(db).has("newtype2")).toBe(false);
    const ok: any = await upd.execute({ id: "A", types: { add: ["newtype"] }, force: true });
    expect(ok.types ?? (await store.getNote(ok.id))?.types).toEqual(["newtype"]);
    expect(tagKinds(db).get("newtype")).toBe("type");
    db.close();
  });

  test("types beside a batch is refused before anything is made", async () => {
    const { db, tools } = fresh();
    await expect(tool(tools, "create-note").execute({ notes: [{ path: "A", content: "a" }], types: ["secret"] })).rejects.toThrow(/inside each note of a batch/);
    await expect(tool(tools, "update-note").execute({ notes: [], types: ["secret"] })).rejects.toThrow(/inside each note of a batch/);
    expect(tagKinds(db).has("secret")).toBe(false);
    // An update that names no note (missing, empty or null id) makes no type either.
    for (const id of [undefined, "", null]) {
      await expect(Promise.resolve().then(() => tool(tools, "update-note").execute({ ...(id === undefined ? {} : { id }), types: { add: ["secret"] }, force: true }))).rejects.toThrow();
    }
    expect(tagKinds(db).has("secret")).toBe(false);
    db.close();
  });

  test("types with the wrong shape, and type with tags that can't be said exactly, are refused with the fix", async () => {
    const { db, store, tools } = fresh();
    await store.upsertTagRecord("person", { fields: { email: { type: "string" } } });
    await store.upsertTagRecord("org", { fields: { site: { type: "string" } } });
    await expect(tool(tools, "create-note").execute({ path: "X", content: "x", types: { add: ["person"] } })).rejects.toThrow(/types takes a list of names/);
    expect(tagKinds(db).has("[object Object]")).toBe(false);
    const q = tool(tools, "query-notes");
    await expect(q.execute({ type: ["person", "org"], tag: "a" })).rejects.toThrow(/pass one type/);
    await expect(q.execute({ type: "person", tag: ["a", "b"] })).rejects.toThrow(/tag_match/);
    await q.execute({ type: "person", tag: ["a", "b"], tag_match: "all" });
    db.close();
  });

  test("naming a parent never writes the parent's record; it reads as a type", async () => {
    const { db, store } = fresh();
    await store.upsertTagRecord("secret", { kind: "tag" });
    await store.upsertTagRecord("work", { parent_names: ["secret"] });
    expect((db.prepare("SELECT kind FROM tags WHERE name = 'secret'").get() as { kind: string }).kind).toBe("tag");
    expect(tagKinds(db).get("secret")).toBe("type");
    db.close();
  });

  test("fields make a type; an explicit plain tag can't carry fields; a rename keeps the kind", async () => {
    const { db, store, tools } = fresh();
    await store.upsertTagRecord("label", { kind: "type" });
    expect(tagKinds(db).get("label")).toBe("type");
    await expect(store.upsertTagRecord("flat", { kind: "tag", fields: { a: { type: "string" } } })).rejects.toThrow(/can't be a plain tag/);
    await tool(tools, "rename-tag").execute({ old_name: "label", new_name: "label2" });
    expect(tagKinds(db).get("label2")).toBe("type");
    db.close();
  });

  test("writes accept types; a plain tag named as a type is refused with the fix; notes show types and keep tags", async () => {
    const { db, store, tools } = fresh();
    await store.upsertTagRecord("task", { fields: { state: { type: "string" } } });
    await store.createNote("plain", { tags: ["pinned"] });
    const made = (await tool(tools, "create-note").execute({ path: "A", content: "a", types: ["task"], tags: ["pinned"] })) as any;
    expect(made.tags.sort()).toEqual(["pinned", "task"]);
    expect(made.types).toEqual(["task"]);
    await expect(tool(tools, "create-note").execute({ path: "B", content: "b", types: ["pinned"] })).rejects.toThrow(/plain tag, not a type.*manage-types/);
    // An old client's tags: ["task"] lands as the type it is.
    const old = (await tool(tools, "create-note").execute({ path: "C", content: "c", tags: ["task"] })) as any;
    expect(old.types).toEqual(["task"]);
    db.close();
  });

  test("query type includes subtypes; tag on a type keeps today's expansion; type on a plain tag teaches", async () => {
    const { db, store, tools } = fresh();
    await store.upsertTagRecord("event/meeting", { parent_names: ["event"] });
    await store.createNote("e", { path: "E", tags: ["event"] });
    await store.createNote("m", { path: "M", tags: ["event/meeting"] });
    await store.createNote("p", { path: "P", tags: ["pinned"] });
    const q = tool(tools, "query-notes");
    const paths = (r: any) => (Array.isArray(r) ? r : r.notes).map((n: any) => n.path).sort();
    expect(paths(await q.execute({ type: "event" }))).toEqual(["E", "M"]);
    expect(paths(await q.execute({ tag: "event" }))).toEqual(["E", "M"]);
    expect(paths(await q.execute({ type: "event", tag: "event/meeting" }))).toEqual(["M"]);
    await expect(q.execute({ type: "pinned" })).rejects.toThrow(/plain tag, not a type: filter with tag/);
    db.close();
  });
});
