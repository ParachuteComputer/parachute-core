// safety/owner-keys: 0.9.1's app keys, NIP-98 owner sign-in and the bare vault (T-414; ROADMAP 0.9.1 "keys by
// name"). Black box: HTTP to the candidate's hub, with a throwaway Nostr key linked to the box's owner by the real
// CLI (`parachute auth link-pubkey`, the step the Uni app asks for). The same wire shapes are cloud's account door.
//
//   1. Sign-in: `POST /account/token` signed with NIP-98 (no cookie, no password) mints the account token, for the
//      owner's key only. A replayed event, an event for another URL or method, an old event and an unlinked key
//      are refused, and an unlinked key never becomes an account.
//   2. App keys: `POST /account/keys {name, vault, can}` mints a named, long-lived key for one vault at read or
//      write, never admin; `GET /account/keys` lists them with when each was last used; `DELETE
//      /account/keys/<name>` revokes one, and the hub refuses it on the very next request (not within 60 s).
//      A key opens its vault at its level and nothing else: not another vault, not the account door, not a mint.
//   3. Bare vault: `POST /account/vaults {name, bare: true}` makes a vault with no notes and no tags; without
//      `bare` the welcome guides are still seeded.
// Red on 0.9.0 (b4a536e): no NIP-98 on /account/token, no /account/keys, `bare` ignored.
import { beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { hubCli } from "../../harness/services.ts";
import { nip98, nostrKey, signEvent } from "../compat/_lib.ts";
import { must, rest, safeFetch, services } from "../lib.ts";

const s = services();
const owner = nostrKey(); // throwaway; linked to the box's owner below
const stranger = nostrKey(); // never linked
const id = () => randomBytes(3).toString("hex");
const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());

async function call(path: string, init: { method?: string; auth?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  const r = await safeFetch(`${s.hub}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.auth ? { authorization: init.auth } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
    body,
  });
  const text = await r.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {}
  return { status: r.status, body: parsed, text };
}

/** Sign in with NIP-98: one fresh event for `POST /account/token`. */
const signIn = (key = owner) => call("/account/token", { method: "POST", auth: nip98(key, `${s.hub}/account/token`, "POST") });

let account = ""; // the owner's account token, from a NIP-98 sign-in

beforeAll(async () => {
  await hubCli(s, ["auth", "link-pubkey", "--user", s.admin.username, owner.pubkey]);
  const r = await signIn();
  must(r.status === 200 && typeof r.body?.token === "string", `NIP-98 sign-in on /account/token: ${r.status} ${r.text.slice(0, 200)}`);
  account = r.body.token;
});

const bearer = () => `Bearer ${account}`;
const mintKey = (body: Record<string, unknown>) => call("/account/keys", { method: "POST", auth: bearer(), body });
const writeNote = (vault: string, token: string) =>
  rest(`${s.hub}/vault/${vault}`, token).post("/notes", { content: "arcade reaction (made up)", path: `reactions/p1/${id()}` });

describe("safety/owner-keys: NIP-98 owner sign-in", () => {
  test("the owner's signed request mints the account token: aud account, short-lived, and it drives /account/*", async () => {
    const c = claims(account);
    expect(c.aud).toBe("account");
    expect(c.exp - c.iat).toBeLessThanOrEqual(15 * 60);
    expect((await call("/account/vaults", { auth: bearer() })).status).toBe(200);
  });

  test("a replayed event is refused", async () => {
    const auth = nip98(owner, `${s.hub}/account/token`, "POST");
    expect((await call("/account/token", { method: "POST", auth })).status).toBe(200);
    expect((await call("/account/token", { method: "POST", auth })).status).toBe(401);
  });

  test("an event signed for another URL or method, or two minutes old, is refused", async () => {
    const other = await call("/account/token", { method: "POST", auth: nip98(owner, `${s.hub}/account/vaults`, "POST") });
    const method = await call("/account/token", { method: "POST", auth: nip98(owner, `${s.hub}/account/token`, "GET") });
    const old = signEvent(owner, {
      created_at: Math.floor(Date.now() / 1000) - 120,
      kind: 27235,
      tags: [["u", `${s.hub}/account/token`], ["method", "POST"]],
      content: "",
    });
    const stale = await call("/account/token", { method: "POST", auth: `Nostr ${Buffer.from(JSON.stringify(old)).toString("base64url")}` });
    expect([other.status, method.status, stale.status]).toEqual([401, 401, 401]);
  });

  test("a body the event doesn't name is refused (payload hash)", async () => {
    const auth = nip98(owner, `${s.hub}/account/token`, "POST", JSON.stringify({ a: 1 }));
    expect((await call("/account/token", { method: "POST", auth, body: { a: 2 } })).status).toBe(401);
  });

  test("an unlinked key is refused and never becomes an account", async () => {
    const r = await signIn(stranger);
    expect(r.status).toBe(401);
    const users = await hubCli(s, ["auth", "list-users"]);
    expect(users).not.toContain(stranger.pubkey.slice(0, 31));
  });
});

describe("safety/owner-keys: app keys", () => {
  test("a write key: named, one vault at read+write, never admin, long-lived; it writes, and the list shows when", async () => {
    const name = `arcade-${id()}`;
    const r = await mintKey({ name, vault: s.vaultName, can: "write" });
    must(r.status === 201, `POST /account/keys: ${r.status} ${r.text.slice(0, 300)}`);
    expect(r.body).toMatchObject({ name, vault: s.vaultName, can: "write", last_used_at: null });
    const c = claims(r.body.token);
    expect(c.scope.split(" ").sort()).toEqual([`vault:${s.vaultName}:read`, `vault:${s.vaultName}:write`]);
    expect(c.aud).toBe(`vault.${s.vaultName}`);
    expect(c.exp - c.iat).toBeGreaterThan(300 * 86400);

    const before = (await call("/account/keys", { auth: bearer() })).body.keys.find((k: any) => k.name === name);
    expect(before).toMatchObject({ name, vault: s.vaultName, can: "write", status: "active", last_used_at: null });
    expect(before.token).toBeUndefined(); // the secret is shown once, at mint

    expect((await writeNote(s.vaultName, r.body.token)).status).toBe(201);
    const after = (await call("/account/keys", { auth: bearer() })).body.keys.find((k: any) => k.name === name);
    expect(typeof after.last_used_at).toBe("string");
    expect(Date.parse(after.last_used_at)).toBeGreaterThan(Date.now() - 60_000);
  });

  test("admin is never mintable as an app key, by `can` or by smuggled scopes", async () => {
    for (const body of [
      { name: `adm-${id()}`, vault: s.vaultName, can: "admin" },
      { name: `adm-${id()}`, vault: s.vaultName, can: "write", scopes: [`vault:${s.vaultName}:admin`] },
      { name: `adm-${id()}`, vault: s.vaultName, can: "owner" },
    ]) {
      const r = await mintKey(body);
      expect({ body, status: r.status, token: r.body?.token }).toEqual({ body, status: 400, token: undefined });
    }
    const names = (await call("/account/keys", { auth: bearer() })).body.keys.map((k: any) => k.name);
    expect(names.filter((n: string) => n.startsWith("adm-"))).toEqual([]);
  });

  test("a name is one key; a bad name, a missing vault and an unknown vault are refused", async () => {
    const name = `dup-${id()}`;
    expect((await mintKey({ name, vault: s.vaultName, can: "read" })).status).toBe(201);
    expect((await mintKey({ name, vault: s.vaultName, can: "read" })).status).toBe(409);
    expect((await mintKey({ name: "has space", vault: s.vaultName, can: "read" })).status).toBe(400);
    expect((await mintKey({ name: `nv-${id()}`, can: "read" })).status).toBe(400);
    expect((await mintKey({ name: `nv-${id()}`, vault: `nope${id()}`, can: "read" })).status).toBe(404);
  });

  test("a key opens its vault at its level and nothing else", async () => {
    const other = `ok${id()}`;
    expect((await call("/account/vaults", { method: "POST", auth: bearer(), body: { name: other, bare: true } })).status).toBe(201);
    const read = (await mintKey({ name: `r-${id()}`, vault: s.vaultName, can: "read" })).body.token;
    const write = (await mintKey({ name: `w-${id()}`, vault: s.vaultName, can: "write" })).body.token;
    expect((await rest(`${s.hub}/vault/${s.vaultName}`, read).get("/notes?limit=1")).status).toBe(200);
    expect((await writeNote(s.vaultName, read)).status).toBe(403);
    expect([401, 403]).toContain((await writeNote(other, write)).status); // another vault
    expect([401, 403]).toContain((await rest(`${s.hub}/vault/${other}`, write).get("/notes?limit=1")).status);
    expect([401, 403]).toContain((await call("/account/keys", { auth: `Bearer ${write}` })).status); // not the account door
    expect([401, 403]).toContain(
      (await call("/account/keys", { method: "POST", auth: `Bearer ${write}`, body: { name: `x-${id()}`, vault: s.vaultName, can: "write" } })).status,
    );
    const mint = await call("/api/auth/mint-token", { method: "POST", auth: `Bearer ${write}`, body: { scope: `vault:${s.vaultName}:admin` } });
    expect([401, 403]).toContain(mint.status); // can't mint itself up to admin
  });

  test("revoking a key refuses its next request at once, and the list says revoked", async () => {
    const name = `rev-${id()}`;
    const key = (await mintKey({ name, vault: s.vaultName, can: "write" })).body.token;
    expect((await writeNote(s.vaultName, key)).status).toBe(201);
    const del = await call(`/account/keys/${name}`, { method: "DELETE", auth: bearer() });
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ name });
    expect((await writeNote(s.vaultName, key)).status).toBe(401);
    expect((await rest(`${s.hub}/vault/${s.vaultName}`, key).get("/notes?limit=1")).status).toBe(401);
    const listed = (await call("/account/keys", { auth: bearer() })).body.keys.find((k: any) => k.name === name);
    expect(listed.status).toBe("revoked");
    expect((await call(`/account/keys/${name}`, { method: "DELETE", auth: bearer() })).status).toBe(200); // idempotent
    expect((await call(`/account/keys/nope-${id()}`, { method: "DELETE", auth: bearer() })).status).toBe(404);
    // A revoked name stays taken: a new key never inherits an old key's history.
    expect((await mintKey({ name, vault: s.vaultName, can: "write" })).status).toBe(409);
  });

  test("a revoked key is refused at once however it is presented: lower-case bearer, X-API-Key, ?key=, root /mcp", async () => {
    const name = `alt-${id()}`;
    const key = (await mintKey({ name, vault: s.vaultName, can: "write" })).body.token;
    expect((await call(`/account/keys/${name}`, { method: "DELETE", auth: bearer() })).status).toBe(200);
    const v = `/vault/${s.vaultName}/api/notes?limit=1`;
    expect((await call(v, { auth: `bearer ${key}` })).status).toBe(401);
    expect((await call(v, { headers: { "x-api-key": key } })).status).toBe(401);
    expect((await call(`${v}&key=${key}`)).status).toBe(401);
    const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const root = await call("/mcp", { method: "POST", auth: `Bearer ${key}`, body: rpc, headers: { accept: "application/json, text/event-stream" } });
    expect(root.status).toBe(401);
  });

  test("deleting a vault ends its keys", async () => {
    const v = `del${id()}`;
    expect((await call("/account/vaults", { method: "POST", auth: bearer(), body: { name: v, bare: true } })).status).toBe(201);
    const name = `dv-${id()}`;
    const key = (await mintKey({ name, vault: v, can: "write" })).body.token;
    expect((await writeNote(v, key)).status).toBe(201);
    expect((await call(`/account/vaults/${v}`, { method: "DELETE", auth: bearer() })).status).toBe(200);
    const listed = (await call("/account/keys", { auth: bearer() })).body.keys.find((k: any) => k.name === name);
    expect(listed.status).toBe("revoked");
  });

  test("/account/keys needs the account token", async () => {
    expect((await call("/account/keys")).status).toBe(401);
    expect((await call("/account/keys", { method: "POST", body: { name: `n-${id()}`, vault: s.vaultName, can: "read" } })).status).toBe(401);
  });
});

describe("safety/owner-keys: bare vault", () => {
  async function created(body: Record<string, unknown>) {
    const r = await call("/account/vaults", { method: "POST", auth: bearer(), body });
    must(r.status === 201, `POST /account/vaults ${JSON.stringify(body)}: ${r.status} ${r.text.slice(0, 300)}`);
    return rest(`${s.hub}/vault/${body.name}`, r.body.vault_token);
  }

  test("bare: true makes a vault with no notes and no tags; without it the guides are seeded", async () => {
    const bare = await created({ name: `bare${id()}`, bare: true });
    const notes = await bare.get("/notes?limit=50");
    expect(notes.status).toBe(200);
    expect(notes.body).toEqual([]);
    const tags = await bare.get("/tags");
    expect(tags.status).toBe(200);
    expect(Array.isArray(tags.body) ? tags.body : tags.body?.tags ?? []).toEqual([]);

    const seeded = await created({ name: `seed${id()}` });
    expect((await seeded.get("/notes?limit=50")).body.length).toBeGreaterThan(0);
  });

  test("bare must be a boolean", async () => {
    const r = await call("/account/vaults", { method: "POST", auth: bearer(), body: { name: `b${id()}`, bare: "yes" } });
    expect(r.status).toBe(400);
  });
});
