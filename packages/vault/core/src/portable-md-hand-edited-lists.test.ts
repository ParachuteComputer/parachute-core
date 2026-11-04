/**
 * A portable-md export edited by hand, then imported again (the format's
 * documented "drop the export into Obsidian, edit, re-import" use). core#32
 * reads an export's unquoted `[..]` as the string it looks like, because the
 * old exporter left such metadata strings unquoted. That is right for a
 * metadata value, but `tags`, a schema's `parent_names` and a field's `enum`
 * are lists the exporter only ever writes in block form, so a `[..]` there
 * was written by a person and is a list. Before core#32 these imported as
 * lists; after it `tags` were silently dropped, a `parent_names` list made the
 * whole import throw, and an `enum` was stored as one string.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { SqliteStore } from "./store.js";
import { exportVaultToDir, importPortableVault } from "./portable-md.js";

let tmpBase: string;

beforeEach(() => {
  tmpBase = join(tmpdir(), `pmd-hand-lists-${process.pid}-${Date.now()}`);
  rmSync(tmpBase, { recursive: true, force: true });
  mkdirSync(tmpBase, { recursive: true });
});

afterEach(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

/** Export `src`, apply `edit` to one file of the export, import into a fresh store. */
async function editAndReimport(
  src: SqliteStore,
  file: string,
  edit: (raw: string) => string,
): Promise<SqliteStore> {
  const out = join(tmpBase, "export");
  await exportVaultToDir(src, { outDir: out });
  const path = join(out, file);
  const raw = readFileSync(path, "utf8");
  const edited = edit(raw);
  expect(edited).not.toBe(raw);
  writeFileSync(path, edited);
  const dst = new SqliteStore(new Database(":memory:"));
  await importPortableVault(dst, { inDir: out, blowAway: true });
  return dst;
}

describe("re-importing a hand-edited current export", () => {
  it("reads a flow list of tags as tags (not a string, which dropped every tag)", async () => {
    const src = new SqliteStore(new Database(":memory:"));
    await src.createNote("body", { id: "n1", path: "Notes/A", tags: ["keep"], metadata: { owners: "x" } });
    const dst = await editAndReimport(src, "Notes/A.md", (raw) =>
      raw.replace("tags:\n  - keep\n", "tags: [keep, urgent]\n").replace("  owners: x\n", "  owners: [ann, bob]\n"),
    );
    const n = (await dst.getNote("n1"))!;
    expect([...n.tags!].sort()).toEqual(["keep", "urgent"]);
    // Metadata stays core#32's decided reading: an unquoted [..] value is a string.
    expect(n.metadata).toEqual({ owners: "[ann, bob]" });
  });

  it("reads a flow list of parent_names in a schema file as parents (the import used to throw)", async () => {
    const src = new SqliteStore(new Database(":memory:"));
    await src.createNote("body", { id: "n1", path: "Notes/A", tags: ["child"] });
    await src.upsertTagRecord("p1", { description: "p" });
    await src.upsertTagRecord("p2", { description: "p" });
    await src.upsertTagRecord("child", { description: "c", parent_names: ["p1"] });
    const dst = await editAndReimport(src, ".parachute/schemas/child.yaml", (raw) =>
      raw.replace("parent_names:\n  - p1\n", "parent_names: [p1, p2]\n"),
    );
    const rec = (await dst.listTagRecords()).find((t) => t.tag === "child");
    expect(rec?.parent_names).toEqual(["p1", "p2"]);
  });

  it("reads a flow list as a field's enum (it was stored as one string)", async () => {
    const src = new SqliteStore(new Database(":memory:"));
    await src.createNote("body", { id: "n1", path: "Notes/A", tags: ["task"], metadata: { status: "todo" } });
    await src.upsertTagRecord("task", { fields: { status: { type: "string", enum: ["todo", "done"] } } });
    const dst = await editAndReimport(src, ".parachute/schemas/task.yaml", (raw) =>
      raw.replace("    enum:\n      - todo\n      - done\n", "    enum: [todo, done, blocked]\n"),
    );
    const rec = (await dst.listTagRecords()).find((t) => t.tag === "task");
    expect((rec?.fields as Record<string, { enum?: unknown }>).status!.enum).toEqual(["todo", "done", "blocked"]);
  });
});
