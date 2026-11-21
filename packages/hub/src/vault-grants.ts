/**
 * Who reaches a vault, and ending it (docs/SPEC-1.0-grants.md §7.1 and §7.3, first slice): the door's side of the
 * grants a vault keeps.
 *
 *   GET    /account/vaults/<v>/statements        → 200 {grants: [row…], links: [], records: []}
 *   DELETE /account/vaults/<v>/statements/<id>   → 200 {id, state: "revoked", revoked_at}
 *   POST   /account/vaults/<v>/statements        → 405 (signed statements are a later slice)
 *
 * Every credential that reaches the vault is a key (keys.ts), so every one is a row: a named key, an AI or app
 * connected by OAuth, this app on each device. Each row is a **door grant** (§7.3), the door's word that the signed-in
 * owner agreed, in §7.1's row shape: `{id, origin: "door", state, signer: null, grantee: null, by: "signer", types,
 * deny: [], expires_at, event: null}`, with what a person needs to know it by: `name`, `kind` (person, agent, app,
 * service), `app` (the OAuth app's own name, when it has one), `created_at`, `last_used_at`, and `admin`/`export` for
 * the two levels that aren't a grant of types.
 *
 * A key made with types (`POST /account/keys {types}`) also has its grant filed at the vault itself, which checks it
 * on every request (vault grants-api.ts). Ending a row revokes the key's token here (the hub's vault doors refuse it at
 * once) and ends the vault's grant (the vault refuses it on the next request even when reached directly).
 *
 * Who may: the owner (`parachute:host:admin`: the hub's own account token, or the operator), or a whole-vault admin
 * credential for that vault (`vault:<v>:admin` with no narrowing of its own), which is what an app holds when its person
 * manages the vault from it. An admin credential for one vault ends only keys that reach that vault alone.
 */
import type { Database } from "bun:sqlite";
import { type AdminAuthContext } from "./admin-auth.ts";
import { HOST_ADMIN_SCOPE } from "./admin-vaults.ts";
import { revokeTokenByJti, signAccessToken, validateAccessToken } from "./jwt-sign.ts";
import { listKeys, type KeyView } from "./keys.ts";

export const GRANT_VERBS_READ = ["read"] as const;
export const GRANT_VERBS_WRITE = ["read", "create", "update", "delete"] as const;

export interface VaultGrantsDeps {
  db: Database;
  issuer: string;
  knownIssuers?: readonly string[];
  /** Send a request to the vault through the hub's own vault proxy (its path is already the vault's). */
  forward?: (req: Request) => Promise<Response | undefined>;
  now?: () => Date;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}
const err = (status: number, error: string, message: string) => json(status, { error, message });

export interface Gate {
  ctx: AdminAuthContext;
  /** The owner (host admin), or only this vault's admin. */
  owner: boolean;
}

/**
 * The owner, or a whole-vault admin credential for `vault`. A credential that is itself narrowed (tags, a grant) is
 * refused: it could otherwise make a key wider than itself.
 */
export async function ownerOrVaultAdmin(req: Request, db: Database, vault: string | null, issuers: readonly string[]): Promise<Gate | Response> {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!m) return err(401, "unauthorized", "send the owner's account token, or this vault's admin credential, as a Bearer");
  let payload: Record<string, unknown>;
  try {
    payload = (await validateAccessToken(db, m[1]!, issuers)).payload as Record<string, unknown>;
  } catch (e) {
    return err(401, "invalid_token", e instanceof Error ? e.message : String(e));
  }
  const sub = typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  if (!sub) return err(401, "invalid_token", "token missing required `sub` claim");
  const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [];
  const ctx: AdminAuthContext = {
    sub,
    scopes,
    clientId: typeof payload.client_id === "string" ? payload.client_id : undefined,
    audience: typeof payload.aud === "string" ? payload.aud : undefined,
  };
  if (scopes.includes(HOST_ADMIN_SCOPE)) return { ctx, owner: true };
  const perms = payload.permissions;
  const narrowed = perms && typeof perms === "object" && Object.keys(perms as object).some((k) => k === "scoped_tags" || k === "grant");
  if (vault !== null && scopes.includes(`vault:${vault}:admin`) && !narrowed) return { ctx, owner: false };
  return err(403, "insufficient_scope", vault === null ? "this is the owner's: it needs the hub's own account token" : `this needs the owner's account token, or vault:${vault}:admin on the whole vault`);
}

/** The verbs a key's level gives on each type it reaches. */
function grantTypes(k: KeyView, vault: string): Record<string, string[]> {
  const level = k.levels[vault];
  const verbs = level === "write" || level === "admin" ? [...GRANT_VERBS_WRITE] : level === "read" ? [...GRANT_VERBS_READ] : [];
  if (verbs.length === 0) return {};
  const types = k.types?.length ? k.types : k.allow_tags?.length ? k.allow_tags : ["*"];
  return Object.fromEntries(types.map((t) => [t, verbs]));
}

function appNames(db: Database): Map<string, string> {
  try {
    const rows = db.prepare("SELECT t.jti AS jti, c.client_name AS name FROM tokens t JOIN clients c ON c.client_id = t.client_id").all() as { jti: string; name: string | null }[];
    return new Map(rows.filter((r) => r.name).map((r) => [r.jti, r.name!]));
  } catch {
    return new Map();
  }
}

/** Every key that reaches `vault`, as grant rows. */
export function vaultGrantRows(db: Database, vault: string, now: Date = new Date()) {
  const jtis = new Map((db.prepare("SELECT name, jti FROM keys").all() as { name: string; jti: string }[]).map((r) => [r.name, r.jti]));
  const apps = appNames(db);
  return listKeys(db, now)
    .filter((k) => k.levels[vault] !== undefined)
    .map((k) => ({
      id: k.name,
      origin: "door" as const,
      state: k.status === "active" ? "in_force" : k.status,
      signer: null,
      grantee: null,
      by: "signer" as const,
      types: grantTypes(k, vault),
      deny: k.denies ?? [],
      expires_at: k.expires_at,
      event: null,
      name: k.name,
      kind: k.owner_kind,
      app: apps.get(jtis.get(k.name) ?? "") ?? null,
      ...(k.levels[vault] === "admin" ? { admin: true } : {}),
      ...(k.levels[vault] === "export" ? { export: true } : {}),
      created_at: k.created_at,
      last_used_at: k.last_used_at,
    }));
}

/** A short admin credential for the hub's own call to one vault (as admin-vault-api.ts makes for its session). */
async function vaultAdminBearer(deps: VaultGrantsDeps, sub: string, vault: string): Promise<string> {
  const minted = await signAccessToken(deps.db, {
    sub,
    scopes: [`vault:${vault}:admin`],
    audience: `vault.${vault}`,
    clientId: "parachute-hub-grants",
    issuer: deps.issuer,
    ttlSeconds: 60,
    vaultScope: [vault],
  });
  return minted.token;
}

/** Call the vault's grants API through the hub's own proxy; the vault's reply, or null when it can't be reached. */
export async function callVaultGrants(deps: VaultGrantsDeps, sub: string, vault: string, method: "PUT" | "DELETE", id: string, body?: unknown): Promise<Response | null> {
  if (!deps.forward) return null;
  const url = new URL(`/vault/${encodeURIComponent(vault)}/api/grants/${encodeURIComponent(id)}`, deps.issuer);
  const req = new Request(url.toString(), {
    method,
    headers: { authorization: `Bearer ${await vaultAdminBearer(deps, sub, vault)}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    return (await deps.forward(req)) ?? null;
  } catch {
    return null;
  }
}

/** Route `/account/vaults/<v>/statements[/<id>]`; null for any other path. */
export async function routeVaultGrants(req: Request, pathname: string, deps: VaultGrantsDeps): Promise<Response | null> {
  const m = /^\/account\/vaults\/([^/]+)\/statements(?:\/([^/]+))?$/.exec(pathname);
  if (!m) return null;
  let vault: string;
  let id: string | null;
  try {
    vault = decodeURIComponent(m[1]!);
    id = m[2] === undefined ? null : decodeURIComponent(m[2]);
  } catch {
    return err(400, "invalid_request", "the path is not valid percent-encoding");
  }
  if (id === null && req.method !== "GET") {
    // Filing a signed statement is a later slice: the same answer as before this route existed.
    return json(405, { error: "method_not_allowed", message: "signed statements aren't taken here yet; use GET to list" }, { allow: "GET" });
  }
  if (id !== null && req.method !== "DELETE") return json(405, { error: "method_not_allowed", message: "use DELETE to end one" }, { allow: "DELETE" });
  const gate = await ownerOrVaultAdmin(req, deps.db, vault, deps.knownIssuers ?? [deps.issuer]);
  if (gate instanceof Response) return gate;
  const now = deps.now?.() ?? new Date();
  if (id === null) return json(200, { grants: vaultGrantRows(deps.db, vault, now), links: [], records: [] });
  return endVaultGrant(deps, gate, vault, id, now);
}

async function endVaultGrant(deps: VaultGrantsDeps, gate: Gate, vault: string, id: string, now: Date): Promise<Response> {
  const key = listKeys(deps.db, now).find((k) => k.name === id && k.levels[vault] !== undefined);
  if (!key) return err(404, "not_found", `nothing called "${id}" reaches ${vault}`);
  if (!gate.owner && Object.keys(key.levels).some((v) => v !== vault)) {
    return err(403, "insufficient_scope", `"${id}" reaches other vaults too: only the owner can end it`);
  }
  const row = deps.db.prepare("SELECT jti FROM keys WHERE name = ?").get(id) as { jti: string };
  revokeTokenByJti(deps.db, row.jti, now, { by: gate.ctx.sub, via: "http" });
  if (key.types?.length) await endFiledGrant(deps, gate.ctx.sub, vault, id);
  const after = deps.db.prepare("SELECT revoked_at FROM tokens WHERE jti = ?").get(row.jti) as { revoked_at: string };
  return json(200, { id, state: "revoked", revoked_at: after.revoked_at });
}

/**
 * End the grant the vault keeps for a key. The token is already revoked at the hub, whose vault doors refuse it at
 * once; this makes the vault refuse it too when reached some other way. A vault that can't be reached now keeps the
 * grant until its date, behind a revoked token: said in the log, never silently.
 */
export async function endFiledGrant(deps: VaultGrantsDeps, sub: string, vault: string, id: string): Promise<void> {
  const r = await callVaultGrants(deps, sub, vault, "DELETE", id);
  if (!r || (r.status !== 200 && r.status !== 404)) {
    console.warn(`[grants] the grant ${id} in ${vault} could not be ended at the vault (${r ? r.status : "unreachable"}); its token is revoked at the hub`);
  }
}
