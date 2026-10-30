/**
 * Cloudflare Durable Object SQLite refuses a statement with more than 100
 * bound parameters ("too many SQL variables"). A tag query expands the tag to
 * itself plus every declared descendant (`parent_names`), and bound one param
 * per tag in the set, so querying a tag with 100+ descendants returned 500 on
 * cloud. bun:sqlite allows far more, so `enforceDoParamCap` wraps
 * `db.prepare` and throws the DO error for a call over 100 params. The
 * workerd proof is parachute-cloud's workers/vault/test/tag-hierarchy-param-cap.test.ts.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";

function enforceDoParamCap(d: Database) {
  const orig = d.prepare.bind(d);
  (d as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    const stmt = orig(sql) as Record<string, unknown>;
    for (const name of ["all", "get", "run", "values", "iterate"] as const) {
      const f = stmt[name];
      if (typeof f !== "function") continue;
      stmt[name] = (...args: unknown[]) => {
        if (args.length > 100) throw new Error("too many SQL variables");
        return (f as (...x: unknown[]) => unknown).apply(stmt, args);
      };
    }
    return stmt;
  };
}

let db: Database;
let store: SqliteStore;
const kids = Array.from({ length: 120 }, (_, i) => `kid${i}`);

beforeEach(async () => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
  enforceDoParamCap(db);
  await store.createNote("on a kid", { tags: ["kid7"] });
  await store.createNote("on the hub", { tags: ["hub"] });
  await store.createNote("elsewhere", { tags: ["other"] });
  for (const k of kids) await store.upsertTagRecord(k, { parent_names: ["hub"] });
});

describe("tag queries over a hierarchy wider than 100 tags", () => {
  it("tag: hub matches the hub and its descendants (match all)", async () => {
    const got = await store.queryNotes({ tags: ["hub"] });
    expect(got.map((n) => n.content).sort()).toEqual(["on a kid", "on the hub"]);
  });

  it("tag: [hub, other] with tag_match any", async () => {
    const got = await store.queryNotes({ tags: ["hub", "other"], tagMatch: "any" });
    expect(got.map((n) => n.content).sort()).toEqual(["elsewhere", "on a kid", "on the hub"]);
  });

  it("a descendant still matches exactly; a non-member does not", async () => {
    expect((await store.queryNotes({ tags: ["kid7"] })).map((n) => n.content)).toEqual(["on a kid"]);
    expect((await store.queryNotes({ tags: ["hub", "other"] })).length).toBe(0);
  });
});
