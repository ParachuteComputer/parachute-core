/**
 * add-attachment (T-476): a file whose bytes ride in the MCP call, for an AI whose runtime can't reach the ticket
 * URL. Through the real MCP HTTP handler and the real ticket-spend writer; the stored bytes are read back from the
 * vault's assets and through read-attachment. Made-up files only.
 */

import { describe, test, expect } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

process.env.PARACHUTE_HOME = join(tmpdir(), `vault-add-attachment-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

const { handleScopedMcp } = await import("./mcp-http.ts");
const { getServerInstruction } = await import("./mcp-tools.ts");
const { writeVaultConfig, assetsDir } = await import("./config.ts");
const { getVaultStore } = await import("./vault-store.ts");
const { MAX_INLINE_ATTACHMENT_BYTES } = await import("../core/src/attachment/inline.ts");

function freshVault(prefix: string): string {
  const name = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeVaultConfig({ name, api_keys: [], created_at: new Date().toISOString() });
  return name;
}

const WRITE = ["vault:read", "vault:write"];
function auth(scopes: string[], scoped_tags: string[] | null = null) {
  return { permission: scopes.includes("vault:write") ? "full" : "read", scopes, legacyDerived: false, scoped_tags } as any;
}

async function rpc(vault: string, method: string, params: Record<string, unknown>, a = auth(WRITE)): Promise<any> {
  const req = new Request(`http://localhost:1940/vault/${vault}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await handleScopedMcp(req, vault, a)).json();
}

/** The tool's answer, or its refusal as `{refused: {code, error_type, field, message}}`. */
async function add(vault: string, args: Record<string, unknown>, a = auth(WRITE)): Promise<any> {
  const body = await rpc(vault, "tools/call", { name: "add-attachment", arguments: args }, a);
  if (body.error) return { refused: { code: body.error.code, ...(body.error.data ?? {}), message: body.error.message } };
  if (body.result?.isError) return { refused: { message: body.result.content?.[0]?.text } };
  return JSON.parse(body.result.content[0].text);
}

const b64url = (b: Uint8Array) => createHash("sha256").update(b).digest("base64url");
function fileInput(bytes: Uint8Array, over: Record<string, unknown> = {}) {
  return {
    id: "f1",
    name: "made-up.bin",
    mimeType: "application/octet-stream",
    size: bytes.length,
    digest: { algorithm: "sha-256", value: b64url(bytes) },
    data: Buffer.from(bytes).toString("base64"),
    ...over,
  };
}

describe("add-attachment", () => {
  test("stores the exact bytes on the record, with the type from the name", async () => {
    const vault = freshVault("addatt");
    const store = getVaultStore(vault);
    const note = await store.createNote("# Has a file\n", { path: "has-file" });
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...randomBytes(3000)]);

    const r = await add(vault, { record: "has-file", file: fileInput(bytes, { name: "map.png", mimeType: "image/png" }) });
    expect(r.refused).toBeUndefined();
    expect(r.record).toBe(note.id);
    expect(r.attachment.size).toBe(bytes.length);
    expect(r.attachment.mime_type).toBe("image/png");
    expect(r.attachment.path).toEndWith(".png");

    const rows = await store.getAttachments(note.id);
    expect(rows.map((x) => x.id)).toEqual([r.attachment.id]);
    expect(rows[0]!.metadata?.original_name).toBe("map.png");
    const stored = readFileSync(join(assetsDir(vault), rows[0]!.path));
    expect(b64url(new Uint8Array(stored))).toBe(b64url(bytes));
  });

  test("a hex digest is taken too, line-wrapped base64 decodes, and a text file reads back through read-attachment", async () => {
    const vault = freshVault("addatt-text");
    const note = await getVaultStore(vault).createNote("# Notes\n", { path: "n" });
    const text = new TextEncoder().encode("first line\nsecond line\n".repeat(40));
    const wrapped = Buffer.from(text).toString("base64").replace(/(.{76})/g, "$1\n");
    const r = await add(vault, {
      record: note.id,
      file: fileInput(text, { name: "notes.txt", mimeType: "text/plain", data: wrapped, digest: { algorithm: "sha-256", value: createHash("sha256").update(text).digest("hex") } }),
    });
    expect(r.refused).toBeUndefined();
    const read = await rpc(vault, "tools/call", { name: "read-attachment", arguments: { attachment_id: r.attachment.id } });
    expect(JSON.parse(read.result.content[0].text).content).toBe(new TextDecoder().decode(text));
  });

  test("a digest or size that doesn't match the bytes is refused, and nothing is stored", async () => {
    const vault = freshVault("addatt-check");
    const store = getVaultStore(vault);
    const note = await store.createNote("# x\n", { path: "x" });
    const bytes = new Uint8Array(randomBytes(500));
    const other = new Uint8Array(randomBytes(500));

    const wrongDigest = await add(vault, { record: note.id, file: fileInput(bytes, { digest: { algorithm: "sha-256", value: b64url(other) } }) });
    expect(wrongDigest.refused?.error_type).toBe("digest_mismatch");

    // One base64 character changed: what a model copying by hand gets wrong.
    const good = Buffer.from(bytes).toString("base64");
    const typo = good.slice(0, 100) + (good[100] === "A" ? "B" : "A") + good.slice(101);
    const copiedWrong = await add(vault, { record: note.id, file: fileInput(bytes, { data: typo }) });
    expect(copiedWrong.refused?.error_type).toBe("digest_mismatch");

    const short = await add(vault, { record: note.id, file: fileInput(bytes, { data: Buffer.from(bytes.slice(0, 400)).toString("base64") }) });
    expect(short.refused?.error_type).toBe("size_mismatch");

    expect(await store.getAttachments(note.id)).toEqual([]);
  });

  test("a file over the cap is refused before it is decoded, with the way that takes it", async () => {
    const vault = freshVault("addatt-cap");
    const note = await getVaultStore(vault).createNote("# x\n", { path: "x" });
    const big = new Uint8Array(randomBytes(MAX_INLINE_ATTACHMENT_BYTES + 1));
    const r = await add(vault, { record: note.id, file: fileInput(big) });
    expect(r.refused?.error_type).toBe("inline_too_large");
    expect(r.refused?.hint).toContain("attachment-url");
    // A small declared size doesn't let a long string through.
    const lying = await add(vault, { record: note.id, file: fileInput(big, { size: 10 }) });
    expect(lying.refused?.error_type).toBe("inline_too_large");
    // At the cap exactly, it is stored.
    const atCap = new Uint8Array(randomBytes(MAX_INLINE_ATTACHMENT_BYTES));
    expect((await add(vault, { record: note.id, file: fileInput(atCap) })).attachment?.size).toBe(MAX_INLINE_ATTACHMENT_BYTES);
  });

  test("a missing record, missing bytes and active content are refused", async () => {
    const vault = freshVault("addatt-refuse");
    const store = getVaultStore(vault);
    const note = await store.createNote("# x\n", { path: "x" });
    const bytes = new TextEncoder().encode("<html><script>made up</script></html>");

    expect((await add(vault, { record: "no/such/record", file: fileInput(bytes) })).refused?.error_type).toBe("not_found");
    const { data: _d, ...noData } = fileInput(bytes);
    const missing = await add(vault, { record: note.id, file: noData });
    expect(missing.refused?.error_type).toBe("missing_required_field");
    expect(missing.refused?.field).toBe("file.data");
    expect((await add(vault, { record: note.id, file: fileInput(bytes, { name: "page.html", mimeType: "text/html" }) })).refused?.error_type).toBe("blocked_upload_extension");
    // No name: the type alone says what it is, and active content is still refused.
    const { name: _n, ...unnamed } = fileInput(bytes, { mimeType: "text/html" });
    expect((await add(vault, { record: note.id, file: unnamed })).refused?.error_type).toBe("blocked_upload_extension");
    // A passive name doesn't launder an active type.
    const disguised = await add(vault, { record: note.id, file: fileInput(bytes, { name: "a.txt", mimeType: "text/html" }) });
    expect(disguised.refused?.error_type).toBe("blocked_upload_extension");
    expect(disguised.refused?.field).toBe("file.mimeType");
    expect((await add(vault, { record: "no/such/record", file: fileInput(bytes) })).refused?.field).toBe("record");
    expect((await add(vault, { note: note.id, file: fileInput(bytes) })).refused?.error_type).toBe("unknown_parameter");
    expect(await store.getAttachments(note.id)).toEqual([]);
  });

  test("a file's id never names the stored file: no blocked extension reaches disk", async () => {
    const vault = freshVault("addatt-id");
    const store = getVaultStore(vault);
    const note = await store.createNote("# x\n", { path: "x" });
    const bytes = new TextEncoder().encode("made up, not markup");
    const { name: _n, ...unnamed } = fileInput(bytes, { id: "evil.html", mimeType: "application/octet-stream" });
    const r = await add(vault, { record: note.id, file: unnamed });
    expect(r.refused).toBeUndefined();
    expect(r.attachment.path).not.toMatch(/\.(html|svg|js)$/);
    const blank = await add(vault, { record: note.id, file: { ...fileInput(bytes, { id: "x.svg", mimeType: "text/plain" }), name: " " } });
    expect(blank.attachment.path).not.toMatch(/\.svg$/);
    const rows = await store.getAttachments(note.id);
    expect(rows.map((a) => a.path).filter((p) => /\.(html|svg|js)$/.test(p))).toEqual([]);
    // No name, a text type: stored with that type's extension, so a download serves it as text.
    const { name: _n2, ...unnamedText } = fileInput(bytes, { mimeType: "text/plain" });
    expect((await add(vault, { record: note.id, file: unnamedText })).attachment.path).toEndWith(".txt");
  });

  test("a digest in plain base64 (+ and /) is taken as well as base64url", async () => {
    const vault = freshVault("addatt-b64");
    const note = await getVaultStore(vault).createNote("# x\n", { path: "x" });
    // Find made-up bytes whose SHA-256 has a + or / in plain base64, so the two alphabets differ.
    let bytes = new Uint8Array(randomBytes(200));
    while (!/[+/]/.test(createHash("sha256").update(bytes).digest("base64"))) bytes = new Uint8Array(randomBytes(200));
    const plain = createHash("sha256").update(bytes).digest("base64");
    const r = await add(vault, { record: note.id, file: fileInput(bytes, { digest: { algorithm: "sha-256", value: plain } }) });
    expect(r.refused).toBeUndefined();
    expect(r.attachment.size).toBe(200);
  });

  test("a reader can't see or call it; a tag-scoped writer can't attach outside its scope", async () => {
    const vault = freshVault("addatt-scope");
    const store = getVaultStore(vault);
    const inScope = await store.createNote("# in\n", { path: "in", tags: ["work"] });
    const outside = await store.createNote("# out\n", { path: "out", tags: ["home"] });
    const bytes = new Uint8Array(randomBytes(64));

    const listed = await rpc(vault, "tools/list", {}, auth(["vault:read"]));
    expect(listed.result.tools.map((t: any) => t.name)).not.toContain("add-attachment");
    expect((await add(vault, { record: inScope.id, file: fileInput(bytes) }, auth(["vault:read"]))).refused).toBeDefined();

    const scoped = auth(WRITE, ["work"]);
    expect((await add(vault, { record: outside.id, file: fileInput(bytes) }, scoped)).refused?.error_type).toBe("not_found");
    expect(await store.getAttachments(outside.id)).toEqual([]);
    expect((await add(vault, { record: inScope.id, file: fileInput(bytes) }, scoped)).attachment?.size).toBe(64);
  });

  test("an audio file with transcribe: true is queued as an upload ticket's is", async () => {
    const vault = freshVault("addatt-audio");
    const store = getVaultStore(vault);
    const note = await store.createNote("# memo\n", { path: "memo" });
    const r = await add(vault, { record: note.id, file: fileInput(new Uint8Array([1, 2, 3, 4]), { name: "memo.wav", mimeType: "audio/wav" }), transcribe: true });
    const [row] = await store.getAttachments(note.id);
    expect(row!.id).toBe(r.attachment.id);
    expect(row!.metadata?.transcribe_status).toBe("pending");
    expect((await store.getNote(note.id))!.metadata?.transcribe_stub).toBe(true);
  });

  test("tools/list marks the file argument x-mcp-file only for a client that declared the extension", async () => {
    const vault = freshVault("addatt-list");
    const plain = await rpc(vault, "tools/list", {});
    const tool = plain.result.tools.find((t: any) => t.name === "add-attachment");
    expect(tool.inputSchema.required).toEqual(["record", "file"]);
    expect(tool.inputSchema.properties.file.properties.data.type).toBe("string");
    expect(tool.inputSchema.properties.file["x-mcp-file"]).toBeUndefined();
    expect(tool.annotations.readOnlyHint).toBe(false);

    const declared = await rpc(vault, "tools/list", { _meta: { "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/files": {} } } } });
    const marked = declared.result.tools.find((t: any) => t.name === "add-attachment");
    expect(marked.inputSchema.properties.file["x-mcp-file"]).toEqual({ maxSize: MAX_INLINE_ATTACHMENT_BYTES });
  });

  test("the connect-time brief tells a writer to use it when it holds the bytes, and a reader nothing about it", async () => {
    const vault = freshVault("addatt-brief");
    expect(await getServerInstruction(vault, auth(WRITE))).toContain("`add-attachment` stores a file sent in the call");
    expect(await getServerInstruction(vault, auth(["vault:read"]))).not.toContain("add-attachment");
  });
});
