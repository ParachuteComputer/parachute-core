/**
 * MCP refusal mapping — no double-wrap (vault#555 fix 6; every refusal is an isError result since T-476).
 *
 * Verified at code: the catch block in `handleMcp` read `err.message` and
 * fed it into a fresh `new McpError(...)`. The MCP SDK's `McpError`
 * constructor bakes `"MCP error <code>: "` into `.message` ITSELF (not just
 * `.toString()`) — confirmed directly against the SDK below. So an already-
 * formed `McpError` reaching that catch block (or a plain error whose
 * `.message` happens to already carry that prefix — e.g. forwarded verbatim
 * from another MCP-speaking service) got double-prefixed:
 * `"MCP error -32602: MCP error -32602: ..."`. The structured
 * `data.error_type` was always correct — only the human-readable `message`
 * string could double.
 *
 * `handleMcp` (the underlying dispatcher `handleScopedMcp` wraps) is
 * exported specifically so a test can inject a synthetic failing tool and
 * exercise the exact catch-block path without needing a real domain error
 * class that happens to throw an `McpError` naturally (none of core's tools
 * do — `McpError` is only ever constructed inside `mcp-http.ts` itself).
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { handleMcp } from "./mcp-http.ts";
import { docsMinor, docsPageUrl, refusalTopic } from "../core/src/docs-tool.ts";
import pkg from "../package.json" with { type: "json" };
import { plainMessage, refusalOfError, refusalOfReply } from "../core/src/mcp-refusal.ts";
import { generateMcpTools, type McpToolDef } from "../core/src/mcp.ts";
import { SqliteStore } from "../core/src/store.ts";
import type { AuthResult } from "./auth.ts";

interface ToolErrorResponse {
  error?: unknown;
  result: { isError: true; structuredContent: { error_type: string; message: string; [k: string]: unknown } };
}

function toolsWith(execute: (params: Record<string, unknown>) => unknown): () => McpToolDef[] {
  return () => [
    {
      name: "boom",
      description: "throws whatever `execute` throws",
      inputSchema: { type: "object", properties: {} },
      requiredVerb: "read",
      execute,
    },
  ];
}

function fullAuth(): AuthResult {
  return {
    permission: "full",
    scopes: ["vault:v:read", "vault:v:write", "vault:v:admin"],
    legacyDerived: false,
    scoped_tags: null,
    vault_name: null,
    caller_jti: null,
    actor: "test-user",
    via: "api",
  };
}

async function callBoom(execute: (params: Record<string, unknown>) => unknown): Promise<any> {
  const req = new Request("http://localhost:1940/vault/v/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "boom", arguments: {} },
    }),
  });
  const res = await handleMcp(req, toolsWith(execute), "test-server", "v", fullAuth(), "");
  return res.json();
}

async function callNoteToolWithoutId(
  name: "update-note" | "delete-note",
): Promise<ToolErrorResponse> {
  const db = new Database(":memory:");
  try {
    const store = new SqliteStore(db);
    const req = new Request("http://localhost:1940/vault/v/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: {} },
      }),
    });
    const res = await handleMcp(req, () => generateMcpTools(store), "test-server", "v", fullAuth(), "");
    return (await res.json()) as ToolErrorResponse;
  } finally {
    db.close();
  }
}

describe("MCP SDK McpError — confirms the mechanics this fix depends on", () => {
  test("the SDK bakes the JSON-RPC prefix into .message itself, not just .toString()", () => {
    const err = new McpError(ErrorCode.InvalidParams, "bad stuff happened", { error_type: "invalid_query" });
    expect(err.message).toBe("MCP error -32602: bad stuff happened");
    // Naive re-wrap (the pre-fix behavior) doubles it — this is the exact
    // bug, reproduced directly against the SDK class.
    const naiveRewrap = new McpError(ErrorCode.InvalidParams, err.message, { error_type: "invalid_query" });
    expect(naiveRewrap.message).toBe("MCP error -32602: MCP error -32602: bad stuff happened");
  });
});

describe("refusalOfError — the one mapping from a thrown error to a refusal (T-476)", () => {
  test("delete's partial failure keeps what was done and what failed, so a retry can name the rest", () => {
    const err = Object.assign(new Error("2 of 3 deleted"), { error_type: "partial_failure", done: ["a", "b"], failed: [{ id: "c", error: "x" }], missing: ["d"] });
    expect(refusalOfError(err)).toEqual({ error_type: "partial_failure", message: "2 of 3 deleted", done: ["a", "b"], failed: [{ id: "c", error: "x" }], missing: ["d"] });
  });
  test("a plain message with an error_type carries no prefix", () => {
    expect(refusalOfError(Object.assign(new Error("bad stuff happened"), { error_type: "invalid_query", field: "limit" }))).toEqual({
      error_type: "invalid_query", message: "bad stuff happened", field: "limit",
    });
  });

  test("a message that carries the JSON-RPC prefix and an [error_type] token is stripped of both, once", () => {
    const r = refusalOfError(Object.assign(new Error("MCP error -32602: [invalid_query] bad stuff happened"), { error_type: "invalid_query" }));
    expect(r?.message).toBe("bad stuff happened");
    expect(plainMessage("MCP error -32602: MCP error -32602: x")).toBe("MCP error -32602: x");
  });

  test("an McpError already formed: its data is the refusal's fields, its message loses the SDK prefix", () => {
    const err = new McpError(ErrorCode.InvalidParams, "bad stuff happened", { error_type: "invalid_query", hint: "h" });
    expect(err.message).toBe("MCP error -32602: bad stuff happened");
    expect(refusalOfError(err)).toEqual({ error_type: "invalid_query", message: "bad stuff happened", hint: "h" });
  });

  test("an error nobody tagged is not a refusal (the door logs it as a crash)", () => {
    expect(refusalOfError(new Error("something broke"))).toBeNull();
  });

  test("a tool's reply that says `error` is a refusal; `error` becomes error_type and the other fields stay", () => {
    expect(refusalOfReply({ error: "Note not found", error_type: "not_found", id: "n1" })).toEqual({ error_type: "not_found", message: "Note not found", id: "n1" });
    expect(refusalOfReply({ action: "mint", ok: false, error: "invalid_request", message: "ttl too big" })).toEqual({
      error_type: "invalid_request", message: "ttl too big", action: "mint", ok: false,
    });
    expect(refusalOfReply({ error: "Forbidden", message: "no" })).toEqual({ error_type: "forbidden", message: "no" });
    expect(refusalOfReply({ id: "n1" })).toBeNull();
  });
});

/** T-476: every refusal carries `docs`, the page with its fix for this box's version (core/src/docs-tool.ts). */
const docsFor = (type: string) => docsPageUrl({ origin: "https://parachute.computer", version: pkg.version }, refusalTopic(type));

describe("handleMcp refusals — end to end (vault#555 fix 6, T-476)", () => {
  test("a tool throwing an ALREADY-formed McpError is an isError refusal: no prefix, data preserved verbatim as fields", async () => {
    const inner = new McpError(ErrorCode.InvalidRequest, "conflict: note was modified", {
      error_type: "conflict",
      note_id: "abc123",
      hint: "re-read and retry",
    });
    const body = await callBoom(() => {
      throw inner;
    });
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    // Neither "MCP error -32600:" nor a doubled prefix.
    expect(body.result.structuredContent.message).toBe("conflict: note was modified");
    expect(body.result.structuredContent).toEqual({
      error_type: "conflict",
      message: "conflict: note was modified",
      note_id: "abc123",
      hint: "re-read and retry",
      docs: docsFor("conflict"),
    });
    expect(JSON.parse(body.result.content[0].text)).toEqual(body.result.structuredContent);
  });

  test("a plain domain error (never wrapped) is mapped once: error_type, plain message, its fields", async () => {
    const body = await callBoom(() => {
      throw Object.assign(new Error("something went wrong"), { error_type: "invalid_query", field: "limit" });
    });
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.message).toBe("something went wrong");
    expect(body.result.structuredContent.error_type).toBe("invalid_query");
    expect(body.result.structuredContent.field).toBe("limit");
  });

  test("invalid_query forwards how_to (vault#617 bun/cloud symmetry)", async () => {
    const body = await callBoom(() => {
      throw Object.assign(new Error("size_bytes must be a positive number"), {
        error_type: "invalid_query",
        field: "size_bytes",
        how_to: "pass the exact byte length of the file you're about to upload",
      });
    });
    expect(body.result.structuredContent.error_type).toBe("invalid_query");
    expect(body.result.structuredContent.how_to).toBe("pass the exact byte length of the file you're about to upload");
  });

  test("a tool that returns `{error, error_type, ...}` as data is answered as a refusal with its other fields", async () => {
    const body = await callBoom(() => ({ error: "Note not found", error_type: "not_found", id: "n1" }));
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent).toEqual({ error_type: "not_found", message: "Note not found", id: "n1", docs: docsFor("not_found") });
  });

  test("a truly unknown error (no error_type anywhere) is an internal_error refusal, not a thrown McpError", async () => {
    const body = await callBoom(() => {
      throw new Error("plain unstructured failure");
    });
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent).toEqual({ error_type: "internal_error", message: "Error: plain unstructured failure", docs: docsFor("internal_error") });
    expect(body.result.content[0].text).toContain("plain unstructured failure");
  });

  test("an unknown tool is an unknown_tool refusal naming the tool", async () => {
    const req = new Request("http://localhost:1940/vault/v/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope", arguments: {} } }),
    });
    const body: any = await (await handleMcp(req, toolsWith(() => ({})), "test-server", "v", fullAuth(), "")).json();
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent).toEqual({
      error_type: "unknown_tool",
      // T-476: the caller's own level, the same words whether the tool exists above it or not at all
      message: "Unknown tool: nope. tools/list names every tool this connection has.",
      tool: "nope",
      docs: "https://parachute.computer/docs/v/" + docsMinor(pkg.version) + "/fix/needs-admin/",
    });
  });
});

describe("note mutation tools require an id (vault#705)", () => {
  for (const name of ["update-note", "delete-note"] as const) {
    test(`${name} without id returns structured invalid params, never a TypeError`, async () => {
      const body = await callNoteToolWithoutId(name);

      expect(body.error).toBeUndefined();
      expect(body.result.isError).toBe(true);
      expect(body.result.structuredContent).toMatchObject({
        error_type: "missing_required_field",
        field: "id",
        hint: expect.stringContaining("path"),
      });
      expect(body.result.structuredContent.message).not.toContain("TypeError");
      expect(body.result.structuredContent.message).not.toContain("idOrPath.match");
    });
  }
});

// T-456: a tool's MCP annotations follow what the connection can do with it. vault-info sets the vault-wide
// description only for an admin with no tag scope (mcp-tools.ts refuses a tag-scoped one), so for a tag-scoped admin
// it must not say it changes things, and for a plain admin it must not say read-only.
describe("tools/list annotations follow the caller's level", () => {
  const tools = () => [
    { name: "vault-info", description: "d", inputSchema: { type: "object", properties: {} }, requiredVerb: "read" as const, execute: () => ({}) },
  ];
  async function vaultInfoHints(auth: AuthResult): Promise<Record<string, unknown> | undefined> {
    const req = new Request("http://localhost:1940/vault/v/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const res: any = await (await handleMcp(req, tools, "test-server", "v", auth, "")).json();
    return res.result.tools.find((t: { name: string }) => t.name === "vault-info")?.annotations;
  }

  test("an admin's vault-info is a change; a tag-scoped admin's, like a writer's, is read-only", async () => {
    expect((await vaultInfoHints(fullAuth()))?.readOnlyHint).toBe(false);
    expect((await vaultInfoHints({ ...fullAuth(), scoped_tags: ["work"] }))?.readOnlyHint).toBe(true);
    expect((await vaultInfoHints({ ...fullAuth(), scopes: ["vault:v:read", "vault:v:write"] }))?.readOnlyHint).toBe(true);
  });
});
