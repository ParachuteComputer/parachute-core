// The MCP server the model under test talks to (stdio). It shows the model one arm's tool descriptions and forwards
// every call, unchanged, to the box's real vault MCP, logging each call and its result for the oracles.
//
//   bun proxy.ts vault <old|new> <upstream mcp url> <token file> <log.jsonl>
//     old: tools/list and instructions from old/tools.json (main at ccc7729, before the short descriptions)
//     new: whatever this checkout's vault serves
//   bun proxy.ts files <log.jsonl>
//     one helper tool, `http_request`, so a model can spend an upload URL the way a shell would (the same in both arms)
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { connect } from "./mcp.ts";

const [mode, ...rest] = process.argv.slice(2);

function log(file: string, entry: Record<string, unknown>) {
  appendFileSync(file, JSON.stringify({ t: Date.now(), ...entry }) + "\n");
}

if (mode === "vault") {
  const [arm, url, tokenFile, logFile] = rest as [string, string, string, string];
  const upstream = await connect(url, readFileSync(tokenFile, "utf8").trim());
  let tools: any[];
  let instructions: string | undefined;
  if (arm === "old") {
    const snap = JSON.parse(readFileSync(join(import.meta.dir, "old", "tools.json"), "utf8"));
    tools = snap.tools;
    instructions = snap.instructions;
  } else {
    tools = await upstream.listTools();
    instructions = upstream.instructions;
  }
  const server = new Server({ name: "vault", version: "0.0.0" }, { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      const r: any = await upstream.raw(name, args as Record<string, unknown>);
      const text = (r.content ?? []).map((c: any) => c.text ?? "").join("");
      log(logFile, { server: "vault", name, args, isError: !!r.isError, result: text.slice(0, 20_000), resultChars: text.length });
      return r;
    } catch (err) {
      const text = String((err as Error)?.message ?? err);
      log(logFile, { server: "vault", name, args, isError: true, result: text, resultChars: text.length, protocolError: true });
      return { content: [{ type: "text", text }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
} else if (mode === "files") {
  const [logFile] = rest as [string];
  const server = new Server({ name: "files", version: "0.0.0" }, { capabilities: { tools: {} } });
  const httpTool = {
    name: "http_request",
    description: "Make an HTTP request, like curl. The body can be a local file's bytes (file_path) or text (body). Returns the status and up to 2,000 characters of the response body.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", description: "GET, PUT, POST, …" },
        url: { type: "string" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        file_path: { type: "string", description: "Send this local file's bytes as the body" },
        body: { type: "string", description: "Send this text as the body" },
      },
      required: ["method", "url"],
    },
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [httpTool] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const a = (req.params.arguments ?? {}) as { method: string; url: string; headers?: Record<string, string>; file_path?: string; body?: string };
    try {
      const u = new URL(a.url);
      // Only the box (loopback, never the live install's ports).
      if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") throw new Error("only the vault's own host is reachable from this eval");
      if (Number(u.port) >= 1939 && Number(u.port) <= 1946) throw new Error("refused: a live Parachute port");
      const body = a.file_path ? readFileSync(a.file_path) : a.body;
      const r = await fetch(u, { method: a.method, headers: a.headers, body, redirect: "manual" });
      const text = await r.text();
      log(logFile, { server: "files", name: "http_request", args: { ...a, body: a.body ? `<${a.body.length} chars>` : undefined }, status: r.status, isError: false });
      return { content: [{ type: "text", text: `HTTP ${r.status}\n${text.slice(0, 2000)}` }] };
    } catch (err) {
      log(logFile, { server: "files", name: "http_request", args: a, isError: true, result: String(err) });
      return { content: [{ type: "text", text: String((err as Error)?.message ?? err) }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
} else {
  throw new Error("usage: bun proxy.ts vault <old|new> <url> <token file> <log> | files <log>");
}
