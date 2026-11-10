// POSIX tar, the subset a vault export uses: regular files in ustar headers, and a PAX `path` record before a file
// whose name doesn't fit 100 bytes. This is what cloud's `GET /api/export` writes and what its import reads; GNU
// long-name records (which GNU tar writes by default) are refused by that reader, so the writer here never makes one.
export interface TarFile {
  name: string;
  bytes: Uint8Array;
}

const BLOCK = 512;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function untar(buf: Uint8Array): TarFile[] {
  const out: TarFile[] = [];
  const text = (a: Uint8Array) => dec.decode(a).replace(/\0.*$/s, "");
  let paxPath: string | null = null;
  for (let off = 0; off + BLOCK <= buf.length; ) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(text(h.subarray(124, 136)).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error("tar: a header has no readable size");
    const type = String.fromCharCode(h[156] || 48);
    const prefix = text(h.subarray(345, 500));
    const name = (prefix ? `${prefix}/` : "") + text(h.subarray(0, 100));
    const body = buf.subarray(off + BLOCK, off + BLOCK + size);
    if (body.length !== size) throw new Error(`tar: ${name} is cut short`);
    if (type === "x") {
      const m = /\d+ path=([^\n]*)\n/.exec(dec.decode(body));
      if (m) paxPath = m[1]!;
    } else if (type === "L" || type === "K" || type === "g") {
      throw new Error(`tar: a "${type}" record (GNU long name or PAX global): repack with this tool first`);
    } else {
      if (type === "0") out.push({ name: (paxPath ?? name).replace(/^(\.\/)+/, ""), bytes: body.slice() });
      paxPath = null;
    }
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}

function header(name: Uint8Array, size: number, type: string): Uint8Array {
  const h = new Uint8Array(BLOCK);
  h.set(name.subarray(0, 100), 0);
  const field = (off: number, len: number, value: string) => h.set(enc.encode(value.padStart(len - 1, "0")), off);
  field(100, 8, "644");
  field(108, 8, "0");
  field(116, 8, "0");
  field(124, 12, size.toString(8));
  field(136, 12, "0"); // mtime 0: the same vault always packs to the same bytes
  h.set(enc.encode("        "), 148);
  h[156] = type.charCodeAt(0);
  h.set(enc.encode("ustar\0" + "00"), 257);
  let sum = 0;
  for (const b of h) sum += b;
  h.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return h;
}

function padded(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(bytes.length / BLOCK) * BLOCK);
  out.set(bytes);
  return out;
}

export function tar(files: TarFile[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const name = enc.encode(f.name);
    if (name.length > 100) {
      // "<len> path=<name>\n", where <len> counts itself.
      const body = ` path=${f.name}\n`;
      let len = enc.encode(body).length + 1;
      while (String(len).length + enc.encode(body).length !== len) len = String(len).length + enc.encode(body).length;
      const record = enc.encode(`${len}${body}`);
      parts.push(header(enc.encode("PaxHeader"), record.length, "x"), padded(record));
    }
    parts.push(header(name, f.bytes.length, "0"), padded(f.bytes));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export const ATTACHMENT_PREFIX = ".parachute/attachments/";
export const isAttachment = (name: string) => name.startsWith(ATTACHMENT_PREFIX);
