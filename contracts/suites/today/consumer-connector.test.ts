// The consumer connector: someone whose only AI is a consumer app (the Claude app, ChatGPT, a Dots-like app) adds
// their vault as a connector, and the app reads and writes it over MCP. This is a first-class path, so it is
// tested end to end through the same doors the app uses, starting from nothing but the vault's MCP URL:
//
//   MCP 401 → protected-resource metadata → authorization-server metadata → dynamic client registration →
//   the person signs in and approves → code + PKCE → token → MCP: list tools, write, read, search, update →
//   refresh the token → keep working.
//
// The hub's own e2e/mcp-probe.ts walks the same flow; this contract adds discovery from a cold start, an outside
// redirect URI (the app's, not the hub's), the official MCP SDK client, and the checks a person relies on.
import { beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mcp, operator, runId, services } from "../lib.ts";

const s = services();
const MCP_URL = `${s.hub}/vault/${s.vaultName}/mcp`;
const REDIRECT = "https://consumer-app.example/oauth/callback";

function cookie(r: Response, name: string): string | undefined {
  for (const c of r.headers.getSetCookie()) if (c.startsWith(`${name}=`)) return c.split(";")[0]!.slice(name.length + 1);
}
const csrfIn = (html: string) => html.match(/name="__csrf"\s+value="([^"]+)"/)?.[1];

interface Connected {
  clientId: string;
  access: string;
  refresh?: string;
  scope: string;
  tokenEndpoint: string;
}

/** Everything a consumer app does to connect, given only the MCP URL and the person's sign-in. */
async function connect(opts: { scope?: (vault: string) => string; appName: string }): Promise<Connected> {
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
  const prm = await (await fetch(prmUrl!)).json();
  expect(prm.resource).toBe(MCP_URL);
  const issuer = prm.authorization_servers[0];
  expect(issuer).toBe(s.hub);
  expect(prm.scopes_supported).toContain(`vault:${s.vaultName}:read`);

  // 3. Authorization-server metadata: registration, PKCE S256, public clients.
  const as = await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json();
  expect(as.issuer).toBe(issuer);
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

describe("consumer connector: a consumer AI app connects to a person's vault over MCP", () => {
  let app: Connected;

  beforeAll(async () => {
    app = await connect({ appName: `Consumer app ${runId("app")}` });
  });

  test("the app connects from nothing but the MCP URL and the person's approval", () => {
    expect(app.access.split(".").length).toBe(3);
    expect(app.scope).toContain(`vault:${s.vaultName}:write`);
  });

  test("the app sees the tools it needs: read, write, search", async () => {
    const c = await mcp(MCP_URL, app.access);
    try {
      const tools = await c.tools();
      for (const t of ["create-note", "query-notes", "update-note", "list-tags"]) expect(tools).toContain(t);
      // Approving an app for read and write doesn't hand it the vault's admin tools.
      expect(tools).not.toContain("delete-tag");
    } finally {
      await c.close();
    }
  });

  test("the app writes a note, finds it by search, reads it, and updates it", async () => {
    const word = `zq${runId("w").replace(/[^a-z0-9]/g, "")}`;
    const c = await mcp(MCP_URL, app.access);
    try {
      const made = await c.call("create-note", {
        content: `Groceries for ${word}: oats, lemons`,
        path: `${runId("consumer")}/groceries`,
        tags: ["list"],
        metadata: { store: "corner shop" },
      });
      const id = made.id ?? made.note?.id ?? made.notes?.[0]?.id;
      expect(id).toBeString();

      const found = await c.call("query-notes", { search: word });
      const list = Array.isArray(found) ? found : (found.notes ?? found.results ?? []);
      expect(list.map((n: any) => n.id)).toEqual([id]);

      const one = await c.call("query-notes", { id });
      const note = Array.isArray(one) ? one[0] : (one.note ?? one.notes?.[0] ?? one);
      expect(note.content).toContain("oats, lemons");
      expect(note.metadata.store).toBe("corner shop");

      await c.call("update-note", { id, append: "\n- bread", if_updated_at: note.updatedAt });
      const after = await operator().get(`/notes/${id}`);
      expect(after.body.content).toEndWith("- bread");
    } finally {
      await c.close();
    }
  });

  test("what the app writes is the person's vault: other clients see it at once", async () => {
    const path = `${runId("consumer")}/shared`;
    const c = await mcp(MCP_URL, app.access);
    try {
      await c.call("create-note", { content: "written by the app", path });
    } finally {
      await c.close();
    }
    const seen = await operator().get(`/notes/${encodeURIComponent(path)}`);
    expect(seen.status).toBe(200);
    expect(seen.body.content).toBe("written by the app");
  });

  test("the app keeps working after its access token is refreshed", async () => {
    expect(app.refresh).toBeString();
    const r = await fetch(app.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: app.refresh!, client_id: app.clientId }),
    });
    expect(r.status).toBe(200);
    const fresh = await r.json();
    expect(fresh.access_token).not.toBe(app.access);
    const c = await mcp(MCP_URL, fresh.access_token);
    try {
      expect(await c.tools()).toContain("query-notes");
    } finally {
      await c.close();
    }
  });

  test(
    "a used refresh token is dead once the 30-second retry window has passed, and replaying it ends the session",
    async () => {
      // Today's door keeps a one-generation grace window for retried refreshes (hub#685, REFRESH_GRACE_MS = 30 s
      // in hub packages/door-contract/src/tokens.ts). Outside it, a replay is treated as theft (RFC 6819 §5.2.2.3).
      const own = await connect({ appName: `Refresh app ${runId("app")}` });
      const refresh = (token: string) =>
        fetch(own.tokenEndpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: own.clientId }),
        });
      const first = await refresh(own.refresh!);
      expect(first.status).toBe(200);
      const next = await first.json();
      await Bun.sleep(31_000);
      const replay = await refresh(own.refresh!);
      expect(replay.status).toBe(400);
      expect((await replay.json()).error).toBe("invalid_grant");
      // The whole family is revoked: the refresh token handed out after the old one no longer works either.
      expect((await refresh(next.refresh_token)).status).toBe(400);
    },
    60_000,
  );

  test("an app approved to read only cannot write", async () => {
    const reader = await connect({ appName: `Reader app ${runId("app")}`, scope: (v) => `vault:${v}:read` });
    expect(reader.scope).not.toContain(":write");
    const c = await mcp(MCP_URL, reader.access);
    try {
      expect(await c.tools()).not.toContain("create-note");
      await expect(c.call("create-note", { content: "x", path: `${runId("consumer")}/nope` })).rejects.toThrow();
    } finally {
      await c.close();
    }
  });

  test("a made-up or tampered token gets nothing", async () => {
    const [h, p, sig] = app.access.split(".");
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...claims, scope: `${claims.scope} vault:${s.vaultName}:admin` })).toString("base64url")}.${sig}`;
    for (const bad of [forged, "not-a-token"]) {
      const r = await fetch(MCP_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bad}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(r.status).toBe(401);
    }
  });
});
