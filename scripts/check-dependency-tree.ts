// Every installed package's dependencies resolve, from where it sits, to a version its range accepts.
//   bun scripts/check-dependency-tree.ts <repo root>
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
const root = process.argv[2]!;
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
    if (!at) { if (!(pkg.optionalDependencies ?? {})[n]) bad.push(`${pkg.name}@${pkg.version} (${dir.replace(root + "/", "")}): ${n} ${range} not found`); continue; }
    const v = JSON.parse(readFileSync(at, "utf8")).version;
    if (!Bun.semver.satisfies(v, range as string)) bad.push(`${pkg.name}@${pkg.version} (${dir.replace(root + "/", "")}): ${n} ${range} → ${v} at ${at.replace(root + "/", "")}`);
  }
  for (const d of pkgDirs(join(dir, "node_modules"))) check(d);
}
for (const d of ["", "packages/cli", "packages/vault", "packages/hub", "packages/hub/packages/depcheck", "packages/hub/packages/door-contract", "packages/hub/packages/scope-guard"]) check(join(root, d));
console.log(bad.length ? bad.join("\n") : "every dependency satisfies its range");
console.log(`${seen.size} package folders checked`);
