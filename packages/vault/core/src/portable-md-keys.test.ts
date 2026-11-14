/**
 * Frontmatter keys that are not plain YAML words (#75): `it's`, `@at`, `#hash`, `[x]`, `-dash`, `a: b`.
 * The reader used to skip any line whose key did not match `[\w][\w.-]*`, silently. Made-up data.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SqliteStore } from "./store.js";
import { toPortableMarkdown, parseFrontmatter, exportVaultToDir, importPortableVault, SIDECAR_DIR } from "./portable-md.js";

const KEYS = ["it's", 'say "hi"', "@at", "#hash", "[x]", "{y}", "-dash", "a: b", "two words", "&amp", "*star", "!bang", "|pipe", ">gt", "%pct", "`tick", ",comma", "caf\u00e9", "line\nbreak"];

describe("parseFrontmatter reads a quoted key", () => {
  it("double- and single-quoted keys, with their values", () => {
    const { frontmatter } = parseFrontmatter(`---\nid: a\n'it''s': '[[X]]'\n"@at": plain\n'a: b': v\n---\n`);
    expect(frontmatter["it's"]).toBe("[[X]]");
    expect(frontmatter["@at"]).toBe("plain");
    expect(frontmatter["a: b"]).toBe("v");
  });

  it("a quoted key with a block value, and inside a list item's object", () => {
    const { frontmatter } = parseFrontmatter(
      `---\nid: a\n'#h':\n  '[x]': 1\nitems:\n  - '@at': 1\n    "it's": 2\n  - '-d': 3\n---\n`,
    );
    expect(frontmatter["#h"]).toEqual({ "[x]": 1 });
    expect(frontmatter.items).toEqual([{ "@at": 1, "it's": 2 }, { "-d": 3 }]);
  });

  it("a quoted list item is still a string, not a key", () => {
    const { frontmatter } = parseFrontmatter(`---\nid: a\nl:\n  - 'room:ops'\n  - 'ends:'\n---\n`);
    expect(frontmatter.l).toEqual(["room:ops", "ends:"]);
  });
});

describe("the exporter writes a key the plain rule can't read quoted, and it round-trips", () => {
  it.each(KEYS)("key %j", (key) => {
    const metadata = { [key]: "[[X]]", nested: { [key]: [{ [key]: 1, z: 2 }] }, plain_key: "p" };
    const md = toPortableMarkdown({ id: "01M66HE43WKN0Z7EZ0766D7S6N", content: "b", metadata, created_at: "2026-11-01T00:00:00.000Z" });
    expect(md).toContain("  plain_key: p\n");
    expect(parseFrontmatter(md).frontmatter.metadata).toEqual(metadata);
  });
});

describe("a line the reader can't take is reported, not dropped", () => {
  it("warns with the key, at the top level, nested and in a list item", () => {
    const warned: string[] = [];
    const { frontmatter } = parseFrontmatter(
      `---\nid: a\nkept: 1\n@at: lost\nm:\n  ok: 1\n  it's: lost\nl:\n  - a: 1\n    #: x\n    @b: lost\n---\n`,
      "yaml",
      (line) => warned.push(line),
    );
    expect(frontmatter.kept).toBe(1);
    expect((frontmatter.m as any).ok).toBe(1);
    expect(warned.some((w) => w.includes("@at"))).toBe(true);
    expect(warned.some((w) => w.includes("it's"))).toBe(true);
    expect(warned.some((w) => w.includes("@b"))).toBe(true);
  });

  it("a comment line is not a warning", () => {
    const warned: string[] = [];
    parseFrontmatter(`---\nid: a\n# a comment\n---\n`, "yaml", (line) => warned.push(line));
    expect(warned).toEqual([]);
  });
});

describe("the warning for a notes-meta sidecar names the file", () => {
  it("an unreadable key in .parachute/notes-meta/<id>.yaml warns with that file name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pkeys-sidecar-"));
    const warns: string[] = [];
    const orig = console.warn;
    try {
      const store = new SqliteStore(new Database(":memory:"));
      await store.createNote("col1,col2\n1,2\n", { id: "01SIDECARKEY", path: "data/table", extension: "csv" });
      await exportVaultToDir(store, { outDir: dir, vaultName: "t", exportedAt: "2026-01-01T00:00:00.000Z" });
      const file = join(dir, SIDECAR_DIR, "notes-meta", "01SIDECARKEY.yaml");
      writeFileSync(file, readFileSync(file, "utf-8") + "@at: lost\n");
      console.warn = (m: string) => { warns.push(String(m)); };
      await importPortableVault(new SqliteStore(new Database(":memory:")), { inDir: dir });
    } finally {
      console.warn = orig;
      rmSync(dir, { recursive: true, force: true });
    }
    const hit = warns.filter((w) => w.includes("@at"));
    expect(hit.length).toBeGreaterThan(0);
    expect(hit[0]).toContain("notes-meta/01SIDECARKEY.yaml");
  });
});
