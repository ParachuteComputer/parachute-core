/**
 * Where an export puts attachment binaries (T-318 decision A, prototype).
 *
 * The shipped layout writes them under `.parachute/attachments/<id>/`. Obsidian
 * (and any tool that hides dot-folders) never indexes that folder, so a person
 * who opens their export as an Obsidian vault sees broken images. Two visible
 * layouts: `folder` (`_attachments/<storage path>`) and `beside-note`
 * (`<note> files/<file>`). Either one must still round-trip: the imported body
 * is the stored body, the binary comes back, and nothing export-only reaches
 * an attachment row. Old (sidecar) exports keep importing; those are pinned in
 * portable-md-attachment-links.test.ts and portable-md-old-export.test.ts.
 *
 * All data here is made up.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";

import { SqliteStore } from "./store.js";
import {
  ATTACHMENTS_FOLDER,
  exportVaultToDir,
  importPortableVault,
  pruneOrphans,
  type AttachmentLayout,
} from "./portable-md.js";

const IMG = "2026-10-30/1793394673667-0a1b2c3d-garden.png";
const IMG_2 = "2026-10-31/1793394673667-0a1b2c3d-garden.png"; // same basename, other folder
const ROOT_ID = "01M67ABS8ABZS3S1ZYSSK28ZVQ";
const SUB_ID = "01M67ABS8ABZS3S1ZYSSK28ZVR";
const ROOT_BODY = `![garden.png](/api/storage/${IMG})\nBeds by the fence.\n`;
const SUB_BODY = `Two shots:\n![garden.png](/api/storage/${IMG})\n![garden.png](/api/storage/${IMG_2})\n`;
const AT = "2026-10-30T15:10:00.000Z";

function linkTargets(body: string): string[] {
  return [...body.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!);
}

function exportedBody(file: string): string {
  const raw = readFileSync(file, "utf-8");
  return raw.slice(raw.indexOf("\n---\n", 4) + "\n---\n".length);
}

describe("portable-md visible attachment layouts (T-318 decision A)", () => {
  const tmpBase = join(tmpdir(), "parachute-portable-att-layout");
  const assets = join(tmpBase, "assets");
  let store: SqliteStore;
  let warn: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    try { rmSync(tmpBase, { recursive: true }); } catch {}
    mkdirSync(join(assets, "2026-10-30"), { recursive: true });
    mkdirSync(join(assets, "2026-10-31"), { recursive: true });
    writeFileSync(join(assets, IMG), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
    writeFileSync(join(assets, IMG_2), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02]));
    store = new SqliteStore(new Database(":memory:"));
    // A root-level note and a note two folders down, both using IMG; the
    // second also has another file with the same basename.
    await store.createNote(ROOT_BODY, { id: ROOT_ID, path: "Garden" });
    await store.addAttachment(ROOT_ID, IMG, "image/png");
    await store.createNote(SUB_BODY, { id: SUB_ID, path: "Projects/2026/Beds" });
    await store.addAttachment(SUB_ID, IMG, "image/png");
    await store.addAttachment(SUB_ID, IMG_2, "image/png");
    warn = spyOn(console, "warn");
  });

  afterEach(() => warn.mockRestore());

  const layouts: Array<[AttachmentLayout, (noteFile: string) => string]> = [
    ["folder", () => `${ATTACHMENTS_FOLDER}/`],
    ["beside-note", (noteFile) => `${noteFile.slice(0, -".md".length)} files/`],
  ];

  for (const [layout, expectedDir] of layouts) {
    it(`${layout}: every exported link resolves to a file outside any dot-folder`, async () => {
      const out = join(tmpBase, "out");
      const stats = await exportVaultToDir(store, { outDir: out, assetsDir: assets, exportedAt: AT, attachmentLayout: layout });
      expect(stats.attachments).toBe(3);
      expect(stats.skipped_attachments).toEqual([]);
      for (const noteFile of ["Garden.md", "Projects/2026/Beds.md"]) {
        const body = exportedBody(join(out, noteFile));
        const targets = linkTargets(body);
        expect(targets.length).toBeGreaterThan(0);
        const files = new Set<string>();
        for (const t of targets) {
          expect(t.startsWith("/api/storage/")).toBe(false);
          const file = resolve(dirname(join(out, noteFile)), decodeURIComponent(t));
          const rel = file.slice(resolve(out).length + 1);
          expect(existsSync(file)).toBe(true);
          // Obsidian (and Finder by default) hide dot-folders.
          expect(rel.split("/").some((seg) => seg.startsWith("."))).toBe(false);
          expect(rel.startsWith(expectedDir(noteFile))).toBe(true);
          files.add(rel);
          // The ref records the file it went to, for the importer.
          expect(readFileSync(join(out, noteFile), "utf-8")).toContain(`    file: ${rel}\n`);
        }
        // The two same-named files of one note stay two files.
        expect(files.size).toBe(targets.length);
      }
    });

    it(`${layout}: export -> import gives back the stored bodies and binaries, re-export matches`, async () => {
      const outA = join(tmpBase, "a");
      await exportVaultToDir(store, { outDir: outA, assetsDir: assets, exportedAt: AT, attachmentLayout: layout });

      const target = new SqliteStore(new Database(":memory:"));
      const destAssets = join(tmpBase, "dest-assets");
      mkdirSync(destAssets, { recursive: true });
      const stats = await importPortableVault(target, { inDir: outA, assetsDir: destAssets });
      expect(stats.skipped_attachments).toEqual([]);
      expect(stats.attachments_restored).toBe(3);
      expect((await target.getNote(ROOT_ID))!.content).toBe(ROOT_BODY);
      expect((await target.getNote(SUB_ID))!.content).toBe(SUB_BODY);
      // The binaries the walk met are attachments, not skipped notes.
      expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("[import] skipped"))).toEqual([]);
      expect(readFileSync(join(destAssets, IMG))).toEqual(readFileSync(join(assets, IMG)));
      expect(readFileSync(join(destAssets, IMG_2))).toEqual(readFileSync(join(assets, IMG_2)));
      const rows = await target.getAttachments(SUB_ID);
      expect(rows.map((r) => [r.path, r.metadata ?? null]).sort()).toEqual([[IMG, null], [IMG_2, null]]);
      // The binaries are not notes.
      expect((await target.queryNotes({ limit: 100 })).map((n) => n.id).sort()).toEqual([ROOT_ID, SUB_ID]);

      // Re-export: identical once the re-minted attachment ids are mapped back.
      const outB = join(tmpBase, "b");
      await exportVaultToDir(target, { outDir: outB, assetsDir: destAssets, exportedAt: AT, attachmentLayout: layout });
      const ids = async (s: SqliteStore, id: string) => (await s.getAttachments(id)).map((a) => [a.path, a.id] as const);
      const oldIds = new Map([...(await ids(store, ROOT_ID)), ...(await ids(store, SUB_ID))].map(([p, i]) => [i, p]));
      const newIds = new Map([...(await ids(target, ROOT_ID)), ...(await ids(target, SUB_ID))].map(([p, i]) => [i, p]));
      const normalize = (s: string, m: Map<string, string>) => [...m].reduce((acc, [id, p]) => acc.split(id).join(`<${p}>`), s);
      for (const f of ["Garden.md", "Projects/2026/Beds.md"]) {
        expect(normalize(readFileSync(join(outB, f), "utf-8"), newIds)).toBe(normalize(readFileSync(join(outA, f), "utf-8"), oldIds));
      }
    });
  }

  it("a recorded file outside the export's visible files is not restored", async () => {
    const dir = join(tmpBase, "hand");
    mkdirSync(join(dir, ".parachute"), { recursive: true });
    writeFileSync(join(dir, ".parachute", "vault.yaml"), "export_format_version: 1\nexported_at: 2026-10-30T00:00:00.000Z\n");
    writeFileSync(join(tmpBase, "outside.png"), "secret");
    const refs = ["../outside.png", ".parachute/vault.yaml"]
      .map((f, i) => `  - file: ${f}\n    id: att_${i}\n    mime_type: image/png\n    path: 2026-10-30/p${i}.png\n`)
      .join("");
    writeFileSync(join(dir, "plan.md"), `---\nid: n-plan\npath: plan\nattachments:\n${refs}created_at: 2026-10-30T00:00:00.000Z\n---\nbody\n`);
    const destAssets = join(tmpBase, "dest");
    mkdirSync(destAssets, { recursive: true });
    const stats = await importPortableVault(new SqliteStore(new Database(":memory:")), { inDir: dir, assetsDir: destAssets });
    expect(stats.attachments_restored).toBe(0);
    expect(stats.skipped_attachments).toHaveLength(2);
    expect(existsSync(join(destAssets, "2026-10-30", "p0.png"))).toBe(false);
    expect(existsSync(join(destAssets, "2026-10-30", "p1.png"))).toBe(false);
  });

  it("folder: files sit at their storage path; notes sharing a stored file share one copy", async () => {
    // A third file whose storage path differs from IMG only by case: on a
    // case-insensitive disk it would overwrite IMG, so it goes to its id folder.
    const upper = IMG.replace("garden", "GARDEN");
    writeFileSync(join(assets, upper), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x03]));
    const third = await store.addAttachment(ROOT_ID, upper, "image/png");
    const out = join(tmpBase, "out");
    const stats = await exportVaultToDir(store, { outDir: out, assetsDir: assets, exportedAt: AT, attachmentLayout: "folder" });
    expect(stats.attachments).toBe(4); // per ref, as in every layout
    const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: join(out, ATTACHMENTS_FOLDER) }))).sort();
    expect(files).toEqual([`${third.id}/${upper.split("/")[1]}`, IMG, IMG_2].sort());
    expect(readFileSync(join(out, ATTACHMENTS_FOLDER, IMG))).toEqual(readFileSync(join(assets, IMG)));
  });

  it("folder: the mirror sweep removes files of deleted attachments and keeps live ones", async () => {
    const out = join(tmpBase, "mirror");
    await exportVaultToDir(store, { outDir: out, assetsDir: assets, exportedAt: AT, attachmentLayout: "folder" });
    // IMG_2's row is gone from the vault; IMG is still attached.
    const live = (await store.getAttachments(ROOT_ID)).map((a) => a.id);
    const stats = pruneOrphans({
      outDir: out,
      validNoteIds: new Set([ROOT_ID, SUB_ID]),
      validTagNames: new Set(),
      validAttachmentIds: new Set(live),
      validAttachmentPaths: new Set([IMG]),
    });
    expect(stats.attachment_files_removed).toBe(1);
    expect(stats.notes_removed).toBe(0);
    expect(stats.unparseable_files).toEqual([]);
    expect(existsSync(join(out, ATTACHMENTS_FOLDER, IMG))).toBe(true);
    expect(existsSync(join(out, ATTACHMENTS_FOLDER, "2026-10-31"))).toBe(false); // emptied folder removed
    // Without the path set the folder is left alone.
    await exportVaultToDir(store, { outDir: out, assetsDir: assets, exportedAt: AT, attachmentLayout: "folder" });
    const untouched = pruneOrphans({ outDir: out, validNoteIds: new Set([ROOT_ID, SUB_ID]), validTagNames: new Set(), validAttachmentIds: new Set() });
    expect(untouched.attachment_files_removed).toBe(0);
    expect(existsSync(join(out, ATTACHMENTS_FOLDER, IMG_2))).toBe(true);
  });
});
