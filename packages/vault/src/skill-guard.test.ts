/**
 * The skill write rule at a box's MCP door for a key the door contracts can't mint any more: an admin key held to tags
 * (refused since 0.9.1, but one minted before still works). It isn't vault-wide, and a skill reaches every AI, so it
 * may not write one (core skills.ts; the rule itself is held by contracts/suites/door/skills.test.ts).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeVaultConfig } from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { generateScopedMcpTools } from "./mcp-tools.ts";
import type { AuthResult } from "./auth.ts";

const V = "skillguard";
let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = join(tmpdir(), `vault-skill-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "vault", "data"), { recursive: true });
  prevHome = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = tmpHome;
  clearVaultStoreCache();
  writeVaultConfig({ name: V, api_keys: [], created_at: new Date().toISOString() });
  getVaultStore(V);
});

afterEach(() => {
  clearVaultStoreCache();
  if (prevHome === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = prevHome;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

const admin = (scopedTags: string[] | null): AuthResult => ({
  permission: "full",
  scopes: [`vault:${V}:read`, `vault:${V}:write`, `vault:${V}:admin`],
  legacyDerived: false,
  scoped_tags: scopedTags,
  vault_name: null,
  caller_jti: null,
  actor: "test-user",
  via: "api",
});

const tool = (a: AuthResult, name: string) => generateScopedMcpTools(V, a).find((t) => t.name === name)!;
const create = (a: AuthResult) => tool(a, "create-note");
const writer: AuthResult = { ...admin(null), scopes: [`vault:${V}:read`, `vault:${V}:write`] };

describe("the skill rule and a tag-scoped admin key", () => {
  test("an admin key scoped to tags, even to `skill` itself, can't make a skill; a whole-vault admin can", async () => {
    const ok: any = await create(admin(null)).execute({ path: "Skills/Plan", tags: ["skill"], metadata: { description: "x" }, content: "y" });
    expect(ok.tags).toContain("skill");
    const scoped = admin(["skill"]);
    const r: any = await create(scoped).execute({ path: "Skills/Other", tags: ["skill"], metadata: { description: "x" }, content: "y" }).catch((e) => e);
    expect(r?.code ?? r?.error_type, JSON.stringify(r)).toMatch(/SKILL_NEEDS_ADMIN|skill_needs_admin/);
  });

  test("a type declared under `skill` before any skill exists is a skill too; a write key can't add to it or take it off", async () => {
    await tool(admin(null), "update-tag").execute({ tag: "playbook", parent_names: ["skill"] });
    const planted: any = await create(writer).execute({ path: "Playbooks/Evil", tags: ["playbook"], content: "evil" }).catch((e) => e);
    expect(planted?.code ?? planted?.error_type, JSON.stringify(planted)).toMatch(/SKILL_NEEDS_ADMIN|skill_needs_admin/);
    const made: any = await create(admin(null)).execute({ path: "Playbooks/Close", tags: ["playbook"], content: "Close the books." });
    const off: any = await tool(writer, "update-note").execute({ id: made.id, tags: { remove: ["playbook"] }, content: "gone", if_updated_at: made.updatedAt }).catch((e) => e);
    expect(off?.code ?? off?.error_type, JSON.stringify(off)).toMatch(/SKILL_NEEDS_ADMIN|skill_needs_admin/);
  });
});
