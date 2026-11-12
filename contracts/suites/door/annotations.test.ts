// Surface D, T-456: every tool says what it does to the vault (MCP tool annotations), at every door.
//
// Why: with no annotations a client must assume every tool changes things. ChatGPT does: its "Allow read-only tools"
// setting still asked before every read (2026-11-12 session, evidence in the p09-lock repo). So each listed tool
// carries all four hints (readOnlyHint, destructiveHint, idempotentHint, openWorldHint), and they are honest: a client
// may skip asking for a read-only tool, so a tool that needs more than read to see is never marked read-only.
// The checks lean on what the door itself shows (which tools each level sees), not on a copy of the table.
// Red before T-456: no tool carried annotations (`tools/list` had none).
import { describe, expect, test } from "bun:test";
import { accountToken, door, fp, mcp } from "./_door.ts";

const is091 = door().release === "0.9.1";
const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;
type Tool = { name: string; annotations?: Record<string, unknown> };

async function listed(level: "read" | "write" | "admin", opts: { url?: string; bearer?: string } = {}): Promise<Tool[]> {
  const c = await mcp(level, opts);
  try {
    return (await c.tools()) as Tool[];
  } finally {
    await c.close();
  }
}

/** Every tool carries the four hints as booleans, and none reaches past this door. */
function expectHints(where: string, tools: Tool[]) {
  for (const t of tools) {
    const a = t.annotations ?? {};
    expect({ where, tool: t.name, hints: HINTS.map((h) => typeof a[h]) }).toEqual({ where, tool: t.name, hints: HINTS.map(() => "boolean") });
    expect({ where, tool: t.name, openWorld: a.openWorldHint }).toEqual({ where, tool: t.name, openWorld: false });
    // A read-only tool destroys nothing; a removal is destructive.
    if (a.readOnlyHint) expect({ tool: t.name, destructive: a.destructiveHint }).toEqual({ tool: t.name, destructive: false });
    if (/^delete-|^revoke-/.test(t.name)) expect({ tool: t.name, destructive: a.destructiveHint, readOnly: a.readOnlyHint }).toEqual({ tool: t.name, destructive: true, readOnly: false });
  }
}

describe.skipIf(!is091)("tools say what they do", () => {
  test("each level's tools carry the four hints; a tool a reader can't see is never read-only", async () => {
    const read = await listed("read");
    const write = await listed("write");
    const admin = await listed("admin");
    for (const [level, tools] of [["read", read], ["write", write], ["admin", admin]] as const) expectHints(level, tools);

    const readNames = new Set(read.map((t) => t.name));
    const writeNames = new Set(write.map((t) => t.name));
    // Needs write or admin to see: it changes the vault.
    for (const t of [...write.filter((t) => !readNames.has(t.name)), ...admin.filter((t) => !writeNames.has(t.name))]) {
      expect({ tool: t.name, readOnly: t.annotations?.readOnlyHint }).toEqual({ tool: t.name, readOnly: false });
    }
    // A reader's tools are reads, except attachment-url: a reader sees it for downloads, and its upload action (refused
    // to a reader) adds an attachment, so it can't promise read-only.
    for (const t of read) {
      expect({ tool: t.name, readOnly: t.annotations?.readOnlyHint }).toEqual({ tool: t.name, readOnly: t.name !== "attachment-url" });
    }
    // The same tool carries the same hints whatever level lists it.
    for (const t of admin) {
      const w = write.find((x) => x.name === t.name);
      if (w) expect({ tool: t.name, hints: w.annotations }).toEqual({ tool: t.name, hints: t.annotations });
    }
    fp("annotations/read-only.tools", read.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort());
    fp("annotations/destructive.tools", admin.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort());
  });

  test("the account door's tools carry them too, and a vault tool keeps the vault's own", async () => {
    const d = door();
    const tools = await listed("admin", { url: `${d.issuer}/account/mcp`, bearer: await accountToken() });
    expect(tools.length).toBeGreaterThan(0);
    expectHints("account", tools);
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("list-vaults")?.annotations?.readOnlyHint).toBe(true);
    for (const n of ["create-vault", "grant-access", "revoke-access"]) {
      if (byName.has(n)) expect({ tool: n, readOnly: byName.get(n)!.annotations?.readOnlyHint }).toEqual({ tool: n, readOnly: false });
    }
    const vault = new Map((await listed("admin")).map((t) => [t.name, t]));
    for (const t of tools) {
      const own = vault.get(t.name);
      if (own) expect({ tool: t.name, hints: t.annotations }).toEqual({ tool: t.name, hints: own.annotations });
    }
    fp("annotations/account.read-only.tools", tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort());
  });
});
