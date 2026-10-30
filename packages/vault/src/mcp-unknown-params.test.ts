/**
 * Unknown parameters (T-318-09, decided 2026-10-30: "nothing removed before 1.0"). 0.8 ignored a parameter a tool
 * doesn't know and ran the call; 0.9 does the same, so no client that worked on 0.8 breaks, and says so:
 *   - an object answer carries a `warnings` entry `{code: "unknown_parameter", field, hint}` (the one-line fix);
 *     query-notes' list answer becomes `{notes, warnings}`, the shape it already has whenever it warns;
 *   - an array answer keeps its shape (no field to put a warning in): the log line below is its only trace;
 *   - every ignored name is counted in one stderr line naming the tool and the parameter, never its value, so real
 *     exposure can be measured before 1.0 decides whether to refuse them;
 *   - a call that fails anyway (e.g. `note_id` instead of the required `id`) still names the fix in its error.
 * Nested misuses (`near: {id}`, `content_edit: {find}`) stay refused: 0.8 refused them too, less helpfully.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeVaultConfig } from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { generateScopedMcpTools } from "./mcp-tools.ts";
import type { AuthResult } from "./auth.ts";

let tmpHome: string;
let prevHome: string | undefined;
const VAULT = "params";

beforeEach(() => {
  tmpHome = join(tmpdir(), `vault-unknown-params-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "vault", "data"), { recursive: true });
  prevHome = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = tmpHome;
  clearVaultStoreCache();
  writeVaultConfig({ name: VAULT, api_keys: [], created_at: new Date().toISOString() });
  getVaultStore(VAULT);
});

afterEach(() => {
  clearVaultStoreCache();
  if (prevHome === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = prevHome;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

const auth: AuthResult = {
  permission: "full",
  scopes: [`vault:${VAULT}:read`, `vault:${VAULT}:write`, `vault:${VAULT}:admin`],
  legacyDerived: false,
  scoped_tags: null,
  vault_name: null,
  caller_jti: null,
  actor: "test-user",
  via: "api",
} as AuthResult;

function tool(name: string) {
  const t = generateScopedMcpTools(VAULT, auth).find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return (params: Record<string, unknown>) => t.execute(params) as Promise<any>;
}

async function seed() {
  await tool("create-note")({ notes: [
    { path: "a/one", content: "# One", tags: ["alpha"] },
    { path: "a/two", content: "# Two", tags: ["beta"] },
  ] });
}

function captureStderr() {
  const lines: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
  return { lines, restore: () => spy.mockRestore() };
}

describe("unknown parameters are ignored, as on 0.8, with a warning and a counted log line", () => {
  test("query-notes {tags} runs as if it weren't there, and the answer names the fix", async () => {
    await seed();
    const log = captureStderr();
    let r: any;
    try {
      r = await tool("query-notes")({ tags: "SECRET-VALUE-alpha", limit: 10 });
    } finally {
      log.restore();
    }
    const plain = await tool("query-notes")({ limit: 10 });
    const notes = (x: any) => (Array.isArray(x) ? x : x.notes).map((n: any) => n.id).sort();
    expect(notes(r)).toEqual(notes(plain));
    const w = (r.warnings ?? []).find((x: any) => x.code === "unknown_parameter");
    expect(w).toMatchObject({ code: "unknown_parameter", field: "tags", hint: "use tag" });
    const line = log.lines.find((l) => l.includes("unknown parameter"));
    expect(line).toMatch(/query-notes\.tags/);
    expect(line).toMatch(/\b1\b/);
    expect(log.lines.join("\n")).not.toContain("SECRET-VALUE");
  });

  test("the log line counts each tool+parameter", async () => {
    const log = captureStderr();
    try {
      await tool("query-notes")({ zz_count_probe: 1, limit: 1 });
      await tool("query-notes")({ zz_count_probe: 2, limit: 1 });
    } finally {
      log.restore();
    }
    const counts = log.lines.filter((l) => l.includes("query-notes.zz_count_probe")).map((l) => Number(/\((\d+)/.exec(l)?.[1]));
    expect(counts).toEqual([1, 2]);
  });

  test("a write with an unknown parameter is made, and says what it ignored", async () => {
    const log = captureStderr();
    let r: any;
    try {
      r = await tool("create-note")({ path: "b/new", content: "# New", title: "ignored" });
    } finally {
      log.restore();
    }
    const got = await tool("query-notes")({ id: "b/new" });
    expect(got.path).toBe("b/new");
    expect((r.warnings ?? []).map((w: any) => [w.code, w.field])).toContainEqual(["unknown_parameter", "title"]);
  });

  test("an array answer keeps its shape", async () => {
    await seed();
    const log = captureStderr();
    let r: any;
    try {
      r = await tool("list-tags")({ bogus_flag: true });
    } finally {
      log.restore();
    }
    expect(r).toEqual(await tool("list-tags")({}));
    expect(log.lines.some((l) => l.includes("list-tags.bogus_flag"))).toBe(true);
  });

  test("a call that fails anyway still names the fix", async () => {
    const log = captureStderr();
    try {
      await expect(tool("update-note")({ note_id: "a/one", append: "x" })).rejects.toThrow(/`note_id`.*`id`/);
    } finally {
      log.restore();
    }
  });

  test("nested misuses stay refused (0.8 refused them too)", async () => {
    await seed();
    await expect(tool("query-notes")({ near: { id: "a/one" } })).rejects.toThrow(/near takes \{note_id\}, not \{id\}/);
  });

  test("manage-types names a parameter the action called doesn't take", async () => {
    await seed();
    const log = captureStderr();
    let r: any;
    try {
      r = await tool("manage-types")({ action: "rename", old_name: "alpha", new_name: "gamma", fields: { x: { type: "string" } } });
    } finally {
      log.restore();
    }
    expect((r.warnings ?? []).map((w: any) => w.field)).toEqual(["fields"]);
    // ...and the update action, which does take `fields` and `kind`, is not warned about them.
    const u = await tool("manage-types")({ tag: "delta", fields: { y: { type: "string" } }, kind: "type" });
    expect((u.warnings ?? []).filter((w: any) => w.code === "unknown_parameter")).toEqual([]);
  });

  test("the log can't be forged or flooded by caller-chosen names", async () => {
    const log = captureStderr();
    try {
      await tool("query-notes")({ "zz_forge\n[mcp] fake line": 1, limit: 1 });
      for (let i = 0; i < 15; i++) await tool("query-notes")({ zz_rate_probe: i, limit: 1 });
      for (let i = 0; i < 300; i++) await tool("list-tags")({ [`zz_card_${i}`]: 1 });
    } finally {
      log.restore();
    }
    expect(log.lines.every((l) => !l.includes("\n"))).toBe(true);
    expect(log.lines.filter((l) => l.includes("zz_rate_probe"))).toHaveLength(10);
    const distinct = new Set(log.lines.filter((l) => l.includes("list-tags.")).map((l) => /list-tags\.(\S+)/.exec(l)![1]));
    expect(distinct.size).toBeLessThanOrEqual(257);
    expect(distinct.has("<other>")).toBe(true);
  });

  test("`vault` and `_`-names are never warned about", async () => {
    const r = await tool("query-notes")({ vault: VAULT, _client: "x", limit: 1 });
    expect((r.warnings ?? []).filter((w: any) => w.code === "unknown_parameter")).toEqual([]);
  });
});
