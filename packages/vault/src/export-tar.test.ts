/**
 * The export tar's path guards and its concurrent-pull cap (0.9.3, T-463). A tar is extracted wherever the person
 * takes it, so a name that climbs out, an absolute name, or a link that leads out of the attachments folder must be
 * skipped, never written.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CollectingSink, MAX_CONCURRENT_EXPORTS, tryAcquireExport } from "./export-tar.ts";

let root: string;
let assets: string;

beforeEach(() => {
  root = join(tmpdir(), `export-tar-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  assets = join(root, "assets");
  mkdirSync(join(assets, "sub"), { recursive: true });
  mkdirSync(join(root, "outside"), { recursive: true });
  writeFileSync(join(assets, "ok.png"), "made-up-bytes");
  writeFileSync(join(root, "outside", "secret.txt"), "made-up secret");
  symlinkSync(join(root, "outside", "secret.txt"), join(assets, "link.png"));
  symlinkSync(join(root, "outside"), join(assets, "dirlink"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("attachment sources", () => {
  test("a plain file inside the folder goes in", () => {
    const sink = new CollectingSink(assets);
    expect(sink.copyAttachment("ok.png", "attachments/ok.png").ok).toBe(true);
    expect(sink.entries.map((e) => e.name)).toEqual(["attachments/ok.png"]);
  });

  test("a symlink to a file outside the folder is skipped", () => {
    const sink = new CollectingSink(assets);
    const r = sink.copyAttachment("link.png", "attachments/link.png");
    expect(r.ok).toBe(false);
    expect(sink.entries).toEqual([]);
  });

  test("a file reached through a symlinked directory that leads out is skipped", () => {
    const sink = new CollectingSink(assets);
    expect(sink.copyAttachment("dirlink/secret.txt", "attachments/s.txt").ok).toBe(false);
    expect(sink.entries).toEqual([]);
  });

  test("a '..' source and an absolute source are skipped", () => {
    const sink = new CollectingSink(assets);
    expect(sink.copyAttachment("../outside/secret.txt", "a/x").ok).toBe(false);
    expect(sink.copyAttachment(join(root, "outside", "secret.txt"), "a/y").ok).toBe(false);
    expect(sink.entries).toEqual([]);
  });
});

describe("entry names", () => {
  test("'..' and absolute names are refused, a normal and a dotted name are kept", () => {
    const sink = new CollectingSink(assets);
    expect(sink.writeText("../escape.md", "x").ok).toBe(false);
    expect(sink.writeText("a/../../escape.md", "x").ok).toBe(false);
    expect(sink.writeText("a\\..\\escape.md", "x").ok).toBe(false);
    expect(sink.writeText("/etc/passwd", "x").ok).toBe(false);
    expect(sink.writeText("notes/fine.md", "x").ok).toBe(true);
    expect(sink.writeText("notes/..hidden.md", "x").ok).toBe(true);
    expect(sink.entries.map((e) => e.name)).toEqual(["notes/fine.md", "notes/..hidden.md"]);
  });
});

describe("concurrent pulls of one vault", () => {
  test("only MAX_CONCURRENT_EXPORTS at once; a release frees a slot; other vaults are unaffected", () => {
    const held = Array.from({ length: MAX_CONCURRENT_EXPORTS }, () => tryAcquireExport("cap-a")!);
    expect(held.every((r) => typeof r === "function")).toBe(true);
    expect(tryAcquireExport("cap-a")).toBeNull();
    const other = tryAcquireExport("cap-b");
    expect(other).not.toBeNull();
    held[0]!();
    held[0]!(); // a second release of the same slot frees nothing more
    const again = tryAcquireExport("cap-a");
    expect(again).not.toBeNull();
    expect(tryAcquireExport("cap-a")).toBeNull();
    for (const r of [...held, again!, other!]) r();
  });
});
