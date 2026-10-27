// `bun run build:stock`: build today's code as a candidate, in the layout v0.8's tarball will have.
//
// Until lane A1 moves the hub and vault into this repo, "the candidate" is today's hub and vault at the commits in
// pins.json, built from source into one folder:
//
//   <out>/bin/parachute          the hub CLI (stock 0.7: `bun lib/hub/src/cli.ts`)
//   <out>/bin/parachute-vault    the vault CLI
//   <out>/lib/hub, <out>/lib/vault   `git archive` of each pin, with `bun install --frozen-lockfile`
//   <out>/CANDIDATE.json         what this is, and the sha256 of every other file in <out>
//
// The candidate adapter (harness/candidate.ts) runs only what is in this folder, and refuses it if a byte changed.
// When A1 lands, its build replaces this script and writes the same CANDIDATE.json (with profile "v0.8").
//
//   bun run build:stock [--out <dir>] [--hub-dir <checkout>] [--vault-dir <checkout>]
//
// --hub-dir / --vault-dir build from another checkout's working tree (the candidate mutants use this).
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureRepos } from "./services.ts";
import { treeHash, MANIFEST } from "./candidate.ts";
import pins from "../pins.json";

async function sh(cmd: string[], cwd?: string): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${err.slice(-800)}`);
  return out;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const CONTRACTS = resolve(import.meta.dir, "..");

export async function buildStockCandidate(opts: { out: string; hubDir?: string; vaultDir?: string }): Promise<{ sha256: string }> {
  const out = resolve(opts.out);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "bin"), { recursive: true });
  mkdirSync(join(out, "lib"), { recursive: true });
  const source: Record<string, string> = {};
  const repos = opts.hubDir && opts.vaultDir ? null : await ensureRepos();
  for (const [key, override] of [["hub", opts.hubDir], ["vault", opts.vaultDir]] as const) {
    const dest = join(out, "lib", key);
    mkdirSync(dest, { recursive: true });
    if (override) {
      // A working tree, edits included (that's the point for mutants); never its node_modules or .git.
      const files = (await sh(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], override)).split("\0").filter(Boolean);
      for (const f of files) if (existsSync(join(override, f))) cpSync(join(override, f), join(dest, f), { recursive: true, dereference: false });
      const head = (await sh(["git", "rev-parse", "--short=7", "HEAD"], override)).trim();
      const dirty = (await sh(["git", "status", "--porcelain"], override)).trim() ? "+changes" : "";
      source[key] = `${head}${dirty} (from ${override})`;
    } else {
      const commit = (pins as any)[key].commit as string;
      const repo = (repos as any)[key] as string;
      const tar = Bun.spawn(["git", "archive", "--format=tar", commit], { cwd: repo, stdout: "pipe" });
      const x = Bun.spawn(["tar", "-x", "-C", dest], { stdin: tar.stdout, stderr: "pipe" });
      if ((await x.exited) !== 0 || (await tar.exited) !== 0) throw new Error(`git archive ${key} ${commit} failed`);
      source[key] = commit;
    }
    await sh(["bun", "install", "--frozen-lockfile"], dest);
  }
  const wrapper = (entry: string) => `#!/bin/sh\n# stock 0.7 stand-in: runs ${entry} with the Bun on PATH\nexec bun "$(dirname "$(readlink -f "$0")")/../lib/${entry}" "$@"\n`;
  writeFileSync(join(out, "bin", "parachute"), wrapper("hub/src/cli.ts"));
  writeFileSync(join(out, "bin", "parachute-vault"), wrapper("vault/src/cli.ts"));
  chmodSync(join(out, "bin", "parachute"), 0o755);
  chmodSync(join(out, "bin", "parachute-vault"), 0o755);
  const version = async (k: string) => (await Bun.file(join(out, "lib", k, "package.json")).json()).version as string;
  const core = (await sh(["git", "rev-parse", "--short=7", "HEAD"], CONTRACTS).catch(() => "unknown")).trim();
  const sha256 = await treeHash(out);
  const manifest = {
    name: "parachute",
    profile: "stock-0.7",
    note: "today's hub + vault built from pins.json, standing in for the v0.8 build until lane A1",
    version: { hub: await version("hub"), vault: await version("vault") },
    source,
    core_commit: core,
    process_model: "child", // the hub supervises the vault as a child process
    platform: `${process.platform}-${process.arch}`,
    sha256,
  };
  writeFileSync(join(out, MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  return { sha256 };
}

if (import.meta.main) {
  const out = arg("--out") ?? join(CONTRACTS, ".cache", "candidate-stock");
  const t0 = Date.now();
  const { sha256 } = await buildStockCandidate({ out, hubDir: arg("--hub-dir"), vaultDir: arg("--vault-dir") });
  console.log(`[candidate] built ${out} in ${Math.round((Date.now() - t0) / 1000)} s`);
  console.log(`[candidate] sha256 ${sha256}`);
  // For CI: the build step's output, compared with what the runs report (harness/run-candidate.ts).
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha256=${sha256}\ndir=${out}\n`);
}
