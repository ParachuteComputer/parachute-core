// Every tool an admin is shown has a schema a function-calling API accepts (T-407 review): an array always says what
// its items are. OpenAI's and Gemini's tool validation refuse `{type: "array"}` without `items`, and one bad tool can
// fail a client's whole request, so this covers the relisted note tools and everything else in the list.
import { expect, test } from "bun:test";
import { writeVaultConfig } from "./config.ts";
import { generateScopedMcpTools } from "./mcp-tools.ts";
import { closeAllStores } from "./vault-store.ts";

function arraysWithoutItems(schema: unknown, at: string, out: string[]): string[] {
  if (Array.isArray(schema)) schema.forEach((s, i) => arraysWithoutItems(s, `${at}[${i}]`, out));
  else if (schema && typeof schema === "object") {
    const s = schema as Record<string, unknown>;
    if (s.type === "array" && !("items" in s)) out.push(at);
    for (const [k, v] of Object.entries(s)) arraysWithoutItems(v, `${at}.${k}`, out);
  }
  return out;
}

test("no tool in the list has an array parameter without items", () => {
  const vault = `schemas-${Date.now()}`;
  writeVaultConfig({ name: vault, api_keys: [], created_at: new Date().toISOString() });
  const tools = generateScopedMcpTools(vault, { permission: "full", scopes: ["vault:read", "vault:write", "vault:admin"], legacyDerived: false, scoped_tags: null } as any);
  expect(tools.map((t) => t.name)).toContain("create-note");
  expect(tools.flatMap((t) => arraysWithoutItems(t.inputSchema, t.name, []))).toEqual([]);
  closeAllStores();
});
