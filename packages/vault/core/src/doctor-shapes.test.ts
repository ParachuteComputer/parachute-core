/**
 * 0.9.2 doctor additions: a field holding two data types (any field that
 * isn't indexed), a field that names records but isn't declared a reference,
 * and names one letter apart. Each is checked on an unscoped run and on a
 * tag-scoped one, which must not count, name or reveal anything out of scope.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";

let store: SqliteStore;

beforeEach(() => {
  store = new SqliteStore(new Database(":memory:"));
});

const of = async (type: string, opts?: Parameters<SqliteStore["doctor"]>[0]) =>
  (await store.doctor(opts)).findings.filter((f) => f.type === type);

describe("mixed_type_field", () => {
  it("finds a field no type declares holding two data types, and names both", async () => {
    await store.createNote("a", { metadata: { qty: 5 } });
    await store.createNote("b", { metadata: { qty: "five" } });
    await store.createNote("c", { metadata: { qty: 2.5 } });
    const [f, ...rest] = await of("mixed_type_field");
    expect(rest).toEqual([]);
    expect(f?.subject).toBe("qty");
    expect(f?.detail).toContain("number (2 records)");
    expect(f?.detail).toContain("string (1 record)");
    expect(f?.detail).toContain("No type declares it");
  });

  it("finds a declared field that isn't indexed, and leaves indexed fields to their own finding", async () => {
    await store.upsertTagRecord("item", { fields: { qty: { type: "integer" }, n: { type: "integer", indexed: true } } });
    await store.createNote("a", { tags: ["item"], metadata: { qty: 5, n: 1 } });
    await store.createNote("b", { tags: ["item"], metadata: { qty: "a few", n: "x" } });
    expect((await of("mixed_type_field")).map((f) => f.subject)).toEqual(["qty"]);
    expect((await of("mixed_type_field"))[0]?.detail).toContain("Declared by item (integer)");
    expect((await of("mixed_type_indexed_field")).map((f) => f.subject)).toEqual(["n"]);
  });

  it("a field holding one data type, or null beside it, is fine", async () => {
    await store.createNote("a", { metadata: { qty: 5, note: null } });
    await store.createNote("b", { metadata: { qty: 7, note: "x" } });
    expect(await of("mixed_type_field")).toEqual([]);
  });

  it("a scoped run counts only records it may see", async () => {
    await store.upsertTagRecord("mine", {});
    await store.upsertTagRecord("theirs", {});
    await store.createNote("a", { tags: ["mine"], metadata: { qty: 5 } });
    await store.createNote("b", { tags: ["theirs"], metadata: { qty: "five" } });
    expect(await of("mixed_type_field", { allowedTags: new Set(["mine"]) })).toEqual([]);
    expect((await of("mixed_type_field")).length).toBe(1);
  });
});

describe("declared_reference_gap", () => {
  async function seed(values: string[], field = "project") {
    await store.createNote("", { path: "projects/alder" });
    const birch = await store.createNote("", { path: "projects/birch" });
    let i = 0;
    for (const v of values) {
      await store.createNote("", { path: `tasks/${i++}`, metadata: { [field]: v === "<birch id>" ? birch.id : v } });
    }
  }

  it("finds a field whose values name records by path, [[path]] or id, and says to declare a reference", async () => {
    await seed(["projects/alder", "[[projects/birch]]", "<birch id>", "Projects/Alder", "not a record"]);
    const [f] = await of("declared_reference_gap");
    expect(f?.subject).toBe("project");
    expect(f?.detail).toContain("4 of 5 records");
    expect(f?.remedy).toContain('{type: "reference"}');
  });

  it("stays quiet when half or fewer name a record, or the field is declared a reference", async () => {
    await seed(["projects/alder", "x", "y", "z"]);
    expect(await of("declared_reference_gap")).toEqual([]);
    store = new SqliteStore(new Database(":memory:"));
    await store.upsertTagRecord("task", { fields: { project: { type: "reference" } } });
    await seed(["projects/alder", "projects/birch", "projects/alder"]);
    expect(await of("declared_reference_gap")).toEqual([]);
  });

  it("a scoped run doesn't count a path it can't see: it can't be used to test whether a hidden record exists", async () => {
    await store.upsertTagRecord("mine", {});
    await store.upsertTagRecord("secret", {});
    await store.createNote("", { path: "hidden/plan", tags: ["secret"] });
    await store.createNote("", { path: "hidden/budget", tags: ["secret"] });
    for (const [i, v] of ["hidden/plan", "hidden/budget", "hidden/plan"].entries()) {
      await store.createNote("", { path: `mine/${i}`, tags: ["mine"], metadata: { guess: v } });
    }
    expect((await of("declared_reference_gap")).map((f) => f.subject)).toEqual(["guess"]);
    expect(await of("declared_reference_gap", { allowedTags: new Set(["mine"]) })).toEqual([]);
  });
});

describe("near_names", () => {
  it("finds two type names and two field names one letter apart", async () => {
    await store.upsertTagRecord("ledger", { fields: { amount: { type: "integer" } } });
    await store.upsertTagRecord("ledgr", { fields: { amount: { type: "integer" } } });
    await store.createNote("a", { metadata: { due_on: "2026-11-10" } });
    await store.createNote("b", { metadata: { dueon: "2026-11-11" } });
    const subjects = (await of("near_names")).map((f) => f.subject).sort();
    expect(subjects).toEqual(["dueon, due_on", "ledgr, ledger"]);
  });

  it("leaves out a series (item1/item2, phase-a/phase-b) and plain labels", async () => {
    await store.createNote("a", { metadata: { item1: 1, item2: 2, "phase-a": 1, "phase-b": 2 } });
    await store.upsertTagRecord("todo", {});
    await store.upsertTagRecord("toto", {});
    expect(await of("near_names")).toEqual([]);
  });

  it("a scoped run compares only the types and fields it may see", async () => {
    await store.upsertTagRecord("ledger", { fields: { amount: { type: "integer" } } });
    await store.upsertTagRecord("ledgr", { fields: { amount: { type: "integer" } } });
    expect(await of("near_names", { allowedTags: new Set(["ledger"]) })).toEqual([]);
  });
});
