// The v0.8 bundle (PLAN §3 "The bundle", §2.5): the tree the tarball holds, which is also the candidate every suite
// runs (contracts/harness/build-core-candidate.ts builds it; `bun run build:core`).
//
//   bin/parachute-core            the one command: links to lib/packages/cli/bin/, whose sh wrappers run lib/ on
//                                 the bundle's runtime/bun when there is one
//   bin/parachute, bin/parachute-vault   the same program under its two old names, for Prism's PARACHUTE_BIN /
//                                 PARACHUTE_VAULT_BIN and Benjamin's suite; never linked onto a shared PATH
//   runtime/bun                   the pinned Bun (release/bun.json), checked against its sha256
//   lib/                          the workspace with a production install of node_modules (release/payload.ts:
//                                 no embedding stack, no dev tools) and the hub's and vault's built admin pages
//   entitlements/bun.plist        allow-jit: what runtime/bun needs under the hardened runtime (release/sign.ts)
//   package.json                  @openparachute/core, bin parachute-core
//   LICENSE, THIRD-PARTY-NOTICES.txt, SOURCE.md, VERSION (the wrappers know the bundle by VERSION and runtime/bun)
//
// The wrappers turn Bun's transpiler cache off unless the caller sets BUN_RUNTIME_TRANSPILER_CACHE_PATH: by
// default Bun writes it to ~/.bun/install/cache, outside PARACHUTE_HOME (Benjamin's E2). A CLI start measured the
// same within noise without it on this machine (about 50 ms either way).
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { installPinnedBun, hostPlatform } from "./runtime.ts";
import { LEFT_OUT, prune, workspaces, writeNotices } from "./payload.ts";
import { signTree } from "./sign.ts";
import { bundleName } from "./pack.ts";

const RELEASE = import.meta.dir;
export const NAMES = ["parachute-core", "parachute", "parachute-vault"];
const REPO_URL = "https://github.com/ParachuteComputer/parachute-core";

async function sh(cmd: string[], cwd?: string): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} (in ${cwd ?? "."}) failed (${code}): ${(out + err).slice(-800)}`);
  return out;
}

/**
 * Install a staged workspace the way the bundle ships it: a full install first (the hub's `prepare` builds its
 * packages' dist/), the two admin pages built (web/ui/dist, where hub and vault look for them), then node_modules
 * replaced by a production install without scripts, and pruned (release/payload.ts). Returns what was left out.
 */
export async function installWorkspace(lib: string): Promise<string[]> {
  await sh(["bun", "install", "--frozen-lockfile"], lib);
  for (const pkg of ["packages/hub", "packages/vault"]) {
    const ui = join(lib, pkg, "web", "ui");
    if (!existsSync(join(ui, "package.json"))) continue;
    await sh(["bun", "install", "--frozen-lockfile"], ui);
    await sh(["bun", "run", "build"], ui);
    if (!existsSync(join(ui, "dist", "index.html"))) throw new Error(`${pkg}: the admin page build wrote no dist/index.html`);
    rmSync(join(ui, "node_modules"), { recursive: true, force: true });
  }
  for (const w of workspaces(lib)) rmSync(join(w, "node_modules"), { recursive: true, force: true });
  await sh(["bun", "install", "--frozen-lockfile", "--production", "--ignore-scripts"], lib);
  return prune(lib);
}

export interface BundleFacts {
  name: string;
  platform: string;
  runtime: { bun: string; zip: string; sha256: string };
  signed: string;
  left_out: string[];
}

/**
 * Lay out the bundle around an installed lib/ (already at <out>/lib): runtime, wrappers, entitlements, the root
 * package.json and the notices. With `sign` (macOS only), sign it ad hoc with the hardened runtime last, so the
 * candidate's hash covers the signed bytes.
 */
export async function layOutBundle(out: string, opts: { commit: string; rev: string; leftOut?: string[]; sign?: boolean }): Promise<BundleFacts> {
  out = resolve(out);
  const lib = join(out, "lib");
  const pkg = JSON.parse(readFileSync(join(lib, "package.json"), "utf8"));
  const version = (p: string) => JSON.parse(readFileSync(join(lib, p, "package.json"), "utf8")).version as string;
  const platform = hostPlatform();
  mkdirSync(join(out, "runtime"), { recursive: true });
  const bun = await installPinnedBun(join(out, "runtime", "bun"), platform);
  mkdirSync(join(out, "bin"), { recursive: true });
  for (const n of NAMES) symlinkSync(`../lib/packages/cli/bin/${n}`, join(out, "bin", n));
  cpSync(join(RELEASE, "entitlements"), join(out, "entitlements"), { recursive: true });
  copyFileSync(join(lib, "LICENSE"), join(out, "LICENSE"));

  writeFileSync(
    join(out, "package.json"),
    JSON.stringify(
      { name: pkg.name, version: pkg.version, description: pkg.description, license: pkg.license, type: "module", bin: { "parachute-core": "bin/parachute-core" } },
      null,
      2,
    ) + "\n",
  );
  const leftOut = opts.leftOut ?? [];
  const packages = writeNotices(lib, join(out, "THIRD-PARTY-NOTICES.txt"), { version: bun.version, licence: readFileSync(join(RELEASE, "bun-LICENSE.md"), "utf8") });
  writeFileSync(
    join(out, "VERSION"),
    [
      `parachute-core ${pkg.version}`,
      `commit ${opts.commit}`,
      `platform ${platform}`,
      `bun ${bun.version}`,
      `hub ${version("packages/hub")} (moved in)`,
      `vault ${version("packages/vault")} (moved in)`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(out, "SOURCE.md"),
    [
      `# Source of Parachute ${pkg.version}`,
      "",
      `This bundle is built from ${REPO_URL} at commit \`${opts.commit}\`${opts.rev.endsWith("+changes") ? " plus uncommitted changes (a development build, not a release)" : ""}:`,
      `${REPO_URL}/tree/${opts.commit}`,
      "",
      `- \`lib/\` is that commit's workspace (\`package.json\`, \`bun.lock\`, \`packages/\`) as source, with a production`,
      `  install of \`node_modules\` from \`bun.lock\` (${packages} packages, listed with their licences in`,
      "  `THIRD-PARTY-NOTICES.txt`) and the hub's and vault's admin pages built (`web/ui/dist`).",
      `- Left out of \`node_modules\`: ${LEFT_OUT.map((p) => `\`${p}\``).join(", ")} and what only they need${leftOut.length ? ` (${leftOut.length} packages)` : ""}.`,
      "  Local semantic search needs them; an external embedding API (`EMBEDDING_API_URL`) works without.",
      `- \`runtime/bun\` is Bun ${bun.version}, unchanged from ${bun.zip} of its release (sha256 \`${bun.sha256}\`),`,
      "  https://github.com/oven-sh/bun/releases. Its licence and the libraries it links are at the end of",
      "  `THIRD-PARTY-NOTICES.txt`.",
      "- Build it yourself: `bun install && bun run candidate` in the repository (contracts/harness/build-core-candidate.ts).",
      "",
      "Parachute is licensed under the GNU Affero General Public License v3.0 or later (`LICENSE`).",
      "",
    ].join("\n"),
  );
  let signed = "no";
  if (opts.sign) {
    const files = await signTree(out);
    signed = `ad hoc, hardened runtime; ${files.length} Mach-O file(s); runtime/bun with entitlements/bun.plist`;
  }
  return { name: bundleName(pkg.version, platform), platform, runtime: { bun: bun.version, zip: bun.zip, sha256: bun.sha256 }, signed, left_out: leftOut };
}
