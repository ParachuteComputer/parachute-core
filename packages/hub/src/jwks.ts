/**
 * PEM → JWK conversion for the hub's `/.well-known/jwks.json` endpoint.
 *
 * `node:crypto.createPublicKey(pem).export({format: 'jwk'})` already returns
 * the canonical {kty, n, e} for an RSA public key. We layer the JWKS-level
 * fields (`kid`, `alg`, `use`) on top so consumers can pick the right key
 * without extra metadata.
 */
import { createPublicKey } from "node:crypto";

export interface Jwk {
  kty: "RSA";
  n: string;
  e: string;
  kid: string;
  alg: "RS256";
  use: "sig";
}

export interface Jwks {
  keys: Jwk[];
}

export function pemToJwk(publicKeyPem: string, kid: string): Jwk {
  const exported = createPublicKey(publicKeyPem).export({ format: "jwk" }) as {
    kty?: string;
    n?: string;
    e?: string;
  };
  if (exported.kty !== "RSA" || !exported.n || !exported.e) {
    throw new Error(`pemToJwk: expected RSA public key, got kty=${String(exported.kty)}`);
  }
  return {
    kty: "RSA",
    n: exported.n,
    e: exported.e,
    kid,
    alg: "RS256",
    use: "sig",
  };
}
