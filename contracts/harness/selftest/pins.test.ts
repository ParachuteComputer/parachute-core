// A pinned run must run the pinned code: a cached checkout with edits or extra files is refused.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pins from "../../pins.json";
import { ensureRepos, reposDir } from "../services.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pcore-pins-selftest-"));
const saved = process.env.PARACHUTE_REPOS;
afterAll(() => {
  if (saved === undefined) delete process.env.PARACHUTE_REPOS;
  else process.env.PARACHUTE_REPOS = saved;
  rmSync(root, { recursive: true, force: true });
});

async function git(args: string[], cwd?: string) {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(p.stderr).text()}`);
}

/** A fresh cache dir holding a local clone of the vault at its pin (no network, no install). */
async function cacheWithVault(name: string): Promise<string> {
  const cache = join(root, name);
  const dir = join(cache, "parachute-vault");
  await git(["clone", "--quiet", "--shared", "--no-checkout", join(reposDir(), "parachute-vault"), dir]);
  await git(["checkout", "--quiet", pins.vault.commit], dir);
  return dir;
}

async function refused(cache: string): Promise<string> {
  process.env.PARACHUTE_REPOS = cache;
  try {
    await ensureRepos();
  } catch (e) {
    return String(e);
  }
  return "accepted";
}

describe("pinned checkouts", () => {
  test("an edited tracked file is refused", async () => {
    const dir = await cacheWithVault("edited");
    appendFileSync(join(dir, "src/tag-scope.ts"), "\n// changed\n");
    expect(await refused(join(root, "edited"))).toContain("src/tag-scope.ts");
  });

  test("an untracked file is refused", async () => {
    const dir = await cacheWithVault("untracked");
    writeFileSync(join(dir, "src/extra.ts"), "export {};\n");
    expect(await refused(join(root, "untracked"))).toContain("src/extra.ts");
  });

  test("an edit hidden from git status with --skip-worktree is refused", async () => {
    const dir = await cacheWithVault("hidden");
    await git(["update-index", "--skip-worktree", "src/tag-scope.ts"], dir);
    appendFileSync(join(dir, "src/tag-scope.ts"), "\n// changed\n");
    expect(await refused(join(root, "hidden"))).toContain("src/tag-scope.ts");
  });

  test("an ignored file outside node_modules and build output is refused", async () => {
    const dir = await cacheWithVault("ignored");
    writeFileSync(join(dir, ".env"), "VAULT_AUTH_TOKEN=made-up\n");
    expect(await refused(join(root, "ignored"))).toContain(".env");
  });
});
