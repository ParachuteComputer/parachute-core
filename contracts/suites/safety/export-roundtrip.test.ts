// Export and import give back the same vault when a list item holds a colon: a URL, a mailto:, a time (T-395).
//
// Before the fix the exporter wrote `- https://example.org/a` unquoted and the importer read it as an object,
// {"https":"//example.org/a"}. Enum values on a type went the same way. Fixed in packages/vault
// (core/src/portable-md.ts): the exporter quotes such an item, and the importer's list rule follows YAML (a key's colon
// has a space or the end of the line after it), which also restores exports already on disk. Mutants
// "list-colon-unquoted" and "list-colon-parsed-as-key" put each half back. Only the CLI and the box's files here.
import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, freePort, newHome } from "../candidate-lib.ts";
import { must, operator, runId, services } from "../lib.ts";

const s = services();
const R = runId("rt").replace(/-/g, "");
const TYPE = `${R}event`;
const path = `${R}/one`;
const SCRATCH = join(s.home, "..", `roundtrip-${R}`);

const METADATA = {
  urls: ["https://example.org/a", "plain", "http://example.org:8080/b?c=d#e"],
  mail: ["mailto:sam@example.org"],
  times: ["2027-02-03T17:00:00Z", "12:30"],
  refs: ["room:ops", "a.b-c:d", "a :b", "ends:", ":starts", "two:co:lons"],
  spaced: ["key: value", "already quoted: yes"],
  people: [{ address: "mailto:sam@example.org", name: "Sam" }],
  scalar: "https://example.org/s",
  when: "2027-02-03T17:00:00Z",
};
const ENUM = ["a:b", "https://example.org/c", "plain"];

const run = async (home: string, args: string[]) => {
  const r = await cli(home, args, { vault: true });
  must(r.code === 0, `parachute-vault ${args[0]} exited ${r.code}: ${r.stderr.slice(-400)}`);
  return r;
};

const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
      : v;
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

const dbFile = (home: string, vault: string) => join(home, "vault", "data", vault, "vault.db");

/** What a vault holds for this run: the note's lines and the type's, read from the file, and a digest of each. */
function digest(home: string, vault: string) {
  const db = new Database(dbFile(home, vault), { readonly: true });
  try {
    const rows = db.query("SELECT id, path, content, metadata, created_at, updated_at FROM notes WHERE path LIKE ?").all(`${R}/%`) as any[];
    const notes = rows.map((n) => {
      const tags = (db.query("SELECT tag_name FROM note_tags WHERE note_id = ?").all(n.id) as any[]).map((t) => t.tag_name).sort();
      return JSON.stringify([n.id, n.path, n.content.replace(/\n+$/, ""), canon(JSON.parse(n.metadata)), tags, n.created_at, n.updated_at]);
    });
    const tag = db.query("SELECT fields FROM tags WHERE name = ?").get(TYPE) as { fields: string } | null;
    const fields = JSON.stringify(canon(tag ? JSON.parse(tag.fields) : null));
    return { notes, fields, digest: sha(`${[...notes].sort().join("\n")}|${fields}`) };
  } finally {
    db.close();
  }
}

/**
 * A second box's home with one vault, to import into. Import refuses while a daemon answers on the home's port, so
 * this home names a free one and nothing serves it: the import is what a restore onto a stopped box does.
 */
async function restoreTarget(label: string): Promise<{ home: string; vault: string }> {
  const home = newHome(label);
  mkdirSync(join(home, "vault"), { recursive: true });
  writeFileSync(join(home, "vault", "config.yaml"), `port: ${await freePort()}\n`);
  await run(home, ["create", "restored", "--no-mirror", "--json"]);
  return { home, vault: "restored" };
}

describe("export, then import into a new vault", () => {
  let dir: string;
  beforeAll(async () => {
    const op = operator();
    const t = await op.put(`/tags/${TYPE}`, { fields: { status: { type: "string", enum: ENUM } } });
    if (t.status >= 300) throw new Error(`setup: declaring the type gave ${t.status}`);
    const n = await op.post("/notes", { path, content: "made up", tags: [TYPE], metadata: METADATA });
    if (n.status !== 201) throw new Error(`setup: the note gave ${n.status}`);
    dir = join(SCRATCH, "export");
    await run(s.home, ["export", dir, "--vault", s.vaultName]);
  });

  test("digests equal: every list item comes back the string it was", async () => {
    const target = await restoreTarget("rt-copy");
    await run(target.home, ["import", dir, "--vault", target.vault, "--blow-away", "--yes"]);
    const before = digest(s.home, s.vaultName);
    const after = digest(target.home, target.vault);
    expect(before.notes.length).toBe(1);
    expect(after.notes).toEqual(before.notes);
    expect(after.fields).toEqual(before.fields);
    expect(after.digest).toBe(before.digest);
  });

  test("the export quotes them, so an importer from before the fix reads them right too", () => {
    const text = readFileSync(join(dir, `${path}.md`), "utf8");
    expect(text).toContain("- 'https://example.org/a'");
    expect(text).toContain("- 'room:ops'");
    expect(text).toContain("- 'ends:'");
    const schema = readFileSync(join(dir, ".parachute", "schemas", `${TYPE}.yaml`), "utf8");
    expect(schema).toContain("- 'a:b'");
  });

  test("only list items change: a scalar and an object item's value stay as they were", () => {
    const text = readFileSync(join(dir, `${path}.md`), "utf8");
    expect(text).toContain("  scalar: https://example.org/s\n");
    expect(text).toContain("- address: mailto:sam@example.org\n");
  });
});

describe("an object item whose first key holds a colon", () => {
  test("an object item keeps its other keys, though the exporter doesn't quote that first key", async () => {
    const op = operator();
    const made = await op.post("/notes", { path: `${R}/colon-key`, content: "made up", metadata: { items: [{ "x:y": 1, z: 2 }] } });
    expect(made.status).toBe(201);
    const dir = join(SCRATCH, "colon-key");
    await run(s.home, ["export", dir, "--vault", s.vaultName]);
    const target = await restoreTarget("rt-key");
    await run(target.home, ["import", dir, "--vault", target.vault, "--blow-away", "--yes"]);
    const db = new Database(dbFile(target.home, target.vault), { readonly: true });
    try {
      const row = db.query("SELECT metadata FROM notes WHERE id = ?").get(made.body.id) as { metadata: string };
      expect(JSON.parse(row.metadata).items[0].z).toBe(2);
    } finally {
      db.close();
    }
  });
});

describe("an export already on disk, written before the fix", () => {
  test("restores its colon list items as strings, and its object items as objects", async () => {
    const dir = join(SCRATCH, "old-export");
    mkdirSync(join(dir, ".parachute"), { recursive: true });
    writeFileSync(join(dir, ".parachute", "vault.yaml"), "exported_at: 2026-11-01T00:00:00.000Z\nformat_version: 1\nname: old\n");
    const id = "01M66HE43WKN0Z7EZ0766D7S6N";
    // Exactly what the old exporter wrote for these values. Made-up data.
    writeFileSync(
      join(dir, "old.md"),
      `---
id: ${id}
path: ${R}/old
metadata:
  people:
    - address: mailto:sam@example.org
      name: Sam
    - nested:
        - room:ops
  times:
    - 2027-02-03T17:00:00Z
  urls:
    - https://example.org/a
    - plain
created_at: 2026-10-27T13:54:21.437Z
updated_at: 2026-10-27T13:54:21.437Z
---
body
`,
    );
    const target = await restoreTarget("rt-old");
    await run(target.home, ["import", dir, "--vault", target.vault, "--blow-away", "--yes"]);
    const db = new Database(dbFile(target.home, target.vault), { readonly: true });
    try {
      const row = db.query("SELECT metadata FROM notes WHERE id = ?").get(id) as { metadata: string };
      expect(JSON.parse(row.metadata)).toEqual({
        people: [{ address: "mailto:sam@example.org", name: "Sam" }, { nested: ["room:ops"] }],
        times: ["2027-02-03T17:00:00Z"],
        urls: ["https://example.org/a", "plain"],
      });
    } finally {
      db.close();
    }
  });
});
