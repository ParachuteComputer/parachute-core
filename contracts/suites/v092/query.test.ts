// 0.9.2 row 1, "Query fixes people hit": filter any field (a scan with a warning, not a refusal); field values in
// search. The three index fixes don't show at the door; the bench (suites/bench/query-092.bench.ts) measures them.
//
// The rule for "filter any field": a filter on a field that isn't indexed returns exactly what the same filter on an
// indexed field holding the same values returns, with a warning that it scanned. So each operator is checked against
// its indexed twin, on the same records, and the contract doesn't restate the operator's meaning.
import { beforeAll, describe, expect, test } from "bun:test";
import { enc, mcp, paths, rest, runId } from "../door/_door.ts";
import { must, red, restWarnings, said } from "./_v092.ts";

const api = rest("admin");
const writer = rest("write");
const LANE = "0.9.2 query";

const tag = runId("q092");
const f = runId("f");
// Plain (declared, not indexed) and indexed twins with the same values; `colour` is declared by no type at all.
const [stage, stageIx, points, pointsIx, colour] = [`stage_${f}`, `stageix_${f}`, `points_${f}`, `pointsix_${f}`, `colour_${f}`];
const r = runId("q");
const word = `quokka${runId("w")}`;

const records = [
  { name: "a", stage: "open", points: 1, colour: "blue" },
  { name: "b", stage: "open", points: 5, colour: "red" },
  { name: "c", stage: "done", points: 8, colour: "blue" },
  { name: "d", stage: "review", points: 13 },
  { name: "e" }, // carries the type but none of the fields
];

const OPS: [string, string][] = [
  ["eq", "open"],
  ["ne", "open"],
  ["gt", "5"],
  ["gte", "5"],
  ["lt", "8"],
  ["lte", "8"],
  ["in", "open,done"],
  ["not_in", "open,done"],
  ["exists", "true"],
  ["exists", "false"],
];
const NUMERIC = new Set(["gt", "gte", "lt", "lte"]);

beforeAll(async () => {
  const put = await api.put(`/tags/${enc(tag)}`, {
    fields: { [stage]: { type: "string" }, [stageIx]: { type: "string", indexed: true }, [points]: { type: "integer" }, [pointsIx]: { type: "integer", indexed: true } },
  });
  if (put.status !== 200) throw new Error(`setup: declaring ${tag} gave ${put.status} ${said(put.body)}`);
  for (const x of records) {
    const metadata: Record<string, unknown> = {};
    if (x.stage) Object.assign(metadata, { [stage]: x.stage, [stageIx]: x.stage });
    if (x.points !== undefined) Object.assign(metadata, { [points]: x.points, [pointsIx]: x.points });
    if (x.colour) metadata[colour] = x.colour;
    if (x.name === "c") metadata.note_line = `filed under ${word}`;
    const made = await writer.post("/notes", { content: "", path: `${r}/${x.name}`, tags: [tag], metadata });
    if (made.status !== 201) throw new Error(`setup: record ${x.name} gave ${made.status} ${said(made.body)}`);
  }
});

describe("0.9.2 query fixes", () => {
  test("setup: the indexed twins answer every operator today", async () => {
    // If this fails, the red contracts below can't be trusted: their reference answer is broken.
    for (const [op, v] of OPS) {
      const field = NUMERIC.has(op) ? pointsIx : stageIx;
      const got = await writer.get(`/notes?tag=${tag}&meta[${field}][${op}]=${v}`);
      expect(got.status, `${op}: ${said(got.body)}`).toBe(200);
    }
  });

  for (const [op, v] of OPS) {
    red(`a field that isn't indexed can be filtered with ${op}=${v}: the indexed answer, and a warning that it scanned`, { reason: /^refused: 400 FIELD_NOT_INDEXED/, lane: LANE }, async () => {
      const [plain, ix] = NUMERIC.has(op) ? [points, pointsIx] : [stage, stageIx];
      const want = paths((await writer.get(`/notes?tag=${tag}&meta[${ix}][${op}]=${v}`)).body);
      const got = await writer.get(`/notes?tag=${tag}&meta[${plain}][${op}]=${v}`);
      must(got.status === 200, `refused: ${got.status} ${got.body?.code ?? got.body?.error}`);
      must(said(paths(got.body)) === said(want), `wrong rows: ${said(paths(got.body))}, the indexed twin gives ${said(want)}`);
      must(restWarnings(got).some((w) => /scan|not_indexed/i.test(w.code)), `no warning that it scanned: ${said(restWarnings(got))}`);
    });
  }

  red("a field no type declares can be filtered too", { reason: /^refused: 400 FIELD_NOT_INDEXED/, lane: LANE }, async () => {
    const got = await writer.get(`/notes?tag=${tag}&meta[${colour}][eq]=blue`);
    must(got.status === 200, `refused: ${got.status} ${got.body?.code ?? got.body?.error}`);
    must(said(paths(got.body)) === said([`${r}/a`, `${r}/c`]), `wrong rows: ${said(paths(got.body))}`);
  });

  red("a field that isn't indexed can be sorted on, in the indexed order", { reason: /^refused: 400 FIELD_NOT_INDEXED/, lane: LANE }, async () => {
    const want = (await writer.get(`/notes?tag=${tag}&order_by=${pointsIx}&sort=desc`)).body.map((n: any) => n.path);
    const got = await writer.get(`/notes?tag=${tag}&order_by=${points}&sort=desc`);
    must(got.status === 200, `refused: ${got.status} ${got.body?.code ?? got.body?.error}`);
    must(said(got.body.map((n: any) => n.path)) === said(want), `wrong order: ${said(got.body.map((n: any) => n.path))}, indexed gives ${said(want)}`);
  });

  red("over MCP, query-records filters a field that isn't indexed and says it scanned", { reason: /^refused: .*not indexed/, lane: LANE }, async () => {
    const m = await mcp("write");
    try {
      let got: any;
      try {
        got = await m.call("query-records", { type: tag, fields: { [stage]: { eq: "open" } } });
      } catch (err) {
        must(false, `refused: ${(err as Error).message.slice(0, 300)}`);
      }
      const list = Array.isArray(got) ? got : got.records;
      must(said(paths(list)) === said([`${r}/a`, `${r}/b`]), `wrong rows: ${said(paths(list ?? []))}`);
      must(!Array.isArray(got) && said(got.warnings).match(/scan|not_indexed/i), `no warning that it scanned: ${said(got).slice(0, 300)}`);
    } finally {
      await m.close();
    }
  });

  red("search finds a word that is only in a field value", { reason: /^not found by search/, lane: LANE }, async () => {
    const got = await writer.get(`/notes?search=${enc(word)}`);
    must(got.status === 200, `search gave ${got.status}`);
    must(paths(got.body).includes(`${r}/c`), `not found by search: ${said(paths(got.body))}`);
  });

  red("over MCP, query-records search finds a word that is only in a field value", { reason: /^not found by search/, lane: LANE }, async () => {
    const m = await mcp("write");
    try {
      const got: any = await m.call("query-records", { search: word });
      const list = Array.isArray(got) ? got : (got.records ?? []);
      must(paths(list).includes(`${r}/c`), `not found by search: ${said(paths(list))}`);
    } finally {
      await m.close();
    }
  });
});
