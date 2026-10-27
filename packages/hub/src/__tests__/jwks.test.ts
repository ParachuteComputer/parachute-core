import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { pemToJwk } from "../jwks.ts";

function freshRsaPem(): string {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return publicKey.export({ format: "pem", type: "spki" }).toString();
}

describe("pemToJwk", () => {
  test("returns a JWK with kty=RSA, alg=RS256, use=sig, and the supplied kid", () => {
    const pem = freshRsaPem();
    const jwk = pemToJwk(pem, "test-kid");
    expect(jwk.kty).toBe("RSA");
    expect(jwk.alg).toBe("RS256");
    expect(jwk.use).toBe("sig");
    expect(jwk.kid).toBe("test-kid");
    // n + e are non-empty base64url strings.
    expect(jwk.n.length).toBeGreaterThan(0);
    expect(jwk.e.length).toBeGreaterThan(0);
    expect(jwk.n).not.toMatch(/[+/=]/);
    expect(jwk.e).not.toMatch(/[+/=]/);
  });

  test("rejects a non-RSA key", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
    expect(() => pemToJwk(pem, "bad")).toThrow();
  });

  test("is deterministic for the same PEM + kid", () => {
    const pem = freshRsaPem();
    const a = pemToJwk(pem, "k");
    const b = pemToJwk(pem, "k");
    expect(b).toEqual(a);
  });
});
