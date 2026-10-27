// `bun run mutants`: prove the contracts can fail. Each mutant is a one-line change to today's vault that a real bug
// could make. For each, we check out the pinned vault into a temp git worktree, apply the change, start the
// throwaway services from it, run the contracts that should catch it, and require them to go red. The clean clone
// is never touched. Exit 0 only if every mutant is caught.
import { mkdtempSync, rmSync, symlinkSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ensureRepos } from "./services.ts";
import pins from "../pins.json";

interface Mutant {
  name: string;
  why: string;
  file: string;
  find: string;
  replace: string;
  suite: string; // the contract file expected to catch it
}

export const MUTANTS: Mutant[] = [
  {
    name: "scope-leak",
    why: "a tag-scoped pass is treated as unscoped on single-note reads",
    file: "src/tag-scope.ts",
    find: "  rawRoots: string[] | null,\n): boolean {\n  if (rawRoots === null) return true;\n  if (scopeDeniesAll(allowed)) return false;\n  if (!note.tags",
    replace: "  rawRoots: string[] | null,\n): boolean {\n  if (rawRoots === null || rawRoots.length > 0) return true;\n  if (scopeDeniesAll(allowed)) return false;\n  if (!note.tags",
    suite: "suites/today/access.test.ts",
  },
  {
    name: "untagged-leak",
    why: "notes with no tags become visible to every scoped pass",
    file: "src/tag-scope.ts",
    find: "  if (!note.tags || note.tags.length === 0) return false;\n  let admitted = false;",
    replace: "  if (!note.tags || note.tags.length === 0) return true;\n  let admitted = false;",
    suite: "suites/today/access.test.ts",
  },
  {
    name: "no-history",
    why: "changes stop keeping the version before them",
    file: "core/src/history.ts",
    find: "  if (!opts.policy.enabled) return;",
    replace: "  if (!opts.policy.enabled || true) return;",
    suite: "suites/today/links-search-history.test.ts",
  },
  {
    name: "stale-write",
    why: "an update made from an old version silently wins instead of being refused",
    file: "core/src/notes.ts",
    find: '    sql += " AND updated_at IS ?";\n    values.push(updates.if_updated_at);',
    replace: '    sql += " AND (updated_at IS ? OR 1)";\n    values.push(updates.if_updated_at);',
    suite: "suites/today/notes.test.ts",
  },
  {
    name: "wrong-resource",
    why: "the vault advertises a resource URL that isn't its MCP endpoint, so consumer apps can't bind tokens to it",
    file: "src/oauth-discovery.ts",
    find: "    resource: `${base}${prefix}/mcp`,",
    replace: "    resource: `${base}${prefix}`,",
    suite: "suites/today/consumer-connector.test.ts",
  },
];

async function run(cmd: string[], opts: { cwd: string; env?: Record<string, string> }) {
  const p = Bun.spawn(cmd, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out: out + err, code };
}

const only = process.argv.slice(2);
const contracts = resolve(import.meta.dir, "..");
const repos = await ensureRepos();
const results: { name: string; caught: boolean; red: string[] }[] = [];

for (const m of MUTANTS.filter((m) => only.length === 0 || only.includes(m.name))) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `pcore-mutant-${m.name}-`));
  const tree = join(dir, "vault");
  try {
    const add = await run(["git", "worktree", "add", "--detach", "--quiet", tree, pins.vault.commit], { cwd: repos.vault });
    if (add.code !== 0) throw new Error(`git worktree add failed: ${add.out}`);
    symlinkSync(join(repos.vault, "node_modules"), join(tree, "node_modules"));
    const path = join(tree, m.file);
    const src = readFileSync(path, "utf8");
    const hits = src.split(m.find).length - 1;
    if (hits !== 1) throw new Error(`mutant ${m.name}: expected the target text once in ${m.file}, found ${hits}`);
    writeFileSync(path, src.replace(m.find, m.replace));

    const r = await run(["bun", "run", "harness/run.ts", m.suite], {
      cwd: contracts,
      env: { VAULT_REPO_DIR: tree, CONTRACT_SHOW_LOGS: "0" },
    });
    const red = [...r.out.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map((x) => x[1]!);
    // Caught means the suite ran and contracts failed, not that the services failed to start.
    const caught = r.code !== 0 && red.length > 0;
    results.push({ name: m.name, caught, red });
    console.log(`\n[mutant ${m.name}] ${m.why}`);
    console.log(caught ? `  CAUGHT: ${red.length} contract(s) red` : `  NOT CAUGHT (exit ${r.code})`);
    for (const t of red) console.log(`    red: ${t}`);
    if (!caught) console.log(r.out.slice(-3000));
  } finally {
    await run(["git", "worktree", "remove", "--force", tree], { cwd: repos.vault });
    rmSync(dir, { recursive: true, force: true });
  }
}

const missed = results.filter((r) => !r.caught);
console.log(`\n[mutants] ${results.length - missed.length}/${results.length} caught`);
process.exit(missed.length === 0 ? 0 : 1);
