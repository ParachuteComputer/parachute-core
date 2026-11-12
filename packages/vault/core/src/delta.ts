import { createDelta, applyDelta, getDeltaTargetSize } from "./vendor/fossil-delta.js";
/** Encode UTF-8 text as a base64 byte delta, without an argument-sized spread. */
export function encodeDelta(base: string, target: string): string {
  return toBase64(createDeltaBytes(base, target));
}
/** The raw Fossil delta bytes that turn `base` into `target` (both UTF-8 text). */
export function createDeltaBytes(base: string, target: string): Uint8Array {
  const bytes = createDelta(new TextEncoder().encode(base), new TextEncoder().encode(target));
  return bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
}
function toBase64(bytes: Uint8Array | number[]): string {
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; start += 8192) {
    let chunk = "";
    for (let i = start; i < Math.min(start + 8192, bytes.length); i++)
      chunk += String.fromCharCode(bytes[i]!);
    chunks.push(chunk);
  }
  return btoa(chunks.join(""));
}
/** The raw bytes of a base64 delta payload. */
export function fromBase64(payload: string): Uint8Array {
  return Uint8Array.from(atob(payload), c => c.charCodeAt(0));
}
/** Reconstruct exactly one delta; checksum verification remains enabled. */
export function decodeDelta(base: string, payload: string): string {
  return applyDeltaBytes(base, fromBase64(payload));
}
/**
 * Apply raw Fossil delta bytes to `base`. With `maxBytes`, a delta whose header names a larger result is refused
 * before anything is built.
 */
export function applyDeltaBytes(base: string, delta: Uint8Array, maxBytes?: number): string {
  if (maxBytes !== undefined && getDeltaTargetSize(delta) > maxBytes) throw new Error("delta target exceeds the limit");
  return new TextDecoder().decode(new Uint8Array(applyDelta(new TextEncoder().encode(base), delta)));
}
