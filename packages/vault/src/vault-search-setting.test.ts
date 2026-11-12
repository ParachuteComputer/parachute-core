/**
 * `search.auto_hybrid` (0.9.3): the vault's own override of the auto-hybrid default. It round-trips through
 * vault.yaml beside the other settings, an admin sets it over PATCH /api/vault (true, false, or null to clear),
 * a non-admin can neither set nor read it. The search behaviour itself is in core/src/hybrid.test.ts and
 * contracts/suites/v093/hybrid.test.ts.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readVaultConfig, vaultConfigPath, writeVaultConfig } from "./config.ts";
import { BunStore } from "./vault-store.ts";
import { descriptionNeedsAdmin, handleVault } from "./routes.ts";

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = join(tmpdir(), `vault-search-setting-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "vault", "data", "v"), { recursive: true });
  prevHome = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = prevHome;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

const fresh = () => ({ name: "v", api_keys: [], created_at: new Date().toISOString() });

describe("search.auto_hybrid in vault.yaml", () => {
  test("true and false round-trip; unset writes nothing and reads back unset; other blocks are untouched", () => {
    for (const v of [true, false]) {
      writeVaultConfig({ ...fresh(), search: { auto_hybrid: v }, auto_transcribe: { enabled: false } });
      expect(readVaultConfig("v")?.search).toEqual({ auto_hybrid: v });
      expect(readVaultConfig("v")?.auto_transcribe).toEqual({ enabled: false });
    }
    writeVaultConfig(fresh());
    expect(readVaultConfig("v")?.search).toBeUndefined();
    expect(readFileSync(vaultConfigPath("v"), "utf8")).not.toContain("search:");
  });
});

test("a trailing comment on the value is accepted", () => {
  writeVaultConfig(fresh());
  const path = vaultConfigPath("v");
  writeFileSync(path, readFileSync(path, "utf8") + "search:\n  auto_hybrid: false  # keep exact words\n");
  expect(readVaultConfig("v")?.search).toEqual({ auto_hybrid: false });
});

describe("PATCH and GET /api/vault, config.search.auto_hybrid", () => {
  const call = async (method: string, body: unknown, admin: boolean) => {
    writeVaultConfig(readVaultConfig("v") ?? fresh());
    const cfg = readVaultConfig("v")!;
    const res = await handleVault(
      new Request("http://localhost/api/vault", { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) }),
      new BunStore(new Database(":memory:")),
      cfg as any,
      () => writeVaultConfig(cfg),
      async () => ({ enabled: false } as any),
      undefined,
      async () => ({ enabled: false, state: "off" } as any),
      admin ? null : (what?: string) => descriptionNeedsAdmin("v", ["vault:v:write"], what),
    );
    return { status: res.status, body: (await res.json()) as any };
  };

  test("an admin sets true, false and null; the GET shows the effective value to admin only; the file keeps it", async () => {
    expect((await call("GET", undefined, true)).body.config.search.auto_hybrid).toBe(true); // unset: the default
    const off = await call("PATCH", { config: { search: { auto_hybrid: false } } }, true);
    expect(off.status).toBe(200);
    expect(off.body.config.search.auto_hybrid).toBe(false);
    expect(readVaultConfig("v")?.search).toEqual({ auto_hybrid: false });
    expect((await call("GET", undefined, true)).body.config.search.auto_hybrid).toBe(false);
    expect(JSON.stringify((await call("GET", undefined, false)).body)).not.toContain("auto_hybrid");
    const cleared = await call("PATCH", { config: { search: { auto_hybrid: null } } }, true);
    expect(cleared.body.config.search.auto_hybrid).toBe(true);
    expect(readVaultConfig("v")?.search).toBeUndefined();
  });

  test("a non-admin is refused, a non-boolean is a 400, and neither changes the file", async () => {
    writeVaultConfig({ ...fresh(), search: { auto_hybrid: true } });
    const denied = await call("PATCH", { config: { search: { auto_hybrid: false } } }, false);
    expect(denied.status).toBe(403);
    expect(denied.body.message).toContain("search settings");
    for (const bad of ["no", 1, undefined]) expect((await call("PATCH", { config: { search: { auto_hybrid: bad } } }, true)).status).toBe(400);
    expect(readVaultConfig("v")?.search).toEqual({ auto_hybrid: true });
  });
});
