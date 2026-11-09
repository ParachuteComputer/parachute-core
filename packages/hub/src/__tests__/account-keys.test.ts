/**
 * 0.9.1 owner keys (T-414): the security edges the black-box contract (contracts/suites/safety/owner-keys) can't
 * reach on a one-owner box: a linked key that isn't the owner's, and one account's app keys hidden from another.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";
import { routeAccountKeys } from "../account-keys.ts";
import { handleAccountToken } from "../account-token.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { signAccessToken } from "../jwt-sign.ts";
import { listKeys, touchKey } from "../keys.ts";
import { NOSTR_AUTH_KIND, nostrEventId } from "../nostr-event.ts";
import { NostrReplayCache } from "../nostr-http-auth.ts";
import { bindPubkeyOperatorAttested } from "../pubkey-links.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

const ISSUER = "https://hub.test";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

let db: Database;
let dir: string;
let manifestPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phub-account-keys-"));
  db = openHubDb(hubDbPath(dir));
  rotateSigningKey(db);
  manifestPath = join(dir, "services.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({ services: [{ name: "parachute-vault", port: 4101, paths: ["/vault/arcade"], health: "/health", version: "0.9.0" }] }),
  );
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function signedTokenRequest(secret: Uint8Array): Request {
  const unsigned = {
    pubkey: hex(schnorr.getPublicKey(secret)),
    created_at: Math.floor(Date.now() / 1000),
    kind: NOSTR_AUTH_KIND,
    tags: [["u", `${ISSUER}/account/token`], ["method", "POST"]],
    content: "",
  };
  const id = nostrEventId(unsigned);
  const event = { ...unsigned, id, sig: hex(schnorr.sign(Uint8Array.from(Buffer.from(id, "hex")), secret)) };
  return new Request(`${ISSUER}/account/token`, {
    method: "POST",
    headers: { authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64url")}` },
  });
}

describe("POST /account/token with NIP-98", () => {
  test("the owner's linked key gets the account token and no cookie; a friend's linked key is refused", async () => {
    const owner = await createUser(db, "owner", "owner-passphrase-1");
    const friend = await createUser(db, "friend", "friend-passphrase-1", { allowMulti: true });
    const ownerSecret = Uint8Array.from(Buffer.from("11".repeat(32), "hex"));
    const friendSecret = Uint8Array.from(Buffer.from("22".repeat(32), "hex"));
    bindPubkeyOperatorAttested(db, { userId: owner.id, pubkey: hex(schnorr.getPublicKey(ownerSecret)) });
    bindPubkeyOperatorAttested(db, { userId: friend.id, pubkey: hex(schnorr.getPublicKey(friendSecret)) });
    const deps = { db, issuer: ISSUER, replay: new NostrReplayCache(), peerAddr: "127.0.0.1" };

    const ok = await handleAccountToken(signedTokenRequest(ownerSecret), deps);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toBeNull();
    const body = (await ok.json()) as { token: string; aud: string };
    expect(body.aud).toBe("account");

    const no = await handleAccountToken(signedTokenRequest(friendSecret), deps);
    expect(no.status).toBe(403);
    expect(((await no.json()) as { error: string }).error).toBe("not_admin");
  });
});

describe("/account/keys", () => {
  async function accountBearer(sub: string) {
    return (
      await signAccessToken(db, { sub, scopes: ["account:self:admin"], audience: "account", clientId: "t", issuer: ISSUER, ttlSeconds: 600 })
    ).token;
  }
  const call = (path: string, token: string, method = "GET", body?: unknown) =>
    routeAccountKeys(
      new Request(`${ISSUER}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }),
      path,
      { db, issuer: ISSUER, manifestPath },
    ) as Promise<Response>;

  test("one account's app keys are invisible and unrevocable to another", async () => {
    const a = await createUser(db, "alice", "alice-passphrase-1");
    const b = await createUser(db, "bob", "bob-passphrase-1", { allowMulti: true });
    const ta = await accountBearer(a.id);
    const tb = await accountBearer(b.id);
    const made = await call("/account/keys", ta, "POST", { name: "arcade", vault: "arcade", can: "write" });
    expect(made.status).toBe(201);
    const listB = (await (await call("/account/keys", tb)).json()) as { keys: unknown[] };
    expect(listB.keys).toEqual([]);
    expect((await call("/account/keys/arcade", tb, "DELETE")).status).toBe(404);
    const listA = (await (await call("/account/keys", ta)).json()) as { keys: { name: string; status: string }[] };
    expect(listA.keys.map((k) => [k.name, k.status])).toEqual([["arcade", "active"]]);
  });

  test("an app key's row is kind app, owned by its person, and its last use is throttled to a minute", async () => {
    const a = await createUser(db, "alice", "alice-passphrase-1");
    const made = (await (await call("/account/keys", await accountBearer(a.id), "POST", { name: "arcade", vault: "arcade", can: "read" })).json()) as { token: string };
    const jti = JSON.parse(Buffer.from(made.token.split(".")[1]!, "base64url").toString()).jti as string;
    const key = listKeys(db).find((k) => k.name === "arcade")!;
    expect([key.owner, key.owner_kind, key.last_used_at]).toEqual([a.id, "app", null]);
    const t0 = new Date("2026-11-08T12:00:00.000Z");
    expect(touchKey(db, jti, t0)).toBe(true);
    expect(touchKey(db, jti, new Date(t0.getTime() + 30_000))).toBe(false);
    expect(touchKey(db, jti, new Date(t0.getTime() + 61_000))).toBe(true);
    expect(listKeys(db).find((k) => k.name === "arcade")!.last_used_at).toBe("2026-11-08T12:01:01.000Z");
  });
});
