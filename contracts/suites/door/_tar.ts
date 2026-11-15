// A small POSIX tar reader (ustar, plus the PAX `path` record for long names): enough to read a vault export.
export interface TarFile {
  name: string;
  bytes: Uint8Array;
}

export function untar(buf: Uint8Array): TarFile[] {
  const out: TarFile[] = [];
  const text = (a: Uint8Array) => new TextDecoder().decode(a).replace(/\0.*$/s, "");
  let paxPath: string | null = null;
  for (let off = 0; off + 512 <= buf.length; ) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(text(h.subarray(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = text(h.subarray(345, 500));
    const name = (prefix ? `${prefix}/` : "") + text(h.subarray(0, 100));
    const body = buf.subarray(off + 512, off + 512 + size);
    if (type === "x") {
      // PAX records: "<len> key=value\n"
      const rec = new TextDecoder().decode(body);
      const m = /\d+ path=([^\n]*)\n/.exec(rec);
      if (m) paxPath = m[1]!;
    } else if (type === "0") {
      out.push({ name: paxPath ?? name, bytes: body.slice() });
      paxPath = null;
    } else paxPath = null;
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
