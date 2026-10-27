// What every contract file shares: where the services are, a small REST client, made-up test data.
// Contracts only speak HTTP and MCP. Nothing here imports vault or hub code.
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mintToken, type Services } from "../harness/services.ts";
import { allowOrigins, safeFetch } from "../harness/guard.ts";

export { safeFetch };

export type { Services };

export function services(): Services {
  const path = process.env.CONTRACT_SERVICES;
  if (!path) throw new Error("CONTRACT_SERVICES is not set: run the suite with `bun run today` (harness/run.ts)");
  const s: Services = JSON.parse(readFileSync(path, "utf8"));
  // Only these two may ever be called; see harness/guard.ts.
  allowOrigins(s.hub, s.vaultDirect);
  return s;
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
    const r = await safeFetch(`${base}/api${path}`, {
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
    fetch: safeFetch,
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

// ── v0.8 contracts that today's code fails ──────────────────────────────────────────────────────────────────

/** Fail with a reason a red contract can be matched on. Prefer this to a bare expect() in `red` contracts. */
export function must(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(reason);
}

/**
 * A contract v0.8 must meet and today's code doesn't, red for a stated reason.
 *
 * It passes only while the body fails with an error matching `reason`. If the body passes, it fails ("now green":
 * the lane that made it pass removes `red` in the same pull request). If the body fails for another reason (a broken
 * setup, a different bug), it fails too, so an expected failure can't hide one. In a release run
 * (CONTRACT_RELEASE=1) every `red` contract runs as a plain test: release suites can't contain expected failures.
 * RED_SHOW=1 also runs them plainly, to read why each fails.
 */
export function red(
  name: string,
  opts: { reason: RegExp; lane: string },
  fn: () => Promise<unknown> | unknown,
  timeout?: number,
): void {
  const label = `${name} [red today; lane ${opts.lane}]`;
  if (process.env.CONTRACT_RELEASE === "1" || process.env.RED_SHOW === "1") {
    test(label, fn as any, timeout);
    return;
  }
  test(
    label,
    async () => {
      let err: unknown = null;
      try {
        await fn();
      } catch (e) {
        err = e ?? new Error("thrown: " + String(e));
      }
      if (!err) throw new Error(`now green: "${name}" passes. Remove red() and move it on (lane ${opts.lane}).`);
      const msg = err instanceof Error ? err.message : String(err);
      if (!opts.reason.test(msg)) {
        throw new Error(`red for the wrong reason: expected ${opts.reason}, got: ${msg.slice(0, 1200)}`);
      }
    },
    timeout,
  );
}
