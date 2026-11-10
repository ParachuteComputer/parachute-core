// Surface E: connecting an app and holding keys. The OAuth path a consumer AI app takes, and the account door a
// person's own app takes. A connector built against one door must connect to every door.
import { beforeAll, describe, expect, test } from "bun:test";
import { accountToken, accountTokenReply, door, fp, fpEach, lacks, mcp, mcpUrl, rest, runId, safeFetch, shape, vaultTokenReply, vaultUrl } from "./_door.ts";
import { connect, discover, type Connected, type Discovery } from "./_connect.ts";

const claimsOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
const refreshWith = (c: Connected, refresh: string) =>
  safeFetch(c.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: c.clientId }),
  });
const usable = async (access: string) => {
  const r = await safeFetch(`${vaultUrl()}/api/notes?limit=1`, { headers: { authorization: `Bearer ${access}` } });
  return r.status;
};

describe("what an app is told before it connects", () => {
  test("discovery tells an app the same things at every door", async () => {
    const { as, prm } = await discover();
    for (const k of ["registration_endpoint", "authorization_endpoint", "token_endpoint"]) expect(new URL(as[k]).origin).toBe(door().issuer);
    expect(as.code_challenge_methods_supported).toContain("S256");
    expect(as.token_endpoint_auth_methods_supported).toContain("none");
    expect(prm.scopes_supported).toContain(`vault:${door().vault}:read`);
    fpEach("connect/authorization-server", as);
    fp("connect/admin-scope.advertised", prm.scopes_supported.includes(`vault:${door().vault}:admin`));
  });

  test("an app registers itself", async () => {
    const { as } = await discover();
    const reg = await safeFetch(as.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: `Door app ${runId("app")}`, redirect_uris: ["https://consumer-app.example/oauth/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
    });
    expect([200, 201]).toContain(reg.status);
    const body = await reg.json();
    expect(body.client_id).toBeString();
    fp("connect/registration.reply.keys", Object.keys(body).sort());
    const bad = await safeFetch(as.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "x", redirect_uris: ["javascript:alert(1)"] }) });
    fp("connect/refusal.bad-redirect", { status: bad.status, error: (await bad.json().catch(() => ({}))).error ?? null });
  });

  test("the published keys and the revocation list are where an app looks for them", async () => {
    const d = door();
    const jwks = await safeFetch(`${d.issuer}/.well-known/jwks.json`);
    expect(jwks.status).toBe(200);
    const keys = (await jwks.json()).keys;
    expect(keys.length).toBeGreaterThanOrEqual(1);
    fp("connect/jwks.key", { kty: keys[0].kty, alg: keys[0].alg ?? null, use: keys[0].use ?? null });
    const rev = await safeFetch(`${d.issuer}/.well-known/parachute-revocation.json`);
    fp("connect/revocation-list", { status: rev.status, shape: rev.status === 200 ? shape(await rev.json()) : null });
  });
});

// The person's approval happens on the door's consent screen, in a browser session. A door whose owner signs in only
// with a key has no such session yet, so an app can't be approved there: named in deliberate.json.
describe.skipIf(lacks("oauth-approval"))("connecting an app (OAuth)", () => {
  let app: Connected & Discovery;
  beforeAll(async () => {
    app = await connect({ appName: `Door app ${runId("app")}` });
  });

  test("the token reply and the token's claims have the same shape", () => {
    fp("connect/token.reply.shape", shape(app.tokenReply));
    const c = claimsOf(app.access);
    expect(c.iss).toBe(door().issuer);
    expect(c.aud).toBe(`vault.${door().vault}`);
    expect(app.scope).toBe(`vault:${door().vault}:read vault:${door().vault}:write`);
    fp("connect/token.claims", Object.keys(c).sort());
    fp("connect/token.lifetime", c.exp - c.iat);
  });

  test("the app reads and writes with its token, over MCP and REST", async () => {
    const c = await mcp("write", { bearer: app.access });
    try {
      const path = `${runId("connect")}/by-app`;
      await c.call("create-note", { content: "written by the app", path });
      const seen = await rest("read").get(`/notes/${encodeURIComponent(path)}`);
      expect(seen.status).toBe(200);
      expect(seen.body.content).toBe("written by the app");
      fp("connect/written-by.stamp", { by: typeof seen.body.createdBy, via: seen.body.createdVia ?? null });
    } finally {
      await c.close();
    }
    expect(await usable(app.access)).toBe(200);
  });

  test("the app keeps working after its access token is refreshed", async () => {
    expect(app.refresh).toBeString();
    const r = await refreshWith(app, app.refresh!);
    expect(r.status).toBe(200);
    const fresh = await r.json();
    expect(fresh.access_token).not.toBe(app.access);
    expect(fresh.refresh_token).not.toBe(app.refresh);
    fp("connect/refresh.reply.shape", shape(fresh));
    expect(await usable(fresh.access_token)).toBe(200);
    app.refresh = fresh.refresh_token;
    app.access = fresh.access_token;
  });

  test(
    "a used refresh token is dead once the 30-second retry window has passed, and replaying it ends the session",
    async () => {
      const own = await connect({ appName: `Refresh app ${runId("app")}` });
      const first = await refreshWith(own, own.refresh!);
      expect(first.status).toBe(200);
      const next = await first.json();
      await Bun.sleep(31_000);
      const replay = await refreshWith(own, own.refresh!);
      expect(replay.status).toBe(400);
      expect((await replay.json()).error).toBe("invalid_grant");
      expect((await refreshWith(own, next.refresh_token)).status).toBe(400);
    },
    60_000,
  );

  test("an app approved to read only cannot write", async () => {
    const reader = await connect({ appName: `Reader app ${runId("app")}`, scope: (v) => `vault:${v}:read` });
    expect(reader.scope).not.toContain(":write");
    const w = await safeFetch(`${vaultUrl()}/api/notes`, {
      method: "POST",
      headers: { authorization: `Bearer ${reader.access}`, "content-type": "application/json" },
      body: JSON.stringify({ content: "x", path: `${runId("connect")}/nope` }),
    });
    expect(w.status).toBe(403);
  });

  test("an app can ask for admin, and gets what the person approved", async () => {
    const asked = await connect({ appName: `Admin app ${runId("app")}`, scope: (v) => `vault:${v}:read vault:${v}:write vault:${v}:admin` }).then(
      (c) => ({ granted: c.scope.split(" ").map((s) => s.split(":").pop()).sort().join(" ") }),
      (e) => ({ refused: String(e.message).slice(0, 80) }),
    );
    fp("connect/admin-scope", asked);
  });

  test("a revoked app stops working", async () => {
    const own = await connect({ appName: `Revoked app ${runId("app")}` });
    expect(own.revocationEndpoint).toBeString();
    const r = await safeFetch(own.revocationEndpoint!, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: own.refresh!, token_type_hint: "refresh_token", client_id: own.clientId }),
    });
    expect(r.status).toBe(200);
    expect((await refreshWith(own, own.refresh!)).status).toBe(400);
    fp("connect/revoke.access-still-works", (await usable(own.access)) === 200 ? "until it expires" : "stops at once");
  });

  test("a made-up or tampered token gets nothing", async () => {
    const [h, p, sig] = app.access.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...claimsOf(app.access), scope: `${claimsOf(app.access).scope} vault:${door().vault}:admin` })).toString("base64url")}.${sig}`;
    for (const bad of [forged, "not-a-token"]) {
      const r = await safeFetch(mcpUrl(), {
        method: "POST",
        headers: { authorization: `Bearer ${bad}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(r.status).toBe(401);
    }
  });

});

describe("the account door (a person's own app)", () => {
  test("the owner's session becomes an account credential", async () => {
    const r = await accountTokenReply();
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.token).toBeString();
    fp("account/token.reply.shape", shape(body));
    const c = claimsOf(body.token);
    expect(c.aud).toBe("account");
    fp("account/token.lifetime", c.exp - c.iat);
  });

  test("the account credential lists the owner's vaults and mints a credential for one", async () => {
    const d = door();
    const bearer = { authorization: `Bearer ${await accountToken()}` };
    const list = await safeFetch(`${d.issuer}/account/vaults`, { headers: bearer });
    expect(list.status).toBe(200);
    const listed = await list.json();
    const vaults = Array.isArray(listed) ? listed : listed.vaults;
    expect(vaults.map((v: any) => v.name)).toContain(d.vault);
    const mine = vaults.find((v: any) => v.name === d.vault);
    expect(mine.url).toBe(`${d.vaultOrigin}/vault/${d.vault}`);
    fp("account/vaults.reply.envelope", Array.isArray(listed) ? "array" : Object.keys(listed).sort());
    fpEach("account/vaults.item", mine);

    const minted = await vaultTokenReply(d.vault, [`vault:${d.vault}:read`]);
    expect(minted.status).toBe(200);
    const body = await minted.json();
    expect(body.vault_token).toBeString();
    fpEach("account/vault-token.reply", body);
    const c = claimsOf(body.vault_token);
    expect(c.aud).toBe(`vault.${d.vault}`);
    expect(c.scope).toBe(`vault:${d.vault}:read`);
    fp("account/vault-token.claims", Object.keys(c).sort());
    fp("account/vault-token.lifetime", c.exp - c.iat);
    const dflt = await (await vaultTokenReply(d.vault, undefined)).json();
    fp("account/vault-token.default-scope", claimsOf(dflt.vault_token).scope);
  });

  test("it refuses a scope for another vault, a vault that isn't the owner's, and a caller with no credential", async () => {
    const d = door();
    const foreign = await vaultTokenReply(d.vault, [`vault:${d.otherVault}:read`]);
    expect(foreign.status).toBe(400);
    fp("account/refusal.foreign-scope", { status: foreign.status, error: (await foreign.json()).error ?? null });
    const unknown = await vaultTokenReply(`nosuch${runId("v")}`, undefined);
    expect([403, 404]).toContain(unknown.status);
    fp("account/refusal.unknown-vault", { status: unknown.status, error: (await unknown.json()).error ?? null });
    const anon = await safeFetch(`${d.issuer}/account/vaults`);
    expect(anon.status).toBe(401);
    fp("account/refusal.no-credential", { status: anon.status, error: (await anon.json().catch(() => ({}))).error ?? null });
  });

  test("a vault is made and removed through the account door", async () => {
    const d = door();
    const bearer = { authorization: `Bearer ${await accountToken()}`, "content-type": "application/json" };
    const name = `tmp${runId("v")}`;
    const made = await safeFetch(`${d.issuer}/account/vaults`, { method: "POST", headers: bearer, body: JSON.stringify({ name }) });
    expect(made.status).toBe(201);
    fpEach("account/vault.create.reply", JSON.parse(JSON.stringify(await made.json()).split(name).join("<new>")));
    const again = await safeFetch(`${d.issuer}/account/vaults`, { method: "POST", headers: bearer, body: JSON.stringify({ name }) });
    expect(again.status).toBe(409);
    fp("account/refusal.vault-taken", { status: again.status, error: (await again.json()).error ?? null });
    const bad = await safeFetch(`${d.issuer}/account/vaults`, { method: "POST", headers: bearer, body: JSON.stringify({ name: "Not A Name!" }) });
    expect(bad.status).toBe(400);
    fp("account/refusal.vault-name", { status: bad.status, error: (await bad.json()).error ?? null });
    expect((await rest("read", name).get("/notes?limit=1")).status).toBe(200);
    const gone = await safeFetch(`${d.issuer}/account/vaults/${name}`, { method: "DELETE", headers: bearer, body: JSON.stringify({ confirm: name }) });
    fp("account/vault.delete.status", gone.status);
    fp("account/vault.delete.report", Object.keys((await gone.json().catch(() => null)) ?? {}).sort());
    expect(gone.status).toBeLessThan(300);
  });
});
