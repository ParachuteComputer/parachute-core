// lifecycle/upgrade, the fetch: `parachute upgrade` installs the newer release from the home's own channel.
//
// The candidate is installed under a prefix by its own `install` (the versioned installer's layout) and serves a
// home it made. The npm registry and the release downloads are outside systems, so the contract stands in for
// both on loopback (npm_config_registry, PARACHUTE_RELEASES_URL): dist-tags, a SHA256SUMS and a bundle. The "newer
// release" is the candidate's own bundle with a higher version written in.
//   - the home's channel is in run/release.json (a prerelease made the home: beta); `--channel` changes it;
//   - nothing newer on the channel: nothing to do; an older version on a tag is never installed;
//   - a download whose sha256 is not the one in SHA256SUMS is not installed: the prefix is as it was;
//   - a newer one is checked, installed beside the old copy (kept: the way back) and linked; the home's data is not
//     touched, since the running server is not restarted: the new release takes its step at its first start.
// Red on next afe6ce72: bare `upgrade` was the hub's module sweep and fetched nothing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { candidateEnv } from "../../harness/candidate.ts";
import { candidate, cli, newHome } from "../candidate-lib.ts";
import { must } from "../lib.ts";
import { fileHashes } from "./_takeover-lib.ts";

const info = candidate();
const here = JSON.parse(readFileSync(join(info.dir, "package.json"), "utf8")).version as string;
const NEWER = "0.9.9-pre.7"; // made up: above any 0.9.0 prerelease
const platform = `${process.platform}-${process.arch}`;
let home = "";
let prefix = "";
let server: ReturnType<typeof Bun.serve>;
let env: Record<string, string> = {};
/** What the stand-ins answer: the registry's dist-tags, and the release's files by name. */
const tags: Record<string, string> = {};
const files = new Map<string, string | { path: string }>();
const asked: string[] = [];

const release = () => JSON.parse(readFileSync(join(home, "run", "release.json"), "utf8"));
const link = () => readlinkSync(join(prefix, "bin", "parachute-core"));
async function upgrade(args: string[] = []) {
  const p = Bun.spawn([join(prefix, "bin", "parachute"), "upgrade", ...args], { env: candidateEnv(info, home, env), cwd: dirname(home), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}
const sh = (argv: string[]) => {
  const r = Bun.spawnSync(argv, { stderr: "pipe" });
  must(r.exitCode === 0, `setup: ${argv.slice(0, 3).join(" ")} failed: ${r.stderr.toString().slice(-400)}`);
};

beforeAll(async () => {
  home = newHome("up-fetch");
  prefix = join(dirname(home), "prefix");
  const installed = Bun.spawnSync([join(info.dir, "bin", "parachute"), "install", "--prefix", prefix], { env: candidateEnv(info, home), stderr: "pipe" });
  must(installed.exitCode === 0, `setup: install exited ${installed.exitCode}: ${installed.stderr.toString().slice(-600)}`);
  must((await cli(home, ["create", "fetchv", "--no-mirror", "--json"], { vault: true, env: { EMBEDDINGS_ENABLED: "false" } })).code === 0, "setup: vault create");
  must((await cli(home, ["user", "password", "--username", "owner", "--password", `pw-${randomBytes(12).toString("hex")}`])).code === 0, "setup: user password");
  // The newer release: this bundle, saying it is NEWER, packed as a release packs it.
  const build = join(dirname(home), "newer");
  const name = `parachute-core-${NEWER}-${platform}`;
  mkdirSync(build);
  sh(["cp", "-a", "--reflink=auto", info.dir, join(build, name)]);
  for (const pkg of ["package.json", join("lib", "package.json")]) {
    const path = join(build, name, pkg);
    writeFileSync(path, `${JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), version: NEWER }, null, 2)}\n`);
  }
  sh(["tar", "-C", build, "--exclude", "CANDIDATE.json", "-I", "gzip -1", "-cf", join(build, `${name}.tar.gz`), name]);
  const sum = createHash("sha256").update(readFileSync(join(build, `${name}.tar.gz`))).digest("hex");
  files.set(`v${NEWER}/${name}.tar.gz`, { path: join(build, `${name}.tar.gz`) });
  files.set(`v${NEWER}/SHA256SUMS`, `${sum}  ${name}.tar.gz\n`);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      asked.push(path);
      if (path === "/registry/@openparachute/core") return Response.json({ name: "@openparachute/core", "dist-tags": tags });
      const file = files.get(path.replace(/^\/releases\//, ""));
      if (file === undefined) return new Response("not found", { status: 404 });
      return new Response(typeof file === "string" ? file : Bun.file(file.path));
    },
  });
  env = { npm_config_registry: `http://127.0.0.1:${server.port}/registry`, PARACHUTE_RELEASES_URL: `http://127.0.0.1:${server.port}/releases` };
}, 240_000);

afterAll(() => {
  server?.stop(true);
});

describe("lifecycle/upgrade from the home's channel", () => {
  test("the home's channel is recorded; nothing newer there is nothing to do, and an older version is never installed", async () => {
    expect(release()).toMatchObject({ version: here, state: "current", channel: "beta" }); // a prerelease made this home
    Object.assign(tags, { beta: here, latest: "0.8.0", next: "0.8.1-pre.1" });
    const before = Object.fromEntries(fileHashes(home));
    const none = await upgrade(["--json"]);
    must(none.code === 0, `upgrade exited ${none.code}: ${none.stderr.slice(-600)}`);
    expect(JSON.parse(none.stdout.trim().split("\n").pop()!)).toMatchObject({ upgraded: false, from: here, to: here, channel: "beta" });
    expect(none.stderr).toContain("Nothing to do");
    expect(asked).toContain("/registry/@openparachute/core");
    expect(Object.fromEntries(fileHashes(home))).toEqual(before);
    // Another channel, by name: recorded for next time; what it names is older, so nothing is installed.
    const next = await upgrade(["--channel", "next", "--json"]);
    expect(next.code).toBe(0);
    expect(JSON.parse(next.stdout.trim().split("\n").pop()!)).toMatchObject({ upgraded: false, channel: "next" });
    expect(release().channel).toBe("next");
    expect(link()).toBe(`../${here}/bin/parachute-core`);
    expect((await upgrade(["--channel", "beta"])).code).toBe(0);
    expect(release().channel).toBe("beta");
    // With no registry to ask, it says so and changes nothing.
    const offline = await upgrade(["--json"]).then(async () => {
      const p = Bun.spawn([join(prefix, "bin", "parachute"), "upgrade"], { env: candidateEnv(info, home, { ...env, npm_config_registry: "http://127.0.0.1:9/none" }), stdout: "pipe", stderr: "pipe" });
      return { code: await p.exited, stderr: await new Response(p.stderr).text() };
    });
    expect(offline.code).toBe(1);
    expect(offline.stderr).toContain("Nothing was changed");
  }, 120_000);

  test("a download that doesn't match SHA256SUMS is not installed: the prefix is as it was", async () => {
    tags.beta = NEWER;
    const name = `parachute-core-${NEWER}-${platform}.tar.gz`;
    const good = files.get(`v${NEWER}/SHA256SUMS`) as string;
    files.set(`v${NEWER}/SHA256SUMS`, `${"0".repeat(64)}  ${name}\n`);
    const before = readdirSync(prefix).sort();
    const r = await upgrade(["--json"]);
    files.set(`v${NEWER}/SHA256SUMS`, good);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("sha256");
    expect(JSON.parse(r.stdout.trim().split("\n").pop()!)).toMatchObject({ upgraded: false });
    expect(readdirSync(prefix).sort()).toEqual(before);
    expect(link()).toBe(`../${here}/bin/parachute-core`);
    expect(readdirSync(join(prefix, ".store")).filter((n) => n.startsWith(".fetch-") || n.startsWith(NEWER))).toEqual([]);
  }, 240_000);

  test("a newer release on the channel is checked, installed beside the old copy and linked; the home waits for its first start", async () => {
    const before = Object.fromEntries(fileHashes(home));
    const r = await upgrade(["--json"]);
    must(r.code === 0, `upgrade exited ${r.code}: ${r.stderr.slice(-1200)}`);
    expect(JSON.parse(r.stdout.trim().split("\n").pop()!)).toMatchObject({ upgraded: true, from: here, to: NEWER, channel: "beta", how: "bundle" });
    expect(r.stderr).toContain("sha256 matches");
    expect(link()).toBe(`../${NEWER}/bin/parachute-core`);
    expect(existsSync(join(prefix, here, "bin", "parachute"))).toBe(true); // the old copy is kept: the way back
    expect(Object.fromEntries(fileHashes(home))).toEqual(before); // no step yet: the server was not restarted
    // The linked program is the new release; its first command on the home takes the step, with a backup first.
    const v = Bun.spawnSync([join(prefix, "bin", "parachute"), "version"], { env: candidateEnv(info, home) });
    expect(v.stdout.toString().trim()).toBe(NEWER);
    const first = Bun.spawnSync([join(prefix, "bin", "parachute"), "keys", "list"], { env: candidateEnv(info, home), stderr: "pipe" });
    expect(first.exitCode).toBe(0);
    expect(first.stderr.toString()).toContain(`${here} → ${NEWER}`);
    expect(release()).toMatchObject({ version: NEWER, previous: here, state: "current", channel: "beta" });
  }, 240_000);
});
