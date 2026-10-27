// What every contract file shares: where the services are, a small REST client, made-up test data.
// Contracts only speak HTTP and MCP. Nothing here imports vault or hub code.
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { mintToken, type Services } from "../harness/services.ts";

export type { Services };

export function services(): Services {
  const path = process.env.CONTRACT_SERVICES;
  if (!path) throw new Error("CONTRACT_SERVICES is not set: run the suite with `bun run today` (harness/run.ts)");
  return JSON.parse(readFileSync(path, "utf8"));
}

/** A unique prefix per test run, so contracts never see each other's notes. */
export function runId(label: string): string {
  return `${label}-${randomBytes(4).toString("hex")}`;
}

export interface Reply<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

/** REST against one vault. `base` is either the vault directly or the vault behind the hub. */
export function rest(base: string, token: string) {
  async function call<T = any>(method: string, path: string, body?: unknown): Promise<Reply<T>> {
    const r = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {}
    return { status: r.status, body: parsed as T, headers: r.headers };
  }
  return {
    call,
    get: <T = any>(p: string) => call<T>("GET", p),
    post: <T = any>(p: string, b: unknown) => call<T>("POST", p, b),
    patch: <T = any>(p: string, b: unknown) => call<T>("PATCH", p, b),
    put: <T = any>(p: string, b: unknown) => call<T>("PUT", p, b),
    del: <T = any>(p: string) => call<T>("DELETE", p),
  };
}

export const enc = encodeURIComponent;

/** The operator's client, through the hub (the door real clients use). */
export function operator() {
  const s = services();
  return rest(s.vaultViaHub, s.operatorToken);
}

/** A hub-signed pass for this vault, minted the way operators do today. */
export async function pass(opts: { level: "read" | "write" | "admin"; tags?: string[] }): Promise<string> {
  const s = services();
  const levels = { read: ["read"], write: ["read", "write"], admin: ["read", "write", "admin"] }[opts.level];
  return mintToken(s, {
    scope: levels.map((l) => `vault:${s.vaultName}:${l}`).join(" "),
    permissions: opts.tags ? { scoped_tags: opts.tags } : undefined,
    label: `contracts-${opts.level}`,
  });
}

export function paths(notes: { path?: string }[]): string[] {
  return notes.map((n) => n.path ?? "").sort();
}

/** An MCP client, using the official SDK the way consumer apps do. */
export async function mcp(url: string, token: string) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "parachute-contracts", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return {
    client,
    async tools(): Promise<string[]> {
      return (await client.listTools()).tools.map((t) => t.name).sort();
    },
    /** Call a tool; returns the parsed JSON result, or throws with the tool's error text. */
    async call<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
      const r: any = await client.callTool({ name, arguments: args });
      const text = (r.content ?? []).map((c: any) => c.text ?? "").join("");
      if (r.isError) throw new Error(`${name}: ${text}`);
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as T;
      }
    },
    close: () => client.close(),
  };
}
