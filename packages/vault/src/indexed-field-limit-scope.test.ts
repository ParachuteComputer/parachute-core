/**
 * The 0.9.2 indexed-field ceiling through REST and MCP, and its tag-scope
 * scrub: the refusal lists unused indexed fields vault-wide, so a tag-scoped
 * caller hears only those whose every declarer it can read.
 *
 * Fixture: PARACHUTE_HOME temp home + hand-built AuthResult, same pattern
 * as tag-field-conflict-scope.test.ts.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeVaultConfig } from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { generateScopedMcpTools } from "./mcp-tools.ts";
import { handleTags } from "./routes.ts";
import type { AuthResult } from "./auth.ts";
import { INDEXED_FIELD_LIMIT, IndexedFieldLimitError } from "../core/src/indexed-fields.ts";

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = join(tmpdir(), `vault-ixlimit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function indexed(prefix: string, n: number) {
  const fields: Record<string, { type: "string"; indexed: true }> = {};
  for (let i = 0; i < n; i++) fields[`${prefix}${i}`] = { type: "string", indexed: true };
  return fields;
}

/** 87 indexed fields on an out-of-scope type, 1 on the caller's own: at the limit. */
async function atTheLimit() {
  writeVaultConfig({ name: "journal", api_keys: [], created_at: new Date().toISOString() });
  const store = getVaultStore("journal");
  await store.upsertTagRecord("project-hidden", { fields: indexed("secretfield", INDEXED_FIELD_LIMIT - 1) });
  await store.upsertTagRecord("mine", { fields: { mycol: { type: "string", indexed: true } } });
  return store;
}

function put(name: string, body: unknown) {
  return new Request(`http://localhost/api/tags/${name}`, { method: "PUT", body: JSON.stringify(body) });
}

describe("indexed-field ceiling on the doors", () => {
  test("REST, unscoped: 409 indexed_field_limit with limit, got and every unused field", async () => {
    const store = await atTheLimit();
    const res = await handleTags(put("mine", { fields: { mycol: { type: "string", indexed: true }, newcol: { type: "string", indexed: true } } }), store, "/mine");
    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body.error_type).toBe("indexed_field_limit");
    expect(body.field).toBe("newcol");
    expect(body.limit).toBe(88);
    expect(body.got).toBe(88);
    expect(body.unused.length).toBe(88);
    expect(body.error).toMatch(/prune/);
    // Nothing persisted.
    expect(Object.keys((await store.getTagRecord("mine"))!.fields!)).toEqual(["mycol"]);
  });

  test("REST, scoped: the refusal names only unused fields the caller's types declare", async () => {
    const store = await atTheLimit();
    const res = await handleTags(put("mine", { fields: { mycol: { type: "string", indexed: true }, newcol: { type: "string", indexed: true } } }), store, "/mine", {
      allowed: new Set(["mine"]),
      raw: ["mine"],
    });
    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body.error_type).toBe("indexed_field_limit");
    expect(body.unused.map((u: any) => u.field)).toEqual(["mycol"]);
    expect(JSON.stringify(body)).not.toContain("secretfield");
    expect(JSON.stringify(body)).not.toContain("project-hidden");
  });

  test("MCP update-tag, scoped: same refusal, same scrub", async () => {
    await atTheLimit();
    const tool = generateScopedMcpTools("journal", authFor("journal", ["mine"])).find((t) => t.name === "update-tag")!;
    let caught: any;
    try {
      await tool.execute({ tag: "mine", fields: { mycol: { type: "string", indexed: true }, newcol: { type: "string", indexed: true } } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(IndexedFieldLimitError);
    expect(caught.error_type).toBe("indexed_field_limit");
    expect(caught.unused.map((u: any) => u.field)).toEqual(["mycol"]);
    expect(caught.message).not.toContain("secretfield");
    expect(caught.message).toContain("prune");

    // manage-types (0.9's name) folds update-tag: the same refusal and scrub.
    const admin = { ...authFor("journal", ["mine"]), scopes: ["vault:journal:read", "vault:journal:write", "vault:journal:admin"] };
    const mt = generateScopedMcpTools("journal", admin).find((t) => t.name === "manage-types")!;
    let viaTypes: any;
    try {
      await mt.execute({ action: "update", tag: "mine", fields: { mycol: { type: "string", indexed: true }, newcol: { type: "string", indexed: true } } });
    } catch (e) {
      viaTypes = e;
    }
    expect(viaTypes?.error_type).toBe("indexed_field_limit");
    expect(JSON.stringify({ m: viaTypes.message, u: viaTypes.unused })).not.toContain("secretfield");
  });
});
