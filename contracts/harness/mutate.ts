// `bun run mutants`: prove the contracts can fail. Each mutant is a one-line change to today's vault that a real bug
// could make. For each, we check out the pinned vault into a temp git worktree, apply the change, start the
// throwaway services from it, run the contracts that should catch it, and require them to go red. The clean clone
// is never touched. Exit 0 only if every mutant is caught.
import { mkdtempSync, rmSync, symlinkSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ensureRepos } from "./services.ts";
import pins from "../pins.json";
import { MUTANTS } from "./mutants.ts";

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
