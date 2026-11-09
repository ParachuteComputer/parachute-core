/**
 * The hub's MCP crash line is a copy of the vault's (audit L6-02; see ../mcp-error-log.ts for why a copy). One
 * search for `event=mcp_tool_error` must find the same line from either, so both run on the same thrown values here
 * and must print the same thing. A test-only reach into the vault's source: tests run in the monorepo, never ship.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as hub from "../mcp-error-log.ts";

// Imported only when the vault sits beside the hub (this repo), so a hub checked out on its own still runs.
const VAULT_COPY = join(import.meta.dir, "../../../vault/core/src/mcp-error-log.ts");
const vault: typeof hub | null = existsSync(VAULT_COPY) ? await import(VAULT_COPY) : null;

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("did not throw");
}

const withFrames = new TypeError("first line\nat not-a-frame");
withFrames.stack = `TypeError: ${withFrames.message}\n${Array.from(
  { length: 12 },
  (_, i) => `    at f${i} (/x/src/a.ts:${i}:1)`,
).join("\n")}\n    at Array.map (<anonymous>)\n    at run (native:7:39)`;

const hostile = new Proxy(
  {},
  {
    get() {
      throw new Error("getter throws");
    },
  },
);

const cases: Array<[string, unknown]> = [
  ["a real TypeError", thrown(() => (123 as unknown as { replace: () => void }).replace())],
  [
    "V8's JSON.parse wording (quotes its input)",
    new SyntaxError(`Unexpected token 'x', "private text" is not valid JSON`),
  ],
  ["quotes, newlines and an apostrophe", new Error(`Can't read 'a'\n  and "b" or \`c\` or "open`)],
  ["a long message", new RangeError("x".repeat(500))],
  ["frames, a message line that looks like one", withFrames],
  ["a thrown string", "private text"],
  ["null", null],
  ["a Proxy whose getters throw", hostile],
  ["an apostrophe inside a quoted span", new Error("Note 'Bob's private text' not found")],
  ["an escaped quote and a trailing backslash", new Error('bad "a\\"private text" C:\\')],
  [
    "V8's JSON.parse of JSON with its own quotes",
    new SyntaxError(`Unexpected token 'x', "[10,"private text",x]" is not valid JSON`),
  ],
  ["a surrogate pair at the cut", new Error(`${"x".repeat(199)}😀`)],
  ["an unclosed quote into a trailing backslash", new Error('Path "C:\\private text\\')],
  ["typographic quotes", new Error("name: ‘private text’ “private text” «private text»")],
];

describe.skipIf(!vault)("the hub's crash line matches the vault's", () => {
  for (const [label, err] of cases) {
    test(label, () => {
      const line = hub.mcpToolErrorLine("create-note", err, "0.8.0-pre.3");
      expect(line).toBe(vault!.mcpToolErrorLine("create-note", err, "0.8.0-pre.3"));
      expect(line.startsWith("event=mcp_tool_error tool=create-note class=")).toBe(true);
      expect(line).not.toContain("private text");
    });
  }
});
