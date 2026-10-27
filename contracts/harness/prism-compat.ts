// `bun run prism-compat`: Benjamin's compatibility suite (Prism's scripts/parachute-compat/run.mjs), unchanged,
// against the candidate. It is the Nov 9 gate (PLAN §3.1): 0 FAIL from slice 1 on.
//
// His suite is his code (PolyForm Shield, github.com/omniharmonic/prism), so it is fetched at the commit in
// pins.json, never copied here. It runs inside the sandbox (harness/sandbox.ts) with the candidate's
// bin/parachute and bin/parachute-vault, and a PATH holding only the candidate, Bun, Node and the system.
//
// Until slice 1, today's code fails a few of his checks. Each known FAIL is listed in prism-compat-expected.json
// with its reason and the lane that fixes it. This run fails on any FAIL not listed, and on any listed FAIL that
// now passes (take it off the list in the same pull request). With CONTRACT_RELEASE=1 every FAIL fails the run.
//
//   bun run prism-compat                     CANDIDATE_DIR / CANDIDATE_SHA256 as for `bun run candidate`
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { enterSandbox } from "./sandbox.ts";
import { loadCandidate, prepareInfo } from "./candidate.ts";
import { reposDir } from "./services.ts";
import pins from "../pins.json";

const contracts = resolve(import.meta.dir, "..");
const prism = join(reposDir(), "prism");

async function sh(cmd: string[], cwd?: string): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${err.slice(-600)}`);
  return out;
}

// Fetch outside the sandbox (it has no network): a clean checkout of his repo at the pin.
if (!process.env.PCORE_SANDBOX) {
  const pin = (pins as any).prism as { repo: string; commit: string };
  if (!existsSync(join(prism, ".git"))) await sh(["git", "clone", "--quiet", "--filter=blob:none", pin.repo, prism]);
  const head = (await sh(["git", "rev-parse", "HEAD"], prism)).trim();
  if (!head.startsWith(pin.commit)) {
    await sh(["git", "fetch", "--quiet", "origin"], prism).catch(() => {});
    await sh(["git", "checkout", "--quiet", pin.commit], prism);
  }
  if ((await sh(["git", "status", "--porcelain"], prism)).trim()) throw new Error(`${prism} differs from pin ${pin.commit}; delete it to re-clone`);
}
await enterSandbox();

const dir = resolve(process.env.CANDIDATE_DIR ?? join(contracts, ".cache", "candidate-stock"));
const { manifest, sha256 } = await loadCandidate(dir);
const info = prepareInfo(dir, manifest, sha256);
const node = Bun.which("node");
if (!node) throw new Error("prism-compat: node is needed (his suite is a Node script)");
symlinkSync(node, join(info.runtimeDir, "node"));
const lsof = Bun.which("lsof");
if (lsof) symlinkSync(lsof, join(info.runtimeDir, "lsof"));
console.log(`[prism-compat] his suite: ${(pins as any).prism.repo} ${(pins as any).prism.commit}`);
console.log(`[prism-compat] candidate sha256 ${sha256} (${manifest.profile})`);
if (!lsof) console.log("[prism-compat] lsof is missing: his listener and outbound checks can't look (they pass vacuously; R4)");

const home = join(info.scratch, "pc", "home");
mkdirSync(dirname(home), { recursive: true });
const p = Bun.spawn([node, join(prism, "scripts/parachute-compat/run.mjs"), "--home", home, "--bin", info.bin, "--vault-bin", info.vaultBin], {
  cwd: info.scratch,
  env: { HOME: process.env.HOME ?? "", PATH: `${info.runtimeDir}:/usr/local/bin:/usr/bin:/bin`, LANG: "C.UTF-8" },
  stdout: "inherit",
  stderr: "inherit",
});
const exit = await p.exited;
const reportPath = `${home}-report/report.json`;
if (!existsSync(reportPath)) {
  console.error(`[prism-compat] his suite exited ${exit} without a report`);
  process.exit(1);
}
const report = JSON.parse(readFileSync(reportPath, "utf8"));

interface Expected {
  check: string; // "E2" for an embedded item, else "<area>: <id>"
  reason: string;
  lane: string;
}
const expected: Expected[] = JSON.parse(readFileSync(join(contracts, "prism-compat-expected.json"), "utf8")).fails;
const fails: string[] = [
  ...Object.entries(report.embedded as Record<string, { status: string }>).filter(([, v]) => v.status === "FAIL").map(([k]) => k),
  ...(report.results as { area: string; id: string; status: string }[]).filter((r) => r.status === "FAIL").map((r) => `${r.area}: ${r.id}`),
];
const c = report.counts ?? {};
console.log(`[prism-compat] his result: ${c.PASS ?? c.pass ?? "?"} pass · ${c.FAIL ?? c.fail ?? "?"} fail · ${c.SKIP ?? c.skip ?? "?"} skip (exit ${exit})`);
const release = process.env.CONTRACT_RELEASE === "1";
const unexpected = release ? fails : fails.filter((f) => !expected.some((e) => e.check === f));
const fixed = release ? [] : expected.filter((e) => !fails.includes(e.check));
for (const f of fails) {
  const e = expected.find((x) => x.check === f);
  console.log(`[prism-compat]   FAIL ${f}${e && !release ? ` (expected today: ${e.reason}; lane ${e.lane})` : " (NOT EXPECTED)"}`);
}
for (const e of fixed) console.log(`[prism-compat]   now passing: ${e.check} — take it off prism-compat-expected.json`);
if (!process.argv.includes("--keep")) rmSync(info.scratch, { recursive: true, force: true });
const ok = unexpected.length === 0 && fixed.length === 0;
console.log(`[prism-compat] ${ok ? "OK" : "FAILED"}: ${fails.length} FAIL, ${unexpected.length} unexpected, ${fixed.length} expected but passing${release ? " (release run: no FAIL allowed)" : ""}`);
process.exit(ok ? 0 : 1);
