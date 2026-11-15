// Surface D, T-456: every tool says what it does to the vault (MCP tool annotations), at every door.
//
// Why: with no annotations a client must assume every tool changes things. ChatGPT does: its "Allow read-only tools"
// setting still asked before every read (2026-11-12 session, evidence in the p09-lock repo). So each listed tool
// carries all four hints (readOnlyHint, destructiveHint, idempotentHint, openWorldHint), and they are honest: a client
// may skip asking for a read-only tool, so a tool is read-only only if nothing this connection may call on it changes
// the vault. A tool that needs more than read to see is never read-only. Two tools reach further with the level, and
// their hints follow it: vault-info sets the vault's description for an admin (text every AI connection's
// instructions carry), and attachment-url uploads for a writer. The checks lean on what the door shows and does
// (which tools each level sees, which calls it refuses), not on a copy of the table.
// Red before T-456: no tool carried annotations (`tools/list` had none).
import { describe, expect, test } from "bun:test";
import { accountToken, door, fp, lacks, mcp, rest } from "./_door.ts";

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
    // A reader can change nothing, so every tool it sees is read-only for it.
    for (const t of read) expect({ tool: t.name, readOnly: t.annotations?.readOnlyHint }).toEqual({ tool: t.name, readOnly: true });
    fp("annotations/read-only.tools", read.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort());
    fp("annotations/destructive.tools", admin.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort());
  });

  test("a tool's hints follow what the connection can do with it: vault-info changes the vault for an admin only, attachment-url for a writer", async () => {
    const hint = (tools: Tool[], name: string) => tools.find((t) => t.name === name)?.annotations?.readOnlyHint;
    const [read, write, admin] = [await listed("read"), await listed("write"), await listed("admin")];
    const before = (await rest("read").get("/vault")).body.description;
    // A writer may not set the description: vault-info is a read for it.
    const w = await mcp("write");
    try {
      const refused = await w.call("vault-info", { description: "set by a writer" }).then(() => null, (e: Error) => e.message);
      expect(refused).toMatch(/admin/);
    } finally {
      await w.close();
    }
    expect((await rest("read").get("/vault")).body.description).toBe(before);
    expect({ write: hint(write, "vault-info"), read: hint(read, "vault-info") }).toEqual({ write: true, read: true });
    // An admin may, and the next connection's instructions carry it: so for an admin it is not read-only.
    const a = await mcp("admin");
    try {
      await a.call("vault-info", { description: "set by an admin" });
      expect((await rest("read").get("/vault")).body.description).toBe("set by an admin");
    } finally {
      await a.call("vault-info", { description: before ?? null }).catch(() => {}); // later files read the door's description
      await a.close();
    }
    expect((await rest("read").get("/vault")).body.description).toBe(before);
    expect(admin.find((t) => t.name === "vault-info")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    // A reader is refused an upload ticket, so attachment-url only downloads for it; a writer's adds a file.
    const r = await mcp("read");
    try {
      const upload = await r.call("attachment-url", { action: "upload", record: "nowhere", filename: "a.txt", size_bytes: 3 }).then(() => null, (e: Error) => e.message);
      expect(upload).toMatch(/write|Forbidden/i);
    } finally {
      await r.close();
    }
    expect({ read: hint(read, "attachment-url"), write: hint(write, "attachment-url") }).toEqual({ read: true, write: false });
  });

  // The box's account door (`/account/mcp` with an account credential, the five tools below): a door without it is
  // named in deliberate.json (multi-vault-door). Cloud's own account door carries hints too, held by its own tests.
  test.skipIf(lacks("multi-vault-door"))("the account door's tools carry them too, and a vault tool keeps the vault's own", async () => {
    const d = door();
    const tools = await listed("admin", { url: `${d.issuer}/account/mcp`, bearer: await accountToken() });
    expect(tools.length).toBeGreaterThan(0);
    expectHints("account", tools);
    const byName = new Map(tools.map((t) => [t.name, t]));
    // The owner sees all five of the account door's own tools.
    for (const n of ["list-vaults", "list-access", "create-vault", "grant-access", "revoke-access"]) expect({ tool: n, listed: byName.has(n) }).toEqual({ tool: n, listed: true });
    for (const n of ["list-vaults", "list-access"]) expect({ tool: n, readOnly: byName.get(n)!.annotations?.readOnlyHint }).toEqual({ tool: n, readOnly: true });
    for (const n of ["create-vault", "grant-access", "revoke-access"]) expect({ tool: n, readOnly: byName.get(n)!.annotations?.readOnlyHint }).toEqual({ tool: n, readOnly: false });
    const vault = new Map((await listed("admin")).map((t) => [t.name, t]));
    for (const t of tools) {
      const own = vault.get(t.name);
      if (own) expect({ tool: t.name, hints: t.annotations }).toEqual({ tool: t.name, hints: own.annotations });
    }
    fp("annotations/account.read-only.tools", tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort());
  });
});
