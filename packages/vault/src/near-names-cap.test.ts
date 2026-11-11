/** 0.9.2 teaching at the door: the nearest existing name on writes, and vault-info's tag map capped. */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeVaultConfig } from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { generateScopedMcpTools } from "./mcp-tools.ts";
import type { AuthResult } from "./auth.ts";

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = join(tmpdir(), `vault-near-names-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "vault", "data"), { recursive: true });
  prevHome = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = tmpHome;
  clearVaultStoreCache();
});

afterEach(() => {
  clearVaultStoreCache();
  if (prevHome === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = prevHome;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

function seedVault(name: string): void {
  writeVaultConfig({ name, api_keys: [], created_at: new Date().toISOString() });
  getVaultStore(name);
}

function authFor(vaultName: string, scopedTags: string[] | null): AuthResult {
  return {
    permission: "full",
    scopes: [`vault:${vaultName}:read`, `vault:${vaultName}:write`],
    legacyDerived: false,
    scoped_tags: scopedTags,
    vault_name: null,
    caller_jti: null,
    actor: "test-user",
    via: "api",
  };
}

function tool(vaultName: string, name: string, scopedTags: string[] | null = null) {
  return generateScopedMcpTools(vaultName, authFor(vaultName, scopedTags)).find((t) => t.name === name)!;
}

const said = (v: unknown) => JSON.stringify(v);

describe("the nearest existing name (0.9.2)", () => {
  test("a new type one letter from an existing one is made, with a warning naming the existing one", async () => {
    seedVault("v");
    const store = getVaultStore("v");
    await store.upsertTagRecord("meeting", { fields: { held_on: { type: "date" } } });
    const made: any = await tool("v", "create-note").execute({ content: "", path: "m/1", types: ["meetng"] });
    expect(made.types).toEqual(["meetng"]);
    expect(made.warnings).toEqual([expect.objectContaining({ code: "near_name", kind: "type", name: "meetng", nearest: "meeting" })]);
    // A name that isn't near, or one that already exists, gets nothing.
    const other: any = await tool("v", "create-note").execute({ content: "", path: "m/2", types: ["standup"] });
    expect(said(other)).not.toContain("near_name");
    const again: any = await tool("v", "create-note").execute({ content: "", path: "m/3", types: ["meetng"] });
    expect(said(again)).not.toContain("near_name");
  });

  test("a tag-scoped writer isn't told the name of a type outside its scope", async () => {
    seedVault("v");
    const store = getVaultStore("v");
    await store.upsertTagRecord("meeting", { fields: { held_on: { type: "date" } } });
    const made: any = await tool("v", "create-note", ["meetng"]).execute({ content: "", path: "m/1", types: ["meetng"] });
    expect(said(made)).not.toContain('"meeting"');
  });

  test("a field one letter from one the type declares is kept, warned inside validation_status", async () => {
    seedVault("v");
    const store = getVaultStore("v");
    await store.upsertTagRecord("task", { fields: { status: { type: "string" } } });
    const made: any = await tool("v", "create-note").execute({ content: "", path: "t/1", tags: ["task"], metadata: { statu: "open" } });
    expect(made.metadata).toEqual({ statu: "open" });
    expect(made.validation_status.warnings).toEqual([expect.objectContaining({ reason: "near_name", field: "statu", nearest: "status", schema: "task" })]);
  });

  test("a type PUT naming a new type or a new field one letter from an existing one says so", async () => {
    seedVault("v");
    const store = getVaultStore("v");
    await store.upsertTagRecord("ledger", { fields: { amount_due: { type: "integer" } } });
    const r: any = await tool("v", "update-tag").execute({ tag: "ledgr", fields: { amount_du: { type: "integer" } } });
    expect(r.warnings.map((w: any) => [w.kind, w.name, w.nearest])).toEqual([["type", "ledgr", "ledger"], ["field", "amount_du", "amount_due"]]);
    // The same PUT on an existing type with its own field: nothing new, nothing said.
    const again: any = await tool("v", "update-tag").execute({ tag: "ledger", fields: { amount_due: { type: "integer" } } });
    expect(again.warnings).toBeUndefined();
  });
});

describe("near_name on a scoped type update (0.9.2)", () => {
  test("names no type, and no field, from outside the caller's scope", async () => {
    seedVault("v");
    const store = getVaultStore("v");
    await store.upsertTagRecord("health", { fields: { blood_sugar: { type: "integer" } } });
    await store.upsertTagRecord("work", {});
    const scoped: any = await tool("v", "update-tag", ["work", "healt"]).execute({ tag: "work", fields: { blood_sugr: { type: "integer" } } });
    expect(said(scoped)).not.toContain("blood_sugar");
    const open: any = await tool("v", "update-tag").execute({ tag: "work", fields: { blood_sugr2x: { type: "integer" } } });
    expect(open.warnings ?? []).toEqual([]); // not near anything: nothing said
    const unscoped: any = await tool("v", "update-tag").execute({ tag: "office", fields: { blood_suga: { type: "integer" } } });
    expect(unscoped.warnings).toEqual([expect.objectContaining({ kind: "field", nearest: "blood_sugar", declared_by: ["health"] })]);
  });

  test("a field two types declare, one in scope: the warning names only the one the caller may see", async () => {
    seedVault("v");
    const store = getVaultStore("v");
    await store.upsertTagRecord("health", { fields: { blood_sugar: { type: "integer" } } });
    await store.upsertTagRecord("proj", { fields: { blood_sugar: { type: "integer" } } });
    await store.upsertTagRecord("work", {});
    const r: any = await tool("v", "update-tag", ["work", "proj"]).execute({ tag: "work", fields: { blood_sugr: { type: "integer" } } });
    expect(r.warnings).toEqual([expect.objectContaining({ kind: "field", nearest: "blood_sugar", declared_by: ["proj"] })]);
    expect(said(r)).not.toContain("health");
  });
});

describe("vault-info's tag map (0.9.2)", () => {
  test("700 types fit the budget, most used first, with the totals and where the rest are", async () => {
    seedVault("v");
    const store = getVaultStore("v");
    for (let i = 0; i < 700; i++) {
      await store.upsertTagRecord(`kind${String(i).padStart(3, "0")}`, { description: "A made-up type with two fields", fields: { [`a${i % 40}`]: { type: "string" }, [`n${i % 40}`]: { type: "integer" } } });
    }
    for (let i = 0; i < 5; i++) await store.createNote("", { path: `x/${i}`, tags: ["kind699"] });
    const info: any = await tool("v", "vault-info").execute({});
    expect(JSON.stringify({ ...info, indexed_fields: undefined }).length).toBeLessThanOrEqual(16_000);
    expect(info.tags_total).toBe(700);
    expect(info.tags[0].name).toBe("kind699");
    expect(info.tags_more).toContain("list-types");
    expect(info.map.tags.map((t: any) => t.name)).toEqual(["kind699"]); // one tag in use: the counts list fits as it is
  });

  test("a small vault's reply is unchanged", async () => {
    seedVault("v");
    const store = getVaultStore("v");
    await store.upsertTagRecord("task", { fields: { status: { type: "string" } } });
    const info: any = await tool("v", "vault-info").execute({});
    expect(info.tags_total).toBeUndefined();
    expect(info.tags.map((t: any) => t.name)).toContain("task");
  });
});
