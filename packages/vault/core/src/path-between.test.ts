// T-318 §4: query-notes {path_between} answers wherever query-notes is generated (core), as find-path did.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { initSchema } from "./schema.js";
import { generateMcpTools } from "./mcp.js";

test("core query-notes {path_between} is find-path, and never a plain list", async () => {
  const db = new Database(":memory:");
  initSchema(db);
  const store = new SqliteStore(db);
  await store.createNote("end", { path: "B" });
  await store.createNote("to [[B]]", { path: "A" });
  await store.createNote("unrelated", { path: "C" });
  const tools = generateMcpTools(store);
  const q = tools.find((t) => t.name === "query-notes")!;
  const fp = tools.find((t) => t.name === "find-path")!;
  const fresh: any = await q.execute({ path_between: { source: "A", target: "B" } });
  expect(fresh.path).toHaveLength(2);
  expect(fresh).toEqual(await fp.execute({ source: "A", target: "B" }));
  // A missing endpoint is find-path's not_found, not a list of every note.
  await expect(Promise.resolve().then(() => q.execute({ path_between: { source: "nope", target: "B" } }))).rejects.toThrow(/Note not found/);
  await expect(Promise.resolve().then(() => q.execute({ path_between: "A" }))).rejects.toThrow(/path_between takes/);
  db.close();
});
