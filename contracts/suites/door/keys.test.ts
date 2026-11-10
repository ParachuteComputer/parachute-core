// Keys on a 0.9.1 door: the owner signs in with a key they hold, and gives each app a named key that can be
// stopped by name. The same calls at every 0.9.1 door. Runs only there.
import { describe, expect, test } from "bun:test";
import { accountToken, door, fp, lacks, nostrAuth, refusal, rest, runId, safeFetch, shape, vaultUrl } from "./_door.ts";

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
    // 0.9.1 names the key in the write's stamp. Recorded, so a door that doesn't yet shows in the comparison.
    fp("keys/app-key.written-via", String(seen.body.createdVia).replace(name, "<name>"));
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
