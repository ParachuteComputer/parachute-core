/**
 * `add-attachment`: a file whose bytes ride in the MCP tool call itself (T-476).
 *
 * The argument is the FileInput object of MCP's file-transfer extension
 * (`io.modelcontextprotocol/files`, draft): `{id, name?, mimeType, size,
 * digest: {algorithm: "sha-256", value}, data}`, with `data` the RFC 4648
 * base64 bytes. It is the one channel every agent has: a sandboxed runtime
 * (Claude's code sandbox, the API code-execution tool) may not reach this
 * door's ticket URL, but its MCP calls always arrive.
 *
 * This module only checks and decodes the argument; the door stores the bytes
 * through the same writer its upload-ticket spend uses
 * (`GenerateMcpToolsOpts.attachmentTickets.storeUpload`).
 *
 * Pure and runtime-agnostic (Web Crypto and `atob` only), because a Cloudflare
 * Worker bundles it as well as Bun.
 */

/** The MCP file-transfer extension's identifier. */
export const FILES_EXTENSION = "io.modelcontextprotocol/files";

/**
 * The largest file `add-attachment` takes, in decoded bytes; the extension's
 * `maxInlineBytes` and the tool's `x-mcp-file` `maxSize`.
 *
 * Measured, not guessed (T-476, 2026-11-24): a Claude model fills `file.data`
 * by typing the base64 itself, and random base64 costs about one output token
 * per character. Claude Opus retyped 16 KiB (22,136 base64 characters) and
 * 24 KiB (33,200) into one tool argument byte for byte; at 32 KiB
 * (44,267 characters) the call no longer fits one reply. So the cap is 24 KiB.
 * An agent with network access sends a larger file through `attachment-url`.
 */
export const MAX_INLINE_ATTACHMENT_BYTES = 24 * 1024;

export interface InlineFile {
  bytes: Uint8Array;
  /** The file's name when the caller gave one. */
  name?: string;
  mimeType: string;
}

type Refusal = { error_type: string; field: string; hint: string } & Record<string, unknown>;

function refuse(message: string, fields: Refusal): never {
  throw Object.assign(new Error(message), fields);
}

const HINT_DIGEST =
  "digest.value is the file's SHA-256 in base64url without padding (`openssl dgst -sha256 -binary f | basenc --base64url | tr -d =`); hex (`sha256sum f`) is taken too";

/** RFC 4648 base64 (padding optional; line breaks and spaces ignored) → bytes, or null when it isn't base64. */
function decodeBase64(data: string): Uint8Array | null {
  const clean = data.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) return null;
  const padded = clean.replace(/=+$/, "");
  let binary: string;
  try {
    binary = atob(padded + "===".slice((padded.length + 3) % 4));
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Check a FileInput and return its bytes. Refuses, before anything is stored:
 * a missing or malformed field, a file without `data` (this door takes files
 * inline only), a file over `maxBytes` (checked on the declared size and on the
 * base64's length before decoding), `data` that isn't base64, a decoded length
 * other than `size` (`size_mismatch`), and a SHA-256 other than `digest`
 * (`digest_mismatch`: the base64 was copied wrong).
 */
export async function readInlineFile(file: unknown, maxBytes: number = MAX_INLINE_ATTACHMENT_BYTES): Promise<InlineFile> {
  if (file === null || typeof file !== "object" || Array.isArray(file)) {
    refuse("`file` is required: {id, name, mimeType, size, digest, data}", {
      error_type: "missing_required_field",
      field: "file",
      hint: `pass file: {id: "f1", name: "notes.pdf", mimeType: "application/pdf", size: <bytes>, digest: {algorithm: "sha-256", value: "<sha-256>"}, data: "<base64>"}`,
    });
  }
  const f = file as Record<string, unknown>;
  if (typeof f.id !== "string" || f.id.length < 1 || f.id.length > 128) {
    refuse("`file.id` must be a string of 1 to 128 characters", { error_type: "invalid_query", field: "file.id", hint: 'any short label, e.g. "f1"' });
  }
  if (typeof f.mimeType !== "string" || f.mimeType.trim() === "") {
    refuse("`file.mimeType` is required", { error_type: "missing_required_field", field: "file.mimeType", hint: 'e.g. "application/pdf"; "application/octet-stream" when unknown' });
  }
  if (f.name !== undefined && typeof f.name !== "string") {
    refuse("`file.name` must be a string", { error_type: "invalid_query", field: "file.name", hint: 'the file\'s name, e.g. "notes.pdf"' });
  }
  const size = f.size;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
    refuse("`file.size` must be the file's exact length in bytes", { error_type: "invalid_query", field: "file.size", hint: "an integer: the decoded byte count, not the base64 length" });
  }
  if (size === 0) {
    refuse("The file is empty; there is nothing to store", { error_type: "invalid_query", field: "file.size", hint: "an empty file can't be attached" });
  }
  if (size > maxBytes) {
    refuse(`The file (${size} bytes) is over the ${maxBytes} byte limit for a file sent in the call`, {
      error_type: "inline_too_large",
      field: "file.size",
      limit: maxBytes,
      got: size,
      hint: "use attachment-url {action: \"upload\"} and PUT the bytes to its URL, if your runtime can reach this host",
    });
  }
  const digest = f.digest as Record<string, unknown> | undefined;
  if (!digest || typeof digest !== "object" || typeof digest.value !== "string" || (digest.algorithm !== undefined && digest.algorithm !== "sha-256")) {
    refuse("`file.digest` is required: {algorithm: \"sha-256\", value}", { error_type: "missing_required_field", field: "file.digest", hint: HINT_DIGEST });
  }
  if (typeof f.data !== "string" || f.data === "") {
    refuse("`file.data` is required: this vault takes a file's bytes in the call", {
      error_type: "missing_required_field",
      field: "file.data",
      hint: `send the bytes as file.data (base64, up to ${maxBytes} bytes), or use attachment-url if your runtime can reach this host`,
    });
  }
  // A base64 string longer than any file under the cap could need is refused before it is decoded.
  const data = f.data as string;
  if (data.replace(/\s+/g, "").length > Math.ceil(maxBytes / 3) * 4) {
    refuse(`The file is over the ${maxBytes} byte limit for a file sent in the call`, {
      error_type: "inline_too_large",
      field: "file.data",
      limit: maxBytes,
      hint: "use attachment-url {action: \"upload\"} and PUT the bytes to its URL, if your runtime can reach this host",
    });
  }
  const bytes = decodeBase64(data);
  if (!bytes) {
    refuse("`file.data` isn't base64", { error_type: "invalid_query", field: "file.data", hint: "RFC 4648 base64 (A-Z a-z 0-9 + /, = padding), e.g. the output of `base64 -w0 f`" });
  }
  if (bytes.length !== size) {
    refuse(`file.data decodes to ${bytes.length} bytes, but file.size says ${size}`, {
      error_type: "size_mismatch",
      field: "file.size",
      expected: size,
      got: bytes.length,
      hint: "send the whole file and its exact byte length; if you copied the base64 by hand, part of it is missing",
    });
  }
  const sum = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer));
  const want = (digest!.value as string).trim();
  const matches = /^[0-9a-fA-F]{64}$/.test(want) ? want.toLowerCase() === hex(sum) : want.replace(/=+$/, "") === base64url(sum);
  if (!matches) {
    refuse("file.data doesn't match file.digest: the bytes changed on the way", {
      error_type: "digest_mismatch",
      field: "file.digest",
      hint: `the base64 was copied wrong, or the digest is of another file. ${HINT_DIGEST}`,
    });
  }
  return { bytes, ...(typeof f.name === "string" && f.name.trim() !== "" ? { name: f.name } : {}), mimeType: (f.mimeType as string).trim() };
}

/** Did this MCP request's `_meta` declare the file-transfer extension (`io.modelcontextprotocol/clientCapabilities`)? */
export function declaresFilesExtension(meta: unknown): boolean {
  const caps = (meta as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/clientCapabilities"] as Record<string, unknown> | undefined;
  const ext = caps?.extensions as Record<string, unknown> | undefined;
  return !!ext && typeof ext === "object" && ext[FILES_EXTENSION] !== undefined && ext[FILES_EXTENSION] !== null;
}

/**
 * A tool's input schema as one client should see it. A file argument carries
 * the extension's `x-mcp-file` marker only for a request that declared the
 * extension (the spec's backward-compatibility rule: a client without it gets
 * a variant it can fill, here the same FileInput object, unmarked). An
 * AI that types the base64 itself then sees a plain object it can fill.
 */
export function schemaForClient(inputSchema: Record<string, unknown>, declared: boolean): Record<string, unknown> {
  if (declared) return inputSchema;
  const props = inputSchema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props || !Object.values(props).some((p) => p && typeof p === "object" && "x-mcp-file" in p)) return inputSchema;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, p] of Object.entries(props)) {
    if (p && typeof p === "object" && "x-mcp-file" in p) {
      const { "x-mcp-file": _marker, ...rest } = p;
      out[k] = rest;
    } else out[k] = p;
  }
  return { ...inputSchema, properties: out };
}

/** The extension's server settings, for a door that answers `server/discover`: inline only, no out-of-band upload yet. */
export const FILES_EXTENSION_SETTINGS = { maxInlineBytes: MAX_INLINE_ATTACHMENT_BYTES } as const;
