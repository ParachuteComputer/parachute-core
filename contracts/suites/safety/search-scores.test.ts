// Fix 8: what a tag-scoped pass gets back from search doesn't depend on notes it can't see.
//
// Before the fix (vault 42fbf93) full-text search returned `score` = -bm25 (core/src/notes.ts:1995), and FTS5's bm25
// uses corpus-wide statistics (how many notes hold the word, the average note length), computed before the scope
// filter. So the score of the same visible note moved when hidden notes holding the word were added: a scoped pass
// could count hidden notes about a word (research t289 deep/access FINDINGS.md §5, "Search snippets" row). Fixed by
// lane F in packages/vault (core/src/notes.ts searchVisibleOnly): a scoped search is ranked and limited over the notes the pass can
// see. Mutant "search-index-wide" puts the bug back. PLAN §5 fix 8.
//
// The oracle is a twin: search as the scoped pass, have the operator add hidden notes that hold the same word,
// search again. Nothing the pass can see changed, so the answer must be identical: ids, order, scores, snippets.
import { beforeAll, describe, expect, test } from "bun:test";
import { mcp, must, rest, runId, services } from "../lib.ts";
import { note, pass } from "./_lib.ts";

const s = services();
const R = runId("ss").replace(/-/g, "");
const MINE = `${R}mine`;
const OTHER = `${R}other`;
const WORD = `zq${R}needle`;
let scoped: string;
let api: ReturnType<typeof rest>;

beforeAll(async () => {
  scoped = await pass({ level: "read", tags: [MINE] });
  api = rest(s.vaultViaHub, scoped);
  // Two visible notes holding the word, of different lengths so they have different scores.
  await note(`${R}/v1`, `${WORD} once`, [MINE]);
  await note(`${R}/v2`, `${WORD} ${WORD} and a few more words around it, so this note is the longer one`, [MINE]);
});

async function restSearch(limit = 50) {
  const r = await api.get(`/notes?search=${WORD}&limit=${limit}`);
  expect(r.status).toBe(200);
  return r.body as any[];
}

async function mcpSearch(limit = 50) {
  const c = await mcp(`${s.vaultViaHub}/mcp`, scoped);
  try {
    const q = await c.call("query-notes", { search: WORD, limit });
    return (Array.isArray(q) ? q : (q.notes ?? q.results ?? [])) as any[];
  } finally {
    await c.close();
  }
}

/** Fields that differ between the two answers, per note, for a readable reason. */
function diff(a: any[], b: any[]): string {
  const out: string[] = [];
  if (a.map((n) => n.id).join() !== b.map((n) => n.id).join()) out.push(`ids/order ${a.map((n) => n.id)} → ${b.map((n) => n.id)}`);
  for (const [i, n] of a.entries()) {
    const m = b[i] ?? {};
    for (const k of new Set([...Object.keys(n), ...Object.keys(m)])) {
      if (JSON.stringify(n[k]) !== JSON.stringify(m[k])) out.push(`${n.path ?? n.id}.${k}: ${JSON.stringify(n[k])} → ${JSON.stringify(m[k])}`);
    }
  }
  return out.join("; ");
}

describe("search answers don't depend on hidden notes (fix 8)", () => {
  let restBefore: any[] = [];
  let mcpBefore: any[] = [];
  let restAfter: any[] = [];
  let mcpAfter: any[] = [];

  beforeAll(async () => {
    restBefore = await restSearch();
    mcpBefore = await mcpSearch();
    // The operator adds hidden notes that hold the same word, several times over.
    for (let i = 0; i < 8; i++) await note(`${R}/hidden${i}`, `${WORD} ${WORD} ${WORD} hidden ${i}`, [OTHER]);
    restAfter = await restSearch();
    mcpAfter = await mcpSearch();
  });

  test("setup works today: the scoped pass finds exactly its two notes, before and after, on REST and MCP", () => {
    for (const list of [restBefore, restAfter, mcpBefore, mcpAfter]) {
      expect(list.map((n) => n.path).sort()).toEqual([`${R}/v1`, `${R}/v2`]);
    }
  });

  test("REST search gives a scoped pass the same answer whether or not hidden notes hold the word", () => {
    const d = diff(restBefore, restAfter);
    must(d === "", `REST search answer moved when hidden notes were added: ${d}`);
  });

  test("MCP search gives a scoped pass the same answer whether or not hidden notes hold the word", () => {
    const d = diff(mcpBefore, mcpAfter);
    must(d === "", `MCP search answer moved when hidden notes were added: ${d}`);
  });
});

// Codex round 1: the limit must apply after the scope, or hidden notes that rank higher take the visible notes'
// places. The hidden notes above hold the word three times in a short note, so they outrank both visible notes.
describe("a small limit counts only the notes the pass can see (fix 8)", () => {
  test("REST search with limit=2 still returns both visible notes", async () => {
    const got = (await restSearch(2)).map((n) => n.path).sort();
    must(got.length === 2, `REST search with limit=2 returned ${got.length} of the 2 visible notes: hidden matches took their places`);
    expect(got).toEqual([`${R}/v1`, `${R}/v2`]);
  });

  test("MCP search with limit=2 still returns both visible notes", async () => {
    const got = (await mcpSearch(2)).map((n) => n.path).sort();
    must(got.length === 2, `MCP search with limit=2 returned ${got.length} of the 2 visible notes: hidden matches took their places`);
    expect(got).toEqual([`${R}/v1`, `${R}/v2`]);
  });
});
