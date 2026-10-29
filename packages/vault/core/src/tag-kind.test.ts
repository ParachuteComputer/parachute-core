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

describe("v33: every tag record gets a kind", () => {
  test("fields or parents or being a parent make a type; everything else is a tag; idempotent; same columns as fresh", async () => {
    const { db, store } = fresh();
    await store.upsertTagRecord("person", { fields: { email: { type: "string" } } });
    await store.upsertTagRecord("event/meeting", { parent_names: ["event"] });
    await store.upsertTagRecord("described", { description: "only a description" });
    await store.createNote("x", { tags: ["pinned", "project/alder", "person", "event/meeting", "event"] });
    // Back to v32 by hand: the column gone, the version stamped 32.
    db.exec("ALTER TABLE tags DROP COLUMN kind; DELETE FROM schema_version; INSERT INTO schema_version (version, applied_at) VALUES (32, '2026-10-01T00:00:00.000Z')");
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

  test("a v33 vault opened by an older build is refused, not misread (the rollback is the takeover's restore)", () => {
    const { db } = fresh();
    db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (${SCHEMA_VERSION + 1}, '2099-01-01T00:00:00.000Z')`);
    expect(() => initSchema(db)).toThrow();
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
