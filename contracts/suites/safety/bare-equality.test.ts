// A bare metadata filter finds what it names: `{done: true}`, `{streak: 4}`, `{score: 1.5}` (T-395).
//
// Before the fix the engine bound every bare value as text (JSON.stringify), and json_extract gives a number for a
// JSON true or 4, so these filters returned no notes and no error, indexed or not, on REST and MCP. Fixed in
// packages/vault (core/src/query-operators.ts buildPlainEqualityClause, src/routes.ts bracket shorthand,
// src/live-match.ts for a live subscription). Mutants "bare-equality-text-only", "bare-bracket-text-only" and
// "live-bare-truthy" put each back.
//
// The notes are made so a sloppy fix shows: `one` holds a 1 where `yes` holds a true, and the other way round, so
// binding true as 1 alone would find both. `text` holds the strings, which these filters always found; a typed fix
// that drops them would empty a caller's results the same silent way.
import { beforeAll, describe, expect, test } from "bun:test";
import { enc, mcp, operator, paths, runId, services } from "../lib.ts";
import { subscribe } from "./_lib.ts";

const s = services();
const R = runId("be").replace(/-/g, "");
const TYPE = `${R}thing`;
// Indexed fields are columns shared by the vault, so their names carry the run id.
const ACTIVE = `${R}_active`;
const LEVEL = `${R}_level`;
const yes = `${R}/yes`;
const no = `${R}/no`;
const one = `${R}/one`;
const text = `${R}/text`;

beforeAll(async () => {
  const op = operator();
  const made = await op.put(`/tags/${TYPE}`, {
    fields: { [ACTIVE]: { type: "boolean", indexed: true }, [LEVEL]: { type: "integer", indexed: true } },
  });
  if (made.status >= 300) throw new Error(`setup: declaring the type gave ${made.status}`);
  const rows: [string, Record<string, unknown>][] = [
    [yes, { done: true, streak: 4, score: 1.5, [ACTIVE]: true, [LEVEL]: 4 }],
    [no, { done: false, streak: 5, score: 2.5, [ACTIVE]: false, [LEVEL]: 5 }],
    // An indexed field refuses the wrong type on write, so only the fields without an index hold these.
    [one, { done: 1, streak: true }],
    [text, { done: "true", streak: "4", score: "1.5" }],
  ];
  for (const [path, metadata] of rows) {
    const r = await op.post("/notes", { path, content: "made up", tags: [TYPE], metadata });
    if (r.status !== 201) throw new Error(`setup: ${path} gave ${r.status}`);
  }
});

async function viaRestJson(metadata: Record<string, unknown>): Promise<string[]> {
  const r = await operator().get(`/notes?tag=${TYPE}&metadata=${enc(JSON.stringify(metadata))}`);
  expect(r.status).toBe(200);
  return paths(r.body);
}

async function viaMcp(metadata: Record<string, unknown>): Promise<string[]> {
  const c = await mcp(`${s.vaultViaHub}/mcp`, s.operatorToken);
  try {
    return paths(await c.call("query-notes", { tag: TYPE, metadata }));
  } finally {
    await c.close();
  }
}

const TYPED: [string, Record<string, unknown>, string[]][] = [
  ["a boolean, not indexed", { done: true }, [text, yes]],
  ["false, not indexed", { done: false }, [no]],
  ["an integer, not indexed", { streak: 4 }, [text, yes]],
  ["a float, not indexed", { score: 1.5 }, [text, yes]],
  ["a boolean, indexed", { [ACTIVE]: true }, [yes]],
  ["false, indexed", { [ACTIVE]: false }, [no]],
  ["an integer, indexed", { [LEVEL]: 4 }, [yes]],
];

describe("a bare metadata filter finds typed values", () => {
  for (const [what, filter, want] of TYPED) {
    test(`REST metadata=: ${what}`, async () => {
      expect(await viaRestJson(filter)).toEqual(want);
    });
    test(`MCP query-notes: ${what}`, async () => {
      expect(await viaMcp(filter)).toEqual(want);
    });
  }

  test("a number doesn't match a boolean, and a boolean doesn't match a number", async () => {
    expect(await viaMcp({ done: 1 })).toEqual([one]);
    expect(await viaMcp({ streak: true })).toEqual([one]);
    expect(await viaMcp({ [ACTIVE]: 1 })).toEqual([]);
  });

  test("a string filter still means the string", async () => {
    expect(await viaMcp({ done: "true" })).toEqual([text]);
    expect(await viaMcp({ streak: "4" })).toEqual([text]);
    expect(await viaRestJson({ score: "1.5" })).toEqual([text]);
  });
});

describe("REST's bracket shorthand can't carry a type, so it reads what it can", () => {
  const bracket = async (q: string) => {
    const r = await operator().get(`/notes?tag=${TYPE}&${q}`);
    expect(r.status).toBe(200);
    return paths(r.body);
  };

  test("meta[field]=true and meta[field]=4 find typed values and the strings they always found", async () => {
    expect(await bracket("meta[done]=true")).toEqual([text, yes]);
    expect(await bracket("meta[done]=false")).toEqual([no]);
    expect(await bracket("meta[streak]=4")).toEqual([text, yes]);
    expect(await bracket(`meta[${LEVEL}]=4`)).toEqual([yes]);
    expect(await bracket(`meta[${ACTIVE}]=true`)).toEqual([yes]);
  });

  test("a value that only looks like a number stays a string", async () => {
    const path = `${R}/zip`;
    const r = await operator().post("/notes", { path, content: "made up", tags: [TYPE], metadata: { zip: "01234", size: 1234 } });
    expect(r.status).toBe(201);
    expect(await bracket("meta[zip]=01234")).toEqual([path]);
    expect(await bracket("meta[size]=01234")).toEqual([]);
    expect(await bracket("meta[size]=1234")).toEqual([path]);
  });
});

describe("a live subscription with a bare filter gets what the query finds", () => {
  const LIVE = `${R}live`;
  const VALUES: unknown[] = [true, false, 4, 0, "true", "false", "no", "pending", ""];

  /** Subscribe, write a note per value, end on a note the filter matches, and return what the socket was sent. */
  async function delivered(filter: string, last: unknown, label: string): Promise<string[]> {
    const ws = await subscribe(s.operatorToken, `?tag=${LIVE}&${filter}`);
    try {
      const op = operator();
      for (const [i, v] of VALUES.entries()) {
        const r = await op.post("/notes", { path: `${R}/${label}/${i}`, content: "made up", tags: [LIVE], metadata: { flag: v } });
        expect(r.status).toBe(201);
      }
      // Events go out in order on one socket: once this one is here, every earlier one is too.
      const end = `${R}/${label}/end`;
      expect((await op.post("/notes", { path: end, content: "made up", tags: [LIVE], metadata: { flag: last } })).status).toBe(201);
      await ws.waitFor((f) => f.type === "upsert" && f.note?.path === end, "the last note");
      return ws.frames.filter((f) => f.type === "upsert").map((f) => JSON.stringify(f.note.metadata.flag));
    } finally {
      ws.close();
    }
  }

  test("meta[flag]=true: a stored true and \"true\", not any truthy value", async () => {
    expect(await delivered("meta[flag]=true", true, "t")).toEqual(["true", '"true"', "true"]);
  });

  test("meta[flag]=false: a stored false and \"false\", not any falsy value", async () => {
    expect(await delivered("meta[flag]=false", false, "f")).toEqual(["false", '"false"', "false"]);
  });

  test("meta[flag]=4: a stored 4, and no boolean", async () => {
    expect(await delivered("meta[flag]=4", 4, "n")).toEqual(["4", "4"]);
  });

  test("metadata={flag: true} the same", async () => {
    expect(await delivered(`metadata=${enc(JSON.stringify({ flag: true }))}`, true, "j")).toEqual(["true", '"true"', "true"]);
  });
});
