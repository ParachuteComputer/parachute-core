/**
 * `GET /api/export`: the whole vault as one tar, streamed (0.9.3 "the exit").
 *
 * The same export engine as `parachute-vault export` (core `exportVault`) writes into a sink that collects the
 * files instead of writing a folder, and the collected files go out as a POSIX tar, so the archive holds the same
 * paths and bytes as the folder, and as Parachute Cloud's tar (workers/vault export.ts: same engine, same tar
 * layout: ustar headers, a PAX `path` record for a name that has no ustar split, mtime 0 so equal vaults give equal
 * bytes). Text is held in memory (notes are small); each attachment is streamed from disk when its turn comes, never
 * read whole, so the memory a pull needs does not grow with the size of the files.
 */
import { createReadStream, realpathSync, statSync } from "node:fs";
import { join, resolve as resolvePath, sep } from "node:path";
import { exportVault, type ExportEngineOptions, type ExportSink, type ExportStats, type SinkWriteResult } from "../core/src/portable-md.ts";
import type { Store } from "../core/src/types.ts";

interface TextEntry {
  name: string;
  bytes: Uint8Array;
}
interface FileEntry {
  name: string;
  /** Absolute path on disk the bytes are streamed from. */
  path: string;
  size: number;
}
export type TarEntry = TextEntry | FileEntry;
const isFile = (e: TarEntry): e is FileEntry => "path" in e;

const normalize = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** An `ExportSink` that collects the export's files in emission order. */
class CollectingSink implements ExportSink {
  // A tar is extracted wherever the person takes it; the engine's case-collision handling is the one cloud uses.
  readonly caseSensitive = true;
  readonly attachmentsEnabled: boolean;
  readonly entries: TarEntry[] = [];
  private readonly assets: string | null;
  private readonly enc = new TextEncoder();

  constructor(assetsDir: string | null) {
    this.assets = assetsDir ? resolvePath(assetsDir) : null;
    this.attachmentsEnabled = this.assets !== null;
  }

  writeText(relPath: string, content: string): SinkWriteResult {
    // The folder export refuses a path that leaves its root; a tar entry that is absolute or climbs with ".." would
    // land outside wherever it is extracted, so it is refused here the same way (the engine records the skip).
    const name = normalize(relPath);
    if (name.startsWith("/") || name.split("/").includes("..")) {
      return { ok: false, reason: `path-traversal: "${relPath}" would leave the export root` };
    }
    this.entries.push({ name, bytes: this.enc.encode(content) });
    return { ok: true };
  }

  copyAttachment(srcRelPath: string, destRelPath: string): SinkWriteResult {
    if (!this.assets) return { ok: false, reason: "attachment binaries are not wired for this export" };
    const src = resolvePath(join(this.assets, srcRelPath));
    if (src !== this.assets && !src.startsWith(this.assets + sep)) {
      return { ok: false, reason: `path-traversal: source "${src}" escapes assetsDir "${this.assets}"` };
    }
    let size: number;
    try {
      // Follow links before the containment check too: a link inside the assets folder that leads out of it is skipped.
      const real = realpathSync(src);
      const root = realpathSync(this.assets);
      if (real !== root && !real.startsWith(root + sep)) {
        return { ok: false, reason: `path-traversal: source "${src}" resolves outside assetsDir "${this.assets}"` };
      }
      const st = statSync(real);
      if (!st.isFile()) return { ok: false, reason: `source is not a file at "${src}"` };
      size = st.size;
    } catch {
      return { ok: false, reason: `source file missing at "${src}"` };
    }
    this.entries.push({ name: normalize(destRelPath), path: realpathSync(src), size });
    return { ok: true };
  }
}

/** Run the engine into the collecting sink: the ordered entries and the engine's stats. */
export async function collectExportEntries(
  store: Store,
  opts: ExportEngineOptions,
  assetsDir: string | null,
): Promise<{ entries: TarEntry[]; stats: ExportStats }> {
  const sink = new CollectingSink(assetsDir);
  const stats = await exportVault(store, sink, opts);
  return { entries: sink.entries, stats };
}

// ── A minimal POSIX ustar writer (the same layout as Cloud's, so the two doors' tars read the same) ────────────

const BLOCK = 512;
const byteLen = (s: string) => new TextEncoder().encode(s).length;
const octal = (value: number, len: number) => value.toString(8).padStart(len - 1, "0").slice(-(len - 1)) + "\0";
function put(buf: Uint8Array, offset: number, str: string, max: number): void {
  const b = new TextEncoder().encode(str);
  buf.set(b.subarray(0, Math.min(b.length, max)), offset);
}

/** Split a path over 100 bytes into ustar name (at most 100) and prefix (at most 155) at a "/"; null if none fits. */
function splitName(path: string): { name: string; prefix: string } | null {
  if (byteLen(path) <= 100) return { name: path, prefix: "" };
  let idx = path.length;
  for (;;) {
    idx = path.lastIndexOf("/", idx - 1);
    if (idx <= 0) break;
    const name = path.slice(idx + 1);
    const prefix = path.slice(0, idx);
    if (byteLen(name) <= 100 && byteLen(prefix) <= 155) return { name, prefix };
  }
  return null;
}

function header(name: string, prefix: string, size: number, typeflag = 0x30): Uint8Array {
  const h = new Uint8Array(BLOCK);
  put(h, 0, name, 100);
  put(h, 100, octal(0o644, 8), 8);
  put(h, 108, octal(0, 8), 8);
  put(h, 116, octal(0, 8), 8);
  put(h, 124, octal(size, 12), 12);
  put(h, 136, octal(0, 12), 12); // mtime 0: the same vault gives the same bytes
  h.fill(0x20, 148, 156);
  h[156] = typeflag;
  put(h, 257, "ustar\0", 6);
  put(h, 263, "00", 2);
  put(h, 345, prefix, 155);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i]!;
  put(h, 148, sum.toString(8).padStart(6, "0").slice(-6) + "\0 ", 8);
  return h;
}

function paxRecord(key: string, value: string): Uint8Array {
  const body = ` ${key}=${value}\n`;
  const bodyLen = byteLen(body);
  let len = bodyLen + 1;
  while (String(len).length + bodyLen !== len) len = String(len).length + bodyLen;
  return new TextEncoder().encode(`${len}${body}`);
}

function truncateUtf8(s: string, max: number): string {
  let out = "";
  for (const ch of s) {
    if (byteLen(out + ch) > max) break;
    out += ch;
  }
  return out;
}

/** Every header block for one entry: one ustar header, or a PAX `path` record then a ustar header for a long name. */
function entryHeader(entryName: string, size: number): Uint8Array {
  const split = splitName(entryName);
  if (split) return header(split.name, split.prefix, size);
  const record = paxRecord("path", entryName);
  const padded = Math.ceil(record.length / BLOCK) * BLOCK;
  const out = new Uint8Array(BLOCK + padded + BLOCK);
  out.set(header("PaxHeader", "", record.length, 0x78), 0);
  out.set(record, BLOCK);
  out.set(header(truncateUtf8(entryName, 100), "", size), BLOCK + padded);
  return out;
}

/** The exact size of the archive in bytes (sent as Content-Length, and what the stream must add up to). */
export function tarSize(entries: readonly TarEntry[]): number {
  let total = BLOCK * 2;
  for (const e of entries) {
    const size = isFile(e) ? e.size : e.bytes.length;
    total += entryHeader(e.name, size).length + Math.ceil(size / BLOCK) * BLOCK;
  }
  return total;
}

/**
 * The tar as a byte stream. A file that changed size after it was measured fails the stream (the client sees a cut-off
 * download, never a quietly wrong archive). `onDone` runs once, after the last byte has been handed to the client; it
 * does not run when the client goes away or the stream fails.
 */
export function tarStream(entries: readonly TarEntry[], onDone: () => void): ReadableStream<Uint8Array> {
  const pad = (size: number) => new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for (const e of entries) {
      if (!isFile(e)) {
        yield entryHeader(e.name, e.bytes.length);
        yield e.bytes;
        yield pad(e.bytes.length);
        continue;
      }
      yield entryHeader(e.name, e.size);
      let sent = 0;
      // `end` bounds the read, so a file that grew can't push the archive past its measured size.
      const file = createReadStream(e.path, { start: 0, end: Math.max(e.size - 1, 0) });
      if (e.size > 0) {
        for await (const c of file) {
          const b = c as Uint8Array;
          sent += b.length;
          yield b;
        }
      } else file.destroy();
      if (sent !== e.size) throw new Error(`export: "${e.name}" changed while it was being sent (${sent} of ${e.size} bytes)`);
      yield pad(e.size);
    }
    yield new Uint8Array(BLOCK * 2);
  }
  const it = chunks();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const n = await it.next();
        if (n.done) {
          controller.close();
          onDone();
        } else controller.enqueue(n.value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await it.return(undefined);
    },
  });
}
