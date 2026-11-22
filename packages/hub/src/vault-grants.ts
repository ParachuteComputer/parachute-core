/**
 * Who reaches a vault, and ending it (docs/SPEC-1.0-grants.md §7.1 and §7.3, first slice): the door's side of the
 * grants a vault keeps.
 *
 *   GET    /account/vaults/<v>/statements        → 200 {grants: [row…], links: [], records: []}
 *   DELETE /account/vaults/<v>/statements/<id>   → 200 {id, state: "revoked", revoked_at}
 *   POST   /account/vaults/<v>/statements        → 405 (signed statements are a later slice)
 *
 * Every credential that reaches the vault is a key (keys.ts), so every one is a row: a named key, an AI or app
 * connected by OAuth, this app on each device. A person the vault is shared with (a member, `user_vaults`; spec §5.1)
 * is one row of their own (one list, T-476): id `person:<their key>`, `by: "self"`, `grantee` their key, named as they
 * were invited; their sign-ins (an app they signed in with, by OAuth) are in their row, never beside it, and a key or
 * token they made (for an AI, an app, a script) is a row of its own naming them (`person: {id, name}`). Ending their row ends the
 * membership as `revoke-access` does (users.ts removeUserVault): every credential of theirs naming the vault, a key of
 * theirs that also reaches another vault included, and any way back in. Each row is a **door grant** (§7.3), the
 * door's word that the signed-in owner agreed, in §7.1's row shape: `{id, origin: "door", state, signer: null, grantee: null, by: "signer", types,
 * deny: [], expires_at, event: null}`, with what a person needs to know it by: `name`, `kind` (person, agent, app,
 * service), `app` and `client` (the OAuth app's own name and client id, when it was one), `created_at`, `last_used_at`, and `admin`/`export` for
 * the two levels that aren't a grant of types.
 *
 * A key made with types (`POST /account/keys {types}`) also has its grant filed at the vault itself, which checks it
 * on every request (vault grants-api.ts). Ending a row revokes the key's token here (the hub's vault doors refuse it at
 * once) and ends the vault's grant (the vault refuses it on the next request even when reached directly).
 *
 * Who may: the owner (`parachute:host:admin`: the hub's own account token, or the operator), or a whole-vault admin
 * credential for that vault (`vault:<v>:admin` with no narrowing of its own), which is what an app holds when its person
 * manages the vault from it. An admin credential for one vault ends only keys that reach that vault alone; a person's
 * membership it ends as revoke-access does (above).
 */
import type { Database } from "bun:sqlite";
import { type AdminAuthContext } from "./admin-auth.ts";
import { HOST_ADMIN_SCOPE } from "./admin-vaults.ts";
import { revokeTokenByJti, signAccessToken, validateAccessToken } from "./jwt-sign.ts";
import { listKeys, type KeyView } from "./keys.ts";
import { nameOnVault } from "./share-invites.ts";
import { primaryPubkeyForUser } from "./pubkey-links.ts";
import { isHubAdmin, removeUserVault, vaultVerbsForRole } from "./users.ts";

export const GRANT_VERBS_READ = ["read"] as const;
/** Permission keys that say who a write is for or which key signed, and narrow nothing a credential reaches. */
const NOT_NARROWING = new Set(["acts_for", "principal_pubkey"]);
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
  // whole-vault only: any permission but the two that narrow nothing (who a write is for, which key signed) counts as a
  // narrowing, a key this hub doesn't know included (fail closed: a credential can't make a key wider than itself)
  const perms = payload.permissions;
  const narrowed = perms !== undefined && perms !== null && (typeof perms !== "object" || Array.isArray(perms) || Object.keys(perms as object).some((k) => !NOT_NARROWING.has(k)));
  if (vault !== null && scopes.includes(`vault:${vault}:admin`) && !narrowed) return { ctx, owner: false };
  return err(403, "insufficient_scope", vault === null ? "this is the owner's: it needs the hub's own account token" : `this needs the owner's account token, or vault:${vault}:admin on the whole vault`);
}

/** A multi-vault key's level in one vault: it reaches it through the account door (account-keys.ts). */
const ACCOUNT_VAULT_SCOPE = /^account:self:vaults:([^:]+):(read|write)$/;
/** What a key holds of one vault: its own vault scope, or its account-door level there; undefined when it doesn't reach it. */
function levelIn(k: KeyView, vault: string): KeyView["levels"][string] | undefined {
  if (k.levels[vault] !== undefined) return k.levels[vault];
  for (const s of k.scopes) {
    const m = ACCOUNT_VAULT_SCOPE.exec(s);
    if (m && m[1] === vault) return m[2] as "read" | "write";
  }
  return undefined;
}

/** The verbs a key's level gives on each type it reaches. */
function grantTypes(k: KeyView, vault: string): Record<string, string[]> {
  const level = levelIn(k, vault);
  const verbs = level === "write" || level === "admin" ? [...GRANT_VERBS_WRITE] : level === "read" ? [...GRANT_VERBS_READ] : [];
  if (verbs.length === 0) return {};
  const types = k.types?.length ? k.types : k.allow_tags?.length ? k.allow_tags : ["*"];
  return Object.fromEntries(types.map((t) => [t, verbs]));
}

/** Per token: the OAuth app it was given to (its client id, and the name it registered), when it was one. */
function appsOf(db: Database): Map<string, { client: string; name: string | null }> {
  try {
    const rows = db.prepare("SELECT t.jti AS jti, t.client_id AS client, c.client_name AS name FROM tokens t JOIN clients c ON c.client_id = t.client_id").all() as { jti: string; client: string; name: string | null }[];
    return new Map(rows.map((r) => [r.jti, { client: r.client, name: r.name }]));
  } catch {
    return new Map();
  }
}

/** A person the vault is shared with: their hub user, their role there, since when, and their key (the first linked). */
interface Member {
  user: string;
  role: string;
  since: string;
  pubkey: string | null;
}

/** The people `vault` is shared with (`user_vaults`), the hub's admins aside (they reach every vault by construction). */
function membersOf(db: Database, vault: string): Member[] {
  const rows = db
    .prepare("SELECT uv.user_id AS user, uv.role AS role, uv.created_at AS since FROM user_vaults uv WHERE uv.vault_name = ? ORDER BY uv.created_at, uv.user_id")
    .all(vault) as Omit<Member, "pubkey">[];
  return rows.filter((m) => !isHubAdmin(db, m.user)).map((m) => ({ ...m, pubkey: primaryPubkeyForUser(db, m.user) }));
}

/** A person's name on this vault: the one they were invited by, else their name on the hub, else their username. */
function personName(db: Database, user: string, vault: string): string {
  return nameOnVault(db, user, vault) ?? (db.prepare("SELECT username FROM users WHERE id = ?").get(user) as { username: string } | null)?.username ?? user;
}

/** A member's row's id: `person:` and their key (one key is one member, spec §5.1), else their hub user id. A key's
 *  name holds no colon (a given one: keys.ts KEY_NAME_RE; a made-up one: keys.ts baseName), so no key is ever
 *  mistaken for a person. */
const memberId = (m: Member) => `person:${m.pubkey ?? m.user}`;

/** A sign-in of a person's: an app they signed in to the vault with, by OAuth (their Parachute on each device). It is
 *  theirs, shown in their row. Anything they made on purpose (a key for an AI or an app, a token minted for a script)
 *  is a row of its own, named as theirs, so the owner sees it and can end it alone. */
const signIn = (k: KeyView) => k.owner_kind === "app" && k.created_via !== "app_key";

/** Every credential that reaches `vault`, as grant rows: each key, and each person it is shared with (their sign-ins
 *  in their row; a key they made, a row of its own that names them). */
export function vaultGrantRows(db: Database, vault: string, now: Date = new Date()) {
  const jtis = new Map((db.prepare("SELECT name, jti FROM keys").all() as { name: string; jti: string }[]).map((r) => [r.name, r.jti]));
  const apps = appsOf(db);
  const members = membersOf(db, vault);
  const member = new Map(members.map((m) => [m.user, m]));
  const reaching = listKeys(db, now).filter((k) => levelIn(k, vault) !== undefined);
  // whose a key is, when it is a person's other than the hub's owner: a member's (their row's id), or someone's who no
  // longer is one (null), by the name they have on this vault
  const names = new Map<string, string>();
  const personOf = (k: KeyView) => {
    if (k.owner === null || k.owner_kind === "service" || isHubAdmin(db, k.owner)) return null;
    if (!names.has(k.owner)) names.set(k.owner, personName(db, k.owner, vault));
    const m = member.get(k.owner);
    return { id: m ? memberId(m) : null, name: names.get(k.owner)! };
  };
  const keys = reaching
    .filter((k) => !(k.owner !== null && member.has(k.owner) && signIn(k)))
    .map((k) => {
      const person = personOf(k);
      return {
        id: k.name,
        origin: "door" as const,
        state: k.status === "active" ? "in_force" : k.status,
        signer: null,
        grantee: null as string | null,
        by: "signer" as "signer" | "self",
        types: grantTypes(k, vault),
        deny: k.denies ?? [],
        expires_at: k.expires_at,
        event: null,
        name: k.name as string,
        kind: k.owner_kind,
        app: apps.get(jtis.get(k.name) ?? "")?.name ?? null,
        client: apps.get(jtis.get(k.name) ?? "")?.client ?? null,
        ...(levelIn(k, vault) === "admin" ? { admin: true } : {}),
        ...(levelIn(k, vault) === "export" ? { export: true } : {}),
        ...(person ? { person } : {}),
        created_at: k.created_at,
        last_used_at: k.last_used_at,
      };
    });
  const people = members.map((m) => {
    // when they last used the vault: the latest of their sign-ins that reach it
    const used = reaching
      .filter((k) => k.owner === m.user && signIn(k) && k.last_used_at)
      .map((k) => k.last_used_at!)
      .sort()
      .at(-1) ?? null;
    const verbs = vaultVerbsForRole(m.role);
    return {
      id: memberId(m),
      origin: "door" as const,
      state: "in_force",
      signer: null,
      grantee: m.pubkey,
      by: "self" as const,
      types: verbs.includes("write") ? { "*": [...GRANT_VERBS_WRITE] } : verbs.includes("read") ? { "*": [...GRANT_VERBS_READ] } : {},
      deny: [],
      expires_at: null,
      event: null,
      name: personName(db, m.user, vault),
      kind: "person" as const,
      app: null,
      client: null,
      // `write` runs the vault with its owner (grant-access.ts): it may let others in
      ...(verbs.includes("admin") ? { admin: true } : {}),
      member: { role: m.role },
      created_at: m.since,
      last_used_at: used,
    };
  });
  return [...keys, ...people];
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
  // a person the vault is shared with: their membership ends, with every credential of theirs for the vault (users.ts
  // removeUserVault, as revoke-access), so no sign-in of theirs comes back; a key of theirs held to types also loses its
  // grant at the vault now
  const member = membersOf(deps.db, vault).find((m) => memberId(m) === id);
  if (member) {
    const typed = listKeys(deps.db, now).filter((k) => k.owner === member.user && k.types?.length && levelIn(k, vault) !== undefined);
    if (removeUserVault(deps.db, member.user, vault, () => now)) {
      console.log(`vault access revoked: vault=${vault} subject_pubkey=${member.pubkey ?? ""} subject_user_id=${member.user} actor_user_id=${gate.ctx.sub} via=statements`);
    }
    for (const k of typed) await endFiledGrant(deps, gate.ctx.sub, vault, k.name);
    return json(200, { id, state: "revoked", revoked_at: now.toISOString() });
  }
  const key = listKeys(deps.db, now).find((k) => k.name === id && levelIn(k, vault) !== undefined);
  if (!key) return err(404, "not_found", `nothing called "${id}" reaches ${vault}`);
  // a vault's admin ends only what reaches that vault and nothing else: every scope of it one this vault's admin could
  // itself give (api-mint-token's rule 3); anything wider (another vault, the hub) is the owner's to end
  const prefix = `vault:${vault}:`;
  const own = (s: string) => s.startsWith(prefix) && ["read", "write", "admin", "export"].includes(s.slice(prefix.length));
  if (!gate.owner && !key.scopes.every(own)) {
    return err(403, "insufficient_scope", `"${id}" reaches more than ${vault}: only the owner can end it`);
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
