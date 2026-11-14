// Named keys for the 0.9.4 contracts: the box's owner signs in with a throwaway Nostr key and mints keys by name
// (`POST /account/keys`), so a write is stamped `via key:<name>` as a real AI's is. Made-up names only.
import { randomBytes } from "node:crypto";
import { hubCli } from "../../harness/services.ts";
import { nip98, nostrKey } from "../compat/_lib.ts";
import { must, pass, safeFetch, services } from "../lib.ts";

export const s = services();
export const shortId = () => randomBytes(3).toString("hex");

export interface Answer {
  status: number;
  body: any;
  text: string;
}

export async function call(path: string, init: { method?: string; auth?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Answer> {
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  const r = await safeFetch(`${s.hub}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.auth ? { authorization: init.auth } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
    body,
  });
  const text = await r.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {}
  return { status: r.status, body: parsed, text };
}

let account: Promise<string> | null = null;
export function accountToken(): Promise<string> {
  account ??= (async () => {
    const owner = nostrKey();
    await hubCli(s, ["auth", "link-pubkey", "--user", s.admin.username, owner.pubkey]);
    const r = await call("/account/token", { method: "POST", auth: nip98(owner, `${s.hub}/account/token`, "POST") });
    must(r.status === 200 && typeof r.body?.token === "string", `NIP-98 sign-in: ${r.status} ${r.text.slice(0, 200)}`);
    return r.body.token as string;
  })();
  return account;
}

export interface Key {
  name: string;
  token: string;
  /** REST on this vault with this key. */
  api(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Answer>;
}

/** A key minted by name for this vault at `can`. */
export async function mintKey(label: string, can: "read" | "write" | "admin"): Promise<Key> {
  const name = `${label}-${shortId()}`;
  const r = await call("/account/keys", { method: "POST", auth: `Bearer ${await accountToken()}`, body: { name, vault: s.vaultName, can } });
  must(r.status === 201, `minting ${name}: ${r.status} ${r.text.slice(0, 300)}`);
  const token = r.body.token as string;
  return {
    name: r.body.name as string,
    token,
    api: (method, path, body, headers = {}) => call(`/vault/${s.vaultName}/api${path}`, { method, auth: `Bearer ${token}`, body, headers }),
  };
}

export const mcpUrl = () => `${s.hub}/vault/${s.vaultName}/mcp`;
export const enc = encodeURIComponent;

/** The vault's admin, as an operator mints it (an app key is never admin). */
export async function adminPass(): Promise<Key> {
  const token = await pass({ level: "admin" });
  return {
    name: "",
    token,
    api: (method, path, body, headers = {}) => call(`/vault/${s.vaultName}/api${path}`, { method, auth: `Bearer ${token}`, body, headers }),
  };
}
