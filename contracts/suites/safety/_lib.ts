// What the safety contracts share: reading a pass's claims, the hub's mint endpoint, /view, the live socket, and
// a pass signed the way an older hub might have signed it. Only HTTP, WebSocket and the box's own files; nothing
// here imports vault or hub code.
import { createSign } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { checkUrl } from "../../harness/guard.ts";
import { mintToken } from "../../harness/services.ts";
import { operator, pass, safeFetch, services, type Reply } from "../lib.ts";

/** The claims inside a pass (no signature check: the services check it, the contracts read it). */
export function claims(token: string): Record<string, any> {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
}

/** Make a note as the operator; returns its id. */
export async function note(path: string, content: string, tags: string[]): Promise<string> {
  const r = await operator().post("/notes", { content, path, tags });
  if (r.status !== 201) throw new Error(`setup: creating ${path} gave ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body.id as string;
}

/** `GET <vault>/view/<idOrPath>` (the HTML view) with a bearer pass. */
export async function view(token: string | null, idOrPath: string): Promise<{ status: number; text: string }> {
  const s = services();
  const r = await safeFetch(`${s.vaultViaHub}/view/${idOrPath}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: r.status, text: await r.text() };
}

/** `POST /api/auth/mint-token` on the hub, with `bearer` as the minter. */
export async function mintOverHttp(bearer: string, body: Record<string, unknown>): Promise<Reply> {
  const s = services();
  const r = await safeFetch(`${s.hub}/api/auth/mint-token`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {}
  return { status: r.status, body: parsed, headers: r.headers };
}

/** A tag-scoped vault admin pass for the box's admin account: a minter that holds only some tags. */
export async function scopedAdmin(tags: string[]): Promise<string> {
  const s = services();
  return mintToken(s, {
    scope: ["read", "write", "admin"].map((l) => `vault:${s.vaultName}:${l}`).join(" "),
    permissions: { scoped_tags: tags },
    label: "contracts-scoped-minter",
    user: s.admin.username,
  });
}

export { pass };

// ── the live socket ─────────────────────────────────────────────────────────────────────────────────────────

export interface LiveSocket {
  /** Every parsed frame received so far, in order. */
  frames: any[];
  /** Wait until a frame matches, or fail after `ms`. */
  waitFor(match: (f: any) => boolean, what: string, ms?: number): Promise<any>;
  close(): void;
}

/**
 * Open `<vault>/api/subscribe` through the hub as a WebSocket, authenticate with the first message
 * (`{"type":"auth","token"}`), and wait for the end of the snapshot. The guard checks the origin first.
 */
export async function subscribe(token: string, query = ""): Promise<LiveSocket> {
  const s = services();
  const http = `${s.vaultViaHub}/api/subscribe${query}`;
  checkUrl(http);
  const ws = new WebSocket(http.replace(/^http/, "ws"));
  const frames: any[] = [];
  const waiters = new Set<() => void>();
  let closed: string | null = null;
  ws.onmessage = (e) => {
    try {
      frames.push(JSON.parse(String(e.data)));
    } catch {
      frames.push({ raw: String(e.data) });
    }
    for (const w of waiters) w();
  };
  ws.onclose = (e) => {
    closed = `closed ${e.code} ${e.reason}`;
    for (const w of waiters) w();
  };
  const waitFor = (match: (f: any) => boolean, what: string, ms = 10_000) =>
    new Promise<any>((resolve, reject) => {
      const check = () => {
        const hit = frames.find(match);
        if (hit) {
          waiters.delete(check);
          clearTimeout(timer);
          resolve(hit);
        } else if (closed) {
          waiters.delete(check);
          clearTimeout(timer);
          reject(new Error(`live socket ${closed} before ${what}`));
        }
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`live socket: no ${what} within ${ms} ms (frames: ${JSON.stringify(frames).slice(0, 400)})`));
      }, ms);
      waiters.add(check);
      check();
    });
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`live socket: could not open ${http}`));
  });
  ws.send(JSON.stringify({ type: "auth", token }));
  await waitFor((f) => f.type === "snapshot" && f.done === true, "end of snapshot");
  return { frames, waitFor, close: () => ws.close() };
}

// ── a pass as another minter signed it ───────────────────────────────────────────────────────────────────────

/**
 * Re-sign a pass's claims, with `permissions` replaced, using the box's own active signing key (read from its
 * hub.db, as anyone with the box's disk could). This stands in for a pass an older or other minter issued: a fixed
 * mint won't issue one with unknown keys, but passes minted before the fix live until they expire, so the vault must
 * refuse them on its own.
 */
export function resign(token: string, permissions: Record<string, unknown>): string {
  const s = services();
  const db = [join(s.home, "hub.db"), join(s.home, "hub", "hub.db")].find(existsSync);
  if (!db) throw new Error(`setup: no hub.db under ${s.home}`);
  const conn = new Database(db, { readonly: true });
  const key = conn
    .query("SELECT kid, private_key_pem AS pem, algorithm FROM signing_keys WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT 1")
    .get() as { kid: string; pem: string; algorithm: string } | null;
  conn.close();
  if (!key || key.algorithm !== "RS256") throw new Error(`setup: no active RS256 signing key in hub.db (${key?.algorithm})`);
  const header = { ...JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString()), kid: key.kid };
  const body = { ...claims(token), permissions };
  const head = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(body)).toString("base64url")}`;
  const sig = createSign("RSA-SHA256").update(head).sign(key.pem).toString("base64url");
  return `${head}.${sig}`;
}
