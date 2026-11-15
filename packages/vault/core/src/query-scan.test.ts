/**
 * 0.9.2 "filter any field": an operator or order_by on a field that isn't
 * indexed scans the JSON, and must give exactly the rows the same filter on an
 * indexed field holding the same values gives. This checks that rule over the
 * awkward values a loose field can hold (numbers in a text field, numeric text
 * in an integer field, booleans, null, a missing key) and over operands in
 * every shape REST (always text) and MCP (typed JSON) send.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { collectScanWarnings } from "./query-warnings.js";
import { getIndexedField } from "./indexed-fields.js";

let db: Database;
let store: SqliteStore;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

const MISSING = Symbol("missing");

async function seed(type: "string" | "integer", values: unknown[]) {
  await store.upsertTagRecord("t", {
    fields: { plain: { type }, twin: { type, indexed: true } },
  });
  let i = 0;
  for (const v of values) {
    const metadata = v === MISSING ? {} : { plain: v, twin: v };
    await store.createNote(`n${i}`, { tags: ["t"], metadata, path: `r/n${String(i).padStart(2, "0")}` });
    i++;
  }
}

const sorted = (ns: { path?: string | null }[]) => ns.map((n) => n.path).sort();

async function expectTwins(ops: Record<string, unknown>[]) {
  // The twin really is indexed and the plain field really scans; otherwise
  // both sides would scan and agree trivially.
  expect(getIndexedField(db, "twin")).not.toBeNull();
  expect(getIndexedField(db, "plain")).toBeNull();
  const diffs: string[] = [];
  for (const op of ops) {
    const ix = sorted(await store.queryNotes({ tags: ["t"], metadata: { twin: op }, limit: 1000 }));
    const scan = sorted(await store.queryNotes({ tags: ["t"], metadata: { plain: op }, limit: 1000 }));
    if (JSON.stringify(ix) !== JSON.stringify(scan)) {
      diffs.push(`${JSON.stringify(op)}: indexed ${JSON.stringify(ix)}, scan ${JSON.stringify(scan)}`);
    }
  }
  expect(diffs).toEqual([]);
}

const operands = (vals: unknown[]) =>
  vals.flatMap((v) => [{ eq: v }, { ne: v }, { gt: v }, { gte: v }, { lt: v }, { lte: v }]);

describe("a scan gives its indexed twin's rows", () => {
  it("on a string field, for every operator and operand shape", async () => {
    await seed("string", ["open", "done", "Open", "10", "9", 5, 5.5, true, null, MISSING, "", "5"]);
    await expectTwins([
      ...operands(["open", "5", 5, "10", "9", 10, "", 5.5, true]),
      { in: ["open", "done"] },
      { in: ["5", 9] },
      { in: [5] },
      { not_in: ["open", "done"] },
      { not_in: [5, "9"] },
      { in: [] },
      { not_in: [] },
      { exists: true },
      { exists: false },
      { eq: null },
      { ne: null },
      { gt: "a", lt: "p" },
    ]);
  });

  it("on an integer field, for every operator and operand shape", async () => {
    await seed("integer", [1, 5, 8, 13, "5", "08", "abc", 2.5, -3, true, false, null, MISSING]);
    await expectTwins([
      ...operands([5, "5", "8", 2.5, "2.5", "abc", "6x", "", true, false, 0, "-3", " 5 ", "1e1"]),
      { in: [5, 8] },
      { in: ["5", "13"] },
      { in: [true] },
      { not_in: [5, 8] },
      { not_in: ["1", "13"] },
      { exists: true },
      { exists: false },
      { eq: null },
      { ne: null },
      { gte: "1", lt: 10 },
    ]);
  });

  it("in with text that isn't a number matches that text only", async () => {
    // The indexed twin can't be the reference here: its IN list is CAST to
    // INTEGER, so "abc" becomes 0 and matches a stored false. The scan
    // compares the text as text.
    await seed("integer", [5, "abc", false, MISSING]);
    const got = sorted(await store.queryNotes({ tags: ["t"], metadata: { plain: { in: ["abc"] } } }));
    expect(got).toEqual(["r/n01"]);
  });

  it("order_by gives the indexed order, both directions", async () => {
    await seed("integer", [13, 1, "5", "08", " 7", "1e1", "1-2", "abc", 8, null, MISSING, 2]);
    for (const sort of ["asc", "desc"] as const) {
      const ix = (await store.queryNotes({ tags: ["t"], orderBy: "twin", sort })).map((n) => n.path);
      const scan = (await store.queryNotes({ tags: ["t"], orderBy: "plain", sort })).map((n) => n.path);
      expect(scan).toEqual(ix);
    }
  });

  it("order_by on a string field gives the indexed order", async () => {
    await seed("string", ["b", "a", 10, "9", null, MISSING, "B"]);
    const ix = (await store.queryNotes({ tags: ["t"], orderBy: "twin" })).map((n) => n.path);
    const scan = (await store.queryNotes({ tags: ["t"], orderBy: "plain" })).map((n) => n.path);
    expect(scan).toEqual(ix);
  });
});

describe("fields with no twin", () => {
  it("a float (`number`) field compares as a number, from typed and text operands", async () => {
    await store.upsertTagRecord("t", { fields: { price: { type: "number" } } });
    for (const [i, price] of [4.25, 4.5, 10, 9.99].entries()) {
      await store.createNote(`p${i}`, { tags: ["t"], metadata: { price }, path: `p/${price}` });
    }
    const gt = async (v: unknown) =>
      sorted(await store.queryNotes({ tags: ["t"], metadata: { price: { gt: v } } }));
    // As text, "10" < "4.5"; numerically it's the largest.
    expect(await gt(4.5)).toEqual(["p/10", "p/9.99"]);
    expect(await gt("4.5")).toEqual(["p/10", "p/9.99"]);
    const desc = (await store.queryNotes({ tags: ["t"], orderBy: "price", sort: "desc" })).map((n) => n.path);
    expect(desc).toEqual(["p/10", "p/9.99", "p/4.5", "p/4.25"]);
  });

  it("a field no type declares: numbers compare as numbers, text as text", async () => {
    for (const [i, v] of [3, 12, "12", "blue", "Blue"].entries()) {
      await store.createNote(`u${i}`, { metadata: { colour: v }, path: `u/${i}` });
    }
    const q = async (op: Record<string, unknown>) => sorted(await store.queryNotes({ metadata: { colour: op } }));
    expect(await q({ gt: "5" })).toEqual(["u/1", "u/2", "u/3", "u/4"]); // 12, "12", and text sorts after numbers
    expect(await q({ eq: "12" })).toEqual(["u/1", "u/2"]);
    expect(await q({ eq: "blue" })).toEqual(["u/3"]);
    expect(await q({ in: ["blue", 3] })).toEqual(["u/0", "u/3"]);
  });

  it("a field name with a dot names that key, not a nested path", async () => {
    await store.createNote("d", { metadata: { "a.b": "x", a: { b: "y" } }, path: "d/1" });
    expect(sorted(await store.queryNotes({ metadata: { "a.b": { eq: "x" } } }))).toEqual(["d/1"]);
    expect(sorted(await store.queryNotes({ metadata: { "a.b": { eq: "y" } } }))).toEqual([]);
  });

  it("a field name with a quote is refused, not injected", async () => {
    await expect(store.queryNotes({ metadata: { "x\"') OR 1=1 --": { eq: "y" } } })).rejects.toThrow(/quote/);
    // A single quote alone is fine: it's doubled inside the SQL literal.
    await store.createNote("q", { metadata: { "it's": "y" }, path: "q/1" });
    expect(sorted(await store.queryNotes({ metadata: { "it's": { eq: "y" } } }))).toEqual(["q/1"]);
  });

  it("date_filter on a field that isn't indexed compares as ISO text", async () => {
    await store.createNote("m1", { metadata: { met: "2026-04-25" }, path: "m/1" });
    await store.createNote("m2", { metadata: { met: "2026-03-01" }, path: "m/2" });
    const got = await store.queryNotes({ dateFilter: { field: "met", from: "2026-04-01" } });
    expect(sorted(got)).toEqual(["m/1"]);
  });
});

describe("where a scan isn't allowed or isn't one", () => {
  it("aggregate refuses a filter on a field that isn't indexed: its reply can't carry the warning", async () => {
    await store.createNote("a", { metadata: { mood: "ok" } });
    for (const opts of [{ metadata: { mood: { eq: "ok" } } }, { dateFilter: { field: "met", from: "2026-01-01" } }]) {
      await expect(store.aggregateNotes({ ...opts, aggregate: { op: "count" } })).rejects.toThrow(/not indexed/);
    }
    // A bare equality still reads the JSON there, as it always did.
    expect(await store.aggregateNotes({ metadata: { mood: "ok" }, aggregate: { op: "count" } })).toEqual([{ group: null, value: 1 }]);
  });

  it("order_by created_at is the notes column, not a scanned field", async () => {
    await store.createNote("old", { created_at: "2026-01-01T00:00:00.000Z", path: "c/old" });
    await store.createNote("new", { created_at: "2026-02-01T00:00:00.000Z", path: "c/new" });
    const got = (await store.queryNotes({ orderBy: "created_at", sort: "desc", pathPrefix: "c/" })).map((n) => n.path);
    expect(got).toEqual(["c/new", "c/old"]);
    expect(collectScanWarnings(db, { orderBy: "created_at" })).toEqual([]);
  });
});

describe("the scan warning", () => {
  it("names exactly the fields that scan", async () => {
    await store.upsertTagRecord("t", { fields: { ix: { type: "integer", indexed: true } } });
    expect(collectScanWarnings(db, { metadata: { ix: { gt: 1 }, plain: "bare equality" } })).toEqual([]);
    expect(collectScanWarnings(db, { orderBy: "updated_at" })).toEqual([]);
    const [w] = collectScanWarnings(db, {
      metadata: { ix: { gt: 1 }, a: { eq: 1 } },
      orderBy: "b",
      dateFilter: { field: "c" },
    });
    expect(w?.code).toBe("scan");
    expect(w?.fields).toEqual(["a", "b", "c"]);
  });
});
