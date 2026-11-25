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

import { createMcpHandler, isLegacyRequest, McpServer, ProtocolError } from "@modelcontextprotocol/server";
import { SkillsExtension, type SkillSource } from "@modelcontextprotocol/server/ext/skills";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import pkg from "../package.json" with { type: "json" };
import type { toolSurface } from "./mcp-http.ts";

export { isLegacyRequest };

const MCP_ERROR_PREFIX_RE = /^MCP error -?\d+:\s*/;

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
      mcp.server.setRequestHandler("tools/list", async () => ({ tools: door.tools.list() as never }));
      mcp.server.setRequestHandler("tools/call", async (request) => {
        try {
          const result = await door.tools.call({
            params: request.params as { name: string; arguments?: Record<string, unknown> },
          });
          return mcp.server.projectCallToolResult(result, undefined);
        } catch (err) {
          // The tool layer throws SDK 1.x errors (domain refusals with `data.error_type`); say them in v2's type so the
          // code and data reach the client as they do on the 2025 path.
          if (err instanceof McpError) throw new ProtocolError(err.code, err.message.replace(MCP_ERROR_PREFIX_RE, ""), err.data);
          throw err;
        }
      });
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
