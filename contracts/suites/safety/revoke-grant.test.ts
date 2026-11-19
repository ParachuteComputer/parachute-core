// Revoking a token ends the consent behind it, as far as no live token still holds it (T-476).
//
// The chain, as the Parachute app runs it: it asks the hub per vault and per verb. When the person takes write away
// from an app, the app asks for `vault:<v>:read` alone (covered by the consent on record, so no page), keeps that
// token, and revokes the old one that held read and write (RFC 7009, POST /oauth/revoke). Before the fix the token
// died, but the consent on record for (person, app) kept `vault:<v>:write` for good, so the app's next ask for write
// skipped the consent page.
//
// Fixed in packages/hub: when an app revokes a live token of its own, each `vault:<name>:<verb>` scope the token
// carried that no other live token of the same person and app holds leaves the consent on record (grants.ts
// `releaseGrantScopes`, called from oauth-handlers.ts `handleRevoke`). Other scopes stay. A revoke by another app,
// or of a token already revoked, changes nothing.
// Mutants "revoke-keeps-grant" and "revoke-ignores-live-tokens" put it back or make it too broad.
//
// Candidate only (safety/): `today/` runs the pinned stock hub, which keeps the consent. Not a door contract: cloud's
// identity worker doesn't do this yet. The person is a made-up key with write on the vault; it signs in through the
// hub's key door, never a password. Each app registers itself by public DCR under its own name, with a redirect on a
// stranger's host, so neither trust by name nor same-hub trust can skip the page.
import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { safeFetch, services } from "../lib.ts";
import { adminSession } from "../oauth.ts";

const s = services();
const HUB = new URL(s.hub).origin;
const VAULT = s.vaultName;
const READ = `vault:${VAULT}:read`;
const WRITE = `vault:${VAULT}:write`;
const REDIRECT = "https://revoking-app.example/oauth/callback";

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

/** A made-up person: a fresh key, granted write on the vault by the operator, signed in through the key door. */
async function person(): Promise<string> {
  const { schnorr } = await import("@noble/curves/secp256k1.js");
  const sk = randomBytes(32);
  const pubkey = Buffer.from(schnorr.getPublicKey(sk)).toString("hex");
  const g = await safeFetch(`${s.hub}/account/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${await operatorBearer()}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "grant-access", arguments: { pubkey, vault: VAULT, role: "write" } } }),
  });
  const granted: any = await g.json().catch(() => null);
  if (g.status !== 200 || granted?.error || granted?.result?.isError) throw new Error(`setup: grant-access gave ${g.status} ${JSON.stringify(granted).slice(0, 300)}`);
  const ch: any = await (await safeFetch(`${s.hub}/api/auth/nostr/challenge`)).json();
  const tags = ch.event_template.tags as string[][];
  const ev: Record<string, unknown> = { pubkey, created_at: Math.floor(Date.now() / 1000), kind: ch.event_template.kind, tags, content: ch.event_template.content };
  const id = createHash("sha256").update(JSON.stringify([0, pubkey, ev.created_at, ev.kind, tags, ev.content])).digest();
  ev.id = id.toString("hex");
  ev.sig = Buffer.from(schnorr.sign(id, sk)).toString("hex");
  const r = await safeFetch(`${s.hub}/api/auth/nostr/verify`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: ev }) });
  const session = cookie(r, "parachute_hub_session");
  if (!session) throw new Error(`setup: the key door gave ${r.status} and no session: ${(await r.text()).slice(0, 200)}`);
  return session;
}

/** An app registers itself (public DCR) under a name no other client has. */
async function register(): Promise<string> {
  const r = await safeFetch(`${s.hub}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: `Contracts Revoking App ${randomBytes(3).toString("hex")}`,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  const body: any = await r.json();
  if (r.status !== 201) throw new Error(`setup: registering gave ${r.status}`);
  return body.client_id as string;
}

interface Asked {
  /** "page": the consent page; "silent": a code straight back to the app; anything else is what stopped it. */
  saw: string;
  redeem: () => Promise<Token>;
}
interface Token {
  access: string;
  refresh: string;
  scopes: string[];
}

/** GET /oauth/authorize as the person's browser; says whether the consent page showed, and can carry on to tokens. */
async function ask(session: string, clientId: string, scope: string): Promise<Asked> {
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
  const html = await auth.text();
  const location = auth.headers.get("location");
  const codeIn = (loc: string | null) => {
    const back = new URL(loc ?? "about:blank");
    return `${back.origin}${back.pathname}` === REDIRECT ? back.searchParams.get("code") : null;
  };
  const saw = auth.status === 200 && html.includes('value="consent"') ? "page" : auth.status === 302 && codeIn(location) ? "silent" : `authorize ${auth.status} ${location ?? ""}`;
  const exchange = async (code: string | null): Promise<Token> => {
    if (!code) throw new Error("setup: no code to redeem");
    const tok = await safeFetch(`${s.hub}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }),
    });
    const body: any = await tok.json().catch(() => null);
    if (tok.status !== 200 || !body?.access_token || !body?.refresh_token) throw new Error(`setup: the token endpoint gave ${tok.status} ${body?.error ?? ""}`);
    return { access: body.access_token, refresh: body.refresh_token, scopes: String(body.scope ?? "").split(" ").filter(Boolean) };
  };
  const redeem = async (): Promise<Token> => {
    if (saw === "silent") return exchange(codeIn(location));
    if (saw !== "page") throw new Error(`setup: ${saw}`);
    const csrf = cookie(auth, "parachute_hub_csrf");
    const consent = await safeFetch(`${s.hub}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: `parachute_hub_session=${session}; parachute_hub_csrf=${csrf}`, origin: HUB },
      body: new URLSearchParams({ ...params, __action: "consent", __csrf: csrfIn(html) ?? csrf ?? "", approve: "yes", vault_pick: VAULT }),
    });
    await consent.arrayBuffer();
    if (consent.status !== 302) throw new Error(`setup: approving gave ${consent.status}`);
    return exchange(codeIn(consent.headers.get("location")));
  };
  return { saw, redeem };
}

/** POST /oauth/revoke (RFC 7009) as `clientId`; always 200 by the RFC. */
async function revoke(clientId: string, token: string, hint: "refresh_token" | "access_token"): Promise<number> {
  const r = await safeFetch(`${s.hub}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, token_type_hint: hint, client_id: clientId }),
  });
  await r.arrayBuffer();
  return r.status;
}

/** Read one page of notes with a token, as the app does. */
async function reads(token: string): Promise<number> {
  const r = await safeFetch(`${s.vaultViaHub}/api/notes?limit=1`, { headers: { authorization: `Bearer ${token}` } });
  await r.arrayBuffer();
  return r.status;
}

// ── 1. giving write back ────────────────────────────────────────────────────────────────────────────────────

describe("an app gives back write: revoking its read+write token ends write's consent, not read's", () => {
  let session: string;
  let app: string;
  let both: Token;
  let readOnly: Token;

  test("setup: the person approves read+write once, then the app asks read alone and gets it without a page", async () => {
    session = await person();
    app = await register();
    const first = await ask(session, app, `${READ} ${WRITE}`);
    expect({ step: "first ask for read+write", saw: first.saw }).toEqual({ step: "first ask for read+write", saw: "page" });
    both = await first.redeem();
    expect(both.scopes.sort()).toEqual([READ, WRITE].sort());
    const second = await ask(session, app, READ);
    expect({ step: "read alone, covered", saw: second.saw }).toEqual({ step: "read alone, covered", saw: "silent" });
    readOnly = await second.redeem();
    expect(readOnly.scopes).toEqual([READ]);
    // The read+write token is still live: nothing so far ended it.
    expect(await reads(both.access)).toBe(200);
  });

  test("after the app revokes its read+write token, asking read+write again shows the consent page", async () => {
    expect(await revoke(app, both.refresh, "refresh_token")).toBe(200);
    expect(await reads(both.access)).toBe(401);
    const again = await ask(session, app, `${READ} ${WRITE}`);
    expect({ step: "read+write after the revoke", saw: again.saw }).toEqual({ step: "read+write after the revoke", saw: "page" });
  });

  test("read alone is still covered: the app's read token is live and keeps reading", async () => {
    const again = await ask(session, app, READ);
    expect({ step: "read alone after the revoke", saw: again.saw }).toEqual({ step: "read alone after the revoke", saw: "silent" });
    expect(await reads(readOnly.access)).toBe(200);
  });
});

// ── 2. the only token ───────────────────────────────────────────────────────────────────────────────────────

describe("revoking an app's only token for the vault", () => {
  let session: string;
  let app: string;
  let only: Token;

  test("asking read again shows the consent page (revoked by its access token: one row with the refresh token)", async () => {
    session = await person();
    app = await register();
    only = await (await ask(session, app, READ)).redeem();
    expect((await ask(session, app, READ)).saw).toBe("silent"); // covered before the revoke
    expect(await revoke(app, only.access, "access_token")).toBe(200);
    const again = await ask(session, app, READ);
    expect({ step: "read after revoking the only token", saw: again.saw }).toEqual({ step: "read after revoking the only token", saw: "page" });
  });

  test("revoking that token again after the person approves anew takes nothing away", async () => {
    const fresh = await (await ask(session, app, READ)).redeem();
    expect(await revoke(app, only.refresh, "refresh_token")).toBe(200);
    expect(await revoke(app, only.access, "access_token")).toBe(200);
    const again = await ask(session, app, READ);
    expect({ step: "read after revoking a dead token again", saw: again.saw }).toEqual({ step: "read after revoking a dead token again", saw: "silent" });
    expect(await reads(fresh.access)).toBe(200);
  });
});

// ── 3. someone else's revoke ────────────────────────────────────────────────────────────────────────────────

describe("a revoke by another app", () => {
  test("is the same silent 200 and changes nothing: the token reads on and its consent still covers it", async () => {
    const session = await person();
    const app = await register();
    const other = await register();
    const tok = await (await ask(session, app, `${READ} ${WRITE}`)).redeem();
    expect(await revoke(other, tok.refresh, "refresh_token")).toBe(200);
    expect(await revoke(other, tok.access, "access_token")).toBe(200);
    expect(await reads(tok.access)).toBe(200);
    const again = await ask(session, app, `${READ} ${WRITE}`);
    expect({ step: "read+write after another app's revoke", saw: again.saw }).toEqual({ step: "read+write after another app's revoke", saw: "silent" });
  });
});
