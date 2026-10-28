// `bun run mutants:candidate`: mutants and flips applied to the candidate's source, then the candidate rebuilt
// (PLAN §7.2: "mutants are applied to the candidate's source, then the candidate is rebuilt").
//
// For each entry: build the core candidate (harness/build-core-candidate.ts) from this repo's working tree with the
// one change applied to packages/<repo>/ (vault or hub, moved in by lane A1), run the named suite against that
// candidate with `bun run candidate`, and require
//   - a mutant: every contract in `catches` red;
//   - a flip:   every red() contract in `catches` reporting "now green" (the fix makes it pass).
// A mutant with `processModel` is built that way (e.g. "child": a bug only the child path can have, until Nov 3).
//
//   bun run mutants:candidate [name ...]     all of MUTANTS, CANDIDATE_MUTANTS and FLIPS, or only those named
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildCoreCandidate, stageWorkspace } from "./build-core-candidate.ts";
import { installWorkspace } from "../../release/bundle.ts";
import { CANDIDATE_MUTANTS, FLIPS, MUTANTS, type Mutant } from "./mutants.ts";

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
// One snapshot of the workspace for the whole run: every mutant is built from the same source.
const snapshot = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pcore-cmut-base-"));
const staged = { dir: join(snapshot, "lib"), rev: await stageWorkspace(resolve(contracts, ".."), join(snapshot, "lib")), installed: true };
// Installed once, here: each mutant gets a copy of the installed workspace with its one change, so a network blip
// in a mutant's own install can't stand in for a missed mutant. No mutant may change what install builds.
// The bundle's install (release/bundle.ts): production node_modules, the admin pages built, the embedding stack left out.
await installWorkspace(staged.dir).catch((err) => {
  throw new Error(`install of the snapshot failed: ${(err as Error).message}`);
});
console.log(`[mutants:candidate] source ${staged.rev}`);
let current: string | null = null;
let child: ReturnType<typeof Bun.spawn> | null = null;
const cleanup = async () => {
  child?.kill();
  if (child) await child.exited;
  if (current) rmSync(current, { recursive: true, force: true });
  rmSync(snapshot, { recursive: true, force: true });
};
process.on("SIGINT", async () => (await cleanup(), process.exit(130)));
process.on("SIGTERM", async () => (await cleanup(), process.exit(130)));

const results: { name: string; kind: string; ok: boolean; error?: boolean }[] = [];
for (const m of all.filter((m) => only.length === 0 || only.includes(m.name))) {
  const which = m.repo ?? "vault";
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `pcore-cmut-${m.name}-`));
  current = dir;
  let ok = false;
  let errored = false;
  try {
    const cand = join(dir, "candidate");
    // The change goes into the copied workspace, never this checkout: patches and paths are relative to the
    // package (packages/vault or packages/hub), as they were to today's repos.
    const apply = async (lib: string) => {
      const pkg = join(lib, "packages", which);
      if (m.file?.startsWith("packages/")) throw new Error(`${m.name}: ${which}/${m.file} is built at install (the snapshot is installed once)`);
      if (m.patch) {
        const ap = await run(["git", "apply", join(import.meta.dir, m.patch)], { cwd: pkg });
        if (ap.code !== 0) throw new Error(`${m.name}: git apply ${m.patch} failed: ${ap.out}`);
      } else {
        const path = join(pkg, m.file!);
        const src = readFileSync(path, "utf8");
        const hits = src.split(m.find!).length - 1;
        if (hits !== 1) throw new Error(`${m.name}: expected the target text once in packages/${which}/${m.file}, found ${hits}`);
        writeFileSync(path, src.replace(m.find!, m.replace!));
      }
    };
    await buildCoreCandidate({ out: cand, staged, edit: { label: `${m.kind} ${m.name}`, apply }, ...(m.processModel ? { processModel: m.processModel } : {}) });
    if (m.processModel) console.log(`[${m.kind} ${m.name}] built as the ${m.processModel} path`);
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
    errored = true;
    console.log(`\n[${m.kind} ${m.name}] ERROR ${(err as Error).message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    current = null;
  }
  results.push({ name: m.name, kind: m.kind, ok, error: errored });
}
rmSync(snapshot, { recursive: true, force: true });
console.log("");
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`[mutants:candidate] ${r.kind.padEnd(6)} ${r.name.padEnd(width)}  ${r.ok ? (r.kind === "flip" ? "flipped" : "caught") : r.error ? "ERROR (not tested)" : "MISSED"}`);
const missed = results.filter((r) => !r.ok);
console.log(`[mutants:candidate] ${results.length - missed.length}/${results.length} ok`);
process.exit(missed.length ? 1 : 0);
