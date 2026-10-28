// `bun run npm-package`: the npm package @openparachute/core (release/npm.ts), installed the way a person installs it,
// then Benjamin's suite (Prism's scripts/parachute-compat/run.mjs, unchanged) on that install. What CI tests here is
// the .tgz the release job publishes (RELEASING.md).
//
//   CANDIDATE_DIR=<bundle> bun run npm-package [--tgz <file>]      (scratch in $NPM_SCRATCH or $TMPDIR, left there)
//
// Outside the sandbox (it needs the registry): pack the package from the bundle (or take --tgz), `npm i -g` it into
// a scratch prefix and `bun add -g` it into a scratch BUN_INSTALL, and check that the hub's two workspace packages
// npm installed are byte-for-byte the dist/ the bundle built. Then, inside the sandbox (no network, a fresh /tmp
// and $HOME; the scratch installs bound read-only), with an old @openparachute/hub and /vault planted next to the
// package in both installs (as `bun add -g` leaves them on a box that had 0.7) and in npm's own node_modules:
//   - `parachute version --json` and `parachute-core version --json` from both installs name @openparachute/core
//     at the package's version, and `parachute --help` from both is core's, not the planted old hub's;
//   - Benjamin's suite with --bin <prefix>/bin/parachute and the package's own parachute-vault: 0 FAIL, the same
//     rule as prism-compat (prism-compat-expected.json, empty).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { enterSandbox, hostNode, SANDBOX_ENV } from "./sandbox.ts";
import { reposDir } from "./services.ts";
import pins from "../pins.json";

const contracts = resolve(import.meta.dir, "..");
const repo = resolve(contracts, "..");
const prism = join(reposDir(), "prism");
const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function sh(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<string> {
  const p = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env ?? (process.env as Record<string, string>), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${(out + err).slice(-800)}`);
  return out;
}

function fail(msg: string): never {
  console.error(`[npm-package] FAILED: ${msg}`);
  process.exit(1);
}

/** Files under `dir`, relative, sorted, with their bytes' sha256. */
function tree(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, n.name);
    if (n.isDirectory()) out.push(...tree(p, base));
    else out.push(`${p.slice(base.length + 1)} ${new Bun.CryptoHasher("sha256").update(readFileSync(p)).digest("hex")}`);
  }
  return out.sort();
}

const bundle = resolve(process.env.CANDIDATE_DIR ?? join(contracts, ".cache", "candidate-core"));

if (!process.env[SANDBOX_ENV]) {
  // ── outside: pack, install twice, plant the old programs ──
  if (!existsSync(join(bundle, "lib", "package.json"))) fail(`no bundle at ${bundle} (bun run build:core)`);
  const scratch = mkdtempSync(join(process.env.NPM_SCRATCH ?? process.env.TMPDIR ?? tmpdir(), "pcore-npm-"));
  let tgz = arg("--tgz");
  if (!tgz) {
    const out = await sh([process.execPath, join(repo, "release", "npm.ts"), "--from", bundle, "--out", join(scratch, "pack")]);
    tgz = out.match(/\[npm\] packed (.+)/)![1]!;
  }
  tgz = resolve(tgz);
  const pkgVersion = JSON.parse(await sh(["tar", "-xzOf", tgz, "package/package.json"])).version as string;
  console.log(`[npm-package] ${tgz} (version ${pkgVersion}, sha256 ${new Bun.CryptoHasher("sha256").update(readFileSync(tgz)).digest("hex")})`);

  // npm needs a HOME for its cache; a scratch one, so nothing of the user's npm config is read.
  const npmHome = join(scratch, "npm-home");
  mkdirSync(npmHome);
  const npmEnv = { PATH: process.env.PATH ?? "", HOME: npmHome, npm_config_cache: join(npmHome, ".npm"), npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" };
  // npm next to Node's real binary: a version manager's shim (mise) reads config from the real HOME.
  const hostNpm = hostNode() ? join(dirname(hostNode()!), "npm") : null;
  const npm = hostNpm && existsSync(hostNpm) ? hostNpm : (Bun.which("npm") ?? fail("npm is needed"));
  npmEnv.PATH = `${dirname(hostNode() ?? npm)}:${dirname(process.execPath)}:${npmEnv.PATH}`;
  const npmPrefix = join(scratch, "npm");
  await sh([npm, "install", "--global", "--prefix", npmPrefix, tgz], { env: npmEnv });
  const bunInstall = join(scratch, "bun");
  await sh([process.execPath, "add", "--global", tgz], { env: { ...npmEnv, BUN_INSTALL: bunInstall } });
  const installed = join(npmPrefix, "lib", "node_modules", "@openparachute", "core");
  for (const name of ["parachute", "parachute-core"]) {
    if (!existsSync(join(npmPrefix, "bin", name))) fail(`npm linked no bin/${name}`);
    if (!existsSync(join(bunInstall, "bin", name))) fail(`bun linked no bin/${name}`);
  }
  for (const n of [join(npmPrefix, "bin", "parachute-vault"), join(bunInstall, "bin", "parachute-vault")]) if (existsSync(n)) fail(`${n} was linked`);

  // The hub's workspace packages, as npm installed them, against the dist/ the bundle built.
  for (const w of ["depcheck", "door-contract"]) {
    // npm puts a global package's dependencies inside its own node_modules.
    const fromNpm = join(installed, "node_modules", "@openparachute", w, "dist");
    const fromBundle = join(bundle, "lib", "packages", "hub", "packages", w, "dist");
    const a = existsSync(fromNpm) ? tree(fromNpm) : ["(missing)"];
    const b = tree(fromBundle);
    if (a.join("\n") !== b.join("\n")) fail(`@openparachute/${w}'s dist from npm differs from the bundle's build`);
  }
  console.log("[npm-package] @openparachute/depcheck and door-contract from npm: the bundle's dist/, byte for byte");
  // What it installed: never the local embedding stack the bundle leaves out (release/payload.ts). TypeScript comes
  // along as a peer of three @openparachute packages (release/npm.ts says why); it is reported, not refused.
  const deps = (root: string) => existsSync(root) ? readdirSync(root).flatMap((n) => (n.startsWith("@") ? readdirSync(join(root, n)).map((m) => `${n}/${m}`) : [n])) : [];
  for (const [what, root] of [["npm", join(installed, "node_modules")], ["bun", join(bunInstall, "install", "global", "node_modules")]] as const) {
    const names = deps(root);
    const heavy = names.filter((n) => ["@huggingface/transformers", "onnxruntime-node", "onnxruntime-web", "sharp"].includes(n));
    if (heavy.length) fail(`${what} installed the local embedding stack: ${heavy.join(", ")}`);
    console.log(`[npm-package] ${what}: ${names.length} packages, no embedding stack${names.includes("typescript") ? "; typescript (a peer)" : ""}`);
  }

  // The old programs beside it, as a box that had 0.7 has them (next to the package in the global node_modules),
  // and in the package's own node_modules, the first place a bare import would look: if the package ever resolved
  // the hub or the vault through node_modules, these would answer instead (and say so).
  for (const at of [join(npmPrefix, "lib", "node_modules"), join(installed, "node_modules"), join(bunInstall, "install", "global", "node_modules")]) {
    for (const [name, entries] of [["hub", ["src/cli.ts", "src/hub-db.ts"]], ["vault", ["src/cli.ts", "core/src/schema.ts"]]] as const) {
      const d = join(at, "@openparachute", name);
      if (existsSync(d)) fail(`${d} exists before planting`);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "package.json"), JSON.stringify({ name: `@openparachute/${name}`, version: "0.7.0", type: "module" }));
      for (const e of entries) {
        mkdirSync(dirname(join(d, e)), { recursive: true });
        writeFileSync(join(d, e), `console.log("OLD ${name.toUpperCase()} 0.7 RAN"); process.exit(99);\nexport const SCHEMA_VERSION = 1;\nexport const HUB_SCHEMA_VERSION = 1;\n`);
      }
    }
  }

  // His suite, fetched outside (the sandbox has no network), as prism-compat does.
  const pin = (pins as any).prism as { repo: string; commit: string };
  if (!existsSync(join(prism, ".git"))) await sh(["git", "clone", "--quiet", "--filter=blob:none", pin.repo, prism]);
  if (!(await sh(["git", "rev-parse", "HEAD"], { cwd: prism })).trim().startsWith(pin.commit)) {
    await sh(["git", "fetch", "--quiet", "origin"], { cwd: prism }).catch(() => "");
    await sh(["git", "checkout", "--quiet", pin.commit], { cwd: prism });
  }
  process.env.NPM_INSTALL_DIR = scratch;
  process.env.NPM_PACKAGE_VERSION = pkgVersion;
  process.env.NPM_PACKAGE_DIR = installed;
}
await enterSandbox();

// ── inside: no network, a fresh /tmp and $HOME; the scratch installs read-only ──
const scratch = process.env.NPM_INSTALL_DIR!;
const version = process.env.NPM_PACKAGE_VERSION!;
const installed = process.env.NPM_PACKAGE_DIR!;
const runtime = mkdtempSync(join(tmpdir(), "npm-runtime-"));
symlinkSync(process.execPath, join(runtime, "bun"));
const node = hostNode();
if (!node) fail("node is needed (his suite is a Node script)");
symlinkSync(node, join(runtime, "node"));
const lsof = Bun.which("lsof");
if (lsof) symlinkSync(lsof, join(runtime, "lsof"));
const PATH = `${runtime}:/usr/local/bin:/usr/bin:/bin`;
const home = mkdtempSync(join(tmpdir(), "npm-home-"));
const env = { PATH, HOME: home, PARACHUTE_HOME: join(home, ".parachute"), LANG: "C.UTF-8" };

for (const prefix of [join(scratch, "npm"), join(scratch, "bun")]) {
  for (const name of ["parachute", "parachute-core"]) {
    const r = Bun.spawnSync([join(prefix, "bin", name), "version", "--json"], { env, stdout: "pipe", stderr: "pipe" });
    const v = r.exitCode === 0 ? JSON.parse(r.stdout.toString()) : null;
    if (!v || v.name !== "@openparachute/core" || v.version !== version) fail(`${prefix}/bin/${name} version --json: exit ${r.exitCode} ${r.stdout}${r.stderr.toString().slice(-400)}`);
  }
}
for (const prefix of [join(scratch, "npm"), join(scratch, "bun")]) {
  const help = Bun.spawnSync([join(prefix, "bin", "parachute"), "--help"], { env, stdout: "pipe", stderr: "pipe" });
  const helpText = help.stdout.toString() + help.stderr.toString();
  if (help.exitCode !== 0 || /OLD (HUB|VAULT) 0\.7 RAN/.test(helpText) || !helpText.includes(`parachute ${version}:`)) fail(`${prefix}/bin/parachute --help with the old hub planted beside it: exit ${help.exitCode}\n${helpText.slice(0, 800)}`);
}
console.log(`[npm-package] both installs answer as @openparachute/core ${version}; the planted 0.7 hub and vault never ran`);

console.log(`[npm-package] his suite: ${(pins as any).prism.repo} ${(pins as any).prism.commit}`);
if (!lsof) console.log("[npm-package] lsof is missing: his listener and outbound checks can't look (they pass vacuously; R4)");
const suiteHome = join(mkdtempSync(join(tmpdir(), "npm-pc-")), "home");
const p = Bun.spawn(
  [node, join(prism, "scripts/parachute-compat/run.mjs"), "--home", suiteHome, "--bin", join(scratch, "npm", "bin", "parachute"), "--vault-bin", join(installed, "packages", "cli", "bin", "parachute-vault")],
  { cwd: dirname(suiteHome), env: { HOME: home, PATH, LANG: "C.UTF-8" }, stdout: "inherit", stderr: "inherit" },
);
const exit = await p.exited;
const reportPath = `${suiteHome}-report/report.json`;
if (!existsSync(reportPath)) fail(`his suite exited ${exit} without a report`);
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const expected: { check: string }[] = JSON.parse(readFileSync(join(contracts, "prism-compat-expected.json"), "utf8")).fails;
const fails: string[] = [
  ...Object.entries(report.embedded as Record<string, { status: string }>).filter(([, v]) => v.status === "FAIL").map(([k]) => k),
  ...(report.results as { area: string; id: string; status: string }[]).filter((r) => r.status === "FAIL").map((r) => `${r.area}: ${r.id}`),
];
const c = report.counts ?? {};
console.log(`[npm-package] his result on the npm install: ${c.PASS ?? "?"} pass · ${c.FAIL ?? "?"} fail · ${c.SKIP ?? "?"} skip (exit ${exit})`);
for (const f of fails) console.log(`[npm-package]   FAIL ${f}`);
const unexpected = fails.filter((f) => !expected.some((e) => e.check === f));
if (unexpected.length) fail(`${unexpected.length} FAIL in his suite on the npm install`);
console.log("[npm-package] OK");
