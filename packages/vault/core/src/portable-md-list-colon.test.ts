/**
 * A list item with a colon survives export and import (T-395). Before the fix
 * `["https://example.org/a"]` came back as `[{"https":"//example.org/a"}]`, and
 * an enum value on a type the same way. Made-up data.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { SqliteStore } from "./store.js";
import { exportVaultToDir, importPortableVault, parseFrontmatter } from "./portable-md.js";

/** Strings a parser could take for a `key:value`, and their neighbours. */
const ITEMS = [
  "https://example.org/a",
  "http://example.org:8080/b?c=d#e",
  "mailto:sam@example.org",
  "2027-02-03T17:00:00Z",
  "12:30",
  "room:ops",
  "a.b-c:d",
  "a :b",
  "a : b",
  "a: b",
  "ends:",
  ":starts",
  "two:co:lons",
  "it's: fine",
  "it's:fine",
  "no colon",
  "line\nbreak:here",
  "[[Projects/Alpha:Beta]]",
  "#tag:x",
];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "t395-list-colon-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/** One line per note and per tag schema, and a digest over the lot. */
async function digest(store: SqliteStore): Promise<{ lines: string[]; sha: string }> {
  const notes = await store.queryNotes({ sort: "asc", limit: 1000 });
  const tags = await store.listTagRecords();
  const lines = [
    ...notes.map((n) => JSON.stringify([n.id, n.path, n.content.replace(/\n+$/, ""), canon(n.metadata), [...(n.tags ?? [])].sort(), n.createdAt, n.updatedAt])),
    ...tags.map((t) => JSON.stringify([t.tag, canon(t.fields ?? null), canon(t.parent_names ?? null)])),
  ].sort();
  return { lines, sha: createHash("sha256").update(lines.join("\n")).digest("hex") };
}

describe("list items with a colon", () => {
  it("export, re-import: digests equal", async () => {
    const source = new SqliteStore(new Database(":memory:"));
    await source.upsertTagRecord("event", { fields: { status: { type: "string", enum: ["a:b", "https://x", "plain"] } } });
    await source.createNote("body", {
      path: "Fake/one",
      tags: ["event", "room:ops"],
      metadata: {
        items: ITEMS,
        people: [{ address: "mailto:sam@example.org", also: ["room:ops"], name: "Sam" }],
        nested: { urls: ["https://example.org/n"] },
        scalar: "https://example.org/s",
      },
    });
    await exportVaultToDir(source, { outDir: dir, exportedAt: "2026-11-06T00:00:00.000Z" });
    const target = new SqliteStore(new Database(":memory:"));
    await importPortableVault(target, { inDir: dir });
    const [before, after] = [await digest(source), await digest(target)];
    expect(after.lines).toEqual(before.lines);
    expect(after.sha).toBe(before.sha);
    // And it stays put: the next export of the import writes the same bytes.
    const again = join(dir, "again");
    await exportVaultToDir(target, { outDir: again, exportedAt: "2026-11-06T00:00:00.000Z" });
    expect(readFileSync(join(again, "Fake/one.md"), "utf8")).toBe(readFileSync(join(dir, "Fake/one.md"), "utf8"));
  });

  it("the exporter leaves a colon outside a list item alone, so existing mirrors don't churn", async () => {
    const source = new SqliteStore(new Database(":memory:"));
    await source.createNote("body", {
      path: "Fake/two",
      metadata: { scalar: "https://example.org/s", people: [{ address: "mailto:sam@example.org" }], plain: ["no colon"] },
      created_at: "2026-11-06T00:00:00.000Z",
    });
    await exportVaultToDir(source, { outDir: dir, exportedAt: "2026-11-06T00:00:00.000Z" });
    const text = readFileSync(join(dir, "Fake/two.md"), "utf8");
    expect(text).toContain("  scalar: https://example.org/s\n");
    expect(text).toContain("    - address: mailto:sam@example.org\n");
    expect(text).toContain("    - no colon\n");
    expect(text).toContain("created_at: 2026-11-06T00:00:00.000Z\n");
  });
});

describe("the list rule in the parser", () => {
  const list = (body: string) => parseFrontmatter(`---\nx:\n${body}---\n`).frontmatter.x;

  it("reads what the old exporter left unquoted as strings", () => {
    expect(list("  - https://example.org/a\n  - room:ops\n  - 2027-02-03T17:00:00Z\n")).toEqual([
      "https://example.org/a",
      "room:ops",
      "2027-02-03T17:00:00Z",
    ]);
  });

  it("still reads object items, in every shape the exporter writes and YAML allows", () => {
    expect(list("  - a: 1\n    b: https://example.org/b\n")).toEqual([{ a: 1, b: "https://example.org/b" }]);
    expect(list("  - a: https://example.org/a\n")).toEqual([{ a: "https://example.org/a" }]);
    expect(list("  - a:\n      - b:c\n")).toEqual([{ a: ["b:c"] }]);
    expect(list("  - a:\n      b: c\n")).toEqual([{ a: { b: "c" } }]);
    expect(list("  - a :  spaced\n")).toEqual([{ a: "spaced" }]);
    expect(list("  - a:\n  - b\n")).toEqual([{ a: "" }, "b"]);
    expect(list("  - a:\tb\n")).toEqual([{ a: "b" }]);
  });

  it("keeps an object item's other keys when its first key holds a colon", () => {
    // The exporter doesn't quote keys, so `{"x:y": 1, "z": 2}` is written like this. Its first key comes back wrong, as
    // it always did, but a string item never has lines under it, so this can't be one, and `z` must survive.
    expect(list("  - x:y: 1\n    z: 2\n")).toEqual([{ x: "y: 1", z: 2 }]);
    expect(list("  - plain:string\n  - x:y: 1\n    z: 2\n  - other:string\n")).toEqual(["plain:string", { x: "y: 1", z: 2 }, "other:string"]);
  });

  it("keeps such an item an object when that key is its only one", () => {
    // Every exporter quotes a string holding `: `, so bare it can only be a key and its value.
    expect(list("  - x:y: 1\n")).toEqual([{ x: "y: 1" }]);
    expect(list("  - x:y: 1\n    z: 2\n  - x:y: 3\n")).toEqual([{ x: "y: 1", z: 2 }, { x: "y: 3" }]);
    expect(list("  - 12:30: standup\n")).toEqual([{ "12": "30: standup" }]);
  });
});
