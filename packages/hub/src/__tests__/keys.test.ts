// Keys with scopes (T-318 design §2): every live token becomes a key with the same scopes (hub.db v25), every new
// mint gets its key, and a key never changes how its token verifies.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, migrate, openHubDb } from "../hub-db.ts";
import { recordTokenMint, revokeTokenByJti, signAccessToken, validateAccessToken } from "../jwt-sign.ts";
import { listKeys } from "../keys.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), "phub-keys-"));
  const db = openHubDb(hubDbPath(dir));
  return { db, cleanup: () => (db.close(), rmSync(dir, { recursive: true, force: true })) };
}

const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";

describe("v25: every live token becomes a key with the same scopes", () => {
  test("adopts live rows only, names them, finds their owners, and keeps scopes and tag scopes as they are", async () => {
    const { db, cleanup } = makeDb();
    try {
      const user = await createUser(db, "rowan", "made-up-password-1");
      const ins = db.prepare(
        `INSERT INTO tokens (jti, user_id, client_id, scopes, expires_at, created_at, created_via, subject, permissions, revoked_at, rotated_to)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const at = "2026-10-01T00:00:00.000Z";
      // Back to v24: no keys table, rows as today's hub writes them.
      db.exec("DROP TABLE keys; DELETE FROM schema_version WHERE version = 25");
      ins.run("t-script", null, "cli", "vault:uni:read vault:uni:write", FUTURE, at, "cli_mint", "uni-tasks", null, null, null);
      ins.run("t-script2", null, "cli", "vault:uni:read", FUTURE, at, "cli_mint", "uni-tasks", null, null, null);
      ins.run("t-person", user.id, "api-mint-token", "vault:uni:admin", FUTURE, at, "cli_mint", user.id, null, null, null);
      ins.run("t-agent", user.id, "c", "vault:uni:read", FUTURE, at, "agent_grant", "agent-grant", JSON.stringify({ scoped_tags: ["task", "pinned"] }), null, null);
      ins.run("t-app", user.id, "claude-app", "vault:uni:write", FUTURE, at, "oauth_refresh", null, null, null, null);
      ins.run("t-revoked", null, "cli", "vault:uni:read", FUTURE, at, "cli_mint", "old", null, at, null);
      ins.run("t-expired", null, "cli", "vault:uni:read", PAST, at, "cli_mint", "older", null, null, null);
      ins.run("t-rotated", user.id, "claude-app", "vault:uni:write", FUTURE, at, "oauth_refresh", null, null, null, "t-app");
      migrate(db);
      const keys = Object.fromEntries(listKeys(db).map((k) => [k.name, k]));
      expect(Object.keys(keys).sort()).toEqual(["claude-app", "rowan", "agent-grant", "uni-tasks", "uni-tasks-2"].sort());
      expect(keys["uni-tasks"]).toMatchObject({ owner: "uni-tasks", owner_kind: "service", scopes: ["vault:uni:read", "vault:uni:write"], levels: { uni: "write" }, status: "active" });
      expect(keys.rowan).toMatchObject({ owner: user.id, owner_kind: "person", levels: { uni: "admin" } });
      expect(keys["agent-grant"]).toMatchObject({ owner: user.id, owner_kind: "agent", allow_tags: ["task", "pinned"], types: null, denies: null });
      expect(keys["claude-app"]).toMatchObject({ owner: user.id, owner_kind: "app" });
      // Idempotent: a second run adds nothing.
      db.exec("DELETE FROM schema_version WHERE version = 25");
      db.exec("DROP TABLE keys");
      migrate(db);
      expect(listKeys(db)).toHaveLength(5);
    } finally {
      cleanup();
    }
  });

  test("a new mint gets its key, the token still verifies, and revoking the token shows on the key", async () => {
    const { db, cleanup } = makeDb();
    try {
      rotateSigningKey(db);
      const issuer = "http://127.0.0.1:47999";
      const signed = await signAccessToken(db, { sub: "mts", scopes: ["vault:uni:read"], audience: "vault.uni", clientId: "cli", issuer });
      recordTokenMint(db, { jti: signed.jti, createdVia: "cli_mint", subject: "mts", clientId: "cli", scopes: ["vault:uni:read"], expiresAt: signed.expiresAt });
      expect(listKeys(db).map((k) => [k.name, k.status])).toEqual([["mts", "active"]]);
      const before = await validateAccessToken(db, signed.token, issuer);
      expect(before.payload.jti).toBe(signed.jti);
      revokeTokenByJti(db, signed.jti, new Date());
      expect(listKeys(db)[0]!.status).toBe("revoked");
      await expect(validateAccessToken(db, signed.token, issuer)).rejects.toThrow(/revoked/);
    } finally {
      cleanup();
    }
  });
});
