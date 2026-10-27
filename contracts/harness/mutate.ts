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
  catches: string[]; // contracts (test-name substrings) that must go red; another red test doesn't count
}

export const MUTANTS: Mutant[] = [
  {
    name: "scope-leak",
    why: "a tag-scoped pass is treated as unscoped on single-note reads",
    file: "src/tag-scope.ts",
    find: "  rawRoots: string[] | null,\n): boolean {\n  if (rawRoots === null) return true;\n  if (scopeDeniesAll(allowed)) return false;\n  if (!note.tags",
    replace: "  rawRoots: string[] | null,\n): boolean {\n  if (rawRoots === null || rawRoots.length > 0) return true;\n  if (scopeDeniesAll(allowed)) return false;\n  if (!note.tags",
    suite: "suites/today/access.test.ts",
    catches: ["a scoped pass sees exactly the notes under its tags", "cannot change or delete a note it cannot see"],
  },
  {
    name: "untagged-leak",
    why: "notes with no tags become visible to every scoped pass",
    file: "src/tag-scope.ts",
    find: "  if (!note.tags || note.tags.length === 0) return false;\n  let admitted = false;",
    replace: "  if (!note.tags || note.tags.length === 0) return true;\n  let admitted = false;",
    suite: "suites/today/access.test.ts",
    catches: ["a scoped pass sees exactly the notes under its tags"],
  },
  {
    name: "no-history",
    why: "changes stop keeping the version before them",
    file: "core/src/history.ts",
    find: "  if (!opts.policy.enabled) return;",
    replace: "  if (!opts.policy.enabled || true) return;",
    suite: "suites/today/links-search-history.test.ts",
    catches: ["each change keeps the version before it", "an old version can be restored"],
  },
  {
    name: "stale-write",
    why: "an update made from an old version silently wins instead of being refused",
    file: "core/src/notes.ts",
    find: '    sql += " AND updated_at IS ?";\n    values.push(updates.if_updated_at);',
    replace: '    sql += " AND (updated_at IS ? OR 1)";\n    values.push(updates.if_updated_at);',
    suite: "suites/today/notes.test.ts",
    catches: ["a stale one is refused"],
  },
  {
    name: "wrong-resource",
    why: "the vault advertises a resource URL that isn't its MCP endpoint, so consumer apps can't bind tokens to it",
    file: "src/oauth-discovery.ts",
    find: "    resource: `${base}${prefix}/mcp`,",
    replace: "    resource: `${base}${prefix}`,",
    suite: "suites/today/consumer-connector.test.ts",
    catches: ["the app connects from nothing but the MCP URL"],
  },
];

async function run(cmd: string[], opts: { cwd: string; env?: Record<string, string> }) {
  const p = Bun.spawn(cmd, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out: out + err, code };
}

const only = process.argv.slice(2);
const unknown = only.filter((n) => !MUTANTS.some((m) => m.name === n));
if (unknown.length) {
  console.error(`unknown mutant(s): ${unknown.join(", ")}; known: ${MUTANTS.map((m) => m.name).join(", ")}`);
  process.exit(2);
}
const contracts = resolve(import.meta.dir, "..");
const repos = await ensureRepos();
// Clear worktrees an interrupted earlier run left registered, and clean up this run's if we're interrupted.
await run(["git", "worktree", "prune"], { cwd: repos.vault });
let current: { tree: string; dir: string } | null = null;
let child: ReturnType<typeof Bun.spawn> | null = null;
const onSignal = async () => {
  child?.kill();
  if (child) await child.exited;
  if (current) {
    await run(["git", "worktree", "remove", "--force", current.tree], { cwd: repos.vault });
    rmSync(current.dir, { recursive: true, force: true });
  }
  process.exit(130);
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
const results: { name: string; caught: boolean; red: string[] }[] = [];

for (const m of MUTANTS.filter((m) => only.length === 0 || only.includes(m.name))) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `pcore-mutant-${m.name}-`));
  const tree = join(dir, "vault");
  current = { tree, dir };
  try {
    const add = await run(["git", "worktree", "add", "--detach", "--quiet", tree, pins.vault.commit], { cwd: repos.vault });
    if (add.code !== 0) throw new Error(`git worktree add failed: ${add.out}`);
    symlinkSync(join(repos.vault, "node_modules"), join(tree, "node_modules"));
    const path = join(tree, m.file);
    const src = readFileSync(path, "utf8");
    const hits = src.split(m.find).length - 1;
    if (hits !== 1) throw new Error(`mutant ${m.name}: expected the target text once in ${m.file}, found ${hits}`);
    writeFileSync(path, src.replace(m.find, m.replace));

    child = Bun.spawn(["bun", "run", "harness/run.ts", m.suite], {
      cwd: contracts,
      env: { ...process.env, VAULT_REPO_DIR: tree, CONTRACT_SHOW_LOGS: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [o, e, code] = await Promise.all([new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text(), child.exited]);
    child = null;
    const r = { out: o + e, code };
    const red = [...r.out.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map((x) => x[1]!);
    // Caught means the contracts named for this mutant went red: not just any test, and not a failed startup.
    const missing = m.catches.filter((want) => !red.some((t) => t.includes(want)));
    const caught = r.code !== 0 && missing.length === 0;
    if (!caught && missing.length) console.log(`  expected red but weren't: ${missing.join(" | ")}`);
    results.push({ name: m.name, caught, red });
    console.log(`\n[mutant ${m.name}] ${m.why}`);
    console.log(caught ? `  CAUGHT: ${red.length} contract(s) red` : `  NOT CAUGHT (exit ${r.code})`);
    for (const t of red) console.log(`    red: ${t}`);
    if (!caught) console.log(r.out.slice(-3000));
  } finally {
    await run(["git", "worktree", "remove", "--force", tree], { cwd: repos.vault });
    rmSync(dir, { recursive: true, force: true });
    current = null;
  }
}

const missed = results.filter((r) => !r.caught);
console.log("");
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`[mutants] ${r.name.padEnd(width)}  ${r.caught ? `caught, ${r.red.length} red` : "MISSED"}`);
console.log(`[mutants] ${results.length - missed.length}/${results.length} caught`);
process.exit(missed.length === 0 ? 0 : 1);
