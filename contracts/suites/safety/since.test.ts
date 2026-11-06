// `since` on MCP query-notes means "what changed since": edits count, not only new notes (T-395).
//
// Before the fix query-notes had no `since`: it was ignored, and the call came back with every note, unfiltered. PR
// #21 still ignores it, with a hint to use date_from, which is created_at, so a caller who follows the hint misses
// every edit. Fixed in packages/vault (core/src/mcp.ts withSinceFilter). date_from stays what it says, created_at.
// Mutants "since-ignored" and "since-on-created-at" put the bug back.
import { beforeAll, describe, expect, test } from "bun:test";
import { mcp, operator, pass, paths, runId, services } from "../lib.ts";

const s = services();
const R = runId("sn").replace(/-/g, "");
const TAG = `${R}log`;
const WORD = `zq${R}word`;
const untouched = `${R}/untouched`;
const edited = `${R}/edited`;
const added = `${R}/added`;
let at: string;

const make = async (path: string) => {
  const r = await operator().post("/notes", { path, content: `${WORD} made up`, tags: [TAG] });
  if (r.status !== 201) throw new Error(`setup: ${path} gave ${r.status}`);
  return r.body as { id: string; updatedAt: string };
};

beforeAll(async () => {
  await make(untouched);
  const old = await make(edited);
  await Bun.sleep(20);
  at = new Date().toISOString();
  await Bun.sleep(20);
  const r = await operator().patch(`/notes/${old.id}`, { content: `${WORD} changed`, if_updated_at: old.updatedAt });
  if (r.status !== 200) throw new Error(`setup: the edit gave ${r.status}`);
  await make(added);
});

async function query(args: Record<string, unknown>, token = s.operatorToken) {
  const c = await mcp(`${s.vaultViaHub}/mcp`, token);
  try {
    return await c.call("query-notes", { tag: TAG, ...args });
  } finally {
    await c.close();
  }
}

describe("query-notes `since`", () => {
  test("finds notes edited since then as well as notes made since then, and leaves out the rest", async () => {
    expect(paths(await query({ since: at }))).toEqual([added, edited].sort());
  });

  test("a tag-scoped pass gets the same answer", async () => {
    const scoped = await pass({ level: "read", tags: [TAG] });
    expect(paths(await query({ since: at }, scoped))).toEqual([added, edited].sort());
  });

  test("narrows search and aggregate too", async () => {
    const found = await query({ since: at, search: WORD });
    expect(paths(found)).toEqual([added, edited].sort());
    expect(await query({ since: at, aggregate: { op: "count" } })).toEqual([{ group: null, value: 2 }]);
  });

  test("the tool's schema offers it, so a client can find it", async () => {
    const c = await mcp(`${s.vaultViaHub}/mcp`, s.operatorToken);
    try {
      const tool = (await c.client.listTools()).tools.find((t) => t.name === "query-notes");
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toContain("since");
    } finally {
      await c.close();
    }
  });

  test("created_at filtering is still there, by name", async () => {
    expect(paths(await query({ date_from: at }))).toEqual([added]);
    expect(paths(await query({ date_filter: { field: "created_at", from: at } }))).toEqual([added]);
    expect(paths(await query({ date_filter: { field: "updated_at", from: at } }))).toEqual([added, edited].sort());
  });

  test("with another date filter it refuses, rather than dropping one", async () => {
    for (const other of [{ date_from: at }, { date_to: at }, { date_filter: { field: "created_at", from: at } }]) {
      await expect(query({ since: at, ...other })).rejects.toThrow(/since/);
    }
  });

  test("null means not set, as clients send for an empty optional", async () => {
    const all = paths(await query({}));
    expect(paths(await query({ since: null }))).toEqual(all);
    expect(paths(await query({ since: at, date_from: null, date_to: null, date_filter: null }))).toEqual([added, edited].sort());
  });

  test("a value that isn't a date is refused, not ignored", async () => {
    await expect(query({ since: "last tuesday" })).rejects.toThrow(/updated_at|date/);
    await expect(query({ since: 20261106 })).rejects.toThrow(/since/);
  });
});
