// T-318 §8a + portable-md: a type with no fields or parents (made by `kind: "type"`, or by a write's `types`)
// is recorded only in tags.kind. The portable export (on-demand export, cloud's nightly snapshots and restore,
// account moves) must carry it, or the restored vault reads it as a plain tag and refuses `type`/`types` with it.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SqliteStore } from "./store.js";
import { initSchema } from "./schema.js";
import { generateMcpTools } from "./mcp.js";
import { tagKinds } from "./tag-kind.js";
import { exportVaultToDir, importPortableVault } from "./portable-md.js";

function fresh() {
  const db = new Database(":memory:");
  initSchema(db);
  const store = new SqliteStore(db);
  return { db, store, tools: generateMcpTools(store) };
}
const run = (tools: ReturnType<typeof generateMcpTools>, name: string, params: Record<string, unknown>) =>
  tools.find((t) => t.name === name)!.execute(params) as Promise<any>;

describe("a type with no fields survives export and import", () => {
  test("kind: type (promoted) and types: [...] (made by a write) both come back as types", async () => {
    const src = fresh();
    await run(src.tools, "update-tag", { tag: "project", kind: "type" });
    await run(src.tools, "create-note", { path: "p/alder", content: "Alder", tags: ["project"] });
    await run(src.tools, "create-note", { path: "m/one", content: "One", types: ["meeting"] });
    await run(src.tools, "create-note", { path: "x", content: "x", tags: ["pinned"] });
    await run(src.tools, "create-note", { path: "e", content: "e", tags: ["event"] });
    await run(src.tools, "update-tag", { tag: "event/meeting", parent_names: ["event"] });
    // A parent is read as a type, never written as one: it must not become a recorded type on the way through.
    expect(Object.fromEntries(tagKinds(src.db))).toMatchObject({ project: "type", meeting: "type", pinned: "tag", event: "type" });

    const dir = mkdtempSync(join(tmpdir(), "kind-portable-"));
    try {
      await exportVaultToDir(src.store, { outDir: dir, exportedAt: "2026-10-31T00:00:00.000Z" });
      const dst = fresh();
      await importPortableVault(dst.store, { inDir: dir, blowAway: true });
      initSchema(dst.db); // the next wake
      expect(Object.fromEntries(tagKinds(dst.db))).toMatchObject({ project: "type", meeting: "type", pinned: "tag", event: "type" });
      // What an agent sees: the type filter and a typed write keep working after the restore.
      const q = await run(dst.tools, "query-notes", { type: "project" });
      expect((Array.isArray(q) ? q : q.notes).map((n: any) => n.path)).toEqual(["p/alder"]);
      const made = await run(dst.tools, "create-note", { path: "m/two", content: "Two", types: ["meeting"] });
      expect(made.types).toEqual(["meeting"]);
      // Being a parent stays read, not recorded: dropping the last child makes event a plain tag again, as before export.
      await run(dst.tools, "update-tag", { tag: "event/meeting", parent_names: [] });
      const stored = dst.db.prepare("SELECT kind FROM tags WHERE name = 'event'").get() as { kind: string | null } | null;
      expect(stored?.kind ?? "tag").toBe("tag");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
