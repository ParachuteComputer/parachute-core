/**
 * The vault's MCP door for protocol revision 2026-07-28 (T-476; Aaron approved the Skills extension on 2026-07-28 connections, 11-24).
 *
 * Claude Code asks an MCP server for skills only on a 2026-07-28 connection (it probes with `server/discover`;
 * code.claude.com/docs/en/mcp, and the 2.1.331 client sends no `skills/list` on an older one). Core's door speaks the
 * 2025 era through SDK 1.x. This file answers the 2026-07-28 requests with SDK v2 (`@modelcontextprotocol/server`),
 * the routing the SDK documents for "keep the existing legacy wiring beside a strict modern endpoint"
 * (`isLegacyRequest`). 2025-era requests never reach this file, so existing clients see no change.
 *
 * Both eras serve the same tools (`toolSurface` in mcp-http.ts) and the same instructions. Only this era adds the
 * Skills extension (mcp-skills.ts). Two SDKs side by side is a step, not the end: the 2025 path moves onto SDK v2 too
 * (`legacy: "stateless"`) and the 1.x wiring goes, one server for both eras (T-476 subtract line, by 12-18).
 */

import { createMcpHandler, isLegacyRequest, McpServer } from "@modelcontextprotocol/server";
import { SkillsExtension, type SkillSource } from "@modelcontextprotocol/server/ext/skills";
import pkg from "../package.json" with { type: "json" };
import type { toolSurface } from "./mcp-http.ts";

export { isLegacyRequest };

export interface ModernDoor {
  serverName: string;
  instruction: string;
  tools: ReturnType<typeof toolSurface>;
  skills: SkillSource;
}

/** The door a request was routed with, handed to the factory through the handler's `authInfo` pass-through. */
const DOOR_KEY = "parachute/door";

let handler: ReturnType<typeof createMcpHandler> | null = null;

/**
 * One handler for the process (it holds open `subscriptions/listen` streams); one server per request, built for that
 * request's vault and key, as the 2025 path does.
 */
function modernHandler(): ReturnType<typeof createMcpHandler> {
  return (handler ??= createMcpHandler(
    (ctx) => {
      const door = ctx.authInfo?.extra?.[DOOR_KEY] as ModernDoor | undefined;
      if (!door) throw new Error("mcp-modern: request reached the handler without its door");
      const mcp = new McpServer(
        { name: door.serverName, version: pkg.version },
        { instructions: door.instruction, capabilities: { tools: {} } },
      );
      // Core's JSON Schemas are typed loosely (Record<string, unknown>); they are the same objects the 2025 path sends.
      // SDK v2 hands the request's envelope (`_meta`: protocol version, client capabilities) to the handler apart from
      // its params; the file argument's `x-mcp-file` mark follows the client's declared capabilities (#164).
      mcp.server.setRequestHandler("tools/list", async (_request, ctx) => ({
        tools: door.tools.list(ctx.mcpReq.envelope) as never,
      }));
      // One way to refuse (core/src/mcp-refusal.ts): the tool layer answers every refusal as an `isError` result with
      // `structuredContent {error_type, message, ...}` and throws none, so this era says them exactly as the 2025 one.
      mcp.server.setRequestHandler("tools/call", async (request) =>
        mcp.server.projectCallToolResult(
          await door.tools.call({ params: request.params as { name: string; arguments?: Record<string, unknown> } }),
          undefined,
        ),
      );
      new SkillsExtension({ source: door.skills }).attach(mcp);
      return mcp;
    },
    // Only modern requests are routed here. JSON replies: the vault sends no progress mid-call.
    { legacy: "reject", responseMode: "json" },
  ));
}

/** Answer one 2026-07-28 request. The caller has already authenticated it (mcp-http.ts `handleScopedMcp`). */
export function handleModernMcp(req: Request, door: ModernDoor, parsedBody?: unknown): Promise<Response> {
  return modernHandler().fetch(req, {
    authInfo: { token: "", clientId: "", scopes: [], extra: { [DOOR_KEY]: door } },
    ...(parsedBody === undefined ? {} : { parsedBody }),
  });
}
