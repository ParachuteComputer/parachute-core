/**
 * `/account/keys` — named app keys (0.9.1 "keys by name", T-414). The owner mints a long-lived key for one vault at
 * `read` or `write` for an app (Taste Arcade's worker, a script), lists them with when each was last used, and
 * revokes one by name. The same wire shapes are cloud's account door (parachute-cloud workers/identity
 * `account-keys.ts`), so one client works against a box and a cloud or own-Cloudflare hub.
 *
 *   POST   /account/keys          {name, vault, can: "read"|"write", expires_in?, on_behalf_of?: true}
 *                                 → 201 {name, vault, can, scopes, token, created_at, expires_at, last_used_at}
 *   POST   /account/keys          {name, vaults: {<vault>: "read"|"write", …}, expires_in?}   (0.9.1, T-446)
 *                                 → 201 {name, vaults, scopes, token, …}: a key for the account door (`/account/mcp`)
 *                                   covering several vaults, each at its own level; it opens no vault directly
 *   GET    /account/keys          → 200 {keys: [{name, vault, can, status, created_at, expires_at, last_used_at,
 *                                    revoked_at}]}   (the token is shown once, at mint, never again)
 *   DELETE /account/keys/<name>   → 200 {name, revoked_at}   (idempotent; 404 for a name that isn't yours)
 *
 * What holds it safe:
 *   - **Never admin.** `can` is `read` or `write`, nothing else, and the body may carry no other field: a `scopes`
 *     list, `admin` or a typo is refused with 400 before anything is signed. The scopes are built here:
 *     `vault:<v>:read`, plus `vault:<v>:write` for write, with `vault_scope` pinned to `<v>` and `aud=vault.<v>`.
 *   - **Only the owner mints.** Every route needs `parachute:host:admin`: the hub's own account token (session or
 *     NIP-98 sign-in) or the operator's credential. Not an OAuth app holding `account:self:admin` (see `account`). An app key carries only vault scopes,
 *     so it can't list, mint or revoke keys, or mint itself anything wider (`/api/auth/mint-token` attenuates).
 *   - **A name is one key, forever.** A taken name, revoked or not, is refused (409), so a new key never inherits
 *     an old key's name, last-used time or write stamps. The name is checked and the row written in one synchronous
 *     step after signing, so two mints racing for a name can't both win.
 *   - **Revocation is immediate on the hub.** The token row is revoked (the revocation list the vault reads picks
 *     it up within its 60 s cache), and the hub refuses a revoked token at its `/vault/*` door on the very next
 *     request (`hub-server.ts` proxyToVault). `last_used_at` is written at that same door, at most once a minute.
 *
 * The write stamp (ROADMAP 0.9.1): the key's name and kind are signed into it (its `key` claim), so the vault
 * stamps its writes `via key:<name>`. With `on_behalf_of: true` the owner also lets it write on behalf of people it
 * names: the token carries `permissions.acts_for: "<name>"` and a write may say who it is for, stamped
 * `by <name>:<id>` (vault core `write-stamp.ts`). The key's name is that prefix, so it must fit the prefix rule.
 * Only the owner's own sign-in reaches this route, so a key can never grant itself the permission.
 *
 * Long-lived: one year by default and at most (the hub's mint cap); `expires_in` (seconds) can shorten it.
 */
import type { Database } from "bun:sqlite";
import { listVaultsWithMeta, requireAnyScope } from "./account-api.ts";
import { type AdminAuthContext, adminAuthErrorResponse } from "./admin-auth.ts";
import { HOST_ADMIN_SCOPE } from "./admin-vaults.ts";
import { SERVICES_MANIFEST_PATH } from "./config.ts";
import {
  KeyNameTakenError,
  TokenMintPrincipalGoneError,
  recordTokenMint,
  revokeTokenByJti,
  signAccessToken,
} from "./jwt-sign.ts";
import { KEY_NAME_RE, onBehalfNameProblem } from "./keys.ts";
import { getUserById } from "./users.ts";
import { VAULT_NAME_CHARSET_RE } from "./vault-name.ts";

/** client_id on app-key tokens and their registry rows. */
export const APP_KEY_CLIENT_ID = "parachute-app-key";
/** One year: long-lived, and the hub's mint cap (`MAX_MINT_TTL_SECONDS`). */
export const APP_KEY_MAX_TTL_SECONDS = 365 * 24 * 60 * 60;
/** The shortest key worth naming. */
export const APP_KEY_MIN_TTL_SECONDS = 60;

const LEVELS = { read: ["read"], write: ["read", "write"] } as const;
type Can = keyof typeof LEVELS;
const BODY_FIELDS = new Set(["name", "vault", "can", "vaults", "expires_in", "on_behalf_of"]);
/** A multi-vault key covers at most this many vaults (the 10-vault power user, with room). */
export const APP_KEY_MAX_VAULTS = 50;
/** The account-door scope a multi-vault key carries per vault: `account:self:vaults:<vault>:<can>`. */
const ACCOUNT_VAULT_SCOPE_RE = /^account:self:vaults:([^:]+):(read|write)$/;

export interface AccountKeysDeps {
  db: Database;
  issuer: string;
  knownIssuers?: readonly string[];
  manifestPath?: string;
  now?: () => Date;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
const err = (status: number, error: string, message: string) => json(status, { error, message });

interface AppKeyRow {
  name: string;
  jti: string;
  created_at: string;
  last_used_at: string | null;
  scopes: string;
  permissions: string | null;
  expires_at: string;
  revoked_at: string | null;
}

/** A multi-vault key's levels, vault by vault, from its scopes; null for a one-vault key. */
function vaultLevels(scopes: readonly string[]): Record<string, Can> | null {
  const out: Record<string, Can> = {};
  for (const s of scopes) {
    const m = ACCOUNT_VAULT_SCOPE_RE.exec(s);
    if (m) out[m[1]!] = m[2] as Can;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function view(r: AppKeyRow, now: Date) {
  const scopes = r.scopes.split(/\s+/).filter(Boolean);
  const levels = vaultLevels(scopes);
  const vault = scopes[0]?.split(":")[1] ?? null;
  const can: Can = scopes.some((s) => s.endsWith(":write")) ? "write" : "read";
  const status = r.revoked_at
    ? "revoked"
    : r.expires_at <= now.toISOString()
      ? "expired"
      : "active";
  return {
    name: r.name,
    // A multi-vault key (the account door's) names its level per vault; a one-vault key keeps its 0.9.1 shape.
    ...(levels ? { vaults: levels } : { vault, can }),
    status,
    created_at: r.created_at,
    expires_at: r.expires_at,
    last_used_at: r.last_used_at,
    revoked_at: r.revoked_at,
    // Present only on a key that may write on behalf of others, so every other key's shape is unchanged.
    ...(actsFor(r.permissions) !== null ? { on_behalf_of: true } : {}),
  };
}

function actsFor(permissions: string | null): string | null {
  if (!permissions) return null;
  try {
    const v = (JSON.parse(permissions) as { acts_for?: unknown }).acts_for;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

const APP_KEYS_SQL = `SELECT k.name, k.jti, k.created_at, k.last_used_at, t.scopes, t.permissions, t.expires_at, t.revoked_at
  FROM keys k JOIN tokens t ON t.jti = k.jti
  WHERE t.created_via = 'app_key' AND t.user_id = ?`;

/**
 * The gate: the hub's own account token (`/account/token`, by session or NIP-98) or the operator's credential —
 * both carry `parachute:host:admin`, which no OAuth client can be granted. Not `account:self:admin` alone: that
 * scope is OAuth-requestable (hub#827), and a third-party app holding it must not mint year-long keys that outlive
 * its own grant (the same reason the create-vault handoff is capped, account-api.ts).
 */
async function account(req: Request, deps: AccountKeysDeps): Promise<AdminAuthContext | Response> {
  try {
    return await requireAnyScope(
      deps.db,
      req,
      [HOST_ADMIN_SCOPE],
      deps.knownIssuers ?? [deps.issuer],
    );
  } catch (e) {
    return adminAuthErrorResponse(e);
  }
}

/** Route `/account/keys` and `/account/keys/<name>`. Returns null for any other path. */
export async function routeAccountKeys(
  req: Request,
  pathname: string,
  deps: AccountKeysDeps,
): Promise<Response | null> {
  if (pathname === "/account/keys") {
    if (req.method === "GET") return listAppKeys(req, deps);
    if (req.method === "POST") return mintAppKey(req, deps);
    return new Response(
      JSON.stringify({ error: "method_not_allowed", message: "use GET or POST" }),
      {
        status: 405,
        headers: { "content-type": "application/json", allow: "GET, POST" },
      },
    );
  }
  if (pathname.startsWith("/account/keys/")) {
    let name: string;
    try {
      name = decodeURIComponent(pathname.slice("/account/keys/".length));
    } catch {
      return err(400, "invalid_request", "the key name in the path is not valid percent-encoding");
    }
    if (req.method === "DELETE") return revokeAppKey(req, name, deps);
    return new Response(JSON.stringify({ error: "method_not_allowed", message: "use DELETE" }), {
      status: 405,
      headers: { "content-type": "application/json", allow: "DELETE" },
    });
  }
  return null;
}

async function mintAppKey(req: Request, deps: AccountKeysDeps): Promise<Response> {
  const ctx = await account(req, deps);
  if (ctx instanceof Response) return ctx;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return err(400, "invalid_request", 'send JSON: {name, vault, can: "read"|"write"}');
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return err(400, "invalid_request", 'send JSON: {name, vault, can: "read"|"write"}');
  }
  const body = raw as Record<string, unknown>;
  const extra = Object.keys(body).filter((k) => !BODY_FIELDS.has(k));
  if (extra.length) {
    return err(
      400,
      "invalid_request",
      `unknown field(s): ${extra.join(", ")}; an app key takes name, vault, can, expires_in and on_behalf_of (or vaults instead of vault and can)`,
    );
  }
  if (body.vaults !== undefined) return mintMultiVaultKey(body, ctx, deps);
  const { name, vault, can, expires_in } = body;
  if (typeof name !== "string" || !KEY_NAME_RE.test(name)) {
    return err(
      400,
      "invalid_name",
      "name: letters, digits, '.', '_' and '-', up to 80, starting with a letter or digit",
    );
  }
  if (typeof vault !== "string" || !VAULT_NAME_CHARSET_RE.test(vault)) {
    return err(400, "invalid_request", "vault: the name of one vault");
  }
  if (can !== "read" && can !== "write") {
    return err(400, "invalid_scope", 'can: "read" or "write"; an app key is never admin');
  }
  const onBehalf = body.on_behalf_of;
  if (onBehalf !== undefined && typeof onBehalf !== "boolean") {
    return err(
      400,
      "invalid_request",
      'on_behalf_of: true lets the key write on behalf of people it names (stamped "by <name>:<id>"); false or absent, it writes as you',
    );
  }
  if (onBehalf === true) {
    const problem = onBehalfNameProblem(name);
    if (problem) return err(400, "invalid_name", problem);
  }
  let ttl = APP_KEY_MAX_TTL_SECONDS;
  if (expires_in !== undefined) {
    if (
      typeof expires_in !== "number" ||
      !Number.isInteger(expires_in) ||
      expires_in < APP_KEY_MIN_TTL_SECONDS ||
      expires_in > APP_KEY_MAX_TTL_SECONDS
    ) {
      return err(
        400,
        "invalid_request",
        `expires_in: whole seconds, ${APP_KEY_MIN_TTL_SECONDS} to ${APP_KEY_MAX_TTL_SECONDS}`,
      );
    }
    ttl = expires_in;
  }
  const manifestPath = deps.manifestPath ?? SERVICES_MANIFEST_PATH;
  if (!listVaultsWithMeta(manifestPath, deps.issuer).some((v) => v.name === vault)) {
    return err(404, "vault_not_found", `no vault named "${vault}"`);
  }
  const user = getUserById(deps.db, ctx.sub);
  if (!user) return err(403, "invalid_subject", "bearer subject is not a hub user");
  if (deps.db.prepare("SELECT 1 FROM keys WHERE name = ?").get(name)) {
    return err(
      409,
      "name_taken",
      `a key called "${name}" already exists (revoked keys keep their names); pick another`,
    );
  }

  const scopes = LEVELS[can].map((l) => `vault:${vault}:${l}`);
  const permissions = onBehalf === true ? { acts_for: name } : null;
  const minted = await signAccessToken(deps.db, {
    sub: user.id,
    scopes,
    audience: `vault.${vault}`,
    clientId: APP_KEY_CLIENT_ID,
    issuer: deps.issuer,
    ttlSeconds: ttl,
    vaultScope: [vault],
    // The write stamp: the vault names this key's writes `key:<name>` (a top-level claim, which an older vault
    // ignores), and with the owner's grant lets them say who they are for, as `<name>:<id>` (`permissions.acts_for`,
    // which an older vault refuses). Vault auth.ts; core write-stamp.ts.
    extraClaims: { key: { name, kind: "app" }, ...(permissions ? { permissions } : {}) },
    ...(deps.now ? { now: deps.now } : {}),
  });
  // Synchronous from here to the insert: bun:sqlite on one thread, so no other mint can take the name in between.
  if (deps.db.prepare("SELECT 1 FROM keys WHERE name = ?").get(name)) {
    return err(409, "name_taken", `a key called "${name}" already exists; pick another`);
  }
  try {
    deps.db.transaction(() => {
      recordTokenMint(deps.db, {
        jti: minted.jti,
        createdVia: "app_key",
        // The key's name rides the registry's label column, which is what names its key row (keys.ts baseName).
        subject: name,
        keyName: name,
        ...(permissions ? { permissions: JSON.stringify(permissions) } : {}),
        userId: user.id,
        userUpdatedAt: user.updatedAt,
        clientId: APP_KEY_CLIENT_ID,
        scopes,
        expiresAt: minted.expiresAt,
        ...(deps.now ? { now: deps.now } : {}),
      });
      const key = deps.db.prepare("SELECT name FROM keys WHERE jti = ?").get(minted.jti) as {
        name: string;
      } | null;
      if (key?.name !== name)
        throw new Error(
          `app key row for ${minted.jti} is named ${key?.name ?? "nothing"}, not ${name}`,
        );
    })();
  } catch (e) {
    if (e instanceof TokenMintPrincipalGoneError) return err(409, "conflict", e.message);
    if (e instanceof KeyNameTakenError)
      return err(409, "name_taken", `a key called "${name}" already exists; pick another`);
    throw e;
  }
  const row = deps.db.prepare(`${APP_KEYS_SQL} AND k.name = ?`).get(user.id, name) as AppKeyRow;
  return json(201, { ...view(row, deps.now?.() ?? new Date()), scopes, token: minted.token });
}

/**
 * A key for the account door (`/account/mcp`) that covers several vaults, each at its own level (0.9.1 "one
 * multi-vault door", T-446): `{name, vaults: {<vault>: "read"|"write", …}, expires_in?}`. It carries
 * `account:self:vaults:<vault>:<can>` per vault with `aud=account`, so it opens the account door and no vault
 * directly; the account door mints each hop at that vault's level (key-level.ts). Never admin, never create-vault.
 * Its writes are stamped `via key:<name>` like any key's: the account door's hop carries the key's signed `key` claim
 * (account-mcp-backend.ts). `on_behalf_of` stays refused here: it would put `permissions.acts_for` on every hop, and
 * a key that writes for other people across several vaults is a wider grant than 0.9.1 needs.
 */
async function mintMultiVaultKey(
  body: Record<string, unknown>,
  ctx: AdminAuthContext,
  deps: AccountKeysDeps,
): Promise<Response> {
  const { name, vaults, expires_in } = body;
  if (body.vault !== undefined || body.can !== undefined) {
    return err(
      400,
      "invalid_request",
      "send either vault and can (one vault) or vaults (several), not both",
    );
  }
  if (body.on_behalf_of !== undefined) {
    return err(
      400,
      "invalid_request",
      "on_behalf_of is for a one-vault key; a multi-vault key writes as you, stamped with its name",
    );
  }
  if (typeof name !== "string" || !KEY_NAME_RE.test(name)) {
    return err(
      400,
      "invalid_name",
      "name: letters, digits, '.', '_' and '-', up to 80, starting with a letter or digit",
    );
  }
  const shape = 'vaults: {"<vault>": "read"|"write", …}, at least one';
  if (!vaults || typeof vaults !== "object" || Array.isArray(vaults))
    return err(400, "invalid_request", shape);
  const entries = Object.entries(vaults as Record<string, unknown>);
  if (entries.length === 0) return err(400, "invalid_request", shape);
  if (entries.length > APP_KEY_MAX_VAULTS) {
    return err(400, "invalid_request", `vaults: at most ${APP_KEY_MAX_VAULTS}`);
  }
  for (const [v, level] of entries) {
    if (!VAULT_NAME_CHARSET_RE.test(v))
      return err(400, "invalid_request", `vaults: "${v}" is not a vault name`);
    if (level !== "read" && level !== "write") {
      return err(400, "invalid_scope", `vaults.${v}: "read" or "write"; an app key is never admin`);
    }
  }
  let ttl = APP_KEY_MAX_TTL_SECONDS;
  if (expires_in !== undefined) {
    if (
      typeof expires_in !== "number" ||
      !Number.isInteger(expires_in) ||
      expires_in < APP_KEY_MIN_TTL_SECONDS ||
      expires_in > APP_KEY_MAX_TTL_SECONDS
    ) {
      return err(
        400,
        "invalid_request",
        `expires_in: whole seconds, ${APP_KEY_MIN_TTL_SECONDS} to ${APP_KEY_MAX_TTL_SECONDS}`,
      );
    }
    ttl = expires_in;
  }
  const installed = new Set(
    listVaultsWithMeta(deps.manifestPath ?? SERVICES_MANIFEST_PATH, deps.issuer).map((v) => v.name),
  );
  const missing = entries.map(([v]) => v).filter((v) => !installed.has(v));
  if (missing.length)
    return err(404, "vault_not_found", `no vault named ${missing.map((v) => `"${v}"`).join(", ")}`);
  const user = getUserById(deps.db, ctx.sub);
  if (!user) return err(403, "invalid_subject", "bearer subject is not a hub user");
  if (deps.db.prepare("SELECT 1 FROM keys WHERE name = ?").get(name)) {
    return err(
      409,
      "name_taken",
      `a key called "${name}" already exists (revoked keys keep their names); pick another`,
    );
  }
  const scopes = entries
    .map(([v, level]) => `account:self:vaults:${v}:${level as Can}`)
    .sort((a, b) => a.localeCompare(b));
  const minted = await signAccessToken(deps.db, {
    sub: user.id,
    scopes,
    audience: "account",
    clientId: APP_KEY_CLIENT_ID,
    issuer: deps.issuer,
    ttlSeconds: ttl,
    extraClaims: { key: { name, kind: "app" } },
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (deps.db.prepare("SELECT 1 FROM keys WHERE name = ?").get(name)) {
    return err(409, "name_taken", `a key called "${name}" already exists; pick another`);
  }
  try {
    deps.db.transaction(() => {
      recordTokenMint(deps.db, {
        jti: minted.jti,
        createdVia: "app_key",
        subject: name,
        keyName: name,
        userId: user.id,
        userUpdatedAt: user.updatedAt,
        clientId: APP_KEY_CLIENT_ID,
        scopes,
        expiresAt: minted.expiresAt,
        ...(deps.now ? { now: deps.now } : {}),
      });
      const key = deps.db.prepare("SELECT name FROM keys WHERE jti = ?").get(minted.jti) as {
        name: string;
      } | null;
      if (key?.name !== name)
        throw new Error(
          `app key row for ${minted.jti} is named ${key?.name ?? "nothing"}, not ${name}`,
        );
    })();
  } catch (e) {
    if (e instanceof TokenMintPrincipalGoneError) return err(409, "conflict", e.message);
    if (e instanceof KeyNameTakenError)
      return err(409, "name_taken", `a key called "${name}" already exists; pick another`);
    throw e;
  }
  const row = deps.db.prepare(`${APP_KEYS_SQL} AND k.name = ?`).get(user.id, name) as AppKeyRow;
  return json(201, { ...view(row, deps.now?.() ?? new Date()), scopes, token: minted.token });
}

async function listAppKeys(req: Request, deps: AccountKeysDeps): Promise<Response> {
  const ctx = await account(req, deps);
  if (ctx instanceof Response) return ctx;
  const now = deps.now?.() ?? new Date();
  const rows = deps.db
    .prepare(`${APP_KEYS_SQL} ORDER BY k.created_at, k.name`)
    .all(ctx.sub) as AppKeyRow[];
  return json(200, { keys: rows.map((r) => view(r, now)) });
}

async function revokeAppKey(req: Request, name: string, deps: AccountKeysDeps): Promise<Response> {
  const ctx = await account(req, deps);
  if (ctx instanceof Response) return ctx;
  const row = deps.db
    .prepare(`${APP_KEYS_SQL} AND k.name = ?`)
    .get(ctx.sub, name) as AppKeyRow | null;
  if (!row) return err(404, "key_not_found", `you have no app key called "${name}"`);
  const now = deps.now?.() ?? new Date();
  revokeTokenByJti(deps.db, row.jti, now, { by: ctx.sub, via: "http" });
  const after = deps.db.prepare("SELECT revoked_at FROM tokens WHERE jti = ?").get(row.jti) as {
    revoked_at: string;
  };
  return json(200, { name, revoked_at: after.revoked_at });
}
