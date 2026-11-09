/**
 * Import reads only what the export holds, even when the export is a git clone
 * carrying symlinks (T-419, audit L3-02).
 *
 * Mirror import clones someone's repo and hands the checkout to
 * `importPortableVault`. A repo can hold symlinks, and the old containment
 * check used `path.resolve`, which doesn't follow them: a linked note, folder,
 * sidecar, schema or attachment pulled a server file into a note body, a
 * tag's description, or the vault's assets. Here a real git repo carries one
 * link of each kind, pointing at made-up "server" files beside it, and is
 * really cloned (git checks the links out as links) before the import.
 * The contract `contracts/suites/safety/import-confine.test.ts` drives the same
 * case through the HTTP route.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { SqliteStore } from "./store.js";
import { importPortableVault } from "./portable-md.js";

const SECRET = "MADE-UP SERVER SECRET";
const fm = (lines: string[], body: string) => `---\n${lines.join("\n")}\n---\n${body}\n`;

function git(args: string[], cwd: string): void {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}

describe("importPortableVault: symlinks in a cloned export (T-419)", () => {
  const base = mkdtempSync(join(tmpdir(), "parachute-import-links-"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("imports the real notes and nothing a link points at", async () => {
    // The server's own files, outside the repo.
    const outside = join(base, "server-only");
    mkdirSync(join(outside, "folder"), { recursive: true });
    writeFileSync(join(outside, "secret.md"), fm(["id: leak-file", "path: leak"], SECRET));
    writeFileSync(join(outside, "folder", "inner.md"), fm(["id: leak-dir", "path: linked/inner"], SECRET));
    writeFileSync(join(outside, "meta.yaml"), `id: leak-meta\npath: data\nextension: csv\nmetadata:\n  secret: ${SECRET}\n`);
    writeFileSync(join(outside, "schema.yaml"), `description: ${SECRET}\n`);
    writeFileSync(join(outside, "key.pem"), `${SECRET}\n`);

    // The repo: a real note, a note with an attachment row, and a link of each kind.
    const repo = join(base, "repo");
    const side = join(repo, ".parachute");
    for (const d of ["notes-meta", "schemas", "attachments/att-1", "attachments/att-2"]) mkdirSync(join(side, d), { recursive: true });
    writeFileSync(join(side, "vault.yaml"), "export_format_version: 1\nexported_at: 2026-11-08T00:00:00.000Z\n");
    writeFileSync(join(repo, "ok.md"), fm(["id: ok", "path: ok"], "a made-up note"));
    writeFileSync(join(repo, "att.md"), fm(["id: att", "path: att", "attachments:", "  - id: att-1", "    path: 2026/key.pem", "    mime_type: text/plain", "  - id: att-2", "    path: 2026/config.txt", "    mime_type: text/plain"], "has files"));
    writeFileSync(join(repo, "data.csv"), "a,b\n1,2\n");
    symlinkSync(join(outside, "secret.md"), join(repo, "leak.md"));
    symlinkSync(join(outside, "folder"), join(repo, "linked"));
    symlinkSync(join(outside, "meta.yaml"), join(side, "notes-meta", "leak-meta.yaml"));
    symlinkSync(join(outside, "schema.yaml"), join(side, "schemas", "linkedtag.yaml"));
    symlinkSync(join(outside, "key.pem"), join(side, "attachments", "att-1", "key.pem"));
    // Inside the clone but outside the attachments: the clone's .git/config holds the URL it came from, token and all.
    symlinkSync("../../../.git/config", join(side, "attachments", "att-2", "config.txt"));
    git(["init", "-q", "-b", "main"], repo);
    git(["add", "-A"], repo);
    git(["commit", "-q", "-m", "made-up export"], repo);
    const clone = join(base, "clone");
    git(["clone", "-q", "--", `file://${repo}`, clone], base);
    git(["remote", "set-url", "origin", "https://x-access-token:MADE-UP-TOKEN@github.com/o/r.git"], clone);

    const store = new SqliteStore(new Database(":memory:"));
    const assets = join(base, "assets");
    const stats = await importPortableVault(store, { inDir: clone, assetsDir: assets });

    expect((await store.getNote("ok"))?.content).toContain("a made-up note");
    expect(await store.getNote("leak-file")).toBeNull();
    expect(await store.getNote("leak-dir")).toBeNull();
    expect(await store.getNote("leak-meta")).toBeNull();
    expect((await store.getTagRecord("linkedtag"))?.description ?? null).toBeNull();
    expect(stats.skipped_attachments.map((s) => s.reason).join(" ")).toContain("not a file inside the export");
    const copied = join(assets, "2026", "key.pem");
    expect(existsSync(copied) ? readFileSync(copied, "utf-8") : "").not.toContain(SECRET);
    const config = join(assets, "2026", "config.txt");
    expect(existsSync(config) ? readFileSync(config, "utf-8") : "").not.toContain("MADE-UP-TOKEN");
    expect(stats.attachments_restored).toBe(0);
  });

  it("an attachments folder that links elsewhere in the clone gives nothing", async () => {
    // `.parachute/attachments -> ..`: attachment id `.git` would name the clone's .git folder.
    const repo = join(base, "repo2");
    mkdirSync(join(repo, ".parachute"), { recursive: true });
    writeFileSync(join(repo, ".parachute", "vault.yaml"), "export_format_version: 1\nexported_at: 2026-11-08T00:00:00.000Z\n");
    writeFileSync(join(repo, "att.md"), fm(["id: att", "path: att", "attachments:", "  - id: .git", "    path: x/config", "    mime_type: text/plain"], "has a file"));
    symlinkSync("..", join(repo, ".parachute", "attachments"));
    git(["init", "-q", "-b", "main"], repo);
    git(["add", "-A"], repo);
    git(["commit", "-q", "-m", "made-up export"], repo);
    const clone = join(base, "clone2");
    git(["clone", "-q", "--", `file://${repo}`, clone], base);
    git(["remote", "set-url", "origin", "https://x-access-token:MADE-UP-TOKEN@github.com/o/r.git"], clone);

    const assets = join(base, "assets2");
    const stats = await importPortableVault(new SqliteStore(new Database(":memory:")), { inDir: clone, assetsDir: assets });
    expect(stats.attachments_restored).toBe(0);
    const config = join(assets, "x", "config");
    expect(existsSync(config) ? readFileSync(config, "utf-8") : "").not.toContain("MADE-UP-TOKEN");
  });
});
