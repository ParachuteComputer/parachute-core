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
// A float field can't be indexed, so it has no twin: its scan is checked against the numbers themselves.
const price = `price_${f}`;
const r = runId("q");
const word = `quokka${runId("w")}`;

const records = [
  { name: "a", stage: "open", points: 1, colour: "blue", price: 4.25 },
  { name: "b", stage: "open", points: 5, colour: "red", price: 4.5 },
  { name: "c", stage: "done", points: 8, colour: "blue", price: 10 },
  { name: "d", stage: "review", points: 13, price: 9.99 },
  { name: "e" }, // carries the type but none of the fields
] as { name: string; stage?: string; points?: number; colour?: string; price?: number }[];

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
    fields: { [stage]: { type: "string" }, [stageIx]: { type: "string", indexed: true }, [points]: { type: "integer" }, [pointsIx]: { type: "integer", indexed: true }, [price]: { type: "number" } },
  });
  if (put.status !== 200) throw new Error(`setup: declaring ${tag} gave ${put.status} ${said(put.body)}`);
  for (const x of records) {
    const metadata: Record<string, unknown> = {};
    if (x.stage) Object.assign(metadata, { [stage]: x.stage, [stageIx]: x.stage });
    if (x.points !== undefined) Object.assign(metadata, { [points]: x.points, [pointsIx]: x.points });
    if (x.colour) metadata[colour] = x.colour;
    if (x.price !== undefined) metadata[price] = x.price;
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
    test(`a field that isn't indexed can be filtered with ${op}=${v}: the indexed answer, and a warning that it scanned`, async () => {
      const [plain, ix] = NUMERIC.has(op) ? [points, pointsIx] : [stage, stageIx];
      const want = paths((await writer.get(`/notes?tag=${tag}&meta[${ix}][${op}]=${v}`)).body);
      const got = await writer.get(`/notes?tag=${tag}&meta[${plain}][${op}]=${v}`);
      must(got.status === 200, `refused: ${got.status} ${got.body?.code ?? got.body?.error}`);
      must(said(paths(got.body)) === said(want), `wrong rows: ${said(paths(got.body))}, the indexed twin gives ${said(want)}`);
      must(restWarnings(got).some((w) => /scan|not_indexed/i.test(w.code)), `no warning that it scanned: ${said(restWarnings(got))}`);
    });
  }

  test("a field no type declares can be filtered too", async () => {
    const got = await writer.get(`/notes?tag=${tag}&meta[${colour}][eq]=blue`);
    must(got.status === 200, `refused: ${got.status} ${got.body?.code ?? got.body?.error}`);
    must(said(paths(got.body)) === said([`${r}/a`, `${r}/c`]), `wrong rows: ${said(paths(got.body))}`);
  });

  test("a field that isn't indexed can be sorted on, in the indexed order", async () => {
    const want = (await writer.get(`/notes?tag=${tag}&order_by=${pointsIx}&sort=desc`)).body.map((n: any) => n.path);
    const got = await writer.get(`/notes?tag=${tag}&order_by=${points}&sort=desc`);
    must(got.status === 200, `refused: ${got.status} ${got.body?.code ?? got.body?.error}`);
    must(said(got.body.map((n: any) => n.path)) === said(want), `wrong order: ${said(got.body.map((n: any) => n.path))}, indexed gives ${said(want)}`);
  });

  test("a float field compares as a number: gt 4.5 is 10 and 9.99, not the text order", async () => {
    const got = await writer.get(`/notes?tag=${tag}&meta[${price}][gt]=4.5&order_by=${price}&sort=desc`);
    must(got.status === 200, `refused: ${got.status} ${got.body?.code ?? got.body?.error}`);
    const order = got.body.map((n: any) => n.path);
    must(said(order) === said([`${r}/c`, `${r}/d`]), `wrong rows or order: ${said(order)}`);
    must(restWarnings(got).some((w) => /scan/i.test(w.code)), `no warning that it scanned: ${said(restWarnings(got))}`);
  });

  test("over MCP, query-records filters a field that isn't indexed and says it scanned", async () => {
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

  test("search finds a word that is only in a field value", async () => {
    const got = await writer.get(`/notes?search=${enc(word)}`);
    must(got.status === 200, `search gave ${got.status}`);
    must(paths(got.body).includes(`${r}/c`), `not found by search: ${said(paths(got.body))}`);
  });

  test("over MCP, query-records search finds a word that is only in a field value", async () => {
    const m = await mcp("write");
    try {
      const got: any = await m.call("query-records", { search: word });
      const list = Array.isArray(got) ? got : (got.records ?? []);
      must(paths(list).includes(`${r}/c`), `not found by search: ${said(paths(list))}`);
    } finally {
      await m.close();
    }
  });

  // Field values in search, past the first hit: where it ranks, that an edit shows at once, and which value shapes count.
  const found = async (w: string) => paths((await writer.get(`/notes?search=${enc(w)}&limit=50`)).body);

  test("a title or body hit ranks above a field-only hit", async () => {
    const w = `okapi${runId("r")}`;
    // The field note is made first and is shorter, so only the ranking rule can put the body note ahead.
    for (const [name, content, metadata] of [
      ["fieldonly", "", { note_line: `seen near ${w}` }],
      ["body", `a longer line that mentions ${w} once, among several other plain words`, {}],
      // A long body: bm25 alone scores a hit in a long text below a hit in a short field, so only a rule can keep it ahead.
      ["long", `intro\n\n${"filler words about nothing much ".repeat(300)} ${w}`, {}],
      ["title", "", {}],
    ] as [string, string, Record<string, unknown>][]) {
      const made = await writer.post("/notes", { content, path: name === "title" ? `${r}/${w}` : `${r}/rk-${name}`, tags: [tag], metadata });
      must(made.status === 201, `setup: ${name} gave ${made.status}`);
    }
    // `paths` sorts, so read the order as the server gave it.
    const order = ((await writer.get(`/notes?search=${enc(w)}&limit=50`)).body as { path: string }[]).map((n) => n.path);
    must(order.length === 4 && order[3] === `${r}/rk-fieldonly`, `the field-only hit should come after the title, body and long-body hits: ${said(order)}`);
  });

  test("editing only a field makes the new word searchable at once and the old word stops finding it", async () => {
    const [oldWord, newWord] = [`tapir${runId("o")}`, `lemur${runId("n")}`];
    const made = await writer.post("/notes", { content: "plain", path: `${r}/edit`, tags: [tag], metadata: { note_line: oldWord } });
    must(made.status === 201, `setup: gave ${made.status}`);
    must((await found(oldWord)).includes(`${r}/edit`), "the old word wasn't found before the edit");
    const edit = await writer.patch(`/notes/${made.body.id}`, { metadata: { note_line: newWord }, if_updated_at: made.body.updatedAt });
    must(edit.status === 200, `edit gave ${edit.status} ${said(edit.body)}`);
    must((await found(newWord)).includes(`${r}/edit`), `the new word isn't found: ${said(await found(newWord))}`);
    must(!(await found(oldWord)).includes(`${r}/edit`), "the old word still finds it");
  });

  test("a field holding a list, a number or a nested value is searchable by its text", async () => {
    const [a, b, c] = [`ibex${runId("a")}`, `ibex${runId("b")}`, `ibex${runId("c")}`];
    const made = await writer.post("/notes", { content: "", path: `${r}/shapes`, tags: [tag], metadata: { kinds: ["one", a], count: 4817203, nest: { deeper: [{ label: b }] }, flag: true, gone: null } });
    must(made.status === 201, `setup: gave ${made.status} ${said(made.body)}`);
    for (const [what, w] of [["a list item", a], ["a number", "4817203"], ["a nested value", b]]) {
      must((await found(w)).includes(`${r}/shapes`), `${what} isn't found by ${w}: ${said(await found(w))}`);
    }
    must(!(await found(c)).includes(`${r}/shapes`), "an unrelated word found it");
    must(!(await found("deeper")).includes(`${r}/shapes`), "a field NAME found it: only values are searched");
  });
});
