// Connecting an app, step by step, as a consumer AI app does it: discovery from a cold 401, dynamic registration,
// PKCE, the person's approval, tokens. Every step is the same call at every door except the approval screen, which
// is the person's own sign-in and so belongs to the door (the one branch on `kind` in these contracts).
import { expect } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { door, mcpUrl, safeFetch } from "./_door.ts";

export const REDIRECT = "https://consumer-app.example/oauth/callback";

export interface Connected {
  clientId: string;
  access: string;
  refresh?: string;
  scope: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  tokenReply: Record<string, unknown>;
}

export interface Discovery {
  prm: any;
  as: any;
  challenge: string;
}

/** What a cold MCP call leads an app to: the protected-resource document and the authorization server's. */
export async function discover(): Promise<Discovery> {
  const d = door();
  const cold = await safeFetch(mcpUrl(), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(cold.status).toBe(401);
  const challenge = cold.headers.get("www-authenticate") ?? "";
  const prmUrl = challenge.match(/resource_metadata="([^"]+)"/)?.[1];
  expect(prmUrl).toBeString();
  const prm = await (await safeFetch(prmUrl!)).json();
  expect(prm.resource).toBe(mcpUrl());
  expect(prm.authorization_servers[0]).toBe(d.issuer);
  const as = await (await safeFetch(`${d.issuer}/.well-known/oauth-authorization-server`)).json();
  expect(as.issuer).toBe(d.issuer);
  return { prm, as, challenge };
}

const csrfIn = (html: string) => html.match(/name="__csrf"\s+value="([^"]+)"/)?.[1];
const setCookie = (r: Response, name: string) => {
  for (const c of r.headers.getSetCookie()) if (c.startsWith(`${name}=`)) return c.split(";")[0]!.slice(name.length + 1);
};

/** The person approves the app on the door's own consent screen. Returns where the door sends the browser. */
async function approve(authorizeEndpoint: string, params: Record<string, string>, form: Record<string, string> = {}): Promise<string> {
  const d = door();
  if (d.signIn.how !== "cookie") throw new Error("approve: this door's owner signs in with a key; the consent screen needs a browser session");
  const first = await safeFetch(`${authorizeEndpoint}?${new URLSearchParams(params)}`, { headers: { cookie: d.signIn.cookie } });
  if (first.status === 302) return first.headers.get("location")!;
  expect(first.status).toBe(200);
  const html = await first.text();
  if (d.kind === "box") {
    const csrf = setCookie(first, "parachute_hub_csrf") ?? d.signIn.csrf;
    const session = /parachute_hub_session=([^;]+)/.exec(d.signIn.cookie)![1]!;
    const consent = await safeFetch(authorizeEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: `parachute_hub_session=${session}; parachute_hub_csrf=${csrf}` },
      body: new URLSearchParams({ ...params, __action: "consent", __csrf: csrfIn(html) ?? csrf, approve: "yes", vault_pick: d.vault, ...form }),
    });
    expect(consent.status, (await consent.clone().text()).slice(0, 300)).toBe(302);
    return consent.headers.get("location")!;
  }
  // Cloud-style: the consent form posts back to the same origin, which answers with a bridge page (or a redirect).
  const consent = await safeFetch(authorizeEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: d.issuer, cookie: d.signIn.cookie },
    body: new URLSearchParams({ ...params, __action: "consent", __csrf: d.signIn.csrf, decision: "approve", ...form }),
  });
  const body = await consent.text();
  const bridged = body.match(/location\.replace\((.*)\);<\/script>/)?.[1];
  const loc = consent.headers.get("location") ?? (bridged ? (JSON.parse(bridged) as string) : "");
  expect(loc, `consent gave ${consent.status}: ${body.slice(0, 200)}`).toBeTruthy();
  return loc;
}

/** Everything a consumer app does to connect, given only the MCP URL and the person's approval. */
export async function connect(opts: { scope?: (vault: string) => string; appName: string }): Promise<Connected & Discovery> {
  const d = door();
  const disc = await discover();
  const { as } = disc;
  const reg = await safeFetch(as.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: opts.appName, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  expect([200, 201]).toContain(reg.status);
  const clientId = (await reg.json()).client_id;
  expect(clientId).toBeString();

  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(8).toString("hex");
  const scope = opts.scope?.(d.vault) ?? `vault:${d.vault}:read vault:${d.vault}:write`;
  const params = {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    scope,
    state,
    resource: mcpUrl(),
  };
  const back = new URL(await approve(as.authorization_endpoint, params));
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
  expect(back.searchParams.get("state")).toBe(state);
  const code = back.searchParams.get("code");
  expect(code).toBeString();

  const tok = await safeFetch(as.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: code!, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource: mcpUrl() }),
  });
  expect(tok.status).toBe(200);
  const body = await tok.json();
  expect(body.token_type?.toLowerCase()).toBe("bearer");
  return { ...disc, clientId, access: body.access_token, refresh: body.refresh_token, scope: body.scope, tokenEndpoint: as.token_endpoint, revocationEndpoint: as.revocation_endpoint, tokenReply: body };
}

/**
 * The account door's consent, per vault (0.9.1 "one multi-vault door"): an app asks for the account door
 * (`account:vaults`, as its protected-resource document says), and the person chooses a level for each vault:
 * none, read or write. The form posts `account_vault_levels=1` and one `vault_level:<vault>` = `none|read|write`
 * per vault; a vault not posted is none. Returns the token reply, or the refusal when the door refuses the choice.
 */
export async function connectAccount(opts: { appName: string; levels: Record<string, string>; scope?: string }): Promise<
  { ok: true; access: string; scope: string } | { ok: false; refusal: string }
> {
  const d = door();
  const resource = `${d.issuer}/account/mcp`;
  const cold = await safeFetch(resource, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(cold.status).toBe(401);
  const prmUrl = (cold.headers.get("www-authenticate") ?? "").match(/resource_metadata="([^"]+)"/)?.[1];
  expect(prmUrl).toBeString();
  const prm = await (await safeFetch(prmUrl!)).json();
  expect(prm.scopes_supported).toContain("account:vaults");
  const as = await (await safeFetch(`${d.issuer}/.well-known/oauth-authorization-server`)).json();
  const reg = await safeFetch(as.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: opts.appName, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  expect([200, 201]).toContain(reg.status);
  const clientId = (await reg.json()).client_id;
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(8).toString("hex");
  const params = {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    scope: opts.scope ?? "account:vaults",
    state,
    resource,
  };
  const form: Record<string, string> = { account_vault_levels: "1" };
  for (const [v, level] of Object.entries(opts.levels)) form[`vault_level:${v}`] = level;
  let location: string;
  try {
    location = await approve(as.authorization_endpoint, params, form);
  } catch (e) {
    return { ok: false, refusal: (e as Error).message };
  }
  const back = new URL(location);
  const code = back.searchParams.get("code");
  if (!code) return { ok: false, refusal: back.searchParams.get("error") ?? location };
  const tok = await safeFetch(as.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource }),
  });
  expect(tok.status, (await tok.clone().text()).slice(0, 300)).toBe(200);
  const body = await tok.json();
  return { ok: true, access: body.access_token, scope: body.scope };
}
