// `bun run build:previous`: the release before this one (pins.json `previous_core`: 0.8, main at ccc7729), built the
// way its own commit builds a candidate, for lifecycle/upgrade (the 0.8 → 0.9 step on a home, and its rollback).
//
//   bun run build:previous [--out <dir>]     default .cache/candidate-previous; CI passes PREVIOUS_CORE_DIR to the run
//
// The source is a shared local clone of this repo at that commit in .cache/previous-core-src (fetched first if this
// clone lacks it, as CI's shallow checkout does; its build reads files through git), then its own
// `bun install --frozen-lockfile` and its own `build:core --no-pack`.
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import pins from "../pins.json";

const CONTRACTS = resolve(import.meta.dir, "..");
const REPO = resolve(CONTRACTS, "..");

async function sh(cmd: string[], cwd: string, opts: { quiet?: boolean } = {}): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0 && !opts.quiet) throw new Error(`${cmd.join(" ")} failed (${code}): ${err.slice(-800)}`);
  return { code, out, err };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

export async function buildPreviousCore(out: string): Promise<{ sha256: string; dir: string }> {
  const { commit, version } = pins.previous_core;
  const src = join(CONTRACTS, ".cache", "previous-core-src");
  if ((await sh(["git", "cat-file", "-e", `${commit}^{commit}`], REPO, { quiet: true })).code !== 0) {
    await sh(["git", "fetch", "--depth", "1", "origin", commit], REPO);
  }
  rmSync(src, { recursive: true, force: true });
  mkdirSync(join(CONTRACTS, ".cache"), { recursive: true });
  await sh(["git", "clone", "--quiet", "--shared", "--no-checkout", REPO, src], REPO);
  await sh(["git", "-c", "advice.detachedHead=false", "checkout", "--quiet", commit], src);
  await sh(["bun", "install", "--frozen-lockfile"], src);
  await sh(["bun", "install", "--frozen-lockfile"], join(src, "contracts"));
  rmSync(out, { recursive: true, force: true });
  const built = await sh(["bun", "run", "harness/build-core-candidate.ts", "--out", out, "--no-pack"], join(src, "contracts"));
  const sha256 = /sha256 ([0-9a-f]{64})/.exec(built.out)?.[1];
  if (!sha256 || !existsSync(join(out, "bin", "parachute"))) throw new Error(`the ${version} build made no candidate:\n${built.out}${built.err}`);
  console.log(`[previous] ${version} (${commit.slice(0, 7)}) built at ${out}`);
  console.log(`[previous] sha256 ${sha256}`);
  return { sha256, dir: out };
}

if (import.meta.main) {
  const out = resolve(arg("--out") ?? join(CONTRACTS, ".cache", "candidate-previous"));
  const { sha256, dir } = await buildPreviousCore(out);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha256=${sha256}\ndir=${dir}\n`);
}
