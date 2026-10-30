/**
 * Cloudflare Durable Object SQLite refuses a LIKE/GLOB pattern over 50 bytes
 * ("LIKE or GLOB pattern too complex") and a statement with more than 100
 * bound parameters ("too many SQL variables"). T-36 (core#23) took LIKE out of
 * wikilink resolution; these cover the other caller-supplied LIKE queries:
 * `path_prefix`, `exclude_path_prefix`, and the tag-rename cascade.
 *
 * bun:sqlite enforces neither limit, so `enforceDoLimits` wraps
 * `db.prepare` and throws the DO error for a statement that would hit one.
 * The workerd proof is parachute-cloud's
 * workers/vault/test/long-like-patterns.test.ts.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** Throw the DO error for any statement over the LIKE-pattern or bind cap. */
function enforceDoLimits(d: Database) {
  const orig = d.prepare.bind(d);
  (d as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    const stmt = orig(sql) as Record<string, unknown>;
    const hasLike = /\b(LIKE|GLOB)\b/i.test(sql);
    for (const m of [...sql.matchAll(/\b(?:LIKE|GLOB)\s+'((?:[^']|'')*)'/gi)]) {
      if (bytes(m[1]!.replace(/''/g, "'")) > 50) throw new Error("LIKE or GLOB pattern too complex");
    }
    for (const name of ["all", "get", "run", "values", "iterate"] as const) {
      const f = stmt[name];
      if (typeof f !== "function") continue;
      stmt[name] = (...args: unknown[]) => {
        if (args.length > 100) throw new Error("too many SQL variables");
        if (hasLike && args.some((a) => typeof a === "string" && bytes(a) > 50)) {
          throw new Error("LIKE or GLOB pattern too complex");
        }
        return (f as (...x: unknown[]) => unknown).apply(stmt, args);
      };
    }
    return stmt;
  };
}

// A folder name a person would plausibly use: 54 bytes with the slash.
const DIR = "Meetings with the whole friends group about the move/";

let db: Database;
let store: SqliteStore;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
  enforceDoLimits(db);
});

describe("path_prefix / exclude_path_prefix over 50 bytes", () => {
  it("path_prefix with a long folder returns the notes under it", async () => {
    expect(bytes(DIR)).toBeGreaterThan(49);
    await store.createNote("in", { path: `${DIR}one` });
    await store.createNote("out", { path: "elsewhere/two" });
    const got = await store.queryNotes({ pathPrefix: DIR });
    expect(got.map((n) => n.path)).toEqual([`${DIR}one`]);
  });

  it("exclude_path_prefix with a long folder drops the notes under it", async () => {
    await store.createNote("in", { path: `${DIR}one` });
    await store.createNote("out", { path: "elsewhere/two" });
    await store.createNote("pathless");
    const got = await store.queryNotes({ excludePathPrefix: [DIR] });
    expect(got.map((n) => n.path ?? null).sort()).toEqual([null, "elsewhere/two"].sort());
  });

  it("matching keeps LIKE's semantics: ASCII case-insensitive, '_' and '%' literal", async () => {
    await store.createNote("a", { path: "Projects/Alpha" });
    await store.createNote("b", { path: "projectsX/beta" });
    await store.createNote("c", { path: "a_b/c" });
    await store.createNote("d", { path: "aXb/d" });
    expect((await store.queryNotes({ pathPrefix: "PROJECTS/" })).map((n) => n.path)).toEqual(["Projects/Alpha"]);
    expect((await store.queryNotes({ pathPrefix: "a_b/" })).map((n) => n.path)).toEqual(["a_b/c"]);
    expect((await store.queryNotes({ pathPrefix: "%" })).map((n) => n.path)).toEqual([]);
    expect((await store.queryNotes({ excludePathPrefix: ["a_b/"] })).map((n) => n.path)).toContain("aXb/d");
  });
});

describe("rename-tag cascade on Durable Object limits", () => {
  it("renames a tag whose sub-tag is over 48 bytes, rewriting body, parents and _tags paths", async () => {
    const sub = "proj/meetings-with-the-whole-friends-group-about-the-move";
    expect(bytes(sub)).toBeGreaterThan(48);
    const n = await store.createNote(`body #${sub} and [[_tags/${sub}]]`, { tags: [sub] });
    await store.createNote("root", { tags: ["proj"] });
    await store.createNote("config", { path: `_tags/${sub}` });
    const r = await store.renameTag("proj", "project");
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.sub_tags_renamed).toBe(1);
    expect(r.notes_rewritten).toBe(1);
    expect(r.paths_renamed).toBe(1);
    const newSub = "project/meetings-with-the-whole-friends-group-about-the-move";
    expect((await store.getNote(n.id))!.content).toBe(`body #${newSub} and [[_tags/${newSub}]]`);
    expect((await store.getNote(n.id))!.tags).toEqual([newSub]);
    expect((await store.queryNotes({ path: `_tags/${newSub}` })).length).toBe(1);
  });

  it("renames a tag with 50 sub-tags (over 100 bound params with one per pattern)", async () => {
    const subs = Array.from({ length: 50 }, (_, i) => `person/p${i}`);
    await store.createNote(`hi #person/p7`, { tags: ["person", ...subs] });
    const r = await store.renameTag("person", "people");
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.sub_tags_renamed).toBe(50);
    expect(r.notes_rewritten).toBe(1);
  });

  it("rewrites parent_names that name a long tag", async () => {
    const parent = "area/meetings-with-the-whole-friends-group-about-it";
    await store.createNote("x", { tags: [parent, "child"] });
    await store.upsertTagRecord("child", { parent_names: [parent] });
    const r = await store.renameTag(parent, "area/short");
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.parent_refs_updated).toBe(1);
    const row = db.prepare("SELECT parent_names FROM tags WHERE name = 'child'").get() as { parent_names: string };
    expect(JSON.parse(row.parent_names)).toEqual(["area/short"]);
  });

  it("a '_' in the old name is literal: renaming task_ leaves taskX/sub alone", async () => {
    await store.createNote("a", { tags: ["task_", "task_/sub", "taskX/sub"] });
    const r = await store.renameTag("task_", "todo");
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.sub_tags_renamed).toBe(1);
    const names = (db.prepare("SELECT name FROM tags ORDER BY name").all() as { name: string }[]).map((x) => x.name);
    expect(names).toContain("taskX/sub");
    expect(names).toContain("todo/sub");
  });
});
