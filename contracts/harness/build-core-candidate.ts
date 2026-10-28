// `bun run build:core`: build this repo's one program as a candidate: the v0.8 bundle tree (release/bundle.ts), which
// is what the tarball holds.
//
//   <out>/bin/parachute-core     the one command (a wrapper that runs lib/ on runtime/bun)
//   <out>/bin/parachute          alias: the hub's commands, for Prism's PARACHUTE_BIN and Benjamin's suite
//   <out>/bin/parachute-vault    alias: the vault's commands, for PARACHUTE_VAULT_BIN
//   <out>/runtime/bun            the pinned Bun (release/bun.json)
//   <out>/lib/                   the workspace (package.json, bun.lock, packages/), production node_modules
//   <out>/package.json           what npm and bun would publish and link: @openparachute/core, bin parachute-core
//   <out>/entitlements/, LICENSE, THIRD-PARTY-NOTICES.txt, SOURCE.md, VERSION
//   <out>/CANDIDATE.json         profile "v0.8", and the sha256 of every other file in <out>
//
// The candidate adapter (harness/candidate.ts) runs only what is in this folder, and refuses it if a byte changed.
//
//   bun run build:core [--out <dir>] [--source <checkout>] [--sign] [--pack <dir> | --no-pack] [--process-model in-process|child]
//
// --process-model: the vault inside serve's process (the default, lane A2) or the hub's vault child (the fallback
// until the Nov 3 decision, PLAN §2.1). A child build changes BUILT_PROCESS_MODEL in the copied packages/cli and
// says so in CANDIDATE.json.
// --source builds from another checkout's working tree, edits included. The default is this repo's working tree;
// CI builds from a clean checkout, so that is the commit. --sign (macOS) signs the tree ad hoc with the hardened
// runtime before it is hashed (release/sign.ts). It then writes <name>.tar.gz and SHA256SUMS into --pack <dir>
// (default <out>/../dist; release/pack.ts). The candidate mutants pass `edit`, which changes the copied source in lib/ before it is
// installed (harness/mutate-candidate.ts).
import { appendFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { treeHash, MANIFEST } from "./candidate.ts";
import { installWorkspace, layOutBundle } from "../../release/bundle.ts";
import { packTree } from "../../release/pack.ts";

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
const WORKSPACE = (f: string) => ["package.json", "bun.lock", "bunfig.toml", "LICENSE"].includes(f) || f.startsWith("packages/");

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

const SERVE = "packages/cli/src/serve.ts";
const BUILT = /^export const BUILT_PROCESS_MODEL: ProcessModel = "(in-process|child)";$/m;

/** The process model the copied workspace's `serve` runs, after setting it to `want` if given. */
async function setProcessModel(lib: string, want?: "in-process" | "child"): Promise<"in-process" | "child"> {
  const file = join(lib, SERVE);
  const text = await Bun.file(file).text();
  const m = text.match(BUILT);
  if (!m) throw new Error(`${SERVE} has no BUILT_PROCESS_MODEL line; the build can't tell what serve runs`);
  if (!want || want === m[1]) return m[1] as "in-process" | "child";
  writeFileSync(file, text.replace(BUILT, `export const BUILT_PROCESS_MODEL: ProcessModel = "${want}";`));
  return want;
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
  /** Sign the tree ad hoc with the hardened runtime before hashing it (macOS; release/sign.ts). */
  sign?: boolean;
  /** What `serve` runs (default: what packages/cli/src/serve.ts says, "in-process"). */
  processModel?: "in-process" | "child";
}): Promise<{ sha256: string; name: string }> {
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
  const model = await setProcessModel(lib, opts.processModel);
  // The production install, admin pages and pruning (release/bundle.ts); a staged snapshot has had it already.
  const leftOut = opts.staged?.installed ? undefined : await installWorkspace(lib);
  const commit = (await sh(["git", "rev-parse", "HEAD"], opts.staged ? REPO : source).catch(() => "unknown")).trim();
  const bundle = await layOutBundle(out, { commit, rev, leftOut, sign: opts.sign });

  const pkg = await Bun.file(join(lib, "package.json")).json();
  const version = async (p: string) => (await Bun.file(join(lib, p, "package.json")).json()).version as string;

  const sha256 = await treeHash(out);
  const manifest = {
    name: pkg.name,
    profile: "v0.8",
    note:
      model === "in-process"
        ? "the v0.8 bundle tree built from this repo's workspace; serve runs the vault inside its own process (lane A2)"
        : "the v0.8 bundle tree built from this repo's workspace, child path: the hub starts the vault as a child (the fallback until Nov 3)",
    version: { core: pkg.version, hub: await version("packages/hub"), vault: await version("packages/vault") },
    source: { core: `${rev}${opts.source ? ` (from ${source})` : ""}${opts.edit ? ` + ${opts.edit.label}` : ""}` },
    core_commit: rev.replace("+changes", ""),
    process_model: model,
    platform: `${process.platform}-${process.arch}`,
    bundle,
    sha256,
  };
  writeFileSync(join(out, MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  return { sha256, name: bundle.name };
}

if (import.meta.main) {
  const out = arg("--out") ?? join(REPO, "contracts", ".cache", "candidate-core");
  const t0 = Date.now();
  const pm = arg("--process-model");
  if (pm !== undefined && pm !== "in-process" && pm !== "child") throw new Error(`--process-model is in-process or child, not ${pm}`);
  const { sha256, name } = await buildCoreCandidate({ out, source: arg("--source"), sign: process.argv.includes("--sign"), processModel: pm });
  console.log(`[candidate] built ${out} in ${Math.round((Date.now() - t0) / 1000)} s`);
  console.log(`[candidate] sha256 ${sha256}`);
  // For CI: the build step's output, compared with what the runs report (harness/run-candidate.ts).
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha256=${sha256}\ndir=${out}\nname=${name}\n`);
  // The tarball goes next to the tree by default (<out>/../dist), where embedded/bundle looks for it.
  const packDir = process.argv.includes("--no-pack") ? undefined : (arg("--pack") ?? join(dirname(out), "dist"));
  if (packDir) {
    mkdirSync(packDir, { recursive: true });
    const p = await packTree(out, name, packDir);
    console.log(`[candidate] packed ${p.tarball}`);
    console.log(`[candidate] tarball sha256 ${p.sha256} (${p.sums})`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${p.tarball}\n`);
  }
}
