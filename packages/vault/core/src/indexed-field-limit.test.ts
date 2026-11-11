// 0.9.2 PR 4: the indexed-field ceiling. Every Parachute refuses a NEW
// indexed field past INDEXED_FIELD_LIMIT (88: cloud's 100 columns per table,
// 12 taken by `notes`), with a hint naming unused indexed fields. Only new
// declarations are refused; a vault already over the limit keeps working and
// doctor reports it.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SqliteStore } from "./store.js";
import {
  INDEXED_FIELD_LIMIT,
  IndexedFieldLimitError,
  countIndexedFields,
  getIndexedField,
} from "./indexed-fields.js";
import { upsertTagRecord as rawUpsertTagRecord } from "./tag-schemas.js";
import { exportVaultToDir, importPortableVault } from "./portable-md.js";

let db: Database;
let store: SqliteStore;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

/** `n` indexed string fields named `${prefix}0..` */
function indexed(prefix: string, n: number, start = 0) {
  const fields: Record<string, { type: "string"; indexed: true }> = {};
  for (let i = start; i < start + n; i++) fields[`${prefix}${i}`] = { type: "string", indexed: true };
  return fields;
}

/** A vault that got over the limit before 0.9.2: rows and columns written the way declareField wrote them. */
function forceIndexed(d: Database, field: string, tag: string) {
  d.prepare("INSERT INTO indexed_fields (field, sqlite_type, declarer_tags) VALUES (?, 'TEXT', ?)").run(field, JSON.stringify([tag]));
  d.exec(`ALTER TABLE notes ADD COLUMN "meta_${field}" TEXT GENERATED ALWAYS AS (json_extract(metadata, '$."${field}"')) VIRTUAL`);
  d.exec(`CREATE INDEX "idx_meta_${field}" ON notes("meta_${field}")`);
}

async function refusal(p: Promise<unknown>): Promise<IndexedFieldLimitError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(IndexedFieldLimitError);
    return e as IndexedFieldLimitError;
  }
  throw new Error("expected the indexed-field limit refusal, got success");
}

describe("indexed-field ceiling", () => {
  it("the 88th indexed field is accepted and the 89th refused, naming unused fields to prune", async () => {
    await store.upsertTagRecord("big", { fields: indexed("f", INDEXED_FIELD_LIMIT) });
    expect(countIndexedFields(db)).toBe(88);
    // One field holds a value, so it is NOT unused.
    await store.createNote("x", { tags: ["big"], metadata: { f0: "held" } });

    const err = await refusal(store.upsertTagRecord("more", { description: "d", fields: indexed("g", 1) }));
    expect(err.error_type).toBe("indexed_field_limit");
    expect(err.field).toBe("g0");
    expect(err.got).toBe(88);
    expect(err.limit).toBe(88);
    expect(err.message).toMatch(/limit is 88/);
    expect(err.message).toMatch(/prune/);
    const names = err.unused.map((u) => u.field);
    expect(names).not.toContain("f0");
    expect(names).toContain("f1");
    expect(err.unused.find((u) => u.field === "f1")!.reason).toBe("no_values");

    // Refused whole: no schema row, no column, the count unchanged.
    expect(await store.getTagRecord("more")).toBeNull();
    expect(getIndexedField(db, "g0")).toBeNull();
    expect(countIndexedFields(db)).toBe(88);
  });

  it("a write adding several new fields is counted once, before any column, with the vault's own numbers", async () => {
    await store.upsertTagRecord("big", { fields: indexed("f", INDEXED_FIELD_LIMIT - 1) });
    for (let i = 0; i < INDEXED_FIELD_LIMIT - 1; i++) await store.createNote(`n${i}`, { tags: ["big"], metadata: { [`f${i}`]: "v" } });
    const err = await refusal(store.upsertTagRecord("more", { fields: indexed("g", 3) }));
    expect(err.fields).toEqual(["g0", "g1", "g2"]);
    expect(err.got).toBe(87);
    expect(err.unused).toEqual([]); // not the write's own half-declared fields
    expect(err.message).toContain("this write would add 3");
    expect(err.message).toContain("room for 1 more");
    expect(countIndexedFields(db)).toBe(87);
    // One of them fits.
    await store.upsertTagRecord("more", { fields: indexed("g", 1) });
    expect(countIndexedFields(db)).toBe(88);
  });

  it("a field no live type declares is listed as prune-schema's", async () => {
    await store.upsertTagRecord("big", { fields: indexed("f", INDEXED_FIELD_LIMIT - 1) });
    // An orphan: declarer tag gone without releasing (the gitcoin defect).
    forceIndexed(db, "orphan", "deleted-tag");
    const err = await refusal(store.upsertTagRecord("more", { fields: indexed("g", 1) }));
    const orphan = err.unused.find((u) => u.field === "orphan");
    expect(orphan?.reason).toBe("no_live_declarer");
    expect(err.message).toContain("orphan (no type declares it; prune-schema drops it)");
  });

  it("at the limit, what adds no column still works: a second declarer, a re-declare, a sole declarer's retype, a swap", async () => {
    await store.upsertTagRecord("big", { fields: indexed("f", INDEXED_FIELD_LIMIT) });
    // Second declarer of an existing indexed field.
    await store.upsertTagRecord("other", { fields: { f3: { type: "string", indexed: true } } });
    expect(getIndexedField(db, "f3")!.declarerTags.sort()).toEqual(["big", "other"]);
    // Re-declare the same set.
    await store.upsertTagRecord("big", { fields: indexed("f", INDEXED_FIELD_LIMIT) });
    // Sole declarer retypes.
    const retyped = { ...indexed("f", INDEXED_FIELD_LIMIT), f7: { type: "integer" as const, indexed: true as const } };
    await store.upsertTagRecord("big", { fields: retyped as any });
    expect(getIndexedField(db, "f7")!.sqliteType).toBe("INTEGER");
    // Swap one indexed field for another in one write.
    const swapped: Record<string, unknown> = { ...indexed("f", INDEXED_FIELD_LIMIT) };
    delete swapped.f0;
    swapped.h0 = { type: "string", indexed: true };
    await store.upsertTagRecord("big", { fields: swapped as any });
    expect(getIndexedField(db, "f0")).toBeNull();
    expect(getIndexedField(db, "h0")).not.toBeNull();
    expect(countIndexedFields(db)).toBe(88);
  });

  it("a vault already over the limit keeps working; doctor reports the count and the excess", async () => {
    await store.upsertTagRecord("big", { fields: indexed("f", INDEXED_FIELD_LIMIT) });
    forceIndexed(db, "old1", "big");
    forceIndexed(db, "old2", "big");
    rawUpsertTagRecord(db, "big", { fields: { ...indexed("f", INDEXED_FIELD_LIMIT), ...indexed("old", 2, 1) } });
    expect(countIndexedFields(db)).toBe(90);

    // Writes and indexed queries still work.
    await store.createNote("y", { tags: ["big"], metadata: { old1: "v" } });
    const found = await store.queryNotes({ tags: ["big"], metadata: { old1: { eq: "v" } } } as any);
    expect(found.length).toBe(1);
    // Re-saving the same schema adds no column, so it isn't refused.
    await store.upsertTagRecord("big", { description: "touched", fields: { ...indexed("f", INDEXED_FIELD_LIMIT), ...indexed("old", 2, 1) } });
    // A new one is.
    await refusal(store.upsertTagRecord("more", { fields: indexed("g", 1) }));

    const report = await store.doctor({});
    expect(report.indexed_fields).toEqual({ count: 90, limit: 88 });
    const f = report.findings.find((x) => x.type === "indexed_field_limit")!;
    expect(f.severity).toBe("warning");
    expect(f.detail).toMatch(/90 indexed fields, over the limit of 88/);
  });

  it("doctor: count under the limit, no finding; a scoped run carries no vault-wide count", async () => {
    await store.upsertTagRecord("t", { fields: indexed("f", 3) });
    const report = await store.doctor({});
    expect(report.indexed_fields).toEqual({ count: 3, limit: 88 });
    expect(report.findings.some((x) => x.type === "indexed_field_limit")).toBe(false);
    const scoped = await store.doctor({ allowedTags: new Set(["t"]) });
    expect(scoped.indexed_fields).toBeUndefined();
  });

  describe("import of an export from a vault over the limit", () => {
    let dir: string;
    beforeEach(() => {
      dir = join(tmpdir(), `ix-limit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(dir, { recursive: true });
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("completes: the extra field and its values land, only its index is left off", async () => {
      await store.upsertTagRecord("big", { fields: indexed("f", INDEXED_FIELD_LIMIT) });
      // A second type whose indexed field the old vault held past 88.
      forceIndexed(db, "extra", "late");
      rawUpsertTagRecord(db, "late", { fields: { extra: { type: "string", indexed: true } } });
      await store.createNote("kept", { id: "n1", path: "n1", tags: ["late"], metadata: { extra: "value" } });
      await exportVaultToDir(store, { outDir: dir });

      const target = new SqliteStore(new Database(":memory:"));
      const stats = await importPortableVault(target, { inDir: dir });
      expect(stats.unindexed_schema_fields).toEqual([
        expect.objectContaining({ tag: "late", field: "extra" }),
      ]);
      expect(countIndexedFields(target.db)).toBe(88);
      expect((await target.getTagRecord("late"))!.fields!.extra).toMatchObject({ type: "string", indexed: false });
      expect((await target.getNote("n1"))!.metadata).toMatchObject({ extra: "value" });
    });

    it("keeps what fits in one schema file and unindexes only the rest", async () => {
      await store.upsertTagRecord("big", { fields: indexed("f", INDEXED_FIELD_LIMIT - 2) });
      for (let i = 0; i < 5; i++) forceIndexed(db, `late${i}`, "late");
      rawUpsertTagRecord(db, "late", { fields: indexed("late", 5) });
      await exportVaultToDir(store, { outDir: dir });

      const target = new SqliteStore(new Database(":memory:"));
      const stats = await importPortableVault(target, { inDir: dir });
      expect(countIndexedFields(target.db)).toBe(88);
      expect(stats.unindexed_schema_fields).toHaveLength(3);
      const late = (await target.getTagRecord("late"))!.fields!;
      expect(Object.values(late).filter((f: any) => f.indexed === true)).toHaveLength(2);
    });

    it("blow-away drops orphaned indexed fields first, so they don't cost the export its indexes", async () => {
      await store.upsertTagRecord("big", { fields: indexed("f", INDEXED_FIELD_LIMIT) });
      await exportVaultToDir(store, { outDir: dir });

      const target = new SqliteStore(new Database(":memory:"));
      for (let i = 0; i < 5; i++) forceIndexed(target.db, `orphan${i}`, "gone-tag");
      const stats = await importPortableVault(target, { inDir: dir, blowAway: true });
      expect(stats.unindexed_schema_fields).toEqual([]);
      expect(countIndexedFields(target.db)).toBe(88);
      expect(getIndexedField(target.db, "orphan0")).toBeNull();
    });
  });
});
