// Keys on a 0.9.1 door: the owner signs in with a key they hold, and gives each app a named key that can be
// stopped by name. The same calls at every 0.9.1 door. Runs only there.
import { describe, expect, test } from "bun:test";
import { accountToken, door, fp, lacks, mcp, nostrAuth, refusal, rest, runId, safeFetch, shape, vaultUrl } from "./_door.ts";

const is09 = door().release === "0.9.1"; // owner keys and named app keys arrived with 0.9.1
const d = door();
const bearer = async () => ({ authorization: `Bearer ${await accountToken()}`, "content-type": "application/json" });
const withKey = (token: string, method: string, path: string, body?: unknown) =>
  safeFetch(`${vaultUrl()}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });

describe.skipIf(!is09)("the owner's key", () => {
  test("the owner signs in with the key: one signed request, an account credential back", async () => {
    expect(d.ownerKey, "a 0.9 door file carries a made-up owner key").toBeString();
    const url = `${d.issuer}/account/token`;
    const r = await safeFetch(url, { method: "POST", headers: { authorization: await nostrAuth(d.ownerKey!, url, "POST") } });
    expect(r.status, (await r.clone().text()).slice(0, 200)).toBe(200);
    const body = await r.json();
    expect(body.token).toBeString();
    fp("keys/owner-key.reply.shape", shape(body));
    const claims = JSON.parse(Buffer.from(body.token.split(".")[1], "base64url").toString());
    expect(claims.aud).toBe("account");
  });

  test("a key the door doesn't know, a replayed proof and a proof for another address are refused", async () => {
    const url = `${d.issuer}/account/token`;
    const stranger = "11".repeat(32);
    const unknown = await safeFetch(url, { method: "POST", headers: { authorization: await nostrAuth(stranger, url, "POST") } });
    expect(unknown.status).toBe(401);
    fp("keys/refusal.unknown-key", { status: unknown.status, error: (await unknown.json().catch(() => ({}))).error ?? null });
    const proof = await nostrAuth(d.ownerKey!, url, "POST");
    expect((await safeFetch(url, { method: "POST", headers: { authorization: proof } })).status).toBe(200);
    const replay = await safeFetch(url, { method: "POST", headers: { authorization: proof } });
    expect(replay.status).toBe(401);
    fp("keys/refusal.replayed-proof", { status: replay.status, error: (await replay.json().catch(() => ({}))).error ?? null });
    const elsewhere = await safeFetch(url, { method: "POST", headers: { authorization: await nostrAuth(d.ownerKey!, `${d.issuer}/account/vaults`, "POST") } });
    expect(elsewhere.status).toBe(401);
  });

  test.skipIf(lacks("sign-in-keys-on-the-account-door"))("the account lists its sign-in keys", async () => {
    const r = await safeFetch(`${d.issuer}/account/pubkeys`, { headers: await bearer() });
    fp("keys/pubkeys.list", { status: r.status, shape: r.status === 200 ? shape(await r.json()) : null });
    expect(r.status).toBe(200);
  });
});

describe.skipIf(!is09)("named app keys", () => {
  test("an app key is minted by name, writes under its name, shows in the list, and stops when revoked", async () => {
    const name = `door-app-${runId("k")}`;
    const made = await safeFetch(`${d.issuer}/account/keys`, { method: "POST", headers: await bearer(), body: JSON.stringify({ name, vault: d.vault, can: "write" }) });
    expect(made.status, (await made.clone().text()).slice(0, 200)).toBe(201);
    const key = await made.json();
    expect(key.token).toBeString();
    fp("keys/app-key.mint.shape", shape(key));
    const claims = JSON.parse(Buffer.from(key.token.split(".")[1], "base64url").toString());
    expect(claims.scope).toBe(`vault:${d.vault}:read vault:${d.vault}:write`);
    fp("keys/app-key.lifetime-days", Math.round((claims.exp - claims.iat) / 86400));

    const path = `${runId("keys")}/by-key`;
    const w = await withKey(key.token, "POST", "/notes", { content: "by an app key", path });
    expect(w.status).toBe(201);
    const seen = await rest("read").get(`/notes/${encodeURIComponent(path)}`);
    // 0.9.1 names the key in the write's stamp, never the channel: `key:<name>`.
    fp("keys/app-key.written-via", String(seen.body.createdVia).replace(name, "<name>"));
    expect(seen.body.createdVia).toBe(`key:${name}`);
    const admin = await withKey(key.token, "PUT", `/tags/${runId("t")}`, { fields: { a: { type: "string" } } });
    expect(admin.status).toBe(403);

    const listed = await (await safeFetch(`${d.issuer}/account/keys`, { headers: await bearer() })).json();
    const mine = listed.keys.find((k: any) => k.name === name);
    expect(mine).toBeTruthy();
    expect(mine.token).toBeUndefined();
    fp("keys/app-key.list.item.shape", shape(mine));

    const again = await safeFetch(`${d.issuer}/account/keys`, { method: "POST", headers: await bearer(), body: JSON.stringify({ name, vault: d.vault, can: "read" }) });
    expect(again.status).toBe(409);
    fp("keys/refusal.name-taken", { status: again.status, error: (await again.json()).error ?? null });
    const asAdmin = await safeFetch(`${d.issuer}/account/keys`, { method: "POST", headers: await bearer(), body: JSON.stringify({ name: `${name}-a`, vault: d.vault, can: "admin" }) });
    expect(asAdmin.status).toBe(400);
    fp("keys/refusal.admin-key", { status: asAdmin.status, error: (await asAdmin.json()).error ?? null });

    const gone = await safeFetch(`${d.issuer}/account/keys/${name}`, { method: "DELETE", headers: await bearer() });
    expect(gone.status).toBe(200);
    fp("keys/app-key.revoke.shape", shape(await gone.json()));
    const after = await withKey(key.token, "GET", "/notes?limit=1");
    expect(after.status).toBe(401);
    fp("keys/refusal.revoked-key", refusal({ status: after.status, body: await after.json().catch(() => null), headers: after.headers, text: "" }));
  });
});

describe.skipIf(!is09)("the write stamp names the key", () => {
  test("a write by key \"claude\" reads back via key:claude on /api/notes, /api/records and MCP, and on its revision with the key's kind", async () => {
    const name = `claude-${runId("k").toLowerCase()}`.slice(0, 60);
    const made = await safeFetch(`${d.issuer}/account/keys`, { method: "POST", headers: await bearer(), body: JSON.stringify({ name, vault: d.vault, can: "write" }) });
    expect(made.status, (await made.clone().text()).slice(0, 200)).toBe(201);
    const key = (await made.json()).token as string;
    const base = runId("stamp");
    const reader = rest("read");
    const via = async (p: string) => (await reader.get(`/notes/${encodeURIComponent(p)}`)).body;

    expect((await withKey(key, "POST", "/notes", { content: "one", path: `${base}/notes` })).status).toBe(201);
    const rec = await withKey(key, "POST", "/records", { body: "two", path: `${base}/records` });
    expect(rec.status, (await rec.clone().text()).slice(0, 300)).toBe(201);
    const c = await mcp("write", { bearer: key });
    try {
      await c.call("create-note", { content: "three", path: `${base}/mcp` });
      await c.call("update-note", { id: `${base}/mcp`, content: "three, again", force: true });
    } finally {
      await c.close();
    }
    const stamps = await Promise.all(["notes", "records", "mcp"].map(async (p) => {
      const n = await via(`${base}/${p}`);
      return { door: p, createdVia: n.createdVia, lastUpdatedVia: n.lastUpdatedVia };
    }));
    fp("keys/write-stamp.via", stamps.map((s) => ({ ...s, createdVia: String(s.createdVia).replace(name, "<name>"), lastUpdatedVia: String(s.lastUpdatedVia).replace(name, "<name>") })));
    for (const s of stamps) expect(s, s.door).toEqual({ door: s.door, createdVia: `key:${name}`, lastUpdatedVia: `key:${name}` });

    // The revision holds the content the key replaced, stamped with the key that replaced it.
    const id = (await via(`${base}/mcp`)).id;
    const versions = (await reader.get(`/notes/${encodeURIComponent(id)}/versions`)).body.versions as any[];
    fp("keys/write-stamp.revision.via", String(versions[0]?.via).replace(name, "<name>"));
    expect(versions[0]?.via).toBe(`key:${name}`);
    if (!lacks("revision-key-kind")) {
      // ...and what kind of key it was (the keys table's owner kind).
      fp("keys/write-stamp.revision.kind", versions[0]?.via_kind ?? null);
      expect(versions[0]?.via_kind).toBe("app");
    }
  });

  test.skipIf(lacks("on-behalf-of"))("a key the owner let write on behalf of others stamps by <name>:<id>; a key without it is refused", async () => {
    const name = `portal-${runId("k").toLowerCase()}`.slice(0, 60);
    const mint = (n: string, onBehalf: boolean) =>
      safeFetch(`${d.issuer}/account/keys`, { method: "POST", headers: bearer(), body: JSON.stringify({ name: n, vault: d.vault, can: "write", ...(onBehalf ? { on_behalf_of: true } : {}) }) });
    const bearer = () => ({ authorization: `Bearer ${accountTokenValue}`, "content-type": "application/json" });
    const accountTokenValue = await accountToken();
    const made = await mint(name, true);
    expect(made.status, (await made.clone().text()).slice(0, 200)).toBe(201);
    const granted = (await made.json()).token as string;
    const plain = (await (await mint(`${name}-plain`, false)).json()).token as string;
    const reserved = await mint("surface", true);
    fp("keys/on-behalf.refusal.reserved-name", { status: reserved.status, error: (await reserved.json()).error ?? null });
    expect(reserved.status).toBe(400);

    const path = `${runId("onbehalf")}/one`;
    const header = { "Parachute-On-Behalf-Of": "client-42" };
    const post = (token: string, p: string) =>
      safeFetch(`${vaultUrl()}/api/notes`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...header }, body: JSON.stringify({ content: "for a client", path: p }) });
    expect((await post(granted, path)).status).toBe(201);
    const seen = (await rest("read").get(`/notes/${encodeURIComponent(path)}`)).body;
    fp("keys/on-behalf.stamp", { by: String(seen.createdBy).replace(name, "<name>"), via: String(seen.createdVia).replace(name, "<name>") });
    expect(seen.createdBy).toBe(`${name}:client-42`);
    expect(seen.createdVia).toBe(`key:${name}`);
    const refused = await post(plain, `${path}-plain`);
    fp("keys/on-behalf.refusal.not-granted", refusal({ status: refused.status, body: await refused.json().catch(() => null), headers: refused.headers, text: "" }));
    expect(refused.status).toBe(403);
    expect((await rest("read").get(`/notes/${encodeURIComponent(`${path}-plain`)}`)).status).toBe(404);
  });
});
