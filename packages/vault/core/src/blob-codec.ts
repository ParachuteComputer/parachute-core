/**
 * How a `note_blobs` row stores its body (T-460). The column `encoding` says which:
 *
 * - NULL: `content` is the body as TEXT.
 * - `deflate`: `content` is a BLOB, the UTF-8 body compressed with raw deflate (RFC 1951).
 * - `fossil-delta`: `content` is the base64 of a Fossil delta against the whole blob `delta_of`.
 * - `fossil-delta-z`: `content` is a BLOB, the raw Fossil delta bytes against `delta_of`, compressed with raw deflate.
 *
 * NULL and `deflate` are "whole": a delta's base is always whole (depth one). Every encoding stays readable for good;
 * which ones an engine writes is a separate choice. `byte_size` is always the stored size of `content`.
 *
 * Deflate is `node:zlib`'s synchronous pair: capture and compaction run inside a synchronous transaction, so the
 * async `CompressionStream` can't be used, and both Bun and workerd (`nodejs_compat`) provide `node:zlib` natively.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

export const WHOLE_ENCODINGS = [null, "deflate"] as const;
export const DELTA_ENCODINGS = ["fossil-delta", "fossil-delta-z"] as const;
export type BlobEncoding = (typeof WHOLE_ENCODINGS)[number] | (typeof DELTA_ENCODINGS)[number];
/** The SQL test for a whole blob, for a table aliased `alias`. Keep in step with {@link isWhole}. */
export function wholeSql(alias?: string): string {
  const col = alias ? `${alias}.encoding` : "encoding";
  return `(${col} IS NULL OR ${col} = 'deflate')`;
}

/** Whether a blob of this encoding holds a whole body (not a delta). */
export function isWhole(encoding: string | null | undefined): boolean {
  return encoding == null || encoding === "deflate";
}
/** Whether a blob of this encoding is a depth-one delta against a whole blob. */
export function isDelta(encoding: string | null | undefined): boolean {
  return encoding === "fossil-delta" || encoding === "fossil-delta-z";
}
/** Whether this engine can read a blob of this encoding. */
export function isKnownEncoding(encoding: string | null | undefined): boolean {
  return isWhole(encoding) || isDelta(encoding);
}

/** What SQLite hands back for `content`: TEXT as a string, a BLOB as a Uint8Array (Bun) or an ArrayBuffer (a DO). */
export type StoredContent = string | Uint8Array | ArrayBuffer;
export class BlobDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlobDecodeError";
  }
}
function bytesOf(content: StoredContent): Uint8Array {
  if (typeof content === "string") throw new BlobDecodeError("a compressed blob holds text, not bytes");
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}
/** Raw-deflate `bytes`. Returns a plain Uint8Array: bind it as is, since Bun binds an ArrayBuffer as NULL. */
export function deflateBytes(bytes: Uint8Array): Uint8Array {
  const out = deflateRawSync(bytes);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}
/** Inflate stored bytes, refusing output over `maxBytes`. */
export function inflateBytes(content: StoredContent, maxBytes: number): Uint8Array {
  try {
    const out = inflateRawSync(bytesOf(content), { maxOutputLength: maxBytes });
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  } catch (err) {
    if (err instanceof BlobDecodeError) throw err;
    throw new BlobDecodeError(`cannot inflate a blob: ${(err as { code?: string }).code ?? String(err)}`);
  }
}
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
/** The body a whole blob holds. Throws BlobDecodeError on a delta, a bad stream, a body over `maxBytes`, or bad UTF-8. */
export function wholeText(content: StoredContent, encoding: string | null, maxBytes: number): string {
  if (encoding === null) {
    if (typeof content === "string") return content;
    try {
      return strictUtf8.decode(bytesOf(content));
    } catch {
      throw new BlobDecodeError("a whole blob is not UTF-8");
    }
  }
  if (encoding !== "deflate") throw new BlobDecodeError(`not a whole blob: ${encoding}`);
  try {
    return strictUtf8.decode(inflateBytes(content, maxBytes));
  } catch (err) {
    if (err instanceof BlobDecodeError) throw err;
    throw new BlobDecodeError("a deflated blob is not UTF-8");
  }
}
/** The raw Fossil delta bytes a delta blob holds. */
export function deltaBytes(content: StoredContent, encoding: string, maxBytes: number): Uint8Array {
  if (encoding === "fossil-delta") {
    if (typeof content !== "string") throw new BlobDecodeError("a fossil-delta blob holds bytes, not base64 text");
    try {
      return Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
    } catch {
      throw new BlobDecodeError("a fossil-delta blob is not base64");
    }
  }
  if (encoding === "fossil-delta-z") return inflateBytes(content, maxBytes);
  throw new BlobDecodeError(`not a delta blob: ${encoding}`);
}
