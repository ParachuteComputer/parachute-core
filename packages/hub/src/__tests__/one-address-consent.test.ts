// The account door's page at the one address (T-476): "All your vaults" (every vault at write, and leave to make
// vaults) is the person's choice and only theirs, it replaces any earlier choice, a hub with no vault offers it, and
// an older one-vault page posted at /mcp is refused. Security rules, so unit tests on the real handlers and a real db.
import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { registerClient } from "../clients.ts";
import { CSRF_COOKIE_NAME } from "../csrf.ts";
import { findGrant, recordGrant } from "../grants.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { handleAuthorizeGet, handleAuthorizePost, handleToken } from "../oauth-handlers.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession } from "../sessions.ts";
import { createUser, setUserVaults } from "../users.ts";

const ISSUER = "https://hub.example";
const CSRF = "csrf-test-token";
const ALL = ["account:self:vault-create", "account:self:vaults:*:write"];
const TWO = { services: [{ name: "parachute-vault", port: 1940, paths: ["/vault/work", "/vault/other"], health: "/health", version: "0.9.0" }] };
const deps = (manifest: unknown = TWO) => ({ issuer: ISSUER, loadServicesManifest: () => manifest, hubBoundOrigins: () => [ISSUER] }) as never;
const cookie = (sid: string) => `${CSRF_COOKIE_NAME}=${CSRF}; ${buildSessionCookie(sid, Math.floor(SESSION_TTL_MS / 1000))}`;

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
function hub() {
  const dir = mkdtempSync(join(tmpdir(), "one-address-"));
  const db = openHubDb(hubDbPath(dir));
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function person(db: Database, owner = true) {
  if (owner) {
    const u = await createUser(db, "owner", "pw");
    return { id: u.id, sid: createSession(db, { userId: u.id }).id };
  }
  await createUser(db, "owner", "pw");
  const f = await createUser(db, "friend", "pw", { allowMulti: true });
  setUserVaults(db, f.id, ["work"]);
  return { id: f.id, sid: createSession(db, { userId: f.id }).id };
}
const app = (db: Database) => registerClient(db, { redirectUris: ["https://app.example/cb"], status: "approved" }).client.clientId;
const ask = (cid: string, challenge: string, scope: string, resource?: string) => ({
  client_id: cid, redirect_uri: "https://app.example/cb", response_type: "code", scope, code_challenge: challenge, code_challenge_method: "S256",
  ...(resource ? { resource } : {}),
});
function page(db: Database, sid: string, cid: string, challenge: string, scope = "account:vaults", resource?: string, manifest?: unknown) {
  const u = new URL("/oauth/authorize", ISSUER);
  for (const [k, v] of Object.entries(ask(cid, challenge, scope, resource))) u.searchParams.set(k, v);
  return handleAuthorizeGet(db, new Request(u.toString(), { headers: { cookie: cookie(sid) } }), deps(manifest));
}
function answer(db: Database, sid: string, cid: string, challenge: string, fields: [string, string][], scope = "account:vaults", resource?: string, manifest?: unknown) {
  const form = new URLSearchParams({ __action: "consent", __csrf: CSRF, approve: "yes", ...ask(cid, challenge, scope, resource) });
  for (const [k, v] of fields) form.append(k, v);
  return handleAuthorizePost(db, new Request(`${ISSUER}/oauth/authorize`, {
    method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie(sid) },
  }), deps(manifest));
}
async function tokens(db: Database, res: Response, cid: string, verifier: string): Promise<{ scope: string; refresh_token: string }> {
  const code = new URL(res.headers.get("location") ?? "https://x/").searchParams.get("code");
  if (!code) throw new Error(`no code: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const t = await handleToken(db, new Request(`${ISSUER}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: cid, redirect_uri: "https://app.example/cb", code_verifier: verifier }),
  }), deps());
  expect(t.status).toBe(200);
  return (await t.json()) as { scope: string; refresh_token: string };
}
const sorted = (scope: string) => scope.split(" ").filter(Boolean).sort();
const all: [string, string][] = [["vault_reach", "all"], ["account_vault_levels", "1"]];

describe("All your vaults (T-476)", () => {
  test("the owner's All mints every vault at write and leave to make vaults; the page starts on it at /mcp only", async () => {
    const { db, cleanup } = hub();
    try {
      const me = await person(db);
      const cid = app(db);
      const p = pkce();
      const html = await (page(db, me.sid, cid, p.challenge, "account:vaults", `${ISSUER}/mcp`)).text();
      expect(html).toMatch(/name="vault_reach" value="all" checked/);
      // any other account-door ask (the app listing its person's vaults, /account/mcp) starts on "Only these"
      for (const resource of [undefined, `${ISSUER}/account/mcp`]) {
        const other = await (page(db, me.sid, cid, pkce().challenge, "account:vaults", resource)).text();
        expect(other, String(resource)).toMatch(/name="vault_reach" value="chosen" checked/);
        expect(other, String(resource)).not.toMatch(/name="vault_reach" value="all" checked/);
      }
      const t = await tokens(db, await answer(db, me.sid, cid, p.challenge, all), cid, p.verifier);
      expect(sorted(t.scope)).toEqual(ALL);
    } finally { cleanup(); }
  });

  test("All replaces an earlier per-vault choice: a later plain ask replays All, not work=read beside it", async () => {
    const { db, cleanup } = hub();
    try {
      const me = await person(db);
      const cid = app(db);
      let p = pkce();
      await tokens(db, await answer(db, me.sid, cid, p.challenge, [["vault_reach", "chosen"], ["account_vault_levels", "1"], ["vault_level:work", "read"]]), cid, p.verifier);
      p = pkce();
      await tokens(db, await answer(db, me.sid, cid, p.challenge, all), cid, p.verifier);
      expect([...findGrant(db, me.id, cid)!.scopes].sort()).toEqual(ALL);
      p = pkce();
      const replay = page(db, me.sid, cid, p.challenge);
      expect(replay.status).toBe(302);
      expect(sorted((await tokens(db, replay, cid, p.verifier)).scope)).toEqual(ALL);
    } finally { cleanup(); }
  });

  test("All replaces an earlier level-less grant, so the owner's admin never comes back on a replay", async () => {
    const { db, cleanup } = hub();
    try {
      const me = await person(db);
      const cid = app(db);
      recordGrant(db, me.id, cid, ["account:self:vaults"]);
      let p = pkce();
      await tokens(db, await answer(db, me.sid, cid, p.challenge, all, "account:vaults account:self:read"), cid, p.verifier);
      expect(findGrant(db, me.id, cid)!.scopes).not.toContain("account:self:vaults");
      p = pkce();
      const replay = page(db, me.sid, cid, p.challenge);
      const scope = (await tokens(db, replay, cid, p.verifier)).scope;
      expect(sorted(scope)).toEqual(ALL);
    } finally { cleanup(); }
  });

  test("narrowing from All to one vault ends the All token's refresh", async () => {
    const { db, cleanup } = hub();
    try {
      const me = await person(db);
      const cid = app(db);
      let p = pkce();
      const wide = await tokens(db, await answer(db, me.sid, cid, p.challenge, all), cid, p.verifier);
      p = pkce();
      await tokens(db, await answer(db, me.sid, cid, p.challenge, [["vault_reach", "chosen"], ["account_vault_levels", "1"], ["vault_level:work", "read"]]), cid, p.verifier);
      const refresh = await handleToken(db, new Request(`${ISSUER}/oauth/token`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: wide.refresh_token, client_id: cid }),
      }), deps());
      expect(refresh.status).not.toBe(200);
    } finally { cleanup(); }
  });

  test("a hub with no vault yet offers All, and Approve works", async () => {
    const { db, cleanup } = hub();
    try {
      const me = await person(db);
      const cid = app(db);
      const p = pkce();
      const none = { services: [] };
      const html = await (page(db, me.sid, cid, p.challenge, "account:vaults", `${ISSUER}/mcp`, none)).text();
      expect(html).toMatch(/name="vault_reach" value="all" checked/);
      expect(html).not.toMatch(/name="approve" value="yes"[^>]*disabled/);
      const t = await tokens(db, await answer(db, me.sid, cid, p.challenge, [["vault_reach", "all"]], "account:vaults", `${ISSUER}/mcp`, none), cid, p.verifier);
      expect(sorted(t.scope)).toEqual(ALL);
    } finally { cleanup(); }
  });

  test("someone who isn't the hub's owner can't choose All, nor ask for its scopes", async () => {
    const { db, cleanup } = hub();
    try {
      const friend = await person(db, false);
      const cid = app(db);
      let p = pkce();
      const refused = await answer(db, friend.sid, cid, p.challenge, [["vault_reach", "all"]]);
      expect(refused.status).toBe(400);
      p = pkce();
      const t = await tokens(db, await answer(db, friend.sid, cid, p.challenge,
        [["account_vault_levels", "1"], ["vault_level:work", "write"], ["extra_scope", "account:self:vault-create"], ["extra_scope", "account:self:vaults:*:write"]],
        "account:vaults account:self:vault-create account:self:vaults:*:write"), cid, p.verifier);
      for (const s of ALL) expect(t.scope.split(" ")).not.toContain(s);
    } finally { cleanup(); }
  });

  test("an app can't ask for leave to make vaults itself, in any spelling", async () => {
    const { db, cleanup } = hub();
    try {
      const me = await person(db);
      const cid = app(db);
      const p = pkce();
      const t = await tokens(db, await answer(db, me.sid, cid, p.challenge, [["vault_reach", "chosen"], ["account_vault_levels", "1"], ["vault_level:work", "read"]],
        "account:vaults account:self:vault-create ACCOUNT:SELF:VAULT-CREATE account:self:vaults:*:write"), cid, p.verifier);
      expect(t.scope).toBe("account:self:vaults:work:read");
    } finally { cleanup(); }
  });

  test("a one-vault page from before the one address, posted at /mcp, is refused, not read as every vault", async () => {
    const { db, cleanup } = hub();
    try {
      const me = await person(db);
      const cid = app(db);
      const p = pkce();
      const res = await answer(db, me.sid, cid, p.challenge, [["vault_pick", "work"]], "vault:read", `${ISSUER}/mcp`);
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      // Deny on that page still tells the app
      const form = new URLSearchParams({ __action: "consent", __csrf: CSRF, approve: "no", vault_pick: "work", ...ask(cid, p.challenge, "vault:read", `${ISSUER}/mcp`) });
      const denied = await handleAuthorizePost(db, new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie(me.sid) },
      }), deps());
      expect(denied.status).toBe(302);
      expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
    } finally { cleanup(); }
  });
});
