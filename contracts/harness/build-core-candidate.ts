// `bun run build:core`: build this repo's one program as a candidate, in the layout v0.8's tarball will have.
//
//   <out>/bin/parachute-core     the one command (links into lib/packages/cli/bin)
//   <out>/bin/parachute          alias: the hub's commands, for Prism's PARACHUTE_BIN and Benjamin's suite
//   <out>/bin/parachute-vault    alias: the vault's commands, for PARACHUTE_VAULT_BIN
//   <out>/lib/                   the workspace (package.json, bun.lock, packages/), `bun install --frozen-lockfile`
//   <out>/package.json           what npm and bun would publish and link: @openparachute/core, bin parachute-core
//   <out>/CANDIDATE.json         profile "v0.8", and the sha256 of every other file in <out>
//
// The candidate adapter (harness/candidate.ts) runs only what is in this folder, and refuses it if a byte changed.
// Lane D turns this folder into the tarball; the layout stays.
//
//   bun run build:core [--out <dir>] [--source <checkout>]
//
// --source builds from another checkout's working tree, edits included. The default is this repo's working tree;
// CI builds from a clean checkout, so that is the commit. The candidate mutants pass `edit`, which changes the
// copied source in lib/ before it is installed (harness/mutate-candidate.ts).
import { appendFileSync, cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { treeHash, MANIFEST } from "./candidate.ts";

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

const REPO = resolve(import.meta.dir, "..", "..");
/** What goes into lib/: the workspace and nothing else (not contracts/, docs/ or the repo's own files). */
const WORKSPACE = (f: string) => ["package.json", "bun.lock", "bunfig.toml"].includes(f) || f.startsWith("packages/");
const NAMES = ["parachute-core", "parachute", "parachute-vault"];

/**
 * Copy the workspace from a checkout's working tree (tracked and untracked files, never node_modules or a build
 * output git ignores) into `dest`. Returns the source revision, e.g. "0b716f5" or "0b716f5+changes".
 */
export async function stageWorkspace(source: string, dest: string): Promise<string> {
  const files = (await sh(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], source)).split("\0").filter(Boolean);
  mkdirSync(dest, { recursive: true });
  for (const f of files.filter(WORKSPACE)) {
    if (f.split("/").includes("node_modules")) continue;
    if (existsSync(join(source, f))) cpSync(join(source, f), join(dest, f), { recursive: true, dereference: false, verbatimSymlinks: true });
  }
  const head = (await sh(["git", "rev-parse", "--short=7", "HEAD"], source).catch(() => "unknown")).trim();
  const dirty = (await sh(["git", "status", "--porcelain", "--", "package.json", "bun.lock", "bunfig.toml", "packages"], source).catch(() => "")).trim() ? "+changes" : "";
  return `${head}${dirty}`;
}

export async function buildCoreCandidate(opts: {
  out: string;
  /** A checkout to build from (default: this repo's working tree). */
  source?: string;
  /** Or a workspace stageWorkspace() already copied, with its revision: a mutant run builds every mutant from one
   *  snapshot, so editing the checkout during the run changes nothing. `installed`: the snapshot has been through
   *  `bun install` already, so its copy is used as is (one network install per mutant run, not one per mutant). */
  staged?: { dir: string; rev: string; installed?: boolean };
  /** Change the copied workspace (lib/) before install; `label` names the change in CANDIDATE.json. */
  edit?: { label: string; apply: (lib: string) => Promise<void> };
}): Promise<{ sha256: string }> {
  const out = resolve(opts.out);
  const source = resolve(opts.source ?? REPO);
  rmSync(out, { recursive: true, force: true });
  const lib = join(out, "lib");
  mkdirSync(join(out, "bin"), { recursive: true });
  let rev: string;
  if (opts.staged) {
    // verbatimSymlinks: keep each link's target as written (bun's are relative), so the copy stays a closed tree.
    cpSync(opts.staged.dir, lib, { recursive: true, dereference: false, verbatimSymlinks: true });
    rev = opts.staged.rev;
  } else rev = await stageWorkspace(source, lib);
  if (opts.edit) await opts.edit.apply(lib);
  // Builds the hub's packages (depcheck, door-contract) through the root `prepare` script.
  if (!opts.staged?.installed) await sh(["bun", "install", "--frozen-lockfile"], lib);

  for (const name of NAMES) symlinkSync(`../lib/packages/cli/bin/${name}`, join(out, "bin", name));

  const pkg = await Bun.file(join(lib, "package.json")).json();
  const version = async (p: string) => (await Bun.file(join(lib, p, "package.json")).json()).version as string;
  writeFileSync(
    join(out, "package.json"),
    JSON.stringify(
      { name: pkg.name, version: pkg.version, description: pkg.description, license: pkg.license, type: "module", bin: { "parachute-core": "bin/parachute-core" } },
      null,
      2,
    ) + "\n",
  );

  const sha256 = await treeHash(out);
  const manifest = {
    name: pkg.name,
    profile: "v0.8",
    note: "the one program built from this repo's workspace; the hub still starts the vault as a child (lane A1)",
    version: { core: pkg.version, hub: await version("packages/hub"), vault: await version("packages/vault") },
    source: { core: `${rev}${opts.source ? ` (from ${source})` : ""}${opts.edit ? ` + ${opts.edit.label}` : ""}` },
    core_commit: rev.replace("+changes", ""),
    process_model: "child",
    platform: `${process.platform}-${process.arch}`,
    sha256,
  };
  writeFileSync(join(out, MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  return { sha256 };
}

if (import.meta.main) {
  const out = arg("--out") ?? join(REPO, "contracts", ".cache", "candidate-core");
  const t0 = Date.now();
  const { sha256 } = await buildCoreCandidate({ out, source: arg("--source") });
  console.log(`[candidate] built ${out} in ${Math.round((Date.now() - t0) / 1000)} s`);
  console.log(`[candidate] sha256 ${sha256}`);
  // For CI: the build step's output, compared with what the runs report (harness/run-candidate.ts).
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha256=${sha256}\ndir=${out}\n`);
}
