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
    await seed(["projects/alder", "[[projects/birch]]", "<birch id>", "Projects/Alder", "[[projects/alder|Alder]]", "[[projects/birch#notes]]", "not a record"]);
    const [f] = await of("declared_reference_gap");
    expect(f?.subject).toBe("project");
    expect(f?.detail).toContain("6 of 7 records");
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

describe("declared_reference_gap's remedy on a scoped run", () => {
  it("never names a type the pass can't see, though an in-scope record carries it", async () => {
    await store.upsertTagRecord("mine", {});
    await store.upsertTagRecord("secretproj", { kind: "type" });
    await store.createNote("", { path: "projects/alder", tags: ["mine"] });
    for (let i = 0; i < 3; i++) {
      await store.createNote("", { path: `t/${i}`, tags: ["mine", "secretproj"], metadata: { project: "projects/alder" } });
    }
    const open = await of("declared_reference_gap");
    expect(open[0]?.remedy).toContain('tag: "secretproj"');
    const scoped = await of("declared_reference_gap", { allowedTags: new Set(["mine"]) });
    expect(scoped.map((f) => f.subject)).toEqual(["project"]);
    expect(JSON.stringify(scoped)).not.toContain("secretproj");
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

  it("leaves out a series (item1/item2, item/item2, phase-a/phase-b), short names and plain labels", async () => {
    await store.createNote("a", { metadata: { item: 0, item1: 1, item2: 2, "phase-a": 1, "phase-b": 2, x: 1, y: 2, id: 3, ix: 4 } });
    await store.upsertTagRecord("todo", {});
    await store.upsertTagRecord("toto", {});
    expect(await of("near_names")).toEqual([]);
  });

  it("a scoped run compares only the types and fields it may see", async () => {
    await store.upsertTagRecord("ledger", { fields: { amount: { type: "integer" } } });
    await store.upsertTagRecord("ledgr", { fields: { amount: { type: "integer" } } });
    expect(await of("near_names", { allowedTags: new Set(["ledger"]) })).toEqual([]);
  });

  it("a scoped run's counts leave out records a private co-tag hides", async () => {
    await store.upsertTagRecord("ledger", { fields: { amount: { type: "integer" } } });
    await store.upsertTagRecord("ledgr", { fields: { amount: { type: "integer" } } });
    await store.createNote("seen", { tags: ["ledger"] });
    for (let i = 0; i < 7; i++) await store.createNote(`hidden ${i}`, { tags: ["ledger", "secret"] });
    await store.createNote("other", { tags: ["ledgr"] });
    const scope = {
      allowedTags: new Set(["ledger", "ledgr", "secret"]),
      noteTagsInScope: (tags: string[]) => !tags.includes("secret"),
    };
    const [f] = await of("near_names", scope);
    expect(f?.detail).toContain('"ledger" (1 record)');
    expect(f?.detail).not.toContain("8 records");
  });
});

describe("which types a record is checked against (0.9.2)", () => {
  const warningsFor = async (tags: string[], metadata: Record<string, unknown>) => {
    const { validateNote, loadSchemaConfig } = await import("./schema-defaults.js");
    return (validateNote(loadSchemaConfig(store.db), { tags, metadata })?.warnings ?? [])
      .filter((w) => w.reason !== "schema_conflict")
      .map((w) => `${w.schema}:${w.reason}`);
  };

  it("a type overrides `_default` like an ancestor: _default's rules aren't checked", async () => {
    await store.upsertTagRecord("_default", { fields: { status: { type: "string", enum: ["draft", "done"] } } });
    await store.upsertTagRecord("task", { fields: { status: { type: "string", enum: ["open", "closed"] } } });
    expect(await warningsFor(["task"], { status: "open" })).toEqual([]);
  });

  it("an ancestor overridden by one of the record's other types isn't checked either", async () => {
    await store.upsertTagRecord("z", { fields: { st: { type: "string", enum: ["z1"] } } });
    await store.upsertTagRecord("y", { parent_names: ["z"], fields: { st: { type: "string", enum: ["y1", "a1"] } } });
    await store.upsertTagRecord("a", { fields: { st: { type: "string", enum: ["a1"] } } });
    // a decides; y is checked (a1 is in its enum: fine); z is y's ancestor, which y overrides.
    expect(await warningsFor(["a", "y"], { st: "a1" })).toEqual([]);
    // A value y refuses is warned by y alone.
    expect(await warningsFor(["a", "y"], { st: "zz" })).toEqual(["a:enum_mismatch", "y:enum_mismatch"]);
  });

  it("the conformance count counts only the proposal's own violations", async () => {
    await store.upsertTagRecord("ta", { fields: { st: { type: "string", enum: ["open", "done"] } } });
    await store.upsertTagRecord("tb", { fields: { st: { type: "string", enum: ["todo", "done"] } } });
    // tb comes first and refuses "open"; ta (the one proposed below) accepts it.
    await store.createNote("x", { tags: ["tb", "ta"], metadata: { st: "open" } });
    expect((await store.countTagConformance("ta", { st: { type: "string", enum: ["open", "done"] } })).violating_notes).toBe(0);
    // A proposal the record fails counts, even where ta isn't the type that decides.
    expect((await store.countTagConformance("ta", { st: { type: "string", enum: ["done"] } })).violating_notes).toBe(1);
  });
});

describe("migrate's set_default {onlyInvalid} (0.9.2)", () => {
  it("overwrites only values the deciding type refuses, not ones only another type dislikes", async () => {
    const { migrateTagField } = await import("./migrate-tag-field.js");
    await store.upsertTagRecord("task", { fields: { st: { type: "string", enum: ["open", "done"] } } });
    await store.upsertTagRecord("pub", { fields: { st: { type: "string", enum: ["draft"] } } });
    await store.upsertTagRecord("article", { parent_names: ["task", "pub"] }); // task decides st
    await store.createNote("", { path: "a/1", tags: ["article"], metadata: { st: "open" } });
    await store.createNote("", { path: "a/2", tags: ["article"], metadata: { st: "zzz" } });
    const plan = await migrateTagField(store, { tag: "article", field: "st", transform: { kind: "set_default", value: "done", onlyInvalid: true } });
    expect(plan.sample.map((c) => c.path)).toEqual(["a/2"]);
  });
});
