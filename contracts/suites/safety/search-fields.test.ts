// Field values are searchable (0.9.3 query fixes), and a tag-scoped pass finds no record it can't see by a word in one
// of that record's field values. The field text sits in the same index as the body, so the scoped search (a throwaway
// index over the visible notes only, notes.ts searchVisibleOnly) has to carry it too: a visible record is found by
// its field word, a hidden one isn't, and the hidden one doesn't move the visible one's score.
import { beforeAll, describe, expect, test } from "bun:test";
import { mcp, must, rest, runId, services } from "../lib.ts";
import { operator, pass } from "../lib.ts";

const s = services();
const R = runId("sf").replace(/-/g, "");
const MINE = `${R}mine`;
const OTHER = `${R}other`;
const WORD = `zq${R}fieldword`;
let api: ReturnType<typeof rest>;

async function make(path: string, tags: string[], metadata: Record<string, unknown>) {
  const r = await operator().post("/notes", { content: "", path, tags, metadata });
  if (r.status !== 201) throw new Error(`setup: ${path} gave ${r.status}`);
}

beforeAll(async () => {
  const scoped = await pass({ level: "read", tags: [MINE] });
  api = rest(s.vaultViaHub, scoped);
  await make(`${R}/visible`, [MINE], { note_line: `about ${WORD}` });
  await make(`${R}/hidden`, [OTHER], { note_line: `about ${WORD}`, extra: [WORD] });
});

describe("a tag-scoped search finds records by a field word, and only the ones it may see", () => {
  test("REST", async () => {
    const r = await api.get(`/notes?search=${WORD}&limit=50`);
    expect(r.status).toBe(200);
    const got = (r.body as any[]).map((n) => n.path);
    must(got.includes(`${R}/visible`), `the visible record wasn't found: ${JSON.stringify(got)}`);
    must(!got.includes(`${R}/hidden`), `a record outside the pass's tags was found: ${JSON.stringify(got)}`);
  });

  test("MCP", async () => {
    const c = await mcp(`${s.vaultViaHub}/mcp`, await pass({ level: "read", tags: [MINE] }));
    try {
      const q = await c.call("query-notes", { search: WORD, limit: 50 });
      const got = ((Array.isArray(q) ? q : (q.notes ?? q.results ?? [])) as any[]).map((n) => n.path);
      must(got.includes(`${R}/visible`), `the visible record wasn't found: ${JSON.stringify(got)}`);
      must(!got.includes(`${R}/hidden`), `a record outside the pass's tags was found: ${JSON.stringify(got)}`);
    } finally {
      await c.close();
    }
  });
});
