// The MCP description budget (T-318 design §4): what an agent reads before its first call. A writer session's whole
// tool list stays under 4,000 tokens, query-notes under 1,500, every other tool under 400, and the server instructions
// under 800 beyond the vault's own description. Tokens are counted as characters / 4, as the design measured them.
// Short descriptions shipped only after evals/mcp-tasks showed no loss; nothing is lost from the reference
// (vault-info {help}), and a misused parameter gets its one-line fix.
// Runs on the candidate (0.9 behaviour); today's pinned vault sends about 15.6k tokens to a writer.
import { describe, expect, test } from "bun:test";
import { mcp, pass, services } from "../lib.ts";

const tokens = (x: unknown) => Math.ceil((typeof x === "string" ? x : JSON.stringify(x)).length / 4);

async function session(level: "read" | "write" | "admin") {
  const s = services();
  const c = await mcp(`${s.vaultViaHub}/mcp`, level === "admin" ? s.operatorToken : await pass({ level }));
  const tools = (await c.client.listTools()).tools;
  return { c, tools, instructions: c.client.getInstructions() ?? "" };
}

describe("mcp/budget", () => {
  test("a writer session's tool list is under 4,000 tokens", async () => {
    const { c, tools } = await session("write");
    expect(tools.map((t) => t.name)).toContain("update-note");
    expect(tokens(tools)).toBeLessThanOrEqual(4000);
    await c.close();
  });

  test("query-notes is under 1,500 tokens and every other tool under 400 (admin sees them all)", async () => {
    const { c, tools } = await session("admin");
    const over = tools.map((t) => [t.name, tokens(t)] as const).filter(([name, n]) => n > (name === "query-notes" ? 1500 : 400));
    expect(over).toEqual([]);
    await c.close();
  });

  test("the server instructions are under 800 tokens beyond the vault's description", async () => {
    const { c, instructions } = await session("write");
    expect(instructions.length).toBeGreaterThan(0);
    expect(tokens(instructions)).toBeLessThanOrEqual(800);
    await c.close();
  });

  test("nothing is lost: vault-info {help} returns a tool's full reference", async () => {
    const { c } = await session("write");
    const help = await c.call("vault-info", { help: "query-notes" });
    expect(help.tool).toBe("query-notes");
    expect(Object.keys(help.parameters.properties)).toEqual(expect.arrayContaining(["has_broken_links", "expand_links", "order_by", "created_by", "search_mode"]));
    await c.close();
  });

  test("errors teach: a misused or unknown parameter names the fix", async () => {
    const { c } = await session("write");
    await expect(c.call("query-notes", { near: { id: "Anything" } })).rejects.toThrow(/near takes \{note_id\}, not \{id\}/);
    await expect(c.call("query-notes", { tags: "anything" })).rejects.toThrow(/no parameter `tags`.*Did you mean `tag`/);
    await expect(c.call("update-note", { note_id: "x", append: "y" })).rejects.toThrow(/Did you mean `id`/);
    // A rare parameter left out of the short schema is still accepted.
    const r = await c.call("query-notes", { has_links: false, limit: 1 });
    expect(Array.isArray(r) || Array.isArray(r.notes)).toBe(true);
    await c.close();
  });
});
