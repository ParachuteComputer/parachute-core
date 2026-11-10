// Surface F: files. An app uploads a file, attaches it to a note, and gets the same bytes back; an AI app does the
// same with a ticket it can hand to a shell. Bytes are compared exactly.
import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { door, enc, fp, mcp, mediaType, refusal, rest, runId, safeFetch, shape, token, vaultUrl } from "./_door.ts";

const api = rest("write");
const reader = rest("read");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
// A real PNG header and random bytes after it: binary that a text decoder would corrupt.
const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...randomBytes(4096)]);

async function upload(bytes: Uint8Array, name: string, type: string) {
  const form = new FormData();
  form.set("file", new File([bytes as unknown as BlobPart], name, { type }));
  return api.call("POST", "/api/storage/upload", form);
}

describe("files", () => {
  test("upload, attach to a note, read back the same bytes", async () => {
    const bytes = png();
    const up = await upload(bytes, "map.png", "image/png");
    expect(up.status, up.text.slice(0, 200)).toBe(201);
    expect(up.body.size).toBe(bytes.length);
    fp("files/upload.reply.shape", shape(up.body));
    fp("files/upload.path.form", String(up.body.path).replace(/\d{4}-\d{2}-\d{2}/, "<date>").replace(/[0-9a-f-]{8,}/gi, "<id>"));

    const note = await api.post("/notes", { content: "has a file", path: `${runId("files")}/n` });
    const att = await api.post(`/notes/${note.body.id}/attachments`, { path: up.body.path, mimeType: "image/png" });
    expect(att.status, JSON.stringify(att.body)).toBe(201);
    fp("files/attach.reply.shape", shape(att.body));
    const listed = await reader.get(`/notes/${note.body.id}/attachments`);
    expect(listed.status).toBe(200);
    fp("files/attachments.list.shape", shape(listed.body));
    const withFiles = await reader.get(`/notes/${note.body.id}?include_attachments=true`);
    expect(JSON.stringify(withFiles.body.attachments)).toContain(up.body.path);

    const got = await safeFetch(`${vaultUrl()}/api/storage/${up.body.path}`, { headers: { authorization: `Bearer ${await token("read")}` } });
    expect(got.status).toBe(200);
    expect(sha256(new Uint8Array(await got.arrayBuffer()))).toBe(sha256(bytes));
    fp("files/download.headers", { type: mediaType(got.headers), nosniff: got.headers.get("x-content-type-options"), disposition: (got.headers.get("content-disposition") ?? "").split(";")[0] || null });

    const part = await safeFetch(`${vaultUrl()}/api/storage/${up.body.path}`, { headers: { authorization: `Bearer ${await token("read")}`, range: "bytes=0-7" } });
    fp("files/download.range", { status: part.status, bytes: (await part.arrayBuffer()).byteLength });

    const attId = (Array.isArray(listed.body) ? listed.body : listed.body.attachments)[0].id;
    const det = await api.del(`/notes/${note.body.id}/attachments/${attId}`);
    expect(det.status).toBeLessThan(300);
    fp("files/detach.reply", { status: det.status, shape: shape(det.body) });
  });

  test("a file that could run in a browser is refused; no credential, no file", async () => {
    const svg = await upload(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), "x.svg", "image/svg+xml");
    expect(svg.status).toBe(400);
    fp("files/refusal.svg", refusal(svg));
    const html = await upload(new TextEncoder().encode("<html></html>"), "x.html", "text/html");
    expect(html.status).toBe(400);
    const txt = await upload(new TextEncoder().encode("plain text"), "x.txt", "text/plain");
    fp("files/upload.txt", { status: txt.status });
    const md = await upload(new TextEncoder().encode("# md"), "x.md", "text/markdown");
    fp("files/upload.md", { status: md.status });
    const pdf = await upload(new TextEncoder().encode("%PDF-1.4\n%made up\n"), "x.pdf", "application/pdf");
    fp("files/upload.pdf", { status: pdf.status });

    const up = await upload(png(), "y.png", "image/png");
    const anon = await safeFetch(`${vaultUrl()}/api/storage/${up.body.path}`);
    expect(anon.status).toBe(401);
    const missing = await reader.call("GET", `/api/storage/2001-01-01/${runId("no")}.png`);
    expect(missing.status).toBe(404);
    fp("files/refusal.no-such-file", refusal(missing));
    const readerUp = await rest("read").call("POST", "/api/storage/upload", (() => { const f = new FormData(); f.set("file", new File([png() as unknown as BlobPart], "z.png", { type: "image/png" })); return f; })());
    expect(readerUp.status).toBe(403);
  });

  test("an AI app moves a file with tickets: no credential on the upload or the download itself", async () => {
    const c = await mcp("write");
    try {
      const names = (await c.tools()).map((t) => t.name);
      expect(names).toContain("request-attachment-upload");
      expect(names).toContain("request-attachment-download");
      const bytes = png();
      const note = await api.post("/notes", { content: "ticketed", path: `${runId("files")}/t` });
      const ticket = await c.call("request-attachment-upload", { note: note.body.id, filename: "ticket.png", mime_type: "image/png", size_bytes: bytes.length });
      fp("files/ticket.upload.result.shape", shape(ticket));
      const url = String(Object.values(ticket).find((v) => typeof v === "string" && /\/tickets\//.test(v)) ?? "");
      expect(url, JSON.stringify(ticket).slice(0, 300)).toContain("/tickets/");
      expect(new URL(url).origin).toBe(door().vaultOrigin);
      const put = await safeFetch(url, { method: ticket.method ?? "PUT", headers: { "content-type": "image/png" }, body: bytes });
      expect(put.status, (await put.clone().text()).slice(0, 200)).toBeLessThan(300);
      fp("files/ticket.upload.spend.shape", shape(await put.json().catch(() => null)));
      const again = await safeFetch(url, { method: ticket.method ?? "PUT", headers: { "content-type": "image/png" }, body: bytes });
      expect(again.status).toBe(404);

      const listed = await reader.get(`/notes/${note.body.id}/attachments`);
      const atts = Array.isArray(listed.body) ? listed.body : listed.body.attachments;
      expect(atts.length).toBe(1);
      const down = await c.call("request-attachment-download", { attachment_id: atts[0].id });
      fp("files/ticket.download.result.shape", shape(down));
      const durl = String(Object.values(down).find((v) => typeof v === "string" && /\/tickets\//.test(v)) ?? "");
      const got = await safeFetch(durl);
      expect(got.status).toBe(200);
      expect(sha256(new Uint8Array(await got.arrayBuffer()))).toBe(sha256(bytes));
    } finally {
      await c.close();
    }
  });
});
