// What goes into the bundle's lib/node_modules, and the notices for it.
//
// The bundle leaves out the local embedding stack (PLAN §3: "no onnxruntime or sharp"): @huggingface/transformers
// and everything only it needs (onnxruntime-node, onnxruntime-web, sharp, …, about 500 MB). Semantic search is off
// by default since vault 0.7.3, and the vault imports transformers only when local embeddings are turned on
// (vault src/embedding/onnx-transformers.ts), where a missing package fails that provider, not the vault. An
// external embedding API (EMBEDDING_API_URL) still works. It also leaves out TypeScript, a build-time peer.
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const LEFT_OUT = ["@huggingface/transformers", "typescript"];

interface Pkg {
  name?: string;
  version?: string;
  license?: string | { type?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  workspaces?: string[];
}

const readPkg = (dir: string): Pkg => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

/** Node's lookup: the nearest node_modules/<name> at or above `from`, stopping at `root`. */
function resolvePkg(root: string, from: string, name: string): string | null {
  for (let d = from; ; d = dirname(d)) {
    const at = join(d, "node_modules", name);
    if (existsSync(join(at, "package.json"))) return at;
    if (d === root || !d.startsWith(root)) return null;
  }
}

/** Every package folder under lib's node_modules trees (top level, scoped, nested), never following links. */
function installed(lib: string): string[] {
  const out: string[] = [];
  const walk = (nm: string) => {
    if (!existsSync(nm)) return;
    for (const n of readdirSync(nm)) {
      if (n === ".bin" || n.startsWith(".")) continue;
      const at = join(nm, n);
      if (n.startsWith("@")) {
        for (const s of readdirSync(at)) visit(join(at, s));
      } else visit(at);
    }
  };
  const visit = (at: string) => {
    if (lstatSync(at).isSymbolicLink() || !existsSync(join(at, "package.json"))) return;
    out.push(at);
    walk(join(at, "node_modules"));
  };
  for (const w of workspaces(lib)) walk(join(w, "node_modules"));
  return out;
}

/** The workspace's own packages (lib/package.json's workspaces), as folders. */
export function workspaces(lib: string): string[] {
  return [lib, ...(readPkg(lib).workspaces ?? []).map((w) => join(lib, w))].filter((d) => existsSync(join(d, "package.json")));
}

/**
 * Remove every installed package the workspace doesn't reach without `drop`: walk dependencies, optional and peer
 * dependencies from each workspace package the way Node resolves them, then delete the rest and the .bin links into
 * it. Returns the removed packages, as "name@version".
 */
export function prune(lib: string, drop: string[] = LEFT_OUT): string[] {
  lib = resolve(lib);
  const keep = new Set<string>();
  const queue: string[] = [];
  const reach = (from: string, deps: Record<string, string> | undefined) => {
    for (const name of Object.keys(deps ?? {})) {
      if (drop.includes(name)) continue;
      const at = resolvePkg(lib, from, name);
      if (!at) continue; // an optional dependency for another platform
      const real = lstatSync(at).isSymbolicLink() ? resolve(dirname(at), readlinkSync(at)) : at;
      if (keep.has(real)) continue;
      keep.add(real);
      queue.push(real);
    }
  };
  for (const w of workspaces(lib)) {
    keep.add(w);
    queue.push(w);
  }
  while (queue.length) {
    const dir = queue.pop()!;
    const p = readPkg(dir);
    reach(dir, p.dependencies);
    reach(dir, p.optionalDependencies);
    reach(dir, p.peerDependencies);
  }
  const removed: string[] = [];
  for (const at of installed(lib).sort((a, b) => b.length - a.length)) {
    if (keep.has(at) || !existsSync(at)) continue;
    const p = readPkg(at);
    removed.push(`${p.name}@${p.version}`);
    rmSync(at, { recursive: true, force: true });
  }
  // Empty scope folders, and .bin links that now point nowhere.
  for (const nm of [...workspaces(lib), ...installed(lib)].map((d) => join(d, "node_modules"))) {
    if (!existsSync(nm)) continue;
    for (const n of readdirSync(nm)) if (n.startsWith("@") && !readdirSync(join(nm, n)).length) rmSync(join(nm, n), { recursive: true });
    const bin = join(nm, ".bin");
    if (!existsSync(bin)) continue;
    for (const b of readdirSync(bin)) if (!existsSync(join(bin, b))) rmSync(join(bin, b));
  }
  return removed.sort();
}

function licenseText(dir: string): string | null {
  const f = readdirSync(dir).find((n) => /^(licen[cs]e|copying|notice)(\.|$|-)/i.test(n));
  return f && lstatSync(join(dir, f)).isFile() ? readFileSync(join(dir, f), "utf8").trim() : null;
}

/**
 * THIRD-PARTY-NOTICES.txt: every package in lib's node_modules (name, version, licence, its licence file), then
 * the runtime (Bun's own licence document, which lists what it links). Returns the number of packages.
 */
export function writeNotices(lib: string, out: string, runtime: { version: string; licence: string }): number {
  const pkgs = installed(resolve(lib))
    .map((dir) => ({ dir, p: readPkg(dir) }))
    .sort((a, b) => `${a.p.name}@${a.p.version}`.localeCompare(`${b.p.name}@${b.p.version}`));
  const seen = new Set<string>();
  const parts: string[] = [
    "Third-party software in this bundle",
    "",
    "Parachute itself is licensed under the GNU Affero General Public License v3.0 or later (LICENSE; source: SOURCE.md).",
    "It includes the packages below, under lib/node_modules, and the Bun runtime, under runtime/.",
  ];
  for (const { dir, p } of pkgs) {
    const id = `${p.name}@${p.version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const lic = typeof p.license === "string" ? p.license : (p.license?.type ?? "UNKNOWN");
    const text = licenseText(dir);
    parts.push("", "-".repeat(78), `${id}  (${lic})  lib/${relative(resolve(lib), dir)}`, "", text ?? `No licence file in the package; its package.json says: ${lic}.`);
  }
  parts.push("", "-".repeat(78), `bun@${runtime.version}  (MIT, with the libraries it links)  runtime/bun`, "", runtime.licence.trim(), "");
  writeFileSync(out, parts.join("\n"));
  return seen.size;
}
