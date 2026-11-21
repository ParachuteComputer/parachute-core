// Sharing a vault with a friend (T-476; app docs/design/SHARING.md, docs/SPEC-1.0-grants.md §5.1): the owner's key
// invites someone to one vault by name at the account door; the friend reads the invite with its code alone, accepts
// it with their own key, and reaches that vault and no other, as a member (read and write, never admin); the owner
// ends it and the friend's next request is refused. HTTP and MCP only. A box has it; Cloud and the personal door don't
// yet (deliberate.json `share-a-vault`).
import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { accountToken, door, enc, lacks, nostrAuth, safeFetch } from "./_door.ts";

const d = door();
const accountMcp = () => `${d.issuer}/account/mcp`;
const newKey = () => randomBytes(32).toString("hex");

/** One account-door tool, signed by `secret` (NIP-98): `{ok, body}` where body is the tool's answer or its words. */
async function tool(secret: string, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; body: any }> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const res = await safeFetch(accountMcp(), {
    method: "POST",
    headers: { authorization: await nostrAuth(secret, accountMcp(), "POST", body), "content-type": "application/json", accept: "application/json, text/event-stream" },
    body,
  });
  const text = await res.text();
  if (res.status !== 200) return { ok: false, body: `${res.status} ${text.slice(0, 200)}` };
  const json = JSON.parse(text.trimStart().startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data:")) ?? "data:{}").slice(5));
  const inner = json.result?.content?.[0]?.text ?? json.error?.message ?? "";
  if (json.error || json.result?.isError) return { ok: false, body: inner };
  try { return { ok: true, body: JSON.parse(inner) }; } catch { return { ok: true, body: inner }; }
}

/** The friend's side: read an invite (no credential), or accept it signed by `secret`. */
async function friend(path: "look" | "accept", code: string, secret?: string): Promise<{ status: number; body: any }> {
  const url = `${d.issuer}/account/invites/${path}`;
  const body = JSON.stringify({ code });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers.authorization = await nostrAuth(secret, url, "POST", body);
  const res = await safeFetch(url, { method: "POST", headers, body });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const reaches = async (secret: string) => {
  const r = await tool(secret, "list-vaults", {});
  return r.ok ? (r.body.vaults as { name: string }[]).map((v) => v.name) : [];
};

describe.skipIf(lacks("share-a-vault") || !d.ownerKey)("sharing a vault with a friend", () => {
  test("invite by name, read it, accept with your own key: that vault only, as a member; ending it stops the next request", async () => {
    const owner = d.ownerKey!;
    const made = await tool(owner, "invite-to-vault", { vault: d.vault, name: "Bo", from: "Aaron" });
    expect(made.ok, String(made.body)).toBe(true);
    const code = String(made.body.url).split("#")[1]!;
    expect(made.body.url).toBe(`${d.issuer}/invite#${code}`);

    // read with the code alone: who, where, what; nothing used
    const look = await friend("look", code);
    expect(look.status).toBe(200);
    expect(look.body).toMatchObject({ vault: d.vault, from: "Aaron", name: "Bo", can: "read and write" });

    // accepted with Bo's own key: he reaches this vault and not the owner's other one
    const bo = newKey();
    expect((await friend("accept", code)).status).toBe(401);
    const accepted = await friend("accept", code, bo);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ vault: d.vault, name: "Bo" });
    const his = await reaches(bo);
    expect(his).toContain(d.vault);
    expect(his).not.toContain(d.otherVault);
    // a member reads and writes, and can't invite anyone
    expect((await tool(bo, "query-records", { vault: d.vault, limit: 1 })).ok).toBe(true);
    expect((await tool(bo, "invite-to-vault", { vault: d.vault, name: "Mallory" })).ok).toBe(false);

    // used once: a second accept, by anyone, is the one 404
    const again = await friend("accept", code, newKey());
    expect(again.status).toBe(404);
    expect(again.body?.error).toBe("no_invite");

    // the owner's list names him; End, and his next request is refused
    const listed = await tool(owner, "list-access", { vault: d.vault });
    const row = (listed.body.access as { pubkey: string; role: string; name: string | null }[]).find((r) => r.name === "Bo");
    expect(row?.role).toBe("member");
    expect((await tool(owner, "revoke-access", { pubkey: row!.pubkey, vault: d.vault })).body.revoked).toBe(true);
    expect(await reaches(bo)).not.toContain(d.vault);
    expect((await tool(bo, "query-records", { vault: d.vault, limit: 1 })).ok).toBe(false);
  });

  test("taken back before anyone accepts, an invite opens nothing", async () => {
    const owner = d.ownerKey!;
    const made = await tool(owner, "invite-to-vault", { vault: d.vault, name: "Cy" });
    const code = String(made.body.url).split("#")[1]!;
    expect((await tool(owner, "take-back-invite", { vault: d.vault, id: made.body.id })).body.taken_back).toBe(true);
    expect((await friend("look", code)).status).toBe(404);
    const cy = newKey();
    expect((await friend("accept", code, cy)).status).toBe(404);
    expect(await reaches(cy)).not.toContain(d.vault);
  });
});

/** The owner's list of who reaches the vault (spec §7.1), or ending one row of it. */
async function statements(method: "GET" | "DELETE", id?: string): Promise<{ status: number; body: any }> {
  const res = await safeFetch(`${d.issuer}/account/vaults/${enc(d.vault)}/statements${id === undefined ? "" : `/${enc(id)}`}`, {
    method,
    headers: { authorization: `Bearer ${await accountToken()}` },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const setCookie = (r: Response, name: string) => {
  for (const c of r.headers.getSetCookie()) if (c.startsWith(`${name}=`)) return c.split(";")[0]!.slice(name.length + 1);
};
const REDIRECT = "https://their-parachute.example/oauth/callback";

/**
 * A person's own Parachute signing in to the vault, as the app does: the hub's key door with their key, then OAuth (the
 * consent page's Approve when it shows). `{status, token}`: the access token, or null and the step's status.
 */
async function theirToken(secret: string): Promise<{ status: number; token: string | null; step?: string }> {
  const { schnorr } = await import("@noble/curves/secp256k1.js");
  const sk = Buffer.from(secret, "hex");
  const pubkey = Buffer.from(schnorr.getPublicKey(sk)).toString("hex");
  const ch: any = await (await safeFetch(`${d.issuer}/api/auth/nostr/challenge`)).json();
  const tags = ch.event_template.tags as string[][];
  const ev: Record<string, unknown> = { pubkey, created_at: Math.floor(Date.now() / 1000), kind: ch.event_template.kind, tags, content: ch.event_template.content };
  const id = createHash("sha256").update(JSON.stringify([0, pubkey, ev.created_at, ev.kind, tags, ev.content])).digest();
  ev.id = id.toString("hex");
  ev.sig = Buffer.from(schnorr.sign(id, sk)).toString("hex");
  const door = await safeFetch(`${d.issuer}/api/auth/nostr/verify`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: ev }) });
  const session = setCookie(door, "parachute_hub_session");
  if (!session) return { status: door.status, token: null, step: "key door" };
  const registered = await safeFetch(`${d.issuer}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Dee's notes app", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
  const reg: any = await registered.json().catch(() => ({}));
  if (registered.status !== 201) return { status: registered.status, token: null, step: `register ${JSON.stringify(reg).slice(0, 200)}` };
  const verifier = randomBytes(32).toString("base64url");
  const params = { client_id: reg.client_id, redirect_uri: REDIRECT, response_type: "code", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256", scope: `vault:${d.vault}:read vault:${d.vault}:write`, state: randomBytes(8).toString("hex") };
  const auth = await safeFetch(`${d.issuer}/oauth/authorize?${new URLSearchParams(params)}`, { redirect: "manual", headers: { cookie: `parachute_hub_session=${session}` } });
  let location = auth.headers.get("location");
  if (auth.status !== 302) {
    const html = await auth.text();
    if (auth.status !== 200 || !html.includes('value="consent"')) return { status: auth.status, token: null, step: `authorize ${html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 600)}` };
    const csrf = setCookie(auth, "parachute_hub_csrf") ?? "";
    const consent = await safeFetch(`${d.issuer}/oauth/authorize`, { method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: `parachute_hub_session=${session}; parachute_hub_csrf=${csrf}`, origin: d.issuer },
      body: new URLSearchParams({ ...params, __action: "consent", __csrf: html.match(/name="__csrf"\s+value="([^"]+)"/)?.[1] ?? csrf, approve: "yes", vault_pick: d.vault }) });
    await consent.arrayBuffer();
    if (consent.status !== 302) return { status: consent.status, token: null, step: "consent" };
    location = consent.headers.get("location");
  }
  const code = new URL(location ?? "about:blank").searchParams.get("code");
  if (!code) return { status: 302, token: null, step: `no code: ${location}` };
  const tok = await safeFetch(`${d.issuer}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: REDIRECT, code_verifier: verifier }) });
  const j: any = await tok.json().catch(() => ({}));
  return { status: tok.status, step: `token ${JSON.stringify(j).slice(0, 200)}`, token: tok.ok && typeof j.access_token === "string" && String(j.scope ?? "").includes(`vault:${d.vault}:`) ? j.access_token : null };
}

// One list (T-476, spec §5.1 and §7.1): a member is one row in who reaches the vault, `by self`, named as invited, never
// also one row per credential of theirs; ending that row ends their membership, so they can't sign in again.
describe.skipIf(lacks("share-a-vault") || lacks("typed-keys") || !d.ownerKey)("a person in the list of who reaches the vault", () => {
  test("a member is one row, by self; ending it ends the membership, not one sign-in", async () => {
    const owner = d.ownerKey!;
    const made = await tool(owner, "invite-to-vault", { vault: d.vault, name: "Dee", from: "Aaron" });
    expect(made.ok, String(made.body)).toBe(true);
    const dee = newKey();
    expect((await friend("accept", String(made.body.url).split("#")[1]!, dee)).status).toBe(200);
    const pubkey = ((await tool(owner, "list-access", { vault: d.vault })).body.access as { pubkey: string; name: string | null }[]).find((r) => r.name === "Dee")!.pubkey;
    // she signs in from her own Parachute: a credential of hers reaches the vault
    const held = await theirToken(dee);
    expect(held.token, `her vault token: ${held.status} ${held.step}`).toBeString();
    const read = () => safeFetch(`${d.issuer}/vault/${enc(d.vault)}/api/records?limit=1`, { headers: { authorization: `Bearer ${held.token}` } }).then((r) => r.status);
    expect(await read()).toBe(200);

    // the list: Dee once, as a person by self, by the name she was invited by; none of her credentials beside her
    const list = await statements("GET");
    expect(list.status).toBe(200);
    const rows = list.body.grants as { id: string; kind: string; by: string; name: string; grantee: string | null; state: string; types: Record<string, string[]> }[];
    const hers = rows.filter((r) => r.grantee === pubkey || r.name === "Dee" || (r as { app?: string | null }).app === "Dee's notes app");
    expect(hers).toHaveLength(1);
    expect(hers[0]).toMatchObject({ id: pubkey, kind: "person", by: "self", name: "Dee", grantee: pubkey, state: "in_force", origin: "door" });
    expect(hers[0]!.types).toEqual({ "*": ["read", "create", "update", "delete"] });
    expect(rows.filter((r) => r.kind === "person" && r.by === "self").map((r) => r.id)).toContain(pubkey);

    // ended in the list: her held credential is refused, she is no member, and she can't sign in to it again
    const ended = await statements("DELETE", pubkey);
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(ended.body).toMatchObject({ id: pubkey, state: "revoked" });
    expect(await read()).toBe(401);
    expect(((await tool(owner, "list-access", { vault: d.vault })).body.access as { pubkey: string }[]).map((r) => r.pubkey)).not.toContain(pubkey);
    expect(await reaches(dee)).not.toContain(d.vault);
    expect((await theirToken(dee)).token).toBeNull();
    expect(((await statements("GET")).body.grants as { id: string }[]).map((r) => r.id)).not.toContain(pubkey);
    // ending her again finds nothing
    expect((await statements("DELETE", pubkey)).status).toBe(404);
  });
});
