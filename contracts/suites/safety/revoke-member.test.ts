// Taking a member's access away stops them at once (core #129).
//
// The chain, as the Parachute app's embed spike found it on two loopback hubs: an org's hub grants a person's key
// `read` on its vault (grant-access); the person signs in with the key and an app gets a vault token by consent.
// Then the org takes the access away (revoke-access). Before the fix the app's access token kept reading until it
// expired, its refresh token kept minting new ones, and its standing consent was still on record. Only
// `/oauth/revoke` stopped a token, and the hub's 401 for a revoked token had no CORS headers, so a browser app saw a
// network error instead of "revoked".
//
// Fixed in packages/hub. Taking a member's access away (revoke-access, the admin dropping a vault from a user, or
// grant-access lowering their role) revokes their tokens that name that vault above what they still hold, with the
// refresh families, and takes that vault out of their standing consent (users.ts `endVaultAuthorityBeyondRole`).
// Every refresh-row mint re-checks the role, so a mint signing meanwhile, or a family an older hub left live, mints
// nothing (grant-generation.ts). The key door's revoked 401 carries the vault's CORS headers (hub-server.ts).
// Mutants "revoke-access-keeps-tokens", "revoke-access-keeps-consent", "drop-vault-keeps-tokens",
// "lower-role-keeps-tokens", "sweep-ignores-account-door", "mint-skips-role-check" and "revoked-401-no-cors" put each
// back; "sweep-ends-held-verbs" and "sweep-ends-other-users" make it too broad.
//
// Candidate only (safety/). The member is a made-up key; it signs in through the hub's key door, never a password.
import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { safeFetch, services } from "../lib.ts";
import { adminSession } from "../oauth.ts";

const s = services();
const HUB = new URL(s.hub).origin;
const VAULT = s.vaultName;
const REDIRECT = "https://member-app.example/oauth/callback";
const APP_ORIGIN = "https://member-app.example";

// ── helpers: HTTP only ──────────────────────────────────────────────────────────────────────────────────────

function cookie(r: Response, name: string): string | undefined {
  for (const c of r.headers.getSetCookie()) if (c.startsWith(`${name}=`)) return c.split(";")[0]!.slice(name.length + 1);
}
const csrfIn = (html: string) => html.match(/name="__csrf"\s+value="([^"]+)"/)?.[1];

let hostAdmin: Promise<string> | null = null;
/** The admin SPA's way to a host-admin bearer: the admin's session (signed in once per run, suites/oauth.ts). */
function operatorBearer(): Promise<string> {
  hostAdmin ??= (async () => {
    const r = await safeFetch(`${s.hub}/admin/host-admin-token`, { headers: { cookie: `parachute_hub_session=${(await adminSession()).session}` } });
    const body: any = await r.json().catch(() => null);
    if (r.status !== 200 || typeof body?.token !== "string") throw new Error(`setup: /admin/host-admin-token gave ${r.status}`);
    return body.token as string;
  })();
  return hostAdmin;
}

/** One hub-native tool of the account MCP (grant-access, revoke-access), as the box's operator. */
async function accountTool(name: string, args: Record<string, unknown>): Promise<any> {
  const r = await safeFetch(`${s.hub}/account/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${await operatorBearer()}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body: any = await r.json().catch(() => null);
  if (r.status !== 200 || body?.error || body?.result?.isError) throw new Error(`setup: ${name} gave ${r.status} ${JSON.stringify(body).slice(0, 300)}`);
  return JSON.parse(body.result.content[0].text);
}

/** A made-up member: a fresh key, granted `role` on the vault by the operator, signed in through the key door. */
async function member(role: "read" | "member" | "write"): Promise<{ pubkey: string; userId: string; session: string }> {
  const { schnorr } = await import("@noble/curves/secp256k1.js");
  const sk = randomBytes(32);
  const pubkey = Buffer.from(schnorr.getPublicKey(sk)).toString("hex");
  const granted = await accountTool("grant-access", { pubkey, vault: VAULT, role });
  const ch: any = await (await safeFetch(`${s.hub}/api/auth/nostr/challenge`)).json();
  const tags = ch.event_template.tags as string[][];
  const ev: Record<string, unknown> = { pubkey, created_at: Math.floor(Date.now() / 1000), kind: ch.event_template.kind, tags, content: ch.event_template.content };
  const id = createHash("sha256").update(JSON.stringify([0, pubkey, ev.created_at, ev.kind, tags, ev.content])).digest();
  ev.id = id.toString("hex");
  ev.sig = Buffer.from(schnorr.sign(id, sk)).toString("hex");
  const r = await safeFetch(`${s.hub}/api/auth/nostr/verify`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: ev }) });
  const session = cookie(r, "parachute_hub_session");
  if (!session) throw new Error(`setup: the key door gave ${r.status} and no session: ${(await r.text()).slice(0, 200)}`);
  return { pubkey, userId: granted.user_id, session };
}

interface App {
  clientId: string;
  access: string;
  refresh: string;
}

/** An app registers itself (public DCR) and asks the member for `scope`. */
async function register(): Promise<string> {
  const r = await safeFetch(`${s.hub}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Contracts Member App", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  const body: any = await r.json();
  if (r.status !== 201) throw new Error(`setup: registering gave ${r.status}`);
  return body.client_id as string;
}

/**
 * The OAuth sign-in as the member's browser makes it: authorize, the consent page's Approve if it shows, the code
 * for tokens. Returns the token reply, or what stopped it (`stopped`: the step and its status).
 */
async function authorize(session: string, clientId: string, scope: string, form: Record<string, string> = {}): Promise<{ token?: any; stopped?: string }> {
  const verifier = randomBytes(32).toString("base64url");
  const params = {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    scope,
    state: randomBytes(8).toString("hex"),
  };
  const auth = await safeFetch(`${s.hub}/oauth/authorize?${new URLSearchParams(params)}`, { redirect: "manual", headers: { cookie: `parachute_hub_session=${session}` } });
  let location: string | null = null;
  if (auth.status === 302) {
    location = auth.headers.get("location");
  } else {
    const html = await auth.text();
    if (auth.status !== 200 || !html.includes('value="consent"')) return { stopped: `authorize ${auth.status}` };
    const csrf = cookie(auth, "parachute_hub_csrf");
    const consent = await safeFetch(`${s.hub}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: `parachute_hub_session=${session}; parachute_hub_csrf=${csrf}`, origin: HUB },
      body: new URLSearchParams({ ...params, __action: "consent", __csrf: csrfIn(html) ?? csrf ?? "", approve: "yes", vault_pick: VAULT, ...form }),
    });
    await consent.arrayBuffer();
    if (consent.status !== 302) return { stopped: `consent ${consent.status}` };
    location = consent.headers.get("location");
  }
  const back = new URL(location ?? "about:blank");
  const code = back.searchParams.get("code");
  if (`${back.origin}${back.pathname}` !== REDIRECT || !code) return { stopped: `redirect without a code (${back.searchParams.get("error") ?? location})` };
  const tok = await safeFetch(`${s.hub}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }),
  });
  const body: any = await tok.json().catch(() => null);
  if (tok.status !== 200) return { stopped: `token ${tok.status} ${body?.error ?? ""}` };
  return { token: body };
}

/** A member's app with a token for the vault, by consent. */
async function connected(session: string, scope = `vault:${VAULT}:read`, form: Record<string, string> = {}): Promise<App> {
  const clientId = await register();
  const r = await authorize(session, clientId, scope, form);
  if (!r.token?.access_token || !r.token?.refresh_token) throw new Error(`setup: the member's app got no tokens (${r.stopped})`);
  return { clientId, access: r.token.access_token, refresh: r.token.refresh_token };
}

const claimsOf = (token: string): Record<string, any> => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
const scopesOf = (token: string): string[] => String(claimsOf(token).scope ?? "").split(" ").filter(Boolean);

/** Read one note page through the hub, as the app does (with its page's Origin when given). */
async function read(token: string, origin?: string): Promise<Response> {
  return safeFetch(`${s.vaultViaHub}/api/notes?limit=1`, { headers: { authorization: `Bearer ${token}`, ...(origin ? { origin } : {}) } });
}

async function write(token: string): Promise<number> {
  const r = await safeFetch(`${s.vaultViaHub}/api/notes`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ content: "by a member's app", path: `revoke-member/${randomBytes(4).toString("hex")}` }),
  });
  await r.arrayBuffer();
  return r.status;
}

/** The refresh grant, as the app runs it when its access token runs out. */
async function refresh(app: App): Promise<{ status: number; body: any }> {
  const r = await safeFetch(`${s.hub}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: app.refresh, client_id: app.clientId }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** Every `access-control-*` header of a reply, as one comparable object. */
function corsOf(r: Response): Record<string, string> {
  const out: Record<string, string> = {};
  r.headers.forEach((v, k) => {
    if (k.toLowerCase().startsWith("access-control-")) out[k.toLowerCase()] = v;
  });
  return out;
}

// ── 1. revoke-access ────────────────────────────────────────────────────────────────────────────────────────

describe("revoke-access stops the member at once", () => {
  test("their app's access token is refused on the next request, and its refresh token mints nothing", async () => {
    const m = await member("read");
    const app = await connected(m.session);
    expect((await read(app.access)).status).toBe(200);

    expect(await accountTool("revoke-access", { pubkey: m.pubkey, vault: VAULT })).toMatchObject({ revoked: true });

    const after = await read(app.access);
    expect({ step: "the access token after revoke-access", status: after.status }).toEqual({ step: "the access token after revoke-access", status: 401 });
    const r = await refresh(app);
    expect({ step: "the refresh token after revoke-access", status: r.status, error: r.body?.error }).toEqual({ step: "the refresh token after revoke-access", status: 400, error: "invalid_grant" });
  });

  test("every app the member signed in to the vault stops, not only one", async () => {
    const m = await member("read");
    const one = await connected(m.session);
    const two = await connected(m.session);
    expect((await read(two.access)).status).toBe(200);
    await accountTool("revoke-access", { pubkey: m.pubkey, vault: VAULT });
    for (const app of [one, two]) expect((await read(app.access)).status).toBe(401);
  });

  test("their standing consent goes: signing in again gets no token for the vault, and a new grant asks again", async () => {
    const m = await member("read");
    const app = await connected(m.session);
    await accountTool("revoke-access", { pubkey: m.pubkey, vault: VAULT });
    const again = await authorize(m.session, app.clientId, `vault:${VAULT}:read`);
    const named = (again.token?.scope ?? "").split(" ").filter((x: string) => x.startsWith(`vault:${VAULT}:`));
    expect({ step: "authorize after revoke-access", vaultScopes: named }).toEqual({ step: "authorize after revoke-access", vaultScopes: [] });

    // Granted again later: the app asks again, rather than slipping through on the consent given before the revoke.
    await accountTool("grant-access", { pubkey: m.pubkey, vault: VAULT, role: "read" });
    const verifier = randomBytes(32).toString("base64url");
    const params = new URLSearchParams({
      client_id: app.clientId,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      scope: `vault:${VAULT}:read`,
      state: "s",
    });
    const page = await safeFetch(`${s.hub}/oauth/authorize?${params}`, { redirect: "manual", headers: { cookie: `parachute_hub_session=${m.session}` } });
    const html = await page.text();
    expect({ step: "authorize after a new grant", status: page.status, consentShown: html.includes('value="consent"') }).toEqual({ step: "authorize after a new grant", status: 200, consentShown: true });
  });

  test("an app on the account door with this vault chosen at read: its refresh token mints nothing", async () => {
    const m = await member("read");
    const app = await connected(m.session, "account:vaults", { account_vault_levels: "1", [`vault_level:${VAULT}`]: "read" });
    expect(scopesOf(app.access)).toContain(`account:self:vaults:${VAULT}:read`);
    await accountTool("revoke-access", { pubkey: m.pubkey, vault: VAULT });
    const r = await refresh(app);
    expect({ step: "the account door's refresh after revoke-access", status: r.status }).toEqual({ step: "the account door's refresh after revoke-access", status: 400 });
  });

  test("a refresh family an older hub left live after the revoke mints nothing", async () => {
    const m = await member("read");
    const app = await connected(m.session);
    await accountTool("revoke-access", { pubkey: m.pubkey, vault: VAULT });
    // Stands in for what a hub from before this fix left behind: the member's role gone, their app's family live.
    // Written into the box's own hub.db, as anyone with its disk could.
    const path = [join(s.home, "hub.db"), join(s.home, "hub", "hub.db")].find(existsSync);
    if (!path) throw new Error(`setup: no hub.db under ${s.home}`);
    const db = new Database(path);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      const jti = claimsOf(app.access).jti as string;
      const n = db.prepare("UPDATE tokens SET revoked_at = NULL WHERE family_id = (SELECT family_id FROM tokens WHERE jti = ?)").run(jti).changes;
      if (n < 1) throw new Error("setup: the app's refresh family wasn't in hub.db");
    } finally {
      db.close();
    }
    const r = await refresh(app);
    expect({ step: "a left-live refresh after the role is gone", status: r.status, error: r.body?.error }).toEqual({ step: "a left-live refresh after the role is gone", status: 400, error: "invalid_grant" });
  });

  test("another member of the same vault keeps reading", async () => {
    const stays = await member("read");
    const goes = await member("read");
    const kept = await connected(stays.session);
    await connected(goes.session);
    await accountTool("revoke-access", { pubkey: goes.pubkey, vault: VAULT });
    expect((await read(kept.access)).status).toBe(200);
    expect((await refresh(kept)).status).toBe(200);
  });
});

// ── 2. the operator drops the vault from the user, or lowers their role ────────────────────────────────────

describe("the other ways a member loses a vault stop them too", () => {
  test("the operator drops the vault from the user (PATCH /api/users/<id>/vaults): token and refresh refused", async () => {
    const m = await member("read");
    const app = await connected(m.session);
    const r = await safeFetch(`${s.hub}/api/users/${encodeURIComponent(m.userId)}/vaults`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${await operatorBearer()}`, "content-type": "application/json" },
      body: JSON.stringify({ assigned_vaults: [] }),
    });
    expect(r.status).toBe(200);
    expect({ step: "the access token after the vault is dropped", status: (await read(app.access)).status }).toEqual({ step: "the access token after the vault is dropped", status: 401 });
    expect({ step: "the refresh token after the vault is dropped", status: (await refresh(app)).status }).toEqual({ step: "the refresh token after the vault is dropped", status: 400 });
  });

  test("grant-access lowers write to read: the write token can't write any more, and nothing refreshes back to write", async () => {
    const m = await member("write");
    const app = await connected(m.session, `vault:${VAULT}:read vault:${VAULT}:write`);
    expect(scopesOf(app.access)).toContain(`vault:${VAULT}:write`);
    expect(await write(app.access)).toBe(201);

    await accountTool("grant-access", { pubkey: m.pubkey, vault: VAULT, role: "read" });

    const status = await write(app.access);
    expect({ step: "a write with the old write token", refused: status === 401 || status === 403 }).toEqual({ step: "a write with the old write token", refused: true });
    const r = await refresh(app);
    const writes = r.status === 200 ? scopesOf(r.body.access_token).filter((x) => x === `vault:${VAULT}:write`) : [];
    expect({ step: "refresh after the role is lowered", writeScopes: writes }).toEqual({ step: "refresh after the role is lowered", writeScopes: [] });
  });

  test("raising a role, or granting the same role again, leaves the member's tokens alone", async () => {
    const m = await member("read");
    const app = await connected(m.session);
    await accountTool("grant-access", { pubkey: m.pubkey, vault: VAULT, role: "read" });
    await accountTool("grant-access", { pubkey: m.pubkey, vault: VAULT, role: "write" });
    expect((await read(app.access)).status).toBe(200);
    expect((await refresh(app)).status).toBe(200);
  });
});

// ── 3. a browser app can read the refusal ───────────────────────────────────────────────────────────────────

describe("a revoked token's 401 is readable cross-origin", () => {
  test("the revoked 401 carries the same CORS headers as the vault's other 401s", async () => {
    const m = await member("read");
    const app = await connected(m.session);
    // Revoked the long-standing way (RFC 7009), so this contract stands apart from revoke-access's.
    const out = await safeFetch(`${s.hub}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: app.access, token_type_hint: "access_token", client_id: app.clientId }),
    });
    expect(out.status).toBe(200);

    const revoked = await read(app.access, APP_ORIGIN);
    expect(revoked.status).toBe(401);
    // Another 401 on the same route: a token this hub never issued.
    const other = await read("not-a-key", APP_ORIGIN);
    expect(other.status).toBe(401);
    const want = corsOf(other);
    expect(want["access-control-allow-origin"]).toBeString();
    expect({ step: "the revoked 401's CORS headers", cors: corsOf(revoked) }).toEqual({ step: "the revoked 401's CORS headers", cors: want });
    // And the app reads why: the refusal still says invalid_token, in the body and the challenge.
    expect((await revoked.json()).error).toBe("invalid_token");
  });
});
