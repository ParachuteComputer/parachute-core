// Helpers for compat/: a throwaway Nostr key and NIP-98 signing (BIP-340 Schnorr over secp256k1), written out
// here because the contracts carry no Nostr library and must not borrow one from the hub's node_modules.
// Plain bigint arithmetic: slow, but a test signs a handful of events. Checked against the BIP-340 test vectors
// (the first test in uni.test.ts) and, end to end, by the hub accepting what it signs.
import { createHash, randomBytes } from "node:crypto";

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G: Pt = [
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
];
type Pt = [bigint, bigint] | null;

const mod = (a: bigint, m = P) => ((a % m) + m) % m;
function inv(a: bigint, m = P): bigint {
  let [lo, hi, x0, x1] = [mod(a, m), m, 1n, 0n];
  while (lo > 1n) {
    const q = hi / lo;
    [lo, hi] = [hi - q * lo, lo];
    [x0, x1] = [x1 - q * x0, x0];
  }
  return mod(x0, m);
}
function add(a: Pt, b: Pt): Pt {
  if (!a) return b;
  if (!b) return a;
  if (a[0] === b[0] && a[1] !== b[1]) return null;
  const l = a[0] === b[0] ? mod(3n * a[0] * a[0] * inv(2n * a[1])) : mod((b[1] - a[1]) * inv(b[0] - a[0]));
  const x = mod(l * l - a[0] - b[0]);
  return [x, mod(l * (a[0] - x) - a[1])];
}
function mul(k: bigint, pt: Pt = G): Pt {
  let r: Pt = null;
  for (let q = pt; k > 0n; k >>= 1n, q = add(q, q)) if (k & 1n) r = add(r, q);
  return r;
}
const hex32 = (n: bigint) => n.toString(16).padStart(64, "0");
const big = (b: Uint8Array | Buffer) => BigInt(`0x${Buffer.from(b).toString("hex") || "0"}`);
const sha = (...parts: Uint8Array[]) => createHash("sha256").update(Buffer.concat(parts)).digest();
function tagged(tag: string, ...parts: Uint8Array[]): Buffer {
  const t = sha(Buffer.from(tag));
  return sha(t, t, ...parts);
}

/** BIP-340: the x-only public key (hex) for a 32-byte secret key (hex). */
export function xonly(secretHex: string): string {
  return hex32(mul(big(Buffer.from(secretHex, "hex")))![0]);
}

/** BIP-340 Schnorr signature (hex) of a 32-byte message, with 32 bytes of aux randomness. */
export function schnorrSign(secretHex: string, msg: Uint8Array, aux: Uint8Array = randomBytes(32)): string {
  const d0 = big(Buffer.from(secretHex, "hex"));
  if (d0 <= 0n || d0 >= N) throw new Error("secret key out of range");
  const Pp = mul(d0)!;
  const d = Pp[1] % 2n === 0n ? d0 : N - d0;
  const px = Buffer.from(hex32(Pp[0]), "hex");
  const t = Buffer.from(hex32(d ^ big(tagged("BIP0340/aux", aux))), "hex");
  const k0 = mod(big(tagged("BIP0340/nonce", t, px, msg)), N);
  if (k0 === 0n) throw new Error("bad nonce");
  const R = mul(k0)!;
  const k = R[1] % 2n === 0n ? k0 : N - k0;
  const rx = Buffer.from(hex32(R[0]), "hex");
  const e = mod(big(tagged("BIP0340/challenge", rx, px, msg)), N);
  return rx.toString("hex") + hex32(mod(k + e * d, N));
}

/** A throwaway Nostr identity: a random secret, its x-only pubkey. Never written anywhere. */
export function nostrKey(): { secret: string; pubkey: string } {
  for (;;) {
    const secret = randomBytes(32).toString("hex");
    const n = big(Buffer.from(secret, "hex"));
    if (n > 0n && n < N) return { secret, pubkey: xonly(secret) };
  }
}

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** Sign a NIP-01 event. */
export function signEvent(key: { secret: string; pubkey: string }, e: Omit<NostrEvent, "id" | "pubkey" | "sig">): NostrEvent {
  const id = sha(Buffer.from(JSON.stringify([0, key.pubkey, e.created_at, e.kind, e.tags, e.content]))).toString("hex");
  return { ...e, id, pubkey: key.pubkey, sig: schnorrSign(key.secret, Buffer.from(id, "hex")) };
}

/**
 * The NIP-98 `Authorization` header value for one request: kind 27235 with u, method, a nonce, and payload when
 * there's a body. `encoding` is how the two signers on uni render it: the MCP bridge Hermes and uni-nightly use
 * standard base64 (@openparachute/mcp dist/nip98.js:46), the Uni app base64url without padding
 * (uni-app-pipeline crates/uni-core/src/parachute.rs:55-76).
 */
export function nip98(
  key: { secret: string; pubkey: string },
  url: string,
  method: string,
  body?: string,
  encoding: "base64" | "base64url" = "base64url",
): string {
  const tags = [["u", url], ["method", method.toUpperCase()], ["nonce", randomBytes(16).toString("hex")]];
  if (body) tags.push(["payload", createHash("sha256").update(body).digest("hex")]);
  const ev = signEvent(key, { created_at: Math.floor(Date.now() / 1000), kind: 27235, tags, content: "" });
  return `Nostr ${Buffer.from(JSON.stringify(ev)).toString(encoding)}`;
}
