// The workspace's dependencies are the ones the moved repos locked, and every installed one is in range.
//
//   bun scripts/check-dependency-tree.ts <repo root> [<old bun.lock> ...]
//
// 1. Every installed package's dependencies resolve, from where it sits, to a version its range accepts.
// 2. For each old lockfile (the vault's and the hub's own, as moved in): every package version it locked is in the
//    root bun.lock (which `bun install --frozen-lockfile` installs, per platform), unless DEPARTURES lists it with
//    the reason. One version per name at the top of a hoisted tree means a name both repos locked differently can
//    keep only one; those are the departures.
// Exits 1 on any problem.
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

/** Locked versions the root lock does not have, each with why. Keys: "<lockfile>: <name>@<version>". */
const DEPARTURES: Record<string, string> = {
  "packages/vault/bun.lock: otpauth@9.5.0": "one otpauth for both: the hub's 9.5.1 (a patch release; ^9.5.0 accepts it)",
  "packages/vault/bun.lock: @noble/hashes@2.0.1": "otpauth 9.5.1 pins @noble/hashes 2.2.0 exactly, and the hub's @noble/curves pins 2.3.0",
  "packages/vault/bun.lock: @emnapi/runtime@1.11.2": "the hub's 1.10.0: a WebAssembly runtime only the wasm builds of native packages load",
  "packages/hub/bun.lock: @types/bun@1.3.12": "types only (the vault's 1.3.11)",
  "packages/hub/bun.lock: bun-types@1.3.12": "types only (the vault's 1.3.11)",
  "packages/hub/bun.lock: @types/node@25.6.0": "types only (the vault's 25.5.0)",
  "packages/hub/bun.lock: undici-types@7.19.2": "types only (the vault's 7.18.2)",
};

const root = process.argv[2] ?? ".";
const locks = process.argv.slice(3);
const bad: string[] = [];
const seen = new Set<string>();

function pkgDirs(nm: string): string[] {
  if (!existsSync(nm)) return [];
  const out: string[] = [];
  for (const n of readdirSync(nm)) {
    if (n.startsWith(".")) continue;
    if (n.startsWith("@")) for (const m of readdirSync(join(nm, n))) out.push(join(nm, n, m));
    else out.push(join(nm, n));
  }
  return out;
}
function resolveFrom(dir: string, name: string): string | null {
  for (let d = dir; ; d = dirname(d)) {
    const p = join(d, "node_modules", name, "package.json");
    if (existsSync(p)) return p;
    if (d === dirname(d)) return null;
  }
}
function check(dir: string) {
  if (seen.has(dir)) return;
  seen.add(dir);
  const pj = join(dir, "package.json");
  if (!existsSync(pj)) return;
  const pkg = JSON.parse(readFileSync(pj, "utf8"));
  const deps = { ...pkg.dependencies, ...(pkg.optionalDependencies ?? {}) };
  for (const [n, range] of Object.entries<string>(deps)) {
    if (String(range).startsWith("workspace:") || String(range).startsWith("npm:")) continue;
    const at = resolveFrom(dir, n);
    if (!at) {
      if (!(pkg.optionalDependencies ?? {})[n]) bad.push(`${pkg.name}@${pkg.version} (${dir.replace(root + "/", "")}): ${n} ${range} not found`);
      continue;
    }
    const v = JSON.parse(readFileSync(at, "utf8")).version;
    if (!Bun.semver.satisfies(v, range)) bad.push(`${pkg.name}@${pkg.version} (${dir.replace(root + "/", "")}): ${n} ${range} → ${v} at ${at.replace(root + "/", "")}`);
  }
  for (const d of pkgDirs(join(dir, "node_modules"))) check(d);
}

const workspaces = ["", "packages/cli", "packages/vault", "packages/hub", "packages/hub/packages/depcheck", "packages/hub/packages/door-contract"];
for (const d of workspaces) check(join(root, d));
console.log(`${seen.size} package folders checked for ranges`);

const rootLock = Bun.JSONC.parse(readFileSync(join(root, "bun.lock"), "utf8")) as any;
const locked = new Set<string>(Object.values<any>(rootLock.packages).map((v) => String(v[0]))); // "<name>@<version>"
for (const lock of locks) {
  const j = Bun.JSONC.parse(readFileSync(join(root, lock), "utf8")) as any;
  let kept = 0;
  for (const v of Object.values<any>(j.packages)) {
    const id = String(v[0]);
    if (id.includes("@workspace:")) continue;
    const key = `${lock}: ${id}`;
    if (locked.has(id)) kept++;
    else if (DEPARTURES[key]) console.log(`departure ${key}: ${DEPARTURES[key]}`);
    else bad.push(`${key} is locked there but not in the root bun.lock (add it to DEPARTURES with a reason, or fix the lock)`);
  }
  console.log(`${lock}: ${kept} locked versions kept as they were`);
}
for (const key of Object.keys(DEPARTURES)) {
  const [lock, id] = key.split(": ");
  if (locks.includes(lock!) && locked.has(id!)) bad.push(`${key} is listed as a departure but the root lock has it: take it off DEPARTURES`);
}

if (bad.length) {
  console.error(bad.join("\n"));
  process.exit(1);
}
console.log("every dependency is in range, and every version the moved repos locked is kept or a listed departure");
