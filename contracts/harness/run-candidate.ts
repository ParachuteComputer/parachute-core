// `bun run candidate`: run the contracts against a built candidate (CONTRACT_TARGET=candidate).
//
//   bun run candidate                        today, compat, safety, embedded, lifecycle against .cache/candidate-core
//   bun run candidate -- --v1                also the v1 contracts
//   bun run candidate -- suites/embedded     only those suites/files; other args go to `bun test`
//   CANDIDATE_DIR=<dir>                      another candidate (an unpacked v0.8 tarball, a mutant build)
//   CANDIDATE_SHA256=<hex>                   refuse unless the candidate hashes to this (CI passes its build's hash)
//   CONTRACT_RELEASE=1                       a release run: an expected failure counts as a failure (suites/lib.ts)
//   --no-box                                 start no box: only for suites that start the candidate themselves
//                                            (embedded/bundle); the only kind of run on a macOS CI runner
//
// It runs inside the sandbox (harness/sandbox.ts), so the candidate's fixed ports are its own. Every run prints
// what it tested: the candidate's sha256, profile, source, process model (as built and as seen) and platform, and
// any workaround the profile needed. After the run it hashes the candidate again.
import { join, resolve } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { enterSandbox, listeners, onMacRunner } from "./sandbox.ts";
import { loadCandidate, prepareInfo, startCandidateBox, treeHash, watchAttribution } from "./candidate.ts";

await enterSandbox();

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const v1 = args.includes("--v1");
const noBox = args.includes("--no-box");
const extra = args.filter((a) => a !== "--keep" && a !== "--v1" && a !== "--no-box");
// The box's checks (who holds which socket) read /proc; on a macOS runner only suites that need no box run.
if (onMacRunner() && !noBox) throw new Error("on macOS, run with --no-box (the box's listener checks read /proc)");
const contracts = resolve(import.meta.dir, "..");
const dir = resolve(process.env.CANDIDATE_DIR ?? join(contracts, ".cache", "candidate-core"));

const { manifest, sha256 } = await loadCandidate(dir);
const info = prepareInfo(dir, manifest, sha256);
let child: ReturnType<typeof Bun.spawn> | null = null;
let running: Awaited<ReturnType<typeof startCandidateBox>> | null = null;
const cleanup = async () => {
  child?.kill();
  await running?.stop();
  if (!keep) rmSync(info.scratch, { recursive: true, force: true });
};
process.on("SIGINT", async () => (await cleanup(), process.exit(130)));
process.on("SIGTERM", async () => (await cleanup(), process.exit(130)));

const src = typeof manifest.source === "string" ? manifest.source : Object.entries(manifest.source).map(([k, v]) => `${k} ${v}`).join(", ");
console.log(`[candidate] sha256 ${sha256}`);
console.log(`[candidate] ${manifest.name} profile ${manifest.profile}; source ${src}; core ${manifest.core_commit}; built for ${manifest.platform}; run on ${process.platform}-${process.arch}`);

let code = 1;
try {
  const servicesFile = join(info.scratch, "services.json");
  const candidateFile = join(info.scratch, "candidate.json");
  if (noBox) console.log("[candidate] no box (--no-box): only suites that start the candidate themselves");
  else {
    const t0 = Date.now();
    running = await startCandidateBox(info, { keep });
    const s = running.services;
    console.log(`[candidate] process model: built "${manifest.process_model}", seen "${running.observed.model}"`);
    for (const l of running.observed.lines) console.log(`[candidate]   ${l}`);
    console.log(`[candidate] workarounds: ${running.workarounds.length ? running.workarounds.join("; ") : "none"}`);
    console.log(`[candidate] listeners in the sandbox: ${listeners().join(" ")}`);
    console.log(`[candidate] hub ${s.hub}, vault "${s.vaultName}" (${Date.now() - t0} ms)`);
    if (running.observed.model !== manifest.process_model) {
      throw new Error(`the candidate says it is "${manifest.process_model}" but runs as "${running.observed.model}"`);
    }
    if (manifest.profile === "v0.8" && running.workarounds.length) throw new Error("a v0.8 candidate may not need workarounds");
    writeFileSync(servicesFile, JSON.stringify(s));
  }
  writeFileSync(candidateFile, JSON.stringify(info));

  const named = extra.filter((a) => a.startsWith("suites/"));
  const dirs = named.length ? named : ["suites/today", "suites/compat", "suites/safety", "suites/embedded", "suites/lifecycle", ...(v1 ? ["suites/v1"] : [])];
  const rest = extra.filter((a) => !a.startsWith("suites/"));
  // The watcher reads /proc; on a macOS runner there is none (and no box).
  const watch = onMacRunner() ? { stop: () => [] as string[] } : watchAttribution(info);
  child = Bun.spawn(["bun", "test", "--timeout", "120000", ...dirs.map((d) => `./${d}`), ...rest], {
    cwd: contracts,
    env: { ...process.env, CONTRACT_TARGET: "candidate", ...(noBox ? {} : { CONTRACT_SERVICES: servicesFile }), CONTRACT_CANDIDATE: candidateFile },
    stdout: "inherit",
    stderr: "inherit",
  });
  code = await child.exited;
  child = null;
  const foreign = watch.stop();
  if (foreign.length) {
    console.error(`[candidate] listeners started from the candidate that aren't the candidate:\n  ${foreign.join("\n  ")}`);
    code = code || 1;
  } else if (onMacRunner()) console.log("[candidate] listener attribution not checked (macOS runner: no /proc)");
  else console.log("[candidate] every listener started from the candidate during the run was the candidate");
  if (code !== 0 && running && process.env.CONTRACT_SHOW_LOGS !== "0") console.log("[candidate] failed; serve log tail:\n" + (await running.logs()).slice(-4000));
} catch (err) {
  console.error(`[candidate] ${(err as Error).message}`);
  code = code || 1;
} finally {
  await cleanup();
}
const after = await treeHash(dir);
if (after !== sha256) {
  console.error(`[candidate] the candidate changed during the run: ${sha256} → ${after}`);
  code = code || 1;
} else console.log(`[candidate] unchanged after the run: sha256 ${after}`);
process.exit(code);
