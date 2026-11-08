// T-412: a wake writes nothing, and a create looks its paths up by index.
//
// The Taste Arcade edge-vault test (11-08) found both on cloud, where Durable Object rows read and written are billed
// and capped. Every open of a vault ran every migration: SCHEMA_SQL made `idx_notes_path` (one index row per note),
// v5 found no `idx_notes_path_unique` (v18 drops it), so it re-normalized and re-deduplicated every path, built that
// index (one row per note again), and v18 dropped it. What survived was only the case-sensitive
// `(path, extension)` unique index, so every `path = ? COLLATE NOCASE` lookup read the whole notes table: four of
// them on a create with a reference field and `if_exists`.
//
// A "wake" here is what a Durable Object or a restarted server does: a new connection and a new store on a vault
// that already exists. These tests use a real SQLite file and the real engine; nothing is mocked.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, initSchema } from "./schema.ts";
import { SqliteStore } from "./store.ts";
import { generateMcpTools } from "./mcp.ts";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "t412-"));
  file = join(dir, "vault.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A vault with `n` made-up notes, closed again. */
async function makeVault(n: number): Promise<void> {
  const db = new Database(file);
  const store = new SqliteStore(db);
  await store.createNotes(Array.from({ length: n }, (_, i) => ({ content: `made up ${i}`, path: `seed/Note ${i}` })));
  db.close();
}

function indexes(db: Database): string[] {
  return (db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notes' AND name LIKE 'idx_notes_path%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
}
function cookie(db: Database): number {
  return (db.query("PRAGMA schema_version").get() as { schema_version: number }).schema_version;
}
function stamps(db: Database): unknown[] {
  return db.query("SELECT version, applied_at FROM schema_version ORDER BY version").all();
}
function paths(db: Database): string[] {
  return (db.query("SELECT path || '.' || extension AS p FROM notes WHERE path IS NOT NULL ORDER BY p").all() as { p: string }[]).map((r) => r.p);
}

describe("a wake on a vault at this schema", () => {
  test("changes no schema and writes no row", async () => {
    await makeVault(300);
    const db = new Database(file);
    const before = { cookie: cookie(db), stamps: stamps(db) };
    new SqliteStore(db);
    // The schema cookie moves on every CREATE or DROP; total_changes counts every row this connection wrote.
    expect(cookie(db)).toBe(before.cookie);
    expect(stamps(db)).toEqual(before.stamps);
    expect((db.query("SELECT total_changes() AS n").get() as { n: number }).n).toBe(0);
    db.close();
  });

  test("keeps notes whose paths differ only by extension or by case", async () => {
    // Both are allowed (v18's unique index is on (path, extension), case-sensitive). v5's every-boot dedupe,
    // GROUP BY path COLLATE NOCASE, renamed the second of each pair to `<path>-1` on the next open.
    let db = new Database(file);
    let store = new SqliteStore(db);
    await store.createNote("made up", { path: "Recipes/pasta" });
    await store.createNote("a,b\n1,2", { path: "Recipes/pasta", extension: "csv" });
    await store.createNote("made up", { path: "Inbox/Today" });
    await store.createNote("made up", { path: "inbox/today" });
    const want = paths(db);
    expect(want).toEqual(["Inbox/Today.md", "Recipes/pasta.csv", "Recipes/pasta.md", "inbox/today.md"]);
    db.close();
    for (let wake = 0; wake < 2; wake++) {
      db = new Database(file);
      store = new SqliteStore(db);
      expect(paths(db)).toEqual(want);
      db.close();
    }
  });
});

describe("v5 and v18 against each state of the path indexes", () => {
  // Older vaults reach v33 from any of these: v5's unique index (pre-v18), v18's composite one, both (an
  // interrupted swap), or the old plain index left beside either. Each must end with exactly the composite unique
  // index and the case-insensitive lookup index, with no path renamed.
  const states: [string, string[]][] = [
    ["only v5's unique index", ["DROP INDEX idx_notes_path_ext_unique", "CREATE UNIQUE INDEX idx_notes_path_unique ON notes(path) WHERE path IS NOT NULL"]],
    ["only v18's composite unique index", []],
    ["both unique indexes", ["CREATE UNIQUE INDEX idx_notes_path_unique ON notes(path) WHERE path IS NOT NULL"]],
    ["the old plain index beside v18's", ["CREATE INDEX idx_notes_path ON notes(path) WHERE path IS NOT NULL"]],
  ];
  for (const [what, setup] of states) {
    test(what, async () => {
      await makeVault(50);
      let db = new Database(file);
      db.exec("DROP INDEX IF EXISTS idx_notes_path_nocase");
      for (const s of setup) db.exec(s);
      // Stamp the vault one version back, so the next open runs the migrations.
      db.exec("DELETE FROM schema_version");
      db.query("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(SCHEMA_VERSION - 1, "2026-01-01T00:00:00.000Z");
      const before = paths(db);
      db.close();

      db = new Database(file);
      initSchema(db);
      expect(indexes(db)).toEqual(["idx_notes_path_ext_unique", "idx_notes_path_nocase"]);
      expect(paths(db)).toEqual(before);
      const after = cookie(db);
      db.close();

      // And the open after that is a no-op.
      db = new Database(file);
      initSchema(db);
      expect(cookie(db)).toBe(after);
      db.close();
    });
  }

  test("uniqueness is unchanged: same path and extension refused; another extension or a case variant allowed", async () => {
    const db = new Database(file);
    const store = new SqliteStore(db);
    await store.createNote("one", { path: "Same/path" });
    await expect(store.createNote("two", { path: "Same/path" })).rejects.toThrow();
    await store.createNote("x,y", { path: "Same/path", extension: "csv" });
    await store.createNote("three", { path: "same/PATH" });
    expect(paths(db)).toEqual(["Same/path.csv", "Same/path.md", "same/PATH.md"]);
    db.close();
  });
});

/** A Database that remembers every statement the engine prepares. */
class Recording extends Database {
  seen = new Set<string>();
  override prepare(sql: string, ...rest: any[]): any {
    this.seen.add(sql);
    return (super.prepare as any)(sql, ...rest);
  }
  override query(sql: string): any {
    this.seen.add(sql);
    return super.query(sql);
  }
}

/** Plan steps that read every row of `notes` (a SCAN of the table, or of one of its indexes). */
function scansOfNotes(db: Database, sql: string): string[] {
  if (!/^\s*(SELECT|UPDATE|DELETE|WITH)\b/i.test(sql)) return [];
  let plan: { detail: string }[];
  try {
    plan = db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[];
  } catch {
    return [];
  }
  // Aliases the statement gives notes (`FROM notes n`, `JOIN notes AS t`).
  const names = new Set(["notes"]);
  for (const m of sql.matchAll(/\bnotes\s+(?:AS\s+)?([a-z_][a-z0-9_]*)\b/gi)) {
    const alias = m[1]!.toLowerCase();
    if (!["where", "set", "on", "join", "left", "inner", "order", "group", "limit", "values", "using", "union", "natural", "cross"].includes(alias)) names.add(alias);
  }
  return plan.map((p) => p.detail).filter((d) => {
    const m = d.match(/^SCAN (\S+)/);
    return m !== null && names.has(m[1]!.toLowerCase());
  });
}

describe("a create looks its paths up by index", () => {
  test("an Arcade-shaped create (a reference field, if_exists) runs no statement that scans notes", async () => {
    await makeVault(200);
    const db = new Recording(file);
    const store = new SqliteStore(db);
    await store.upsertTagRecord?.("taste-card", { fields: { card_id: { type: "string", indexed: true } } } as any);
    await store.upsertTagRecord?.("reaction", {
      fields: {
        player: { type: "string", indexed: true },
        at: { type: "date", indexed: true },
        card: { type: "reference", target_tags: ["taste-card"] },
      },
    } as any);
    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    await create.execute({ path: "cards/c1", content: "made-up card", tags: ["taste-card"], metadata: { card_id: "c1" } });
    db.seen.clear();
    const made = await create.execute({
      path: "reactions/p1/r1",
      content: "made up",
      tags: ["reaction"],
      metadata: { player: "p1", at: "2026-11-08T00:00:00.000Z", card: "cards/c1" },
      if_exists: "ignore",
    });
    expect((made as any).id).toBeTruthy();
    const pathLookups = [...db.seen].filter((s) => /path\s*=\s*\?\s*COLLATE NOCASE/i.test(s));
    expect(pathLookups.length).toBeGreaterThan(0);
    const scanning = [...db.seen].map((s) => ({ s: s.replace(/\s+/g, " ").trim().slice(0, 200), scans: scansOfNotes(db, s) })).filter((x) => x.scans.length > 0);
    expect(scanning).toEqual([]);
    db.close();
  });
});

describe("a tag filter beside an indexed equality", () => {
  test("probes the tag per candidate instead of listing every note under it, and finds the same notes", async () => {
    const db = new Recording(file);
    const store = new SqliteStore(db);
    await store.upsertTagRecord("reaction", { fields: { player: { type: "string", indexed: true } } } as any);
    await store.upsertTagRecord("other", { fields: { player: { type: "string", indexed: true } } } as any);
    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const want: string[] = [];
    for (let i = 0; i < 120; i++) {
      const tag = i % 3 === 0 ? "other" : "reaction";
      const path = `reactions/p${i % 4}/r${i}`;
      await create.execute({ path, content: "made up", tags: [tag], metadata: { player: `p${i % 4}` } });
      if (tag === "reaction" && i % 4 === 1) want.push(path);
    }
    const found = async (q: Record<string, unknown>) => {
      db.seen.clear();
      const r = (await store.queryNotes({ tags: ["reaction"], limit: 1000, ...q } as any)) as { path: string }[];
      return r.map((n) => n.path).sort();
    };
    for (const metadata of [{ player: { eq: "p1" } }, { player: { in: ["p1"] } }, { player: "p1" }]) {
      expect(await found({ metadata })).toEqual([...want].sort());
      const main = [...db.seen].find((s) => /FROM notes n\b/.test(s) && /meta_player/.test(s))!;
      expect(main).toBeTruthy();
      const plan = (db.query(`EXPLAIN QUERY PLAN ${main}`).all() as { detail: string }[]).map((p) => p.detail);
      // idx_note_tags_tag (tag_name, note_id) is how SQLite lists a whole tag.
      expect(plan.filter((d) => /idx_note_tags_tag\b/.test(d))).toEqual([]);
      expect(plan.some((d) => /USING INDEX idx_meta_player\b/.test(d))).toBe(true);
    }
    // With no indexed equality, the tag still drives (its ids are walked, not every note).
    await found({});
    const tagOnly = [...db.seen].find((s) => /FROM notes n\b/.test(s) && /note_tags/.test(s))!;
    const plan = (db.query(`EXPLAIN QUERY PLAN ${tagOnly}`).all() as { detail: string }[]).map((p) => p.detail);
    expect(plan.some((d) => /^SCAN n\b/.test(d) && !/USING/.test(d))).toBe(false);
    db.close();
  });
});
