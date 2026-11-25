/**
 * One way to refuse (T-476): every refusal of a `tools/call` on the account door is an `isError` result with
 * `structuredContent {error_type, message, ...fields}`, its one text block that object as JSON, the same shape the
 * vault door answers. A copy of the shape half of the vault's `packages/vault/core/src/mcp-refusal.ts`, which says
 * why; a copy, not an import, for the reason `mcp-error-log.ts` gives. `__tests__/mcp-refusal-parity.test.ts` runs both
 * on the same refusals and fails if they ever answer differently. Change both together.
 */

export interface McpRefusal {
  [k: string]: unknown;
  error_type: string;
  message: string;
}

export interface McpRefusalResult {
  [k: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent: McpRefusal;
  isError: true;
}

export function refusalResult(r: McpRefusal): McpRefusalResult {
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], structuredContent: r, isError: true };
}

export function refusal(error_type: string, message: string, fields: Record<string, unknown> = {}): McpRefusal {
  const out: McpRefusal = { error_type, message };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && k !== "error_type" && k !== "message") out[k] = v;
  return out;
}

const PREFIXES = /^(?:MCP error -?\d+:\s*)?(?:\[[a-z0-9_]+\]\s*)?/;
export const plainMessage = (m: string): string => m.replace(PREFIXES, "");

export const unknownToolRefusal = (name: string): McpRefusal => refusal("unknown_tool", `Unknown tool: ${name}`, { tool: name });

export const internalRefusal = (err: unknown): McpRefusal => refusal("internal_error", `Error: ${err instanceof Error ? err.message : "Unknown error"}`);
