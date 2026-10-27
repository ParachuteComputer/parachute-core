/**
 * RSA-2048 signing keys backing the hub's JWT issuance + JWKS endpoint.
 *
 * Lifecycle:
 *   - One *active* key at a time (`retired_at IS NULL`). Used to sign new
 *     JWTs.
 *   - On rotation, the old key gets `retired_at` stamped and a fresh one
 *     becomes active. Retired keys keep validating tokens issued before the
 *     rotation, but only for a limited window.
 *
 * Retention: `JWKS_RETENTION_MS = 24h`. Access tokens are 15-min JWTs, so
 * the cryptographic window is tiny — but JWKS responses are typically cached
 * by clients for up to ~24h, and we don't want a client's stale cache to
 * blackhole valid signatures during that window. 24h is the upper bound on
 * any reasonable client cache; older retired rows stay in the DB for audit
 * but stop appearing in JWKS.
 */
import type { Database } from "bun:sqlite";
import { createHash, generateKeyPairSync } from "node:crypto";

export const JWKS_RETENTION_MS = 24 * 60 * 60 * 1000;
export const SIGNING_ALGORITHM = "RS256";

export interface SigningKey {
  kid: string;
  publicKeyPem: string;
  privateKeyPem: string;
  algorithm: string;
  createdAt: string;
  retiredAt: string | null;
}

interface Row {
  kid: string;
  public_key_pem: string;
  private_key_pem: string;
  algorithm: string;
  created_at: string;
  retired_at: string | null;
}

function rowToKey(r: Row): SigningKey {
  return {
    kid: r.kid,
    publicKeyPem: r.public_key_pem,
    privateKeyPem: r.private_key_pem,
    algorithm: r.algorithm,
    createdAt: r.created_at,
    retiredAt: r.retired_at,
  };
}

/**
 * `kid = base64url(SHA-256(public_key_pem))` — stable, content-addressed,
 * impossible to clash within a database that already has the public key as
 * a unique column.
 */
export function computeKid(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem).digest("base64url");
}

/**
 * Returns the active signing key, generating + inserting a fresh keypair on
 * an empty database. Idempotent: subsequent calls return the same row.
 */
export function getActiveSigningKey(db: Database, now: () => Date = () => new Date()): SigningKey {
  const existing = db
    .query("SELECT * FROM signing_keys WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT 1")
    .get() as Row | null;
  if (existing) return rowToKey(existing);
  return rotateSigningKey(db, now);
}

/**
 * Generates a new RSA-2048 keypair, retires every currently-active key, and
 * returns the new active key. The retire+insert runs in a single transaction
 * so a partial failure can't leave the DB with zero active keys.
 */
export function rotateSigningKey(db: Database, now: () => Date = () => new Date()): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const kid = computeKid(publicKeyPem);
  const stamp = now().toISOString();

  db.transaction(() => {
    db.prepare("UPDATE signing_keys SET retired_at = ? WHERE retired_at IS NULL").run(stamp);
    db.prepare(
      `INSERT INTO signing_keys (kid, public_key_pem, private_key_pem, algorithm, created_at, retired_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(kid, publicKeyPem, privateKeyPem, SIGNING_ALGORITHM, stamp);
  })();

  return {
    kid,
    publicKeyPem,
    privateKeyPem,
    algorithm: SIGNING_ALGORITHM,
    createdAt: stamp,
    retiredAt: null,
  };
}

/**
 * Public keys to advertise on `/.well-known/jwks.json`: every active key plus
 * any retired key whose `retired_at` is within `JWKS_RETENTION_MS`. Older
 * retired rows stay in the DB for audit/debug — they just stop being
 * advertised.
 */
export function getAllPublicKeys(db: Database, now: () => Date = () => new Date()): SigningKey[] {
  const cutoff = new Date(now().getTime() - JWKS_RETENTION_MS).toISOString();
  const rows = db
    .query(
      `SELECT * FROM signing_keys
       WHERE retired_at IS NULL OR retired_at >= ?
       ORDER BY created_at DESC`,
    )
    .all(cutoff) as Row[];
  return rows.map(rowToKey);
}
