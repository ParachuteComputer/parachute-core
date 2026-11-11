// What every door contract shares: which door this run talks to, how to hold a credential there, a small REST and
// MCP client, and the fingerprint recorder.
//
// A door is one way of running Parachute that an app can connect to: a box (hub + vault), Parachute Cloud (two
// Cloudflare workers), or a personal Cloudflare door (the same two workers, one owner). These contracts are the same
// file for all of them. They read a door file (CONTRACT_DOOR, made by harness/doors/) and speak only HTTP and MCP:
// no CLI, no database, no service started here. Getting the first credential is the one step that differs between
// doors on purpose, so the door file carries a sign-in (a session cookie, or a made-up owner key) and everything
// after that goes through the account door, which every door has.
import { appendFileSync, readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { allowOrigins, safeFetch } from "../../harness/guard.ts";

export { safeFetch };

export type Level = "read" | "write" | "admin";

export interface Door {
  /** What it is. Only the sign-in and the consent screen may branch on this. */
  kind: "box" | "cloud" | "personal";
  /** A name for results, e.g. "box-0.8". */
  label: string;
  /** The release line, "0.8", "0.9" or "0.9.1" (0.9 with owner keys): which surfaces the door is expected to have. */
  release: string;
  /** The origin that signs credentials and serves /oauth and /account. */
  issuer: string;
  /** The origin that serves /vault/<name>. The same as `issuer` on a box. */
  vaultOrigin: string;
  /** A vault this run owns and may fill and empty. */
  vault: string;
  /** A second vault of the same owner: a credential for `vault` must not open it. */
  otherVault: string;
  /** How this run is signed in as the owner. */
  signIn: { how: "cookie"; cookie: string; csrf: string } | { how: "nostr"; secretKey: string; secretKeyFile?: string };
  /** 0.9.1 doors: a made-up key the owner can sign in with (NIP-98), as hex. On a key-only door it is the sign-in. */
  ownerKey?: string;
  /** Where this run may write its fingerprint (one JSON object per line). */
  fingerprint?: string;
}

let cached: Door | null = null;
export function door(): Door {
  if (cached) return cached;
  const path = process.env.CONTRACT_DOOR;
  if (!path) throw new Error("CONTRACT_DOOR is not set: run the suite with `bun run doors` (harness/doors/run.ts)");
  const d: Door = JSON.parse(readFileSync(path, "utf8"));
  // These contracts make and delete vaults. They run against a door on this machine's loopback, or against a
  // deployed door whose hosts the person running them has named (DOOR_REMOTE_HOSTS), and never Parachute Cloud.
  const named = (process.env.DOOR_REMOTE_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  for (const url of [d.issuer, d.vaultOrigin]) {
    const host = new URL(url).hostname;
    if (/(^|\.)parachute\.computer$/.test(host)) throw new Error(`refused: ${host} is Parachute Cloud; the door contracts never run there`);
    if (host !== "127.0.0.1" && host !== "localhost" && !named.includes(host)) throw new Error(`refused: ${host} is not this machine and is not named in DOOR_REMOTE_HOSTS`);
  }
  // A key kept in a file (a deployed door's made-up owner): read here, so a door file never holds it.
  if (d.signIn.how === "nostr" && !d.signIn.secretKey && d.signIn.secretKeyFile) d.signIn.secretKey = readFileSync(d.signIn.secretKeyFile, "utf8").trim();
  if (!d.ownerKey && d.signIn.how === "nostr") d.ownerKey = d.signIn.secretKey;
  allowOrigins(d.issuer, d.vaultOrigin);
  cached = d;
  return d;
}

export const vaultUrl = (name = door().vault) => `${door().vaultOrigin}/vault/${name}`;
export const mcpUrl = (name = door().vault) => `${vaultUrl(name)}/mcp`;
export const enc = encodeURIComponent;

/** A unique prefix per test file, so contracts never see each other's notes. */
export function runId(label: string): string {
  return `${label}${randomBytes(4).toString("hex")}`;
}

// ── Credentials, through the account door ───────────────────────────────────────────────────────────────────

import { nostrAuthorization as nostrAuth } from "../../harness/doors/workers.ts";

export { nostrAuth };

interface Held {
  token: string;
  until: number;
}
const held = new Map<string, Promise<Held>>();
function expiry(jwt: string): number {
  try {
    const exp = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()).exp;
    if (typeof exp === "number") return exp * 1000;
  } catch {}
  return Date.now() + 60_000;
}
/** Hold a credential until a minute before it ends, then get a new one the same way. */
function hold(key: string, get: () => Promise<string>): Promise<string> {
  const have = held.get(key);
  const fresh = async (): Promise<Held> => {
    const token = await get();
    return { token, until: expiry(token) - 60_000 };
  };
  const p = (have ?? fresh()).then((h) => (h.until > Date.now() ? h : fresh()));
  held.set(key, p);
  p.catch(() => held.delete(key));
  return p.then((h) => h.token);
}

/** POST /account/token as the signed-in owner: the reply, unparsed, for the contract that pins its shape. */
export async function accountTokenReply(): Promise<Response> {
  const d = door();
  const url = `${d.issuer}/account/token`;
  if (d.signIn.how === "nostr") {
    return safeFetch(url, { method: "POST", headers: { authorization: await nostrAuth(d.signIn.secretKey, url, "POST") } });
  }
  const body = JSON.stringify({ __csrf: d.signIn.csrf });
  return safeFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: d.issuer, cookie: d.signIn.cookie, "x-csrf-token": d.signIn.csrf },
    body,
  });
}

/** The owner's account credential (the account door's bearer). */
export function accountToken(): Promise<string> {
  return hold("account", async () => {
    const r = await accountTokenReply();
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || typeof j.token !== "string") throw new Error(`setup: POST /account/token gave ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    return j.token;
  });
}

/** POST /account/vaults/<name>/token: the reply, unparsed. */
export async function vaultTokenReply(name: string, scopes: string[] | undefined): Promise<Response> {
  return safeFetch(`${door().issuer}/account/vaults/${enc(name)}/token`, {
    method: "POST",
    headers: { authorization: `Bearer ${await accountToken()}`, "content-type": "application/json" },
    body: JSON.stringify(scopes === undefined ? {} : { scopes }),
  });
}

/** A credential for one vault at one level, minted the way an app's owner does: through the account door. */
export function token(level: Level, name = door().vault): Promise<string> {
  return hold(`${name}:${level}`, async () => {
    const levels = { read: ["read"], write: ["read", "write"], admin: ["read", "write", "admin"] }[level];
    const r = await vaultTokenReply(name, levels.map((l) => `vault:${name}:${l}`));
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || typeof j.vault_token !== "string") throw new Error(`setup: a ${level} token for ${name} gave ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    return j.vault_token;
  });
}

// ── REST and MCP ────────────────────────────────────────────────────────────────────────────────────────────

export interface Reply<T = any> {
  status: number;
  body: T;
  headers: Headers;
  text: string;
}

/** REST against one vault at one level. `raw` sends a body as it is (multipart, bytes). */
export function rest(level: Level | null, name = door().vault) {
  async function call<T = any>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply<T>> {
    const raw = body instanceof FormData || body instanceof Uint8Array || typeof body === "string";
    const r = await safeFetch(`${vaultUrl(name)}${path}`, {
      method,
      headers: {
        ...(level ? { authorization: `Bearer ${await token(level, name)}` } : {}),
        ...(body === undefined || raw ? {} : { "content-type": "application/json" }),
        ...extra,
      },
      body: body === undefined ? undefined : raw ? (body as any) : JSON.stringify(body),
    });
    const text = await r.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {}
    return { status: r.status, body: parsed as T, headers: r.headers, text };
  }
  return {
    call,
    get: <T = any>(p: string) => call<T>("GET", `/api${p}`),
    post: <T = any>(p: string, b: unknown) => call<T>("POST", `/api${p}`, b),
    patch: <T = any>(p: string, b: unknown) => call<T>("PATCH", `/api${p}`, b),
    put: <T = any>(p: string, b: unknown) => call<T>("PUT", `/api${p}`, b),
    del: <T = any>(p: string) => call<T>("DELETE", `/api${p}`),
  };
}

/** An MCP client, using the official SDK the way consumer apps do. */
export async function mcp(level: Level, opts: { url?: string; bearer?: string } = {}) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "parachute-door-contracts", version: "0.0.0" });
  const bearer = opts.bearer ?? (await token(level));
  const transport = new StreamableHTTPClientTransport(new URL(opts.url ?? mcpUrl()), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    fetch: safeFetch,
  });
  await client.connect(transport);
  return {
    client,
    async tools() {
      return (await client.listTools()).tools.slice().sort((a, b) => a.name.localeCompare(b.name));
    },
    /** Call a tool; the parsed JSON result, or an Error carrying the tool's error text. */
    async call<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
      const r: any = await client.callTool({ name, arguments: args });
      // A tool's JSON is its first text block; a later block is words for the model (the refresh nudge on the five
      // note-named tools, T-446), so it is never part of the JSON. An error's text is every block.
      const text = r.isError ? (r.content ?? []).map((c: any) => c.text ?? "").join("") : ((r.content ?? []).find((c: any) => c.type === "text")?.text ?? "");
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

// ── The fingerprint ─────────────────────────────────────────────────────────────────────────────────────────
//
// Passing the same contracts is half of "the same". The other half is what an app could branch on without any
// contract noticing: a tool's schema, a discovery document, an error body, the keys of a reply. Contracts record
// those here under a stable key; the runner compares the doors' fingerprints and fails on any difference that
// deliberate.json doesn't name.

/** Replace what legitimately differs per door and per run, so two doors can be compared. */
export function neutral(value: unknown): unknown {
  const d = door();
  const swaps: [string, string][] = [
    [d.issuer, "<issuer>"],
    [d.vaultOrigin, "<vault-origin>"],
    [new URL(d.issuer).host, "<issuer-host>"],
    [new URL(d.vaultOrigin).host, "<vault-host>"],
  ];
  // The box serves both from one origin; name it once so a box and a two-origin door compare.
  const text = (s: string) => {
    let out = s;
    for (const [from, to] of swaps) out = out.split(from).join(to);
    for (const [name, mark] of [[d.vault, "<v>"], [d.otherVault, "<other>"]] as const) {
      for (const lead of ["/vault/", "vault:", "vault.", "parachute-vault/", 'Vault "', 'vault "']) out = out.split(`${lead}${name}`).join(`${lead}${mark}`);
    }
    return out.replace(/<vault-origin>|<issuer>/g, "<door>").replace(/<vault-host>|<issuer-host>/g, "<door-host>");
  };
  const walk = (v: unknown): unknown =>
    typeof v === "string"
      ? text(v)
      : Array.isArray(v)
        ? v.map(walk)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.keys(v).map((k) => [text(k), walk((v as Record<string, unknown>)[k])] as const).sort(([x], [y]) => x.localeCompare(y)))
          : v;
  return walk(value);
}

/** The shape of a value: its keys and the type of each, without the values. Arrays show the shape of their items. */
export function shape(value: unknown): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const kinds = [...new Set(value.map((v) => JSON.stringify(shape(v))))].sort().map((s) => JSON.parse(s));
    return kinds.length === 1 ? [kinds[0]] : kinds.length === 0 ? [] : [{ anyOf: kinds }];
  }
  if (typeof value === "object") return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, shape((value as Record<string, unknown>)[k])]));
  return typeof value;
}

export const sha = (v: unknown) => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex").slice(0, 16);

/** Record one fact about this door under a stable key. The same key must get the same value on every door. */
export function fp(key: string, value: unknown): void {
  const file = door().fingerprint ?? process.env.DOOR_FINGERPRINT;
  if (!file) return;
  appendFileSync(file, `${JSON.stringify({ key, value: neutral(value) })}\n`);
}

/** Status and error code of a reply, the part of a refusal an app branches on: never the message, which names the
 *  run's own notes. `error` is kept only when it is a code. `hint` is what the door tells the caller to do next;
 *  its words are compared by hash, since an AI caller acts on them. */
export function refusal(r: Reply): { status: number; error: unknown; type: unknown; keys: string[]; hint: string | null } {
  const b = r.body && typeof r.body === "object" ? (r.body as Record<string, unknown>) : {};
  const code = (v: unknown) => (typeof v === "string" && /^[a-z0-9_.-]{1,60}$/i.test(v) ? v : v === undefined ? null : "(text)");
  return { status: r.status, error: code(b.error ?? b.code), type: code(b.error_type), keys: Object.keys(b).sort(), hint: typeof b.hint === "string" ? sha(b.hint) : null };
}

/** Record each top-level key of a reply as its own fact, so a named difference can be exactly one key wide. */
export function fpEach(prefix: string, value: unknown): void {
  const o = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  fp(`${prefix}.keys`, Object.keys(o).sort());
  for (const k of Object.keys(o)) fp(`${prefix}.${k}`, shape(o[k]));
}

/** A content type without its parameters: `application/json;charset=utf-8` and `application/json` are one answer. */
export const mediaType = (h: Headers) => (h.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();

// ── What a door is allowed to lack ──────────────────────────────────────────────────────────────────────────

/**
 * Whether this door lacks a surface, by an entry in deliberate.json that says so (`lacks` lists the kinds). A
 * contract may skip itself only through this, so a missing surface is always a named, owned difference and never a
 * quiet skip. The answer is recorded, so the comparison shows it.
 */
export function lacks(id: string): boolean {
  const all = JSON.parse(readFileSync(new URL("./deliberate.json", import.meta.url), "utf8")).differences as { id: string; lacks?: string[]; releases?: string[] }[];
  const entry = all.find((d) => d.id === id);
  // An entry for one release line says nothing about a door on another: nothing is recorded there.
  if (entry?.releases && !entry.releases.includes(door().release)) return false;
  const missing = !!entry?.lacks?.includes(door().kind);
  fp(`has/${id}`, !missing);
  return missing;
}

export function paths(notes: { path?: string }[]): string[] {
  return notes.map((n) => n.path ?? "").sort();
}
