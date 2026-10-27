import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import {
  JWKS_RETENTION_MS,
  computeKid,
  getActiveSigningKey,
  getAllPublicKeys,
  rotateSigningKey,
} from "../signing-keys.ts";

function makeDb() {
  const configDir = mkdtempSync(join(tmpdir(), "phub-sk-"));
  const db = openHubDb(hubDbPath(configDir));
  return { db, cleanup: () => rmSync(configDir, { recursive: true, force: true }) };
}

describe("computeKid", () => {
  test("is deterministic and base64url-shaped", () => {
    const a = computeKid("-----BEGIN PUBLIC KEY-----\nABC\n-----END PUBLIC KEY-----\n");
    const b = computeKid("-----BEGIN PUBLIC KEY-----\nABC\n-----END PUBLIC KEY-----\n");
    expect(a).toBe(b);
    // base64url has no `+`, `/`, or `=` padding.
    expect(a).not.toMatch(/[+/=]/);
    // SHA-256 → 32 bytes → 43 base64url chars.
    expect(a.length).toBe(43);
  });

  test("differs for different PEMs", () => {
    const a = computeKid("PEM-A");
    const b = computeKid("PEM-B");
    expect(a).not.toBe(b);
  });
});

describe("getActiveSigningKey", () => {
  test("auto-seeds an active key on a fresh db", () => {
    const { db, cleanup } = makeDb();
    try {
      const k = getActiveSigningKey(db);
      expect(k.kid.length).toBe(43);
      expect(k.algorithm).toBe("RS256");
      expect(k.retiredAt).toBeNull();
      expect(k.publicKeyPem).toContain("BEGIN PUBLIC KEY");
      expect(k.privateKeyPem).toContain("BEGIN PRIVATE KEY");
      // kid is content-addressed against the public PEM.
      expect(k.kid).toBe(computeKid(k.publicKeyPem));
    } finally {
      cleanup();
    }
  });

  test("is idempotent — repeat calls return the same active key", () => {
    const { db, cleanup } = makeDb();
    try {
      const a = getActiveSigningKey(db);
      const b = getActiveSigningKey(db);
      expect(b.kid).toBe(a.kid);
      expect(b.privateKeyPem).toBe(a.privateKeyPem);
    } finally {
      cleanup();
    }
  });
});

describe("rotateSigningKey", () => {
  test("retires the prior active key and creates a fresh one", () => {
    const { db, cleanup } = makeDb();
    try {
      const old = getActiveSigningKey(db);
      const fresh = rotateSigningKey(db);
      expect(fresh.kid).not.toBe(old.kid);
      expect(fresh.retiredAt).toBeNull();
      const next = getActiveSigningKey(db);
      expect(next.kid).toBe(fresh.kid);

      const oldRow = db
        .query<{ retired_at: string | null }, [string]>(
          "SELECT retired_at FROM signing_keys WHERE kid = ?",
        )
        .get(old.kid);
      expect(oldRow?.retired_at).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  test("transactional — if the insert succeeds, exactly one active key remains", () => {
    const { db, cleanup } = makeDb();
    try {
      getActiveSigningKey(db);
      rotateSigningKey(db);
      rotateSigningKey(db);
      const activeCount = (
        db
          .query<{ n: number }, []>(
            "SELECT COUNT(*) AS n FROM signing_keys WHERE retired_at IS NULL",
          )
          .get() ?? { n: -1 }
      ).n;
      expect(activeCount).toBe(1);
    } finally {
      cleanup();
    }
  });
});

describe("getAllPublicKeys", () => {
  test("includes active + recently-retired (within 24h)", () => {
    const { db, cleanup } = makeDb();
    try {
      const old = getActiveSigningKey(db);
      const fresh = rotateSigningKey(db);
      const keys = getAllPublicKeys(db);
      const kids = keys.map((k) => k.kid).sort();
      expect(kids).toEqual([old.kid, fresh.kid].sort());
    } finally {
      cleanup();
    }
  });

  test("excludes retired keys past 24h retention", () => {
    const { db, cleanup } = makeDb();
    try {
      const old = getActiveSigningKey(db);
      const fresh = rotateSigningKey(db);
      // Force the retired_at far enough in the past to be filtered out.
      const oldRetired = new Date(Date.now() - JWKS_RETENTION_MS - 60_000).toISOString();
      db.prepare("UPDATE signing_keys SET retired_at = ? WHERE kid = ?").run(oldRetired, old.kid);

      const kids = getAllPublicKeys(db).map((k) => k.kid);
      expect(kids).toContain(fresh.kid);
      expect(kids).not.toContain(old.kid);
    } finally {
      cleanup();
    }
  });

  test("on a fresh db with no keys, returns []", () => {
    const { db, cleanup } = makeDb();
    try {
      expect(getAllPublicKeys(db)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("retention boundary is 24h to the millisecond", () => {
    expect(JWKS_RETENTION_MS).toBe(24 * 60 * 60 * 1000);
  });
});
