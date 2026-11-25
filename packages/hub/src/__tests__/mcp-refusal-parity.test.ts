/**
 * The account door's refusal shape is a copy of the vault door's (../mcp-refusal.ts says why). An app that reads one
 * must read the other, so both build the same refusals here and must answer the same bytes. A test-only reach into
 * the vault's source: tests run in the monorepo, never ship.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as hub from "../mcp-refusal.ts";

const VAULT_COPY = join(import.meta.dir, "../../../vault/core/src/mcp-refusal.ts");
const vault: typeof hub | null = existsSync(VAULT_COPY) ? await import(VAULT_COPY) : null;

const cases: Array<[string, (m: typeof hub) => unknown]> = [
  ["a refusal with fields", (m) => m.refusalResult(m.refusal("vault_taken", "That name is taken.", { vault: "home", hint: undefined }))],
  ["fields can't replace the type or the words", (m) => m.refusal("conflict", "changed", { error_type: "x", message: "y", path: "a" })],
  ["an unknown tool", (m) => m.refusalResult(m.unknownToolRefusal("manage-keys"))],
  ["a crash", (m) => m.refusalResult(m.internalRefusal(new TypeError("x is not a function")))],
  ["a thrown non-error", (m) => m.internalRefusal("text")],
  ["the JSON-RPC and type prefixes", (m) => [m.plainMessage("MCP error -32602: [conflict] changed"), m.plainMessage("[not_found] gone"), m.plainMessage("plain [words]")]],
];

describe.skipIf(!vault)("account door refusals = vault door refusals", () => {
  for (const [name, build] of cases) test(name, () => expect(build(hub)).toEqual(build(vault!)));
  test("the shape", () => {
    expect(hub.refusalResult(hub.refusal("vault_taken", "taken", { vault: "home" }))).toEqual({
      content: [{ type: "text", text: JSON.stringify({ error_type: "vault_taken", message: "taken", vault: "home" }, null, 2) }],
      structuredContent: { error_type: "vault_taken", message: "taken", vault: "home" },
      isError: true,
    });
  });
});
