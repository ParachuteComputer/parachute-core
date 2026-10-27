import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthCodeExpiredError,
  AuthCodeNotFoundError,
  AuthCodePkceMismatchError,
  AuthCodeRedirectMismatchError,
  AuthCodeUsedError,
  issueAuthCode,
  redeemAuthCode,
  verifyPkce,
} from "../auth-codes.ts";
import { registerClient } from "../clients.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { createUser } from "../users.ts";

async function makeDb() {
  const configDir = mkdtempSync(join(tmpdir(), "phub-codes-"));
  const db = openHubDb(hubDbPath(configDir));
  const user = await createUser(db, "owner", "pw");
  const reg = registerClient(db, { redirectUris: ["https://example.com/cb"] });
  return {
    db,
    userId: user.id,
    clientId: reg.client.clientId,
    cleanup: () => {
      db.close();
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

describe("issueAuthCode", () => {
  test("inserts a row with all fields populated", async () => {
    const { db, userId, clientId, cleanup } = await makeDb();
    try {
      const code = issueAuthCode(db, {
        clientId,
        userId,
        redirectUri: "https://example.com/cb",
        scopes: ["vault.read"],
        codeChallenge: s256("verifier"),
        codeChallengeMethod: "S256",
      });
      expect(code.code.length).toBeGreaterThan(20);
      expect(code.scopes).toEqual(["vault.read"]);
      expect(code.usedAt).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("redeemAuthCode", () => {
  test("happy path returns the auth code and stamps used_at", async () => {
    const { db, userId, clientId, cleanup } = await makeDb();
    try {
      const verifier = "verifier-string-long-enough";
      const issued = issueAuthCode(db, {
        clientId,
        userId,
        redirectUri: "https://example.com/cb",
        scopes: ["vault.read"],
        codeChallenge: s256(verifier),
        codeChallengeMethod: "S256",
      });
      const redeemed = redeemAuthCode(db, {
        code: issued.code,
        clientId,
        redirectUri: "https://example.com/cb",
        codeVerifier: verifier,
      });
      expect(redeemed.userId).toBe(userId);
      expect(redeemed.usedAt).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  test("second redeem of the same code throws AuthCodeUsedError", async () => {
    const { db, userId, clientId, cleanup } = await makeDb();
    try {
      const verifier = "v".repeat(43);
      const issued = issueAuthCode(db, {
        clientId,
        userId,
        redirectUri: "https://example.com/cb",
        scopes: [],
        codeChallenge: s256(verifier),
        codeChallengeMethod: "S256",
      });
      redeemAuthCode(db, {
        code: issued.code,
        clientId,
        redirectUri: "https://example.com/cb",
        codeVerifier: verifier,
      });
      expect(() =>
        redeemAuthCode(db, {
          code: issued.code,
          clientId,
          redirectUri: "https://example.com/cb",
          codeVerifier: verifier,
        }),
      ).toThrow(AuthCodeUsedError);
    } finally {
      cleanup();
    }
  });

  test("expired code throws AuthCodeExpiredError", async () => {
    const { db, userId, clientId, cleanup } = await makeDb();
    try {
      const verifier = "verifier";
      const epoch = new Date("2026-01-01T00:00:00Z");
      const issued = issueAuthCode(db, {
        clientId,
        userId,
        redirectUri: "https://example.com/cb",
        scopes: [],
        codeChallenge: s256(verifier),
        codeChallengeMethod: "S256",
        now: () => epoch,
      });
      const later = new Date(epoch.getTime() + 90_000); // 90s > 60s TTL
      expect(() =>
        redeemAuthCode(db, {
          code: issued.code,
          clientId,
          redirectUri: "https://example.com/cb",
          codeVerifier: verifier,
          now: () => later,
        }),
      ).toThrow(AuthCodeExpiredError);
    } finally {
      cleanup();
    }
  });

  test("PKCE verifier mismatch throws AuthCodePkceMismatchError", async () => {
    const { db, userId, clientId, cleanup } = await makeDb();
    try {
      const issued = issueAuthCode(db, {
        clientId,
        userId,
        redirectUri: "https://example.com/cb",
        scopes: [],
        codeChallenge: s256("the-real-verifier"),
        codeChallengeMethod: "S256",
      });
      expect(() =>
        redeemAuthCode(db, {
          code: issued.code,
          clientId,
          redirectUri: "https://example.com/cb",
          codeVerifier: "wrong-verifier",
        }),
      ).toThrow(AuthCodePkceMismatchError);
    } finally {
      cleanup();
    }
  });

  test("redirect_uri mismatch throws AuthCodeRedirectMismatchError", async () => {
    const { db, userId, clientId, cleanup } = await makeDb();
    try {
      const verifier = "v";
      const issued = issueAuthCode(db, {
        clientId,
        userId,
        redirectUri: "https://example.com/cb",
        scopes: [],
        codeChallenge: s256(verifier),
        codeChallengeMethod: "S256",
      });
      expect(() =>
        redeemAuthCode(db, {
          code: issued.code,
          clientId,
          redirectUri: "https://elsewhere.com/cb",
          codeVerifier: verifier,
        }),
      ).toThrow(AuthCodeRedirectMismatchError);
    } finally {
      cleanup();
    }
  });

  test("client_id mismatch throws AuthCodeNotFoundError (not an info leak)", async () => {
    const { db, userId, clientId, cleanup } = await makeDb();
    try {
      const verifier = "v";
      const issued = issueAuthCode(db, {
        clientId,
        userId,
        redirectUri: "https://example.com/cb",
        scopes: [],
        codeChallenge: s256(verifier),
        codeChallengeMethod: "S256",
      });
      expect(() =>
        redeemAuthCode(db, {
          code: issued.code,
          clientId: "different-client",
          redirectUri: "https://example.com/cb",
          codeVerifier: verifier,
        }),
      ).toThrow(AuthCodeNotFoundError);
    } finally {
      cleanup();
    }
  });

  test("unknown code throws AuthCodeNotFoundError", async () => {
    const { db, clientId, cleanup } = await makeDb();
    try {
      expect(() =>
        redeemAuthCode(db, {
          code: "no-such-code",
          clientId,
          redirectUri: "https://example.com/cb",
          codeVerifier: "v",
        }),
      ).toThrow(AuthCodeNotFoundError);
    } finally {
      cleanup();
    }
  });
});

describe("verifyPkce", () => {
  test("S256 round-trip verifies", () => {
    const verifier = "test-verifier";
    const challenge = s256(verifier);
    expect(verifyPkce(challenge, "S256", verifier)).toBe(true);
    expect(verifyPkce(challenge, "S256", "wrong")).toBe(false);
  });

  test("plain method is rejected", () => {
    expect(verifyPkce("anything", "plain", "anything")).toBe(false);
  });

  test("unknown method is rejected", () => {
    expect(verifyPkce("x", "S512", "x")).toBe(false);
  });
});
