/** A tag-scoped session sees the `scan` warning (it names only the caller's own fields) and no other. */
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
  tmpHome = join(tmpdir(), `vault-scan-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

async function queryNotesTool(vaultName: string, scopedTags: string[] | null) {
  const tools = generateScopedMcpTools(vaultName, authFor(vaultName, scopedTags));
  return tools.find((t) => t.name === "query-notes")!;
}

describe("the scan warning on a tag-scoped MCP session (0.9.2)", () => {
  test("is kept, while warnings that name tags are still dropped", async () => {
    seedVault("v");
    const store = getVaultStore("v");
    await store.createNote("in", { tags: ["health"], metadata: { mood: "ok" }, path: "in" });
    await store.createNote("out", { tags: ["work"], metadata: { mood: "ok" }, path: "out" });
    const params = { tag: ["health", "zzz-no-such-tag"], metadata: { mood: { eq: "ok" } } };

    const open: any = await (await queryNotesTool("v", null)).execute(params);
    expect(open.warnings.map((w: any) => w.code).sort()).toEqual(["scan", "unknown_tag"]);

    const scoped: any = await (await queryNotesTool("v", ["health"])).execute(params);
    expect(scoped.notes.map((n: any) => n.path)).toEqual(["in"]);
    expect(scoped.warnings).toEqual([expect.objectContaining({ code: "scan", fields: ["mood"] })]);
  });

  test("full-text search and its metadata filter warn too", async () => {
    seedVault("v");
    const store = getVaultStore("v");
    await store.createNote("a wombat", { metadata: { mood: "ok" }, path: "a" });
    const got: any = await (await queryNotesTool("v", null)).execute({ search: "wombat", metadata: { mood: { eq: "ok" } } });
    expect(got.notes.map((n: any) => n.path)).toEqual(["a"]);
    expect(got.warnings.map((w: any) => w.code)).toContain("scan");
  });

  test("aggregate refuses a filter on a field that isn't indexed, scoped or not", async () => {
    seedVault("v");
    const store = getVaultStore("v");
    await store.createNote("in", { tags: ["health"], metadata: { mood: "ok" }, path: "in" });
    for (const scope of [null, ["health"]]) {
      const tool = await queryNotesTool("v", scope);
      await expect(
        (async () => tool.execute({ metadata: { mood: { eq: "ok" } }, aggregate: { op: "count" } }))(),
      ).rejects.toThrow(/not indexed/);
    }
  });
});
