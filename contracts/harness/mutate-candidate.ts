// `bun run mutants:candidate`: mutants and flips applied to the candidate's source, then the candidate rebuilt
// (PLAN §7.2: "mutants are applied to the candidate's source, then the candidate is rebuilt").
//
// For each entry: check the pinned repo out into a temp git worktree, apply the one change, build a candidate from
// it (harness/build-stock-candidate.ts, the other repo at its pin), run the named suite against that candidate with
// `bun run candidate`, and require
//   - a mutant: every contract in `catches` red;
//   - a flip:   every red() contract in `catches` reporting "now green" (the fix makes it pass).
// When lane A1 replaces the stock build, this file builds from this repo's packages/ instead.
//
//   bun run mutants:candidate [name ...]     all of MUTANTS, CANDIDATE_MUTANTS and FLIPS, or only those named
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ensureRepos } from "./services.ts";
import { buildStockCandidate } from "./build-stock-candidate.ts";
import { CANDIDATE_MUTANTS, FLIPS, MUTANTS, type Mutant } from "./mutants.ts";
import pins from "../pins.json";

async function run(cmd: string[], opts: { cwd: string; env?: Record<string, string> }) {
  const p = Bun.spawn(cmd, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out: out + err, code };
}

const all: (Mutant & { kind: "mutant" | "flip" })[] = [
  ...MUTANTS.map((m) => ({ ...m, kind: "mutant" as const })),
  ...CANDIDATE_MUTANTS.map((m) => ({ ...m, kind: "mutant" as const })),
  ...FLIPS.map((m) => ({ ...m, kind: "flip" as const })),
];
const only = process.argv.slice(2);
const unknown = only.filter((n) => !all.some((m) => m.name === n));
if (unknown.length) {
  console.error(`unknown: ${unknown.join(", ")}; known: ${all.map((m) => m.name).join(", ")}`);
  process.exit(2);
}
const contracts = resolve(import.meta.dir, "..");
const repos = await ensureRepos();
for (const r of [repos.vault, repos.hub]) await run(["git", "worktree", "prune"], { cwd: r });
let current: { repo: string; dir: string } | null = null;
let child: ReturnType<typeof Bun.spawn> | null = null;
const cleanup = async () => {
  child?.kill();
  if (child) await child.exited;
  if (current) {
    await run(["git", "worktree", "remove", "--force", join(current.dir, "src")], { cwd: current.repo });
    rmSync(current.dir, { recursive: true, force: true });
  }
};
process.on("SIGINT", async () => (await cleanup(), process.exit(130)));
process.on("SIGTERM", async () => (await cleanup(), process.exit(130)));

const results: { name: string; kind: string; ok: boolean }[] = [];
for (const m of all.filter((m) => only.length === 0 || only.includes(m.name))) {
  const which = m.repo ?? "vault";
  const repo = which === "hub" ? repos.hub : repos.vault;
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `pcore-cmut-${m.name}-`));
  const tree = join(dir, "src");
  current = { repo, dir };
  let ok = false;
  try {
    const add = await run(["git", "worktree", "add", "--detach", "--quiet", tree, (pins as any)[which].commit], { cwd: repo });
    if (add.code !== 0) throw new Error(`git worktree add failed: ${add.out}`);
    if (m.patch) {
      const ap = await run(["git", "apply", join(import.meta.dir, m.patch)], { cwd: tree });
      if (ap.code !== 0) throw new Error(`${m.name}: git apply ${m.patch} failed: ${ap.out}`);
    } else {
      const path = join(tree, m.file!);
      const src = readFileSync(path, "utf8");
      const hits = src.split(m.find!).length - 1;
      if (hits !== 1) throw new Error(`${m.name}: expected the target text once in ${which}/${m.file}, found ${hits}`);
      writeFileSync(path, src.replace(m.find!, m.replace!));
    }
    const cand = join(dir, "candidate");
    await buildStockCandidate({
      out: cand,
      hubDir: which === "hub" ? tree : repos.hub,
      vaultDir: which === "vault" ? tree : repos.vault,
    });
    child = Bun.spawn(["bun", "run", "harness/run-candidate.ts", ...m.suite.split(" ")], {
      cwd: contracts,
      env: { ...process.env, CANDIDATE_DIR: cand, CANDIDATE_SHA256: "", CONTRACT_SHOW_LOGS: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [o, e, code] = await Promise.all([new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text(), child.exited]);
    child = null;
    const out = o + e;
    const red = [...out.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map((x) => x[1]!);
    if (m.kind === "mutant") {
      const missing = m.catches.filter((want) => !red.some((t) => t.includes(want)));
      ok = code !== 0 && missing.length === 0;
      console.log(`\n[mutant ${m.name}] ${m.why}`);
      console.log(ok ? `  CAUGHT: ${red.length} contract(s) red` : `  NOT CAUGHT (exit ${code}); expected red: ${missing.join(" | ")}`);
    } else {
      // A red() contract that passes fails with `now green: "<its name>" passes` (suites/lib.ts).
      const greened = [...out.matchAll(/now green: "(.+?)" passes\./g)].map((x) => x[1]!);
      const flipped = m.catches.filter((want) => greened.some((n) => n.includes(want)));
      const missing = m.catches.filter((w) => !flipped.includes(w));
      ok = missing.length === 0;
      console.log(`\n[flip ${m.name}] ${m.why}`);
      console.log(ok ? `  FLIPPED: ${flipped.length} red contract(s) now green under the fix` : `  NOT FLIPPED: ${missing.join(" | ")}`);
    }
    for (const t of red) console.log(`    red: ${t}`);
    if (!ok) console.log(out.slice(-3000));
  } catch (err) {
    console.log(`\n[${m.kind} ${m.name}] ERROR ${(err as Error).message}`);
  } finally {
    await run(["git", "worktree", "remove", "--force", tree], { cwd: repo });
    rmSync(dir, { recursive: true, force: true });
    current = null;
  }
  results.push({ name: m.name, kind: m.kind, ok });
}
console.log("");
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`[mutants:candidate] ${r.kind.padEnd(6)} ${r.name.padEnd(width)}  ${r.ok ? (r.kind === "flip" ? "flipped" : "caught") : "MISSED"}`);
const missed = results.filter((r) => !r.ok);
console.log(`[mutants:candidate] ${results.length - missed.length}/${results.length} ok`);
process.exit(missed.length ? 1 : 0);
