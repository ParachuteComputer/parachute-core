/**
 * Who may manage who reaches a vault (vault-grants.ts, 1.0 grants slice, T-476): the edge the door contracts can't
 * reach, because no door mints such a credential: a vault admin credential carrying a permission the hub doesn't know
 * is treated as narrowed (fail closed), so it can't make a key wider than itself.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { signAccessToken } from "../jwt-sign.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";
import { ownerOrVaultAdmin } from "../vault-grants.ts";
import { routeAccountKeys } from "../account-keys.ts";
import { writeFileSync } from "node:fs";

const ISSUER = "https://hub.test";
let db: Database;
let dir: string;
let sub: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "phub-vault-grants-"));
  db = openHubDb(hubDbPath(dir));
  rotateSigningKey(db);
  sub = (await createUser(db, "owner", "a-long-made-up-password")).id;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function bearer(permissions?: Record<string, unknown>): Promise<Request> {
  const minted = await signAccessToken(db, { sub, scopes: ["vault:kitchen:admin"], audience: "vault.kitchen", clientId: "test", issuer: ISSUER, ttlSeconds: 600, vaultScope: ["kitchen"],
    ...(permissions ? { extraClaims: { permissions } } : {}) });
  return new Request(`${ISSUER}/account/vaults/kitchen/statements`, { headers: { authorization: `Bearer ${minted.token}` } });
}

describe("a vault admin credential managing its vault", () => {
  test("whole-vault: let in for that vault, not another", async () => {
    const ok = await ownerOrVaultAdmin(await bearer(), db, "kitchen", [ISSUER]);
    expect(ok instanceof Response).toBe(false);
    const other = await ownerOrVaultAdmin(await bearer(), db, "letters", [ISSUER]);
    expect(other instanceof Response && other.status).toBe(403);
  });
  test("one that names who it writes for, or the key that signed, is still whole-vault", async () => {
    for (const p of [{ acts_for: "portal" }, { principal_pubkey: "ab".repeat(32) }]) {
      const ok = await ownerOrVaultAdmin(await bearer(p), db, "kitchen", [ISSUER]);
      expect(ok instanceof Response).toBe(false);
    }
  });
  test("narrowed in any way, a known one or one this hub doesn't know, it is refused", async () => {
    // (an admin pass limited to tags can't be signed at all: signAccessToken refuses it)
    for (const p of [{ grant: "claude" }, { some_future_limit: ["x"] }]) {
      const r = await ownerOrVaultAdmin(await bearer(p), db, "kitchen", [ISSUER]);
      expect(r instanceof Response && r.status, JSON.stringify(p)).toBe(403);
    }
  });
});

describe("a mint that doesn't finish", () => {
  const setup = async (onFile?: () => void) => {
    const manifestPath = join(dir, "services.json");
    writeFileSync(manifestPath, JSON.stringify({ services: [{ name: "parachute-vault", port: 4101, paths: ["/vault/kitchen"], health: "/health", version: "0.9.0" }] }));
    const owner = await signAccessToken(db, { sub, scopes: ["parachute:host:admin"], audience: "account", clientId: "test", issuer: ISSUER, ttlSeconds: 600 });
    // the vault, which this test stands in for: takes each filing after a moment, and counts each end
    const calls: string[] = [];
    const forward = async (req: Request) => {
      calls.push(`${req.method} ${new URL(req.url).pathname}`);
      if (req.method === "PUT") onFile?.();
      await new Promise((r) => setTimeout(r, 20));
      return new Response("{}", { status: req.method === "PUT" ? 201 : 200 });
    };
    const mint = () => routeAccountKeys(new Request(`${ISSUER}/account/keys`, { method: "POST", headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "claude", vault: "kitchen", can: "write", types: ["recipe"] }) }), "/account/keys", { db, issuer: ISSUER, manifestPath, forward });
    return { calls, mint };
  };
  test("two mints of one name: one key, and the grant it uses stays", async () => {
    const { calls, mint } = await setup();
    const [a, b] = await Promise.all([mint(), mint()]);
    expect([a!.status, b!.status].sort()).toEqual([201, 409]);
    expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
  });
  test("a mint whose person went meanwhile ends the grant it filed: no grant in force for a key never made", async () => {
    const { calls, mint } = await setup(() => db.prepare("DELETE FROM users WHERE id = ?").run(sub));
    const r = await mint();
    expect(r!.status).toBe(409);
    expect(calls).toEqual(["PUT /vault/kitchen/api/grants/claude", "DELETE /vault/kitchen/api/grants/claude"]);
  });
});
