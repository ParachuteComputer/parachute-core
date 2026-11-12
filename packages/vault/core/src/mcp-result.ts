/**
 * What a successful `tools/call` answers, at every door: the content blocks, and `structuredContent` where a client
 * needs it.
 *
 * Why `structuredContent` (T-456, proven 11-12 in ChatGPT against a door through a rewriting proxy): ChatGPT reads a
 * JSON text block whose object has a top-level `content` key as `{}`. A note read by id (`query-notes`,
 * `create-note`, `update-note`) is exactly that: its text is `content`. 0.8 and 0.9 both fail; `query-records`, whose
 * text is `body`, reads fine, and renaming the key alone fixes it, which old scripts can't take. Sending the same
 * object as `structuredContent` (MCP 2025-06-18) fixes it with the text unchanged. ChatGPT then gives the model
 * `structuredContent` alone and drops the other blocks, so a note tool's refresh nudge rides inside it too, as
 * `deprecation.notice` (the nine other old names already carry a `deprecation` field in their JSON).
 *
 * Only for that case: every other reply stays as it was, one block (or a tool's own blocks), no `structuredContent`.
 * Pure: no imports, so the cloud runtime answers the same.
 */

export type McpResultBlock = { type: "text"; text: string } | { type: string; [k: string]: unknown };

export interface McpCallResult {
  [k: string]: unknown; // the MCP SDK's result type is open
  content: McpResultBlock[];
  structuredContent?: Record<string, unknown>;
}

/** A deprecated tool's notice, for `structuredContent` (the same words its second block says). */
export interface ResultDeprecation {
  tool: string;
  use: string;
  removed_in: string;
  notice: string;
}

export interface ResultTool {
  /** The MCP content blocks for a result, when not the one JSON text block. */
  resultContent?: (result: unknown) => McpResultBlock[];
  /** Set on a deprecated tool whose reply carries a refresh nudge. */
  deprecation?: ResultDeprecation;
}

/** True when ChatGPT would read this JSON text as `{}`: a plain object with a top-level `content` key. */
export function readsEmptyInChatGpt(result: unknown): result is Record<string, unknown> {
  return !!result && typeof result === "object" && !Array.isArray(result) && Object.hasOwn(result, "content");
}

export function mcpCallResult(tool: ResultTool, result: unknown): McpCallResult {
  const content: McpResultBlock[] = tool.resultContent
    ? tool.resultContent(result)
    : [{ type: "text", text: JSON.stringify(result, null, 2) }];
  // A reply with an image (read-attachment) keeps its blocks alone: a client that prefers structuredContent would
  // drop the picture.
  if (!readsEmptyInChatGpt(result) || content.some((b) => b.type !== "text")) return { content };
  return { content, structuredContent: tool.deprecation ? { ...result, deprecation: tool.deprecation } : result };
}
