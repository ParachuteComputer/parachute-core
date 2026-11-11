/**
 * Short-lived authorization codes for the OAuth `code` grant. The hub mints
 * one when the user approves a consent screen; the client redeems it at
 * `/oauth/token` for an access + refresh token.
 *
 * Single-use is enforced by stamping `used_at` on redemption — a replay
 * attempt sees the row but with `used_at` set and returns `AuthCodeUsedError`.
 * Each code carries the grant generation it was minted under
 * (grant-generation.ts); the token endpoint re-reads it after signing.
 * RFC 6749 §10.5 wants single-use plus revocation of any tokens already
 * issued from a replayed code; revocation is a follow-up.
 *
 * PKCE S256 is mandatory here. The `plain` method is rejected at the
 * authorize step (`/oauth/authorize` enforces `code_challenge_method=S256`).
 * Storing `code_challenge` on the row lets the token endpoint verify the
 * client's `code_verifier` without having to keep state across the redirect.
 */
import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { currentGrantGeneration } from "./grant-generation.ts";

export const AUTH_CODE_TTL_SECONDS = 60;

export interface AuthCode {
  code: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
  /** The grant generation (grant-generation.ts) the code was minted under. */
  grantGeneration: number;
}

export class AuthCodeNotFoundError extends Error {
  constructor() {
    super("authorization code not found");
    this.name = "AuthCodeNotFoundError";
  }
}

export class AuthCodeExpiredError extends Error {
  constructor() {
    super("authorization code has expired");
    this.name = "AuthCodeExpiredError";
  }
}

export class AuthCodeUsedError extends Error {
  constructor() {
    super("authorization code has already been redeemed");
    this.name = "AuthCodeUsedError";
  }
}

export class AuthCodePkceMismatchError extends Error {
  constructor() {
    super("code_verifier does not match the stored code_challenge");
    this.name = "AuthCodePkceMismatchError";
  }
}

export class AuthCodeRedirectMismatchError extends Error {
  constructor() {
    super("redirect_uri does not match the one bound to this code");
    this.name = "AuthCodeRedirectMismatchError";
  }
}

interface Row {
  code: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  scopes: string;
  code_challenge: string;
  code_challenge_method: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
  grant_generation: number;
}

function rowToAuthCode(r: Row): AuthCode {
  return {
    code: r.code,
    clientId: r.client_id,
    userId: r.user_id,
    redirectUri: r.redirect_uri,
    scopes: r.scopes.split(" ").filter((s) => s.length > 0),
    codeChallenge: r.code_challenge,
    codeChallengeMethod: r.code_challenge_method,
    expiresAt: r.expires_at,
    usedAt: r.used_at,
    createdAt: r.created_at,
    grantGeneration: r.grant_generation,
  };
}

export interface IssueAuthCodeOpts {
  clientId: string;
  userId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: string;
  now?: () => Date;
}

export function issueAuthCode(db: Database, opts: IssueAuthCodeOpts): AuthCode {
  const code = randomBytes(32).toString("base64url");
  const now = opts.now?.() ?? new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + AUTH_CODE_TTL_SECONDS * 1000).toISOString();
  // Stamped with the (user, client)'s current grant generation, read here, in the same synchronous step as the grant
  // write that precedes every call (issueAuthCodeRedirect): a later narrowing bumps it and this code stops minting.
  const grantGeneration = currentGrantGeneration(db, opts.userId, opts.clientId);
  db.prepare(
    `INSERT INTO auth_codes
     (code, client_id, user_id, redirect_uri, scopes, code_challenge, code_challenge_method, expires_at, used_at, created_at, grant_generation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    code,
    opts.clientId,
    opts.userId,
    opts.redirectUri,
    opts.scopes.join(" "),
    opts.codeChallenge,
    opts.codeChallengeMethod,
    expiresAt,
    createdAt,
    grantGeneration,
  );
  return {
    code,
    clientId: opts.clientId,
    userId: opts.userId,
    redirectUri: opts.redirectUri,
    scopes: opts.scopes,
    codeChallenge: opts.codeChallenge,
    codeChallengeMethod: opts.codeChallengeMethod,
    expiresAt,
    usedAt: null,
    createdAt,
    grantGeneration,
  };
}

export interface RedeemAuthCodeOpts {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  now?: () => Date;
}

/**
 * Atomically validates and consumes an auth code. Throws on every error
 * branch; the caller maps these to OAuth error codes (`invalid_grant` etc).
 */
export function redeemAuthCode(db: Database, opts: RedeemAuthCodeOpts): AuthCode {
  // The generation on the returned copy is as of now; the mint re-reads it from the row (authCodeGeneration) after
  // signing, because a narrowing may move or leave it in between.
  const row = db.query<Row, [string]>("SELECT * FROM auth_codes WHERE code = ?").get(opts.code);
  if (!row) throw new AuthCodeNotFoundError();
  const code = rowToAuthCode(row);
  if (code.clientId !== opts.clientId) throw new AuthCodeNotFoundError();
  if (code.redirectUri !== opts.redirectUri) throw new AuthCodeRedirectMismatchError();
  const now = opts.now?.() ?? new Date();
  if (now.getTime() > new Date(code.expiresAt).getTime()) {
    throw new AuthCodeExpiredError();
  }
  if (code.usedAt) throw new AuthCodeUsedError();
  if (!verifyPkce(code.codeChallenge, code.codeChallengeMethod, opts.codeVerifier)) {
    throw new AuthCodePkceMismatchError();
  }
  // Single-use: stamp used_at. Race-free because sqlite serializes writes.
  db.prepare("UPDATE auth_codes SET used_at = ? WHERE code = ?").run(now.toISOString(), opts.code);
  return { ...code, usedAt: now.toISOString() };
}

export function verifyPkce(challenge: string, method: string, verifier: string): boolean {
  if (method === "S256") {
    const computed = createHash("sha256").update(verifier).digest("base64url");
    return timingSafeEqualString(computed, challenge);
  }
  // We don't accept "plain" — authorize-time validation rejects it before
  // any code is issued. Defensive: reject unknown methods here too.
  return false;
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** The grant generation on a code's row as it is now (the mint's check reads it inside its insert transaction). */
export function authCodeGeneration(db: Database, code: string): number {
  return db.query<{ grant_generation: number }, [string]>("SELECT grant_generation FROM auth_codes WHERE code = ?").get(code)?.grant_generation ?? -1;
}
