/**
 * Streamable HTTP MCP transport — stateless mode.
 *
 * Each request gets a fresh transport+server pair with no session ID
 * generator. The SDK skips session validation when sessionIdGenerator
 * is undefined, so clients can send `tools/call` or `tools/list`
 * directly without a prior `initialize` handshake.
 *
 * This means server restarts never break existing MCP clients — the
 * root cause of vault#56. The `initialize` method still works if a
 * client sends it (the Server class handles it natively).
 *
 * Every MCP session is scoped to one vault via `/vault/{name}/mcp`.
 * The vault's description is sent as the MCP server instruction, and
 * read-only keys see a filtered tool list.
 */

import { NOTE_TOOL_NAMES } from "../core/src/mcp-records.ts";
import { recordErrorData } from "../core/src/mcp-surface.ts";
import { toolAnnotations } from "../core/src/mcp-annotations.ts";
import { mcpCallResult } from "../core/src/mcp-result.ts";
import { internalRefusal, refusalOfError, refusalResult, unknownToolRefusal, type McpRefusal } from "../core/src/mcp-refusal.ts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { generateScopedMcpTools, getServerInstruction } from "./mcp-tools.ts";
import type { AuthResult } from "./auth.ts";
import type { McpToolDef } from "../core/src/mcp.ts";
import { mcpToolErrorLine } from "../core/src/mcp-error-log.ts";
import { declaresFilesExtension, schemaForClient } from "../core/src/attachment/inline.ts";
import { hasScopeForVault } from "./scopes.ts";
import type { VaultVerb } from "./scopes.ts";
import pkg from "../package.json" with { type: "json" };

/**
 * Required verb for an MCP tool. Reads `tool.requiredVerb` from the tool
 * metadata — every core tool stamps this (vault#376) so the filter is data,
 * not a side-table that can drift. The discovery + dispatch paths below
 * call this with the tool object so a future tool that forgets to stamp
 * falls into the default-deny branch.
 *
 * Default-deny: unknown tools require `write`. Keeps accidental reads of
 * a not-yet-mapped mutation tool from slipping past. (`admin` would be
 * safer-still but would refuse vault-info-style read tools to write-scope
 * callers; `write` is the right middle ground.)
 */
function requiredVerbForTool(tool: { requiredVerb?: VaultVerb }): VaultVerb {
  return tool.requiredVerb ?? "write";
}

/** A record tool's refusal in record words: the hints this door adds, and `record_id` for `note_id` (T-407). The
 *  message is already in record words (the record tool's errorOut). */
function recordRefusal(r: McpRefusal): McpRefusal {
  const { error_type, message, ...rest } = r;
  return { error_type, message, ...recordErrorData(rest) };
}

/**
 * Handle scoped MCP at /vault/{name}/mcp (single vault).
 *
 * `callerBearer` is the RAW credential the session presented (from
 * `extractApiKey`). It's threaded into `generateScopedMcpTools` so the
 * manage-token tool can forward it to hub's mint-token attenuation proxy
 * (vault#403, MGT). NULL when the request carried no bearer (auth would have
 * already rejected) — the tool treats a missing/non-JWT bearer as
 * non-forwardable and returns a clear error on mint.
 */
export async function handleScopedMcp(
  req: Request,
  vaultName: string,
  auth: AuthResult,
  callerBearer?: string | null,
): Promise<Response> {
  // Auth flows through to getServerInstruction so the connect-time
  // markdown brief is filtered by `scoped_tags` — symmetric with the
  // JSON `vault-info` wrapper.
  const instruction = await getServerInstruction(vaultName, auth);
  return handleMcp(
    req,
    () => generateScopedMcpTools(vaultName, auth, callerBearer ?? null, req),
    `parachute-vault/${vaultName}`,
    vaultName,
    auth,
    instruction,
  );
}

/** Exported for direct testing (vault#555 fix 6) — lets a test inject a
 *  synthetic failing tool to exercise the `err instanceof McpError` guard
 *  without needing a real domain error class to construct one naturally. */
export async function handleMcp(
  req: Request,
  getTools: () => McpToolDef[],
  serverName: string,
  vaultName: string,
  auth: AuthResult,
  instruction: string,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  const server = new Server(
    { name: serverName, version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: instruction,
    },
  );

  const mcpTools = getTools();

  // Filter the advertised tool list to what the caller's scopes actually
  // permit for THIS vault. Callers without write don't see mutation tools at
  // all — matches the prior behavior of the read/full permission model but
  // now driven by per-vault scope inheritance. With manage-token (vault#376)
  // requiring `admin`, callers without admin don't see it at all — the AI
  // never knows it could mint child tokens, eliminating that escalation
  // vector by listing.
  const visibleTools = mcpTools.filter((t) =>
    hasScopeForVault(auth.scopes, vaultName, requiredVerbForTool(t)),
  );

  // The caller's level here: two tools reach further at a higher one (mcp-annotations.ts BY_LEVEL). A tag-scoped admin
  // can't set the vault-wide description, so for the hints it counts as a writer.
  const tagScoped = (auth.scoped_tags?.length ?? 0) > 0;
  const level = hasScopeForVault(auth.scopes, vaultName, "admin") && !tagScoped ? "admin" : hasScopeForVault(auth.scopes, vaultName, "write") ? "write" : "read";
  server.setRequestHandler(ListToolsRequestSchema, async (request) => ({
    tools: visibleTools.map((t) => ({
      name: t.name,
      description: t.description,
      // T-476: a file argument is marked `x-mcp-file` only for a client that declared the file-transfer extension.
      inputSchema: schemaForClient(t.inputSchema, declaresFilesExtension(request.params?._meta)),
      annotations: toolAnnotations(t.name, level), // T-456: a client can tell a read from a change (mcp-annotations.ts)
    })),
  }));

  // One way to refuse (core/src/mcp-refusal.ts): every refusal is an `isError` result with `structuredContent
  // {error_type, message, ...}`, never a JSON-RPC error. A record tool's is said in its own words (T-407).
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // Dispatch against the FILTERED tool list: a tool the caller can't see in `tools/list` can't be called either
    // (vault#376), and the refusal is the same as for a tool that doesn't exist, so nothing leaks.
    const tool = visibleTools.find((t) => t.name === name);
    if (!tool) return refusalResult(unknownToolRefusal(name));
    try {
      // `resultContent`, when a tool defines it, decides the content blocks (read-attachment's image, the note
      // aliases' nudge); mcpCallResult adds `structuredContent` where a client needs it (T-456), and answers a refusal
      // a tool said as data (`{error, error_type}`) as a refusal.
      return mcpCallResult(tool, await tool.execute((args ?? {}) as Record<string, unknown>));
    } catch (err) {
      const r = refusalOfError(err);
      if (r) return refusalResult(NOTE_TOOL_NAMES[name] ? recordRefusal(r) : r);
      // Nobody tagged this error, so it is a crash, not a refusal (audit L6-02): one server-log line, no arguments.
      console.error(mcpToolErrorLine(name, err, pkg.version));
      return refusalResult(internalRefusal(err));
    }
  });

  await server.connect(transport);
  return transport.handleRequest(req);
}
