/**
 * Restoring an export written by the exporter before 2ca5178 (every nightly
 * snapshot taken before 2026-10-29). That exporter wrote a metadata string
 * starting with `[ ] { } , ' "` unquoted, so a plain YAML read turns
 * `wiki: "[[Projects/Alpha]]"` into a nested list and `'single'` into `single`.
 * The bytes below are exactly what it wrote (vault f147e34 / core 54475a5,
 * captured with T-318's snapshot-restore check). Made-up data.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { SqliteStore } from "./store.js";
import { exportVaultToDir, importPortableVault, parseFrontmatter } from "./portable-md.js";

/** The metadata the note really had. */
const VALUES: Record<string, unknown> = {
  wiki: "[[Projects/Alpha]]",
  bracket: "[draft]",
  brace: "{x}",
  sq: "'single'",
  dq: '"double"',
  comma: ", lead",
  close: "]x",
  list: ["[[A]]", "plain"],
};

/** What the old exporter wrote for it. */
const OLD_NOTE = `---
id: 01M66HE43WKN0Z7EZ0766D7S6N
path: Notes/Meta
metadata:
  brace: {x}
  bracket: [draft]
  close: ]x
  comma: , lead
  dq: "double"
  list:
    - [[A]]
    - plain
  sq: 'single'
  wiki: [[Projects/Alpha]]
created_at: 2026-10-27T13:54:21.437Z
updated_at: 2026-10-27T13:54:21.437Z
---
body
`;

let tmpBase: string;
let n = 0;

function writeOldExport(exportedAt: string): string {
  const dir = join(tmpBase, `old-${n++}`);
  mkdirSync(join(dir, ".parachute"), { recursive: true });
  mkdirSync(join(dir, "Notes"), { recursive: true });
  writeFileSync(join(dir, ".parachute", "vault.yaml"), `export_format_version: 1\nexported_at: ${exportedAt}\nname: x\n`);
  writeFileSync(join(dir, "Notes", "Meta.md"), OLD_NOTE);
  return dir;
}

async function restoredMetadata(inDir: string): Promise<Record<string, unknown>> {
  const store = new SqliteStore(new Database(":memory:"));
  await importPortableVault(store, { inDir, blowAway: true });
  return (await store.getNote("01M66HE43WKN0Z7EZ0766D7S6N"))!.metadata as Record<string, unknown>;
}

beforeEach(() => {
  tmpBase = join(tmpdir(), `pmd-old-export-${process.pid}-${Date.now()}`);
  rmSync(tmpBase, { recursive: true, force: true });
  mkdirSync(tmpBase, { recursive: true });
});

describe("restore of an export the old exporter wrote", () => {
  it("brings every metadata value back exactly (snapshot from before the quoting fix)", async () => {
    expect(await restoredMetadata(writeOldExport("2026-10-28T04:00:00.000Z"))).toEqual(VALUES);
  });

  it("reads unquoted [..] and {..} as strings even when the export is dated after the fix", async () => {
    // An old engine can still write these after the fix shipped (a rollback, a
    // hub not yet upgraded). Neither exporter ever writes a non-empty flow
    // collection, so one in an export is a string that lost its quotes. The
    // quote-led values can't be told apart from the new exporter's quoting
    // without the date, so they are not asserted here.
    const back = await restoredMetadata(writeOldExport("2026-10-30T04:00:00.000Z"));
    expect(back.wiki).toBe("[[Projects/Alpha]]");
    expect(back.bracket).toBe("[draft]");
    expect(back.brace).toBe("{x}");
    expect(back.list).toEqual(["[[A]]", "plain"]);
  });

  it("still round-trips the current exporter's output exactly", async () => {
    const src = new SqliteStore(new Database(":memory:"));
    await src.createNote("body", { id: "n-new", path: "Notes/New", metadata: { ...VALUES, empty: [], none: {} } });
    const out = join(tmpBase, "new");
    await exportVaultToDir(src, { outDir: out });
    const dst = new SqliteStore(new Database(":memory:"));
    await importPortableVault(dst, { inDir: out, blowAway: true });
    expect((await dst.getNote("n-new"))!.metadata).toEqual({ ...VALUES, empty: [], none: {} });
  });

  it("leaves plain YAML parsing alone outside an export (Obsidian frontmatter keeps flow lists)", () => {
    const fm = parseFrontmatter("---\ntags: [a, b]\nrel: [[x]]\nq: 'single'\n---\n").frontmatter;
    expect(fm.tags).toEqual(["a", "b"]);
    expect(fm.rel).toEqual([["x"]]);
    expect(fm.q).toBe("single");
  });
});
