// The consumer connector's sign-in, step by step, as a consumer AI app does it. Shared by today/ and v1/.
import { expect } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { services } from "./lib.ts";

const s = services();
export const MCP_URL = `${s.hub}/vault/${s.vaultName}/mcp`;
export const REDIRECT = "https://consumer-app.example/oauth/callback";

function cookie(r: Response, name: string): string | undefined {
  for (const c of r.headers.getSetCookie()) if (c.startsWith(`${name}=`)) return c.split(";")[0]!.slice(name.length + 1);
}
const csrfIn = (html: string) => html.match(/name="__csrf"\s+value="([^"]+)"/)?.[1];

/** Every URL the server hands us must stay on the throwaway hub, so a misconfigured hub can't steer the session
 *  cookie or an auth code to the live one. */
function onHub(url: string | undefined): string {
  expect(url).toBeString();
  expect(new URL(url!).origin).toBe(s.hub);
  return url!;
}

export interface Connected {
  clientId: string;
  access: string;
  refresh?: string;
  scope: string;
  tokenEndpoint: string;
}

/** Everything a consumer app does to connect, given only the MCP URL and the person's sign-in. */
export async function connect(opts: { scope?: (vault: string) => string; appName: string }): Promise<Connected> {
  // 1. The app calls MCP with no token and is told where to authenticate.
  const cold = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(cold.status).toBe(401);
  const www = cold.headers.get("www-authenticate") ?? "";
  const prmUrl = www.match(/resource_metadata="([^"]+)"/)?.[1];
  expect(prmUrl).toBeString();

  // 2. Protected-resource metadata names the resource and its authorization server.
  const prm = await (await fetch(onHub(prmUrl))).json();
  expect(prm.resource).toBe(MCP_URL);
  const issuer = prm.authorization_servers[0];
  expect(issuer).toBe(s.hub);
  expect(prm.scopes_supported).toContain(`vault:${s.vaultName}:read`);

  // 3. Authorization-server metadata: registration, PKCE S256, public clients.
  const as = await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json();
  expect(as.issuer).toBe(issuer);
  for (const k of ["registration_endpoint", "authorization_endpoint", "token_endpoint"]) onHub(as[k]);
  expect(as.code_challenge_methods_supported).toContain("S256");
  expect(as.token_endpoint_auth_methods_supported).toContain("none");

  // 4. Dynamic client registration with the app's own redirect URI.
  const reg = await fetch(as.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: opts.appName,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect([200, 201]).toContain(reg.status);
  const clientId = (await reg.json()).client_id;
  expect(clientId).toBeString();

  // 5. The person signs in (in the browser the app opens; here, the same form posts).
  const loginPage = await fetch(`${issuer}/login`, { redirect: "manual" });
  const csrf = cookie(loginPage, "parachute_hub_csrf");
  const login = await fetch(`${issuer}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `parachute_hub_csrf=${csrf}` },
    body: new URLSearchParams({ __csrf: csrfIn(await loginPage.text()) ?? csrf ?? "", ...s.admin }),
  });
  const session = cookie(login, "parachute_hub_session");
  expect(session).toBeString();

  // 6. Authorize with PKCE; the person sees the consent screen and approves.
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(8).toString("hex");
  const scope = opts.scope?.(s.vaultName) ?? `vault:${s.vaultName}:read vault:${s.vaultName}:write`;
  const params = {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope,
    state,
    resource: MCP_URL,
  };
  const auth = await fetch(`${as.authorization_endpoint}?${new URLSearchParams(params)}`, {
    redirect: "manual",
    headers: { cookie: `parachute_hub_session=${session}` },
  });
  let location: string;
  if (auth.status === 302) {
    location = auth.headers.get("location")!;
  } else {
    expect(auth.status).toBe(200);
    const html = await auth.text();
    expect(html).toContain('value="consent"');
    const csrf2 = cookie(auth, "parachute_hub_csrf") ?? csrf;
    const consent = await fetch(as.authorization_endpoint, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `parachute_hub_session=${session}; parachute_hub_csrf=${csrf2}`,
      },
      body: new URLSearchParams({
        ...params,
        __action: "consent",
        __csrf: csrfIn(html) ?? csrf2 ?? "",
        approve: "yes",
        vault_pick: s.vaultName,
      }),
    });
    expect(consent.status).toBe(302);
    location = consent.headers.get("location")!;
  }
  const back = new URL(location);
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
  expect(back.searchParams.get("state")).toBe(state);
  const code = back.searchParams.get("code");
  expect(code).toBeString();

  // 7. Code + verifier for tokens.
  const tok = await fetch(as.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: MCP_URL,
    }),
  });
  expect(tok.status).toBe(200);
  const body = await tok.json();
  expect(body.token_type?.toLowerCase()).toBe("bearer");
  return { clientId, access: body.access_token, refresh: body.refresh_token, scope: body.scope, tokenEndpoint: as.token_endpoint };
}

