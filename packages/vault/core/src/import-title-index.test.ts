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
import { importPortableVault } from "./portable-md.js";
import { syncWikilinks } from "./wikilinks.js";

const SCAN = "SELECT id, path, content FROM notes";

/** Count full-content scans on this connection (the H1-title lookup's query). */
function countScans(db: Database): { scans: number } {
  const counter = { scans: 0 };
  const prepare = db.prepare.bind(db);
  (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string, ...rest: unknown[]) => {
    if (sql.trim() === SCAN) counter.scans++;
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
});
