/**
 * Attachment links in an exported note resolve on disk (T-318 snag #8).
 *
 * The app inserts an attached file into a note body as
 * `![name](/api/storage/<att.path>)` (images) or `[name](/api/storage/<att.path>)`
 * (everything else). That URL only means something to a running vault. The
 * export writes the binary to `.parachute/attachments/<att.id>/<basename>`, so
 * the exported note's link must point there, relative to the note file, or a
 * file browser / markdown previewer shows a broken image.
 *
 * Import must undo it exactly: the imported body equals the original body.
 * The undo is gated on `attachment_links: relative` in `.parachute/vault.yaml`
 * and only touches targets that are the note's own attachment sidecar paths,
 * so an old export (no marker) and a hand-typed relative link import as-is.
 *
 * All data here is made up.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";

import { SqliteStore } from "./store.js";
import { exportVaultToDir, importPortableVault, SIDECAR_DIR } from "./portable-md.js";

const IMG_PATH = "2026-10-30/1793394673667-0a1b2c3d-garden.png";
const PDF_PATH = "2026-10-30/1793394673999-4e5f6a7b-seed list.pdf";
const NOTE_PATH = "Notes/2026/10-30/15-09-48";
const BODY = [
  `![garden.png](/api/storage/${IMG_PATH})`,
  "Plant the garlic before the first frost.",
  `[seed list.pdf](/api/storage/${PDF_PATH})`,
  // Not attached to this note: must stay as written.
  "![other](/api/storage/2026-10-29/not-attached.png)",
  // The bare URL outside link syntax: must stay as written.
  `raw: /api/storage/${IMG_PATH}`,
  "",
].join("\n");

/** Every inline link/embed target in a markdown body, in order. */
function linkTargets(body: string): string[] {
  return [...body.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!);
}

/** The note body of an exported `.md` file (after the closing `---`). */
function exportedBody(file: string): string {
  const raw = readFileSync(file, "utf-8");
  const close = raw.indexOf("\n---\n", 4);
  return raw.slice(close + "\n---\n".length);
}

describe("portable-md attachment links (T-318 #8)", async () => {
  const tmpBase = join(tmpdir(), "parachute-portable-att-links");
  const assets = join(tmpBase, "assets");
  let store: SqliteStore;

  beforeEach(() => {
    try { rmSync(tmpBase, { recursive: true }); } catch {}
    mkdirSync(join(assets, "2026-10-30"), { recursive: true });
    writeFileSync(join(assets, IMG_PATH), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
    writeFileSync(join(assets, PDF_PATH), "%PDF-1.4 made-up\n");
    store = new SqliteStore(new Database(":memory:"));
  });

  async function seedNote(): Promise<{ imgId: string; pdfId: string }> {
    await store.createNote(BODY, { id: "01M67ABS8ABZS3S1ZYSSK28ZVQ", path: NOTE_PATH });
    const img = await store.addAttachment("01M67ABS8ABZS3S1ZYSSK28ZVQ", IMG_PATH, "image/png");
    const pdf = await store.addAttachment("01M67ABS8ABZS3S1ZYSSK28ZVQ", PDF_PATH, "application/pdf");
    return { imgId: img.id, pdfId: pdf.id };
  }

  it("export rewrites the note's own attachment links to the exported sidecar files", async () => {
    const { imgId, pdfId } = await seedNote();
    const before = await store.getNote("01M67ABS8ABZS3S1ZYSSK28ZVQ");
    const outDir = join(tmpBase, "out");
    const stats = await exportVaultToDir(store, { outDir, assetsDir: assets, exportedAt: "2026-10-30T15:10:00.000Z" });
    expect(stats.attachments).toBe(2);

    const noteFile = join(outDir, `${NOTE_PATH}.md`);
    const body = exportedBody(noteFile);
    const targets = linkTargets(body);
    expect(targets[0]).toBe(`../../../${SIDECAR_DIR}/attachments/${imgId}/1793394673667-0a1b2c3d-garden.png`);
    // A space is percent-encoded so the target stays one markdown link.
    expect(targets[1]).toBe(`../../../${SIDECAR_DIR}/attachments/${pdfId}/1793394673999-4e5f6a7b-seed%20list.pdf`);
    // Each rewritten target resolves, from the note's folder, to the file the
    // export wrote.
    const noteDir = dirname(noteFile);
    expect(resolve(noteDir, decodeURIComponent(targets[0]!))).toBe(
      resolve(outDir, SIDECAR_DIR, "attachments", imgId, "1793394673667-0a1b2c3d-garden.png"),
    );
    for (const t of targets.slice(0, 2)) expect(existsSync(resolve(noteDir, decodeURIComponent(t)))).toBe(true);

    // Everything else is untouched.
    expect(targets[2]).toBe("/api/storage/2026-10-29/not-attached.png");
    expect(body).toContain(`raw: /api/storage/${IMG_PATH}`);
    expect(body).toContain("Plant the garlic before the first frost.");
    // The marker the importer gates on.
    expect(readFileSync(join(outDir, SIDECAR_DIR, "vault.yaml"), "utf-8")).toContain("attachment_links: relative\n");

    // Only the exported bytes changed: the stored note is as it was.
    const after = await store.getNote("01M67ABS8ABZS3S1ZYSSK28ZVQ");
    expect(after!.content).toBe(BODY);
    expect(after!.updatedAt).toBe(before!.updatedAt);
  });

  it("a link whose binary was not written stays a storage link", async () => {
    await seedNote();
    rmSync(join(assets, PDF_PATH)); // row kept, file gone (e.g. evicted)
    const outDir = join(tmpBase, "out");
    const stats = await exportVaultToDir(store, { outDir, assetsDir: assets, exportedAt: "2026-10-30T15:10:00.000Z" });
    expect(stats.skipped_attachments).toHaveLength(1);
    const body = exportedBody(join(outDir, `${NOTE_PATH}.md`));
    expect(linkTargets(body)[0]!.startsWith(`../../../${SIDECAR_DIR}/attachments/`)).toBe(true);
    expect(body).toContain(`[seed list.pdf](/api/storage/${PDF_PATH})`);
  });

  it("a markdown-only export (no binaries) leaves the body as stored", async () => {
    await seedNote();
    const outDir = join(tmpBase, "out");
    await exportVaultToDir(store, { outDir, exportedAt: "2026-10-30T15:10:00.000Z" });
    expect(exportedBody(join(outDir, `${NOTE_PATH}.md`))).toBe(BODY);
    // …and it still imports back to the same body.
    const target = new SqliteStore(new Database(":memory:"));
    await importPortableVault(target, { inDir: outDir });
    expect((await target.getNote("01M67ABS8ABZS3S1ZYSSK28ZVQ"))!.content).toBe(BODY);
  });

  it("export → import into a fresh vault gives back the original body, and re-export matches", async () => {
    const { imgId, pdfId } = await seedNote();
    const outA = join(tmpBase, "a");
    await exportVaultToDir(store, { outDir: outA, assetsDir: assets, exportedAt: "2026-10-30T15:10:00.000Z" });

    const target = new SqliteStore(new Database(":memory:"));
    const destAssets = join(tmpBase, "dest-assets");
    mkdirSync(destAssets, { recursive: true });
    const stats = await importPortableVault(target, { inDir: outA, assetsDir: destAssets });
    expect(stats.attachments_restored).toBe(2);
    const imported = await target.getNote("01M67ABS8ABZS3S1ZYSSK28ZVQ");
    expect(imported!.content).toBe(BODY);

    // Re-export: identical bytes once the re-minted attachment ids (a known
    // import limitation) are mapped back.
    const outB = join(tmpBase, "b");
    await exportVaultToDir(target, { outDir: outB, assetsDir: destAssets, exportedAt: "2026-10-30T15:10:00.000Z" });
    const newIds = new Map((await target.getAttachments("01M67ABS8ABZS3S1ZYSSK28ZVQ")).map((a) => [a.path, a.id]));
    const mapIds = (s: string) => s.split(newIds.get(IMG_PATH)!).join(imgId).split(newIds.get(PDF_PATH)!).join(pdfId);
    const a = readFileSync(join(outA, `${NOTE_PATH}.md`), "utf-8");
    const b = readFileSync(join(outB, `${NOTE_PATH}.md`), "utf-8");
    expect(mapIds(b)).toBe(a);
    expect(readFileSync(join(outB, SIDECAR_DIR, "vault.yaml"), "utf-8")).toBe(
      readFileSync(join(outA, SIDECAR_DIR, "vault.yaml"), "utf-8"),
    );

    // And a second import is still the original body.
    const again = new SqliteStore(new Database(":memory:"));
    await importPortableVault(again, { inDir: outB });
    expect((await again.getNote("01M67ABS8ABZS3S1ZYSSK28ZVQ"))!.content).toBe(BODY);
  });

  /** A hand-made export: one note with one attachment and a relative link to
   *  that attachment's sidecar file in its body. */
  function writeExport(dir: string, manifest: string): string {
    mkdirSync(join(dir, SIDECAR_DIR, "attachments", "att_one"), { recursive: true });
    writeFileSync(join(dir, SIDECAR_DIR, "vault.yaml"), manifest);
    writeFileSync(join(dir, SIDECAR_DIR, "attachments", "att_one", "pic.png"), "png");
    const body = [
      "![pic](../.parachute/attachments/att_one/pic.png)",
      "![elsewhere](../.parachute/attachments/att_two/pic.png)",
      "",
    ].join("\n");
    mkdirSync(join(dir, "Garden"), { recursive: true });
    writeFileSync(
      join(dir, "Garden", "plan.md"),
      `---\nid: n-plan\npath: Garden/plan\nattachments:\n  - id: att_one\n    mime_type: image/png\n    path: 2026-10-30/pic.png\ncreated_at: 2026-10-30T00:00:00.000Z\n---\n${body}`,
    );
    return body;
  }

  it("an old export (no marker) imports a relative link exactly as written", async () => {
    const dir = join(tmpBase, "old");
    const body = writeExport(dir, "export_format_version: 1\nexported_at: 2026-10-30T00:00:00.000Z\n");
    const target = new SqliteStore(new Database(":memory:"));
    await importPortableVault(target, { inDir: dir });
    expect((await target.getNote("n-plan"))!.content).toBe(body);
  });

  it("with the marker, only the note's own sidecar targets are turned back into storage links", async () => {
    const dir = join(tmpBase, "new");
    writeExport(dir, "attachment_links: relative\nexport_format_version: 1\nexported_at: 2026-10-30T00:00:00.000Z\n");
    const target = new SqliteStore(new Database(":memory:"));
    await importPortableVault(target, { inDir: dir });
    expect((await target.getNote("n-plan"))!.content).toBe(
      [
        "![pic](/api/storage/2026-10-30/pic.png)",
        "![elsewhere](../.parachute/attachments/att_two/pic.png)",
        "",
      ].join("\n"),
    );
  });
});

describe("portable-md attachment links: only the links export rewrote come back (T-318 #8)", async () => {
  const tmpBase = join(tmpdir(), "parachute-portable-att-links-hand");
  const assets = join(tmpBase, "assets");
  const ID = "01M67ABS8ABZS3S1ZYSSK28ZVQ";
  let store: SqliteStore;

  beforeEach(() => {
    try { rmSync(tmpBase, { recursive: true }); } catch {}
    mkdirSync(join(assets, "2026-10-30"), { recursive: true });
    writeFileSync(join(assets, IMG_PATH), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
    store = new SqliteStore(new Database(":memory:"));
  });

  /** A note with one attached image whose body links it twice: the storage
   *  link the app writes, and a relative link a person typed that is exactly
   *  the path the export would write. Returns the body and the attachment. */
  async function seedHandWritten(): Promise<{ body: string; imgId: string; handTarget: string }> {
    await store.createNote("draft", { id: ID, path: NOTE_PATH });
    const img = await store.addAttachment(ID, IMG_PATH, "image/png");
    const handTarget = `../../../${SIDECAR_DIR}/attachments/${img.id}/1793394673667-0a1b2c3d-garden.png`;
    const body = [
      `![garden.png](/api/storage/${IMG_PATH})`,
      `Typed by hand: ![same file](${handTarget})`,
      "",
    ].join("\n");
    await store.updateNote(ID, { content: body });
    return { body, imgId: img.id, handTarget };
  }

  it("a hand-written relative sidecar link next to a storage link round-trips byte-identical", async () => {
    const { body, imgId } = await seedHandWritten();
    const outA = join(tmpBase, "a");
    const stats = await exportVaultToDir(store, { outDir: outA, assetsDir: assets, exportedAt: "2026-10-30T15:10:00.000Z" });
    expect(stats.attachments).toBe(1);
    // The body already holds the sidecar path, so the export can't tell its
    // own rewrite from the typed link: it leaves this attachment's links be.
    expect(exportedBody(join(outA, `${NOTE_PATH}.md`))).toBe(body);

    const target = new SqliteStore(new Database(":memory:"));
    const destAssets = join(tmpBase, "dest-assets");
    mkdirSync(destAssets, { recursive: true });
    await importPortableVault(target, { inDir: outA, assetsDir: destAssets });
    expect((await target.getNote(ID))!.content).toBe(body);
    // Nothing export-only lands on the stored attachment row.
    const rows = await target.getAttachments(ID);
    expect(rows.map((r) => [r.path, r.mimeType, r.metadata ?? null])).toEqual([[IMG_PATH, "image/png", null]]);

    // Re-export after import: same bytes once the re-minted attachment id is
    // mapped back (ids re-mint on import, a known limitation).
    const outB = join(tmpBase, "b");
    await exportVaultToDir(target, { outDir: outB, assetsDir: destAssets, exportedAt: "2026-10-30T15:10:00.000Z" });
    const newId = rows[0]!.id;
    const a = readFileSync(join(outA, `${NOTE_PATH}.md`), "utf-8");
    const b = readFileSync(join(outB, `${NOTE_PATH}.md`), "utf-8").split(newId).join(imgId);
    expect(b).toBe(a);
  });

  it("an attachment whose binary is not exported leaves the body untouched both ways", async () => {
    const { body } = await seedHandWritten();
    rmSync(join(assets, IMG_PATH)); // row kept, file gone (e.g. evicted)
    const runs: Array<[string, { assetsDir?: string }]> = [
      ["missing", { assetsDir: assets }],
      ["markdown-only", {}],
    ];
    for (const [name, opts] of runs) {
      const out = join(tmpBase, name);
      await exportVaultToDir(store, { outDir: out, ...opts, exportedAt: "2026-10-30T15:10:00.000Z" });
      expect(exportedBody(join(out, `${NOTE_PATH}.md`))).toBe(body);
      const target = new SqliteStore(new Database(":memory:"));
      await importPortableVault(target, { inDir: out });
      expect((await target.getNote(ID))!.content).toBe(body);
    }
  });
});
