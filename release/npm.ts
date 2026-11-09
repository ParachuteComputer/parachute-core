// The npm package @openparachute/core, from a built bundle tree (release/bundle.ts), and `npm pack` of it.
//
//   bun release/npm.ts --from <bundle dir> --out <dir>     → <dir>/package/ and <dir>/openparachute-core-<version>.tgz
//
// The bundle is what Prism ships; npm is for a person with Bun (`npm i -g @openparachute/core` or
// `bun add -g @openparachute/core`), as 0.7's hub and vault were. So the package is the bundle's sources without what
// is platform-bound: no runtime/bun (the wrappers run on the Bun on PATH, as a source checkout does) and no
// node_modules (npm or bun installs the dependencies on the person's machine, argon2 for their platform).
//
//   package.json                   @openparachute/core: bins `parachute` and `parachute-core`; the hub's and the
//                                  vault's dependencies, each at the version bun.lock has, without TypeScript (the
//                                  bundle leaves it out too, release/payload.ts). npm and bun still install it
//                                  (~23 MB): @openparachute/scope-guard, depcheck and door-contract declare it as a
//                                  peer, and a package can't turn off another's peer. Nothing runs it.
//                                  The local embedding stack (@huggingface/transformers, onnxruntime, sharp) is an
//                                  optional dependency (T-418): npm installs it for every platform (~650 MB, and on
//                                  linux-x64 onnxruntime-node's postinstall fetches its CUDA providers); the bundle
//                                  ships one platform's (~100 MB).
//   packages/vault/models/         the embedding model (release/model.ts), so a fresh install embeds offline
//   packages/cli/                  the command (bin/ wrappers, src/, and the tsconfig.json whose `paths` find the
//                                  hub and the vault below: Bun honours them inside node_modules too, so an old
//                                  @openparachute/hub next to this package in a global install is never the one run)
//   packages/hub/, packages/vault/ what each package's own `files` names, with the admin pages the bundle built;
//                                  no tests
//   LICENSE, README.md
//
// The hub's two workspace packages (@openparachute/depcheck, @openparachute/door-contract) come from npm at the
// version the workspace has; their published dist/ is the one the bundle builds (the npm job checks it).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { LEFT_OUT } from "./payload.ts";

const REPO_URL = "https://github.com/ParachuteComputer/parachute-core";
/** Installed as optional dependencies (see stagePackage). */
const OPTIONAL = ["@huggingface/transformers"];

/** Which files of a moved package ship: its own package.json `files`, plus the package.json itself. */
const KEEP: Record<string, string[]> = {
  "packages/cli": ["bin", "src", "package.json", "tsconfig.json"],
};

/** A test or test fixture: never shipped. */
function isTest(rel: string): boolean {
  return /(^|\/)__tests__(\/|$)/.test(rel) || /\.test\.tsx?$/.test(rel);
}

/** bun.lock's resolved version of each package it installs (the text is JSON with trailing commas). */
export function lockedVersions(lockText: string): Map<string, string> {
  const lock = JSON.parse(lockText.replace(/,(\s*[}\]])/g, "$1"));
  const out = new Map<string, string>();
  for (const [key, entry] of Object.entries(lock.packages as Record<string, unknown[]>)) {
    // Top-level entries only: "name" or "@scope/name". A nested "parent/name" is a second copy for one dependent.
    const top = key.startsWith("@") ? key.split("/").length === 2 : !key.includes("/");
    if (!top) continue;
    const spec = String(entry[0]);
    const at = spec.lastIndexOf("@");
    if (at > 0) out.set(spec.slice(0, at), spec.slice(at + 1));
  }
  return out;
}

/** The dependencies the package declares: the hub's and the vault's, at the versions bun.lock resolved. */
export function dependencies(lib: string): Record<string, string> {
  const locked = lockedVersions(readFileSync(join(lib, "bun.lock"), "utf8"));
  const deps: Record<string, string> = {};
  for (const p of ["packages/hub", "packages/vault"]) {
    const pkg = JSON.parse(readFileSync(join(lib, p, "package.json"), "utf8"));
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      if (name === "@openparachute/hub" || name === "@openparachute/vault" || LEFT_OUT.includes(name)) continue;
      let version = locked.get(name);
      if (version?.startsWith("workspace:")) {
        // A workspace package of the hub's: npm has it at the workspace's version.
        const ws = readdirSync(join(lib, "packages/hub/packages")).map((d) => join(lib, "packages/hub/packages", d, "package.json"));
        const found = ws.filter(existsSync).map((f) => JSON.parse(readFileSync(f, "utf8"))).find((w) => w.name === name);
        version = found?.version;
      }
      if (!version) throw new Error(`npm: no locked version for ${name} (${p})`);
      if (deps[name] && deps[name] !== version) throw new Error(`npm: ${name} is locked at two versions (${deps[name]}, ${version})`);
      deps[name] = version;
    }
  }
  return Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));
}

function copyFiltered(from: string, to: string, base: string): void {
  if (!existsSync(from)) return;
  const st = statSync(from);
  const rel = relative(base, from);
  if (isTest(rel) || rel.split("/").includes("node_modules")) return;
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const n of readdirSync(from)) copyFiltered(join(from, n), join(to, n), base);
  } else {
    cpSync(from, to, { preserveTimestamps: false });
  }
}

/** Lay out the package from a bundle tree; returns the package folder. */
export function stagePackage(bundle: string, out: string): string {
  bundle = resolve(bundle);
  const lib = join(bundle, "lib");
  const root = JSON.parse(readFileSync(join(lib, "package.json"), "utf8"));
  const stage = join(resolve(out), "package");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  for (const p of ["packages/cli", "packages/hub", "packages/vault"]) {
    const pkg = JSON.parse(readFileSync(join(lib, p, "package.json"), "utf8"));
    const keep = KEEP[p] ?? [...(pkg.files ?? []), "package.json"];
    for (const f of keep) copyFiltered(join(lib, p, f), join(stage, p, f), lib);
  }
  for (const ui of ["packages/hub/web/ui/dist", "packages/vault/web/ui/dist"]) {
    if (!existsSync(join(stage, ui, "index.html"))) throw new Error(`npm: ${ui}/index.html is missing (build the bundle first)`);
  }
  for (const f of ["LICENSE"]) cpSync(join(lib, f), join(stage, f));
  const readme = join(resolve(import.meta.dir, ".."), "README.md");
  cpSync(existsSync(join(lib, "README.md")) ? join(lib, "README.md") : readme, join(stage, "README.md"));
  const deps = Object.entries(dependencies(lib));
  const pkg = {
    name: root.name,
    version: root.version,
    description: root.description,
    license: root.license,
    type: "module",
    repository: { type: "git", url: `git+${REPO_URL}.git` },
    homepage: REPO_URL,
    bin: { parachute: "packages/cli/bin/parachute", "parachute-core": "packages/cli/bin/parachute-core" },
    files: ["packages", "LICENSE", "README.md"],
    dependencies: Object.fromEntries(deps.filter(([n]) => !OPTIONAL.includes(n))),
    // The local embedding stack is optional (T-418): on a machine with a system libvips, npm runs sharp's install
    // script, which then tries to compile sharp and fails. As an optional dependency that drops the stack instead of
    // failing the whole install; semantic search then says on /health that it can't load ("failing"), and every
    // other part of Parachute works. `bun add -g` runs no dependency's scripts, so it always gets the stack.
    optionalDependencies: Object.fromEntries(deps.filter(([n]) => OPTIONAL.includes(n))),
    // Bun runs it (the wrappers exec `bun`); npm only installs it.
    engines: { bun: ">=1.4" },
    publishConfig: { access: "public" },
  };
  writeFileSync(join(stage, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  return stage;
}

/** `npm pack` the staged folder into `out`; returns the tarball's path. */
export async function packPackage(stage: string, out: string): Promise<string> {
  const p = Bun.spawn(["npm", "pack", "--json", "--pack-destination", resolve(out)], { cwd: stage, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`npm pack failed (${code}): ${stderr.slice(-600)}`);
  return join(resolve(out), JSON.parse(stdout)[0].filename);
}

if (import.meta.main) {
  const arg = (k: string) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const from = arg("--from");
  const out = arg("--out");
  if (!from || !out) {
    console.error("usage: bun release/npm.ts --from <bundle dir> --out <dir>");
    process.exit(2);
  }
  const stage = stagePackage(from, out);
  const tgz = await packPackage(stage, out);
  console.log(`[npm] staged ${stage}`);
  console.log(`[npm] packed ${tgz}`);
  const gh = process.env.GITHUB_OUTPUT;
  if (gh) writeFileSync(gh, `stage=${stage}\ntarball=${tgz}\n`, { flag: "a" });
}
