/**
 * core #129: a member whose vault is taken away while a token is being minted gets nothing that outlives the revoke.
 *
 * The sweep in users.ts (`endVaultAuthorityBeyondRole`) ends what exists when the role changes. A code redeem marks
 * its code used, then signs (an await), then inserts its refresh row: a revoke that lands in that await finds nothing
 * to end yet. So every refresh-row mint re-checks, inside its insert transaction, that the person still holds each
 * vault verb it carries (`assertMintedUnderCurrentGrant`). The same check refuses a refresh family an older hub left
 * live after a revoke. The contract suite can't time a request into an await; this drives the handler in-process.
 */
import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueAuthCode } from "../auth-codes.ts";
import { registerClient } from "../clients.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { handleToken } from "../oauth-handlers.ts";
import { createUser, removeUserVault, upsertUserVault } from "../users.ts";

const REDIRECT = "https://app.example/cb";
const deps = {
  issuer: "http://127.0.0.1",
  loadDeclaredScopes: () => new Set(["vault:default:read", "vault:default:write", "vault:read"]),
  loadServicesManifest: () => ({ services: [] }) as never,
};

function token(db: ReturnType<typeof openHubDb>, form: Record<string, string>) {
  return handleToken(
    db,
    new Request("http://127.0.0.1/oauth/token", {
      method: "POST",
      body: new URLSearchParams(form),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }),
    deps,
  );
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "member-revoke-mint-"));
  const db = openHubDb(hubDbPath(dir));
  await createUser(db, "owner", "pw");
  const bob = await createUser(db, "bob", "pw", { allowMulti: true });
  upsertUserVault(db, bob.id, "default", "read");
  const client = registerClient(db, { redirectUris: [REDIRECT], status: "approved" }).client.clientId;
  const verifier = randomBytes(32).toString("base64url");
  const code = issueAuthCode(db, {
    clientId: client,
    userId: bob.id,
    redirectUri: REDIRECT,
    scopes: ["vault:default:read"],
    codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
    codeChallengeMethod: "S256",
  }).code;
  const redeem = { grant_type: "authorization_code", code, client_id: client, redirect_uri: REDIRECT, code_verifier: verifier };
  return { db, bob, client, code, redeem, cleanup: () => (db.close(), rmSync(dir, { recursive: true, force: true })) };
}

describe("a refresh-row mint re-checks the person's role (core #129)", () => {
  test("revoke lands while a code redeem is signing: no token, no live row", async () => {
    const { db, bob, code, redeem, cleanup } = await setup();
    try {
      const pending = token(db, redeem);
      // The redeem marks the code used before it awaits the signature: revoke in that gap.
      for (let i = 0; i < 10_000; i++) {
        if ((db.query("SELECT used_at FROM auth_codes WHERE code = ?").get(code) as { used_at: string | null }).used_at) break;
        await Promise.resolve();
      }
      expect((db.query("SELECT count(*) AS n FROM tokens WHERE user_id = ?").get(bob.id) as { n: number }).n).toBe(0);
      expect(removeUserVault(db, bob.id, "default")).toBe(true);
      const res = await pending;
      const body = (await res.json()) as { error?: string; refresh_token?: string };
      expect({ status: res.status, error: body.error, refresh: body.refresh_token }).toEqual({ status: 400, error: "invalid_grant", refresh: undefined });
      expect(db.query("SELECT jti FROM tokens WHERE user_id = ? AND revoked_at IS NULL").all(bob.id)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("a refresh family left live after the member lost the vault mints nothing", async () => {
    const { db, bob, client, redeem, cleanup } = await setup();
    try {
      const first = (await (await token(db, redeem)).json()) as { refresh_token: string };
      // As an older hub left it: the role gone, the family still live.
      db.prepare("DELETE FROM user_vaults WHERE user_id = ?").run(bob.id);
      const r = await token(db, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: client });
      expect({ status: r.status, error: ((await r.json()) as { error?: string }).error }).toEqual({ status: 400, error: "invalid_grant" });
    } finally {
      cleanup();
    }
  });

  test("a member who still holds the vault refreshes as before", async () => {
    const { db, client, redeem, cleanup } = await setup();
    try {
      const first = (await (await token(db, redeem)).json()) as { refresh_token: string };
      const r = await token(db, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: client });
      expect(r.status).toBe(200);
    } finally {
      cleanup();
    }
  });
});
