/**
 * T-318: a portable-md import used to scan every note's content once per
 * wikilink that missed on id, path and basename (the H1-title fallback), both
 * while each note landed and again in the final syncAllWikilinks pass. That is
 * quadratic in the vault: a real 2,698-note vault ran past the Durable
 * Object's 300 s CPU limit on cloud and could not be imported at all.
 *
 * These tests count the full-content scans an import runs, and check that the
 * links it builds are the ones a plain per-note resolution gives.
 *
 * RED without the fix: drop `deferWikilinkSync: true` in importVaultReplay and
 * the per-note pass scans again (hundreds of scans); drop the withTitleIndex
 * wrapper in syncAllWikilinks and the final pass does.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SqliteStore } from "./store.js";
import { importPortableVault, importVault, IMPORT_CHECKPOINT_NOTES } from "./portable-md.js";
import { syncWikilinks, resolveWikilinkDetailed } from "./wikilinks.js";
import { withTitleIndex } from "./notes.js";

/** The H1-title lookup's scan, and the one scan that builds the index. */
const SCANS = new Set(["SELECT id, path, content FROM notes", "SELECT id, path, extension, content FROM notes"]);

/** Count full-content scans on this connection (the H1-title lookup's query). */
function countScans(db: Database): { scans: number } {
  const counter = { scans: 0 };
  const prepare = db.prepare.bind(db);
  (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string, ...rest: unknown[]) => {
    if (SCANS.has(sql.trim())) counter.scans++;
    return (prepare as (s: string, ...r: unknown[]) => ReturnType<typeof db.prepare>)(sql, ...rest);
  }) as typeof db.prepare;
  return counter;
}

/**
 * N notes. Each links to the NEXT note by its H1 title (a forward reference:
 * the target lands later, and its path differs from its title, so only the
 * title fallback finds it), to one title nobody has (stays unresolved), and to
 * the previous note by path.
 */
function writeExport(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), "t318-title-index-"));
  mkdirSync(join(dir, ".parachute"), { recursive: true });
  writeFileSync(join(dir, ".parachute", "vault.yaml"), "name: titles\nexport_format_version: 1\n");
  mkdirSync(join(dir, "notes"), { recursive: true });
  for (let i = 0; i < n; i++) {
    const id = `note-${String(i).padStart(4, "0")}`;
    const body = [
      `# Topic number ${i}`,
      "",
      `Next: [[Topic number ${i + 1}]]. Missing: [[Nobody wrote ${i}]].`,
      i > 0 ? `Previous: [[notes/n${i - 1}]].` : "",
      "",
    ].join("\n");
    writeFileSync(
      join(dir, "notes", `n${i}.md`),
      `---\nid: ${id}\npath: notes/n${i}\ncreated_at: "2026-10-01T00:00:00.000Z"\nupdated_at: "2026-10-02T00:00:00.000Z"\n---\n${body}`,
    );
  }
  return dir;
}

describe("portable-md import: wikilink title fallback (T-318)", () => {
  it("scans note content a bounded number of times, not once per missed wikilink", async () => {
    const n = 120;
    const db = new Database(":memory:");
    const store = new SqliteStore(db);
    const counter = countScans(db);
    const stats = await importPortableVault(store, { inDir: writeExport(n), blowAway: true });
    expect(stats.notes_created).toBe(n);
    // One scan builds the title index for the final pass. Before the fix this
    // was 2 scans per note (each note's own sync) plus 2 per note again in the
    // final pass: about 4n.
    expect(counter.scans).toBeLessThanOrEqual(2);
  });

  it("builds the same links, unresolved and ambiguous rows as resolving each note on its own", async () => {
    const n = 40;
    const db = new Database(":memory:");
    const store = new SqliteStore(db);
    await importPortableVault(store, { inDir: writeExport(n), blowAway: true });

    const links = () =>
      (db.query("SELECT source_id, target_id, relationship FROM links ORDER BY 1, 2, 3").all() as unknown[]).map((r) => JSON.stringify(r));
    const unresolved = () =>
      (db.query("SELECT source_id, target_path, relationship FROM unresolved_wikilinks ORDER BY 1, 2, 3").all() as unknown[]).map((r) =>
        JSON.stringify(r),
      );
    const before = { links: links(), unresolved: unresolved() };
    // Forward title links resolved: n-1 "next" + n-1 "previous"; the last
    // note's "next" and every "missing" stay unresolved.
    expect(before.links.length).toBe(2 * (n - 1));
    expect(before.unresolved.length).toBe(n + 1);

    // Resolve every note again the plain way: one note at a time, no index.
    let changed = 0;
    for (const row of db.query("SELECT id, content FROM notes").all() as { id: string; content: string }[]) {
      const r = syncWikilinks(db, row.id, row.content);
      changed += r.added + r.removed;
    }
    expect(changed).toBe(0);
    expect(links()).toEqual(before.links);
    expect(unresolved()).toEqual(before.unresolved);
  });

  it("an ordinary createNote still resolves its wikilinks at once", async () => {
    const store = new SqliteStore(new Database(":memory:"));
    const target = await store.createNote("# Plain Title\n\nbody", { path: "a/target" });
    const src = await store.createNote("see [[Plain Title]]", { path: "a/source" });
    const out = await store.getLinks(src.id, { direction: "outbound" });
    expect(out.map((l) => l.targetId)).toEqual([target.id]);
  });

  it("awaits the checkpoint during the replay and lands the same vault (cloud commits in chunks)", async () => {
    const n = 2 * IMPORT_CHECKPOINT_NOTES + 10;
    const dir = writeExport(n);
    const snapshot = (db: Database) =>
      JSON.stringify([
        db.query("SELECT id, path, content, metadata, created_at, updated_at FROM notes ORDER BY id").all(),
        db.query("SELECT source_id, target_id, relationship FROM links ORDER BY 1, 2, 3").all(),
        db.query("SELECT source_id, target_path, relationship FROM unresolved_wikilinks ORDER BY 1, 2, 3").all(),
      ]);
    const plainDb = new Database(":memory:");
    await importPortableVault(new SqliteStore(plainDb), { inDir: dir, blowAway: true });

    const chunkDb = new Database(":memory:");
    let calls = 0;
    const { FsImportSource } = await import("./portable-md.js");
    await importVault(new SqliteStore(chunkDb), new FsImportSource({ inDir: dir }), {
      blowAway: true,
      checkpoint: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 0));
      },
    });
    // 2 in the notes loop (at 200 and 400) + 2 in the final wikilink pass.
    expect(calls).toBe(4);
    expect(snapshot(chunkDb)).toBe(snapshot(plainDb));

    // A retry into the now-full vault also chunks its wipe (one 500-note batch).
    calls = 0;
    await importVault(new SqliteStore(chunkDb), new FsImportSource({ inDir: dir }), {
      blowAway: true,
      checkpoint: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 0));
      },
    });
    expect(calls).toBe(5);
    expect(snapshot(chunkDb)).toBe(snapshot(plainDb));
  });
});

describe("withTitleIndex answers exactly like the SQL it replaces (T-318)", () => {
  it("same resolution, candidates and order for odd paths and titles", async () => {
    const db = new Database(":memory:");
    const store = new SqliteStore(db);
    // Insertion order matters: the SQL returns table order, so a suffix match
    // inserted before a whole-path match must stay first.
    const notes: Array<[string | undefined, string]> = [
      ["z/readme", "# Shared title"],
      ["README", "# shared TITLE"],
      ["Projects/Parachute/Plan", "plan"],
      ["Archive/parachute/plan", "old plan"],
      ["Café/Été", "# Über Notes"],
      ["café/ÉTÉ", "x"],
      ["docs/a/b/c", "deep"],
      ["other/B/C", "deep too"],
      [undefined, "# Pathless Title"],
      ["MiXeD/Case", "# Ünïcode Heading"],
      ["solo/unique-name", "# Only One"],
    ];
    for (const [path, content] of notes) await store.createNote(content, path ? { path } : {});
    // Same path, two extensions: the SQL orders these by extension.
    await store.createNote("md body", { path: "x/dup/readme" });
    await store.createNote("csv body", { path: "x/dup/readme", extension: "csv" });

    const targets = [
      "readme", "README", "plan", "Parachute/Plan", "parachute/plan", "Été", "été", "ÉTÉ", "Café/Été",
      "b/c", "B/C", "a/b/c", "c", "Shared title", "shared title", "Pathless Title", "über notes",
      "Über Notes", "ünïcode heading", "case", "CASE", "unique-name", "Only One", "nobody", "MiXeD/Case", "dup/readme",
    ];
    const plain = targets.map((t) => resolveWikilinkDetailed(db, t));
    const indexed = withTitleIndex(db, () => targets.map((t) => resolveWikilinkDetailed(db, t)));
    expect(indexed).toEqual(plain);
    // The fixture really exercises ambiguity with more than one candidate.
    expect(plain.filter((r) => r.ambiguous && r.candidates.length > 1).length).toBeGreaterThanOrEqual(3);
  });
});
