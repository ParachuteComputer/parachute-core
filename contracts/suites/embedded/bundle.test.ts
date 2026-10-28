// embedded/bundle (PLAN §3 "The bundle", "Signing", "Nothing outside the home"; §2.5; §7.3 macos-14): the tree the
// tarball holds is what Prism ships, so it is tested as shipped.
//   - the layout: bin/parachute-core and its two aliases, runtime/bun, lib/, entitlements/bun.plist, LICENSE,
//     THIRD-PARTY-NOTICES.txt, SOURCE.md, VERSION;
//   - it runs on its own pinned Bun (release/bun.json), with no Bun on PATH, the hub and its vault child both;
//   - the tarball unpacks to exactly the tree under test, and SHA256SUMS names its hash;
//   - lib/ has no local embedding stack (no onnxruntime, no sharp), no dev tools, and native code only for this
//     platform;
//   - every package in lib/ is in the notices, and SOURCE.md names the commit it was built from;
//   - copied to a path with a space and run with no Bun on PATH: create a vault, serve, sign in with a password
//     (argon2 from the payload), the admin page, a write and a read;
//   - on macOS: every Mach-O file is signed ad hoc with the hardened runtime, runtime/bun with allow-jit only.
// Lane D. The tarball is CANDIDATE_TARBALL, or <candidate>/../dist/<name>.tar.gz where `bun run build:core` packs it.
// The run on macOS (CI's bundle-macos job) has no network namespace; it is a throwaway runner and run-candidate
// starts no box there (--no-box), so the vault's fixed port is free.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { candidateEnv, treeHash } from "../../harness/candidate.ts";
import { allowOrigins, candidate, freePort, newHome, safeFetch, until } from "../candidate-lib.ts";
import { must } from "../lib.ts";
import { newMachine } from "../lifecycle/_takeover-lib.ts";

const REPO = resolve(import.meta.dir, "..", "..", "..");
const pin = JSON.parse(readFileSync(join(REPO, "release", "bun.json"), "utf8")) as { version: string };
const platform = `${process.platform}-${process.arch}`;
const NO_BUN_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";

const dir = () => candidate().dir;
const rootPkg = () => JSON.parse(readFileSync(join(dir(), "package.json"), "utf8")) as { name: string; version: string };
const bundleName = () => `parachute-core-${rootPkg().version}-${platform}`;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(argv: string[], env: Record<string, string>, cwd?: string): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(argv, { env, cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() };
}

/** Installed package folders under every node_modules in lib/ (not workspace links), as path → name@version. */
function installedPackages(lib: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (nm: string) => {
    if (!existsSync(nm)) return;
    for (const n of readdirSync(nm)) {
      if (n.startsWith(".")) continue;
      const at = join(nm, n);
      for (const p of n.startsWith("@") ? readdirSync(at).map((s) => join(at, s)) : [at]) {
        if (lstatSync(p).isSymbolicLink() || !existsSync(join(p, "package.json"))) continue;
        const j = JSON.parse(readFileSync(join(p, "package.json"), "utf8"));
        out.set(relative(lib, p), `${j.name}@${j.version}`);
        walk(join(p, "node_modules"));
      }
    }
  };
  const find = (d: string) => {
    for (const n of readdirSync(d)) {
      const at = join(d, n);
      if (n === "node_modules") walk(at);
      else if (!n.startsWith(".") && lstatSync(at).isDirectory() && !at.includes("/node_modules/")) find(at);
    }
  };
  find(lib);
  return out;
}

function files(root: string, keep: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const at = join(d, n);
      const st = lstatSync(at);
      if (st.isDirectory()) walk(at);
      else if (st.isFile() && keep(relative(root, at))) out.push(relative(root, at));
    }
  };
  walk(root);
  return out.sort();
}

function head(path: string, n: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const b = Buffer.alloc(n);
    const got = readSync(fd, b, 0, n, 0);
    return b.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/** What a native file is built for, from its header: "linux-x64", "darwin-arm64", …, or why it can't tell. */
function nativeTarget(path: string): string {
  const b = head(path, 20);
  if (b.length >= 20 && b.readUInt32BE(0) === 0x7f454c46) {
    const machine = b[5] === 2 ? b.readUInt16BE(18) : b.readUInt16LE(18);
    return `linux-${({ 0x3e: "x64", 0xb7: "arm64" } as Record<number, string>)[machine] ?? `machine 0x${machine.toString(16)}`}`;
  }
  if (b.length >= 8 && b.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = b.readUInt32LE(4);
    return `darwin-${({ 0x0100000c: "arm64", 0x01000007: "x64" } as Record<number, string>)[cpu] ?? `cpu 0x${cpu.toString(16)}`}`;
  }
  if (b.length >= 4 && b.readUInt32BE(0) === 0xcafebabe) return "darwin-universal";
  return `unknown (${b.subarray(0, 4).toString("hex")})`;
}

/** An executable, dylib or bundle Mach-O (what codesign signs), thin or fat; not a .o or a Java class file. */
function isMachO(path: string): boolean {
  const b = head(path, 16);
  if (b.length < 16) return false;
  if (b.readUInt32BE(0) === 0xcafebabe) return b.readUInt32BE(4) > 0 && b.readUInt32BE(4) < 20;
  return b.readUInt32LE(0) === 0xfeedfacf && [0x2, 0x6, 0x8].includes(b.readUInt32LE(12));
}

// ── where a run happens: its own network on Linux (the suite's box holds the vault's fixed port), else here ───────

interface Place {
  user: string;
  home: string;
  run(argv: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }>;
  spawn(argv: string[], env: Record<string, string>): { proc: ReturnType<typeof Bun.spawn>; log(): string; stop(): Promise<number | null> };
  expose(port: number): Promise<string>;
  dispose(): Promise<void>;
}

let places: Place[] = [];
afterEach(async () => {
  for (const p of places) await p.dispose();
  places = [];
});

async function place(label: string): Promise<Place> {
  let p: Place;
  if (process.platform === "linux") {
    const m = await newMachine(label, { oldInstall: false });
    p = {
      user: m.user,
      home: m.home,
      run: (argv, env) => m.run(argv, { env }),
      spawn: (argv, env) => m.spawn(argv, { env }),
      expose: (port) => m.expose(port),
      dispose: () => m.dispose(),
    };
  } else {
    const info = candidate();
    const home = newHome(label);
    const user = dirname(home);
    const procs: ReturnType<Place["spawn"]>[] = [];
    const env = (extra: Record<string, string>) => candidateEnv(info, home, { EMBEDDINGS_ENABLED: "false", ...extra });
    p = {
      user,
      home,
      async run(argv, extra) {
        const r = Bun.spawn(argv, { env: env(extra), cwd: user, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, code] = await Promise.all([new Response(r.stdout).text(), new Response(r.stderr).text(), r.exited]);
        return { code, stdout, stderr };
      },
      spawn(argv, extra) {
        const logPath = join(user, `serve-${Date.now()}.log`);
        const proc = Bun.spawn(argv, { env: env(extra), cwd: user, stdout: Bun.file(logPath), stderr: Bun.file(logPath) });
        const h = {
          proc,
          log: () => (existsSync(logPath) ? readFileSync(logPath, "utf8").replace(/pvk_[A-Za-z0-9_-]+/g, "pvk_<redacted>") : ""),
          async stop() {
            if (proc.exitCode !== null || proc.signalCode !== null) return proc.exitCode;
            proc.kill("SIGTERM");
            const done = await Promise.race([proc.exited.then(() => true), Bun.sleep(15_000).then(() => false)]);
            if (!done) proc.kill("SIGKILL");
            await proc.exited;
            return proc.exitCode;
          },
        };
        procs.push(h);
        return h;
      },
      async expose(port) {
        const origin = `http://127.0.0.1:${port}`;
        allowOrigins(origin);
        return origin;
      },
      async dispose() {
        for (const h of procs.reverse()) await h.stop();
        rmSync(user, { recursive: true, force: true });
      },
    };
  }
  places.push(p);
  return p;
}

/** Command lines of the processes whose executable is `exe` (Linux: /proc in this PID namespace; macOS: ps and
 *  lsof, asked only about processes whose command line mentions `mentioning`). */
function processesOf(exe: string, mentioning: string): string[] {
  const want = realpathSync(exe);
  if (process.platform === "linux") {
    const out: string[] = [];
    for (const pid of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
      try {
        if (realpathSync(`/proc/${pid}/exe`) === want) out.push(readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim());
      } catch {}
    }
    return out;
  }
  // macOS: ps gives the command line (argv[0] is just "bun", run by name); lsof's first `txt` file is the executable.
  const out: string[] = [];
  for (const line of Bun.spawnSync(["ps", "-axww", "-o", "pid=,args="], { stdout: "pipe" }).stdout.toString().split("\n")) {
    const m = line.trim().match(/^(\d+) (.+)$/);
    if (!m || !m[2]!.includes(mentioning)) continue;
    const txt = Bun.spawnSync(["lsof", "-a", "-p", m[1]!, "-d", "txt", "-Fn"], { stdout: "pipe", stderr: "ignore" }).stdout.toString();
    const exe = txt.split("\n").find((l) => l.startsWith("n"))?.slice(1);
    let real = exe;
    try {
      if (exe) real = realpathSync(exe);
    } catch {}
    if (real === want) out.push(m[2]!);
  }
  return out;
}

const cookie = (r: Response, name: string) => r.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);

async function signIn(origin: string, username: string, password: string): Promise<string | undefined> {
  const page = await safeFetch(`${origin}/login`, { redirect: "manual" });
  const html = await page.text();
  const csrf = cookie(page, "parachute_hub_csrf");
  const field = html.match(/name="__csrf"\s+value="([^"]+)"/)?.[1] ?? csrf ?? "";
  const r = await safeFetch(`${origin}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `parachute_hub_csrf=${csrf}` },
    body: new URLSearchParams({ __csrf: field, username, password }),
  });
  return cookie(r, "parachute_hub_session");
}

describe("embedded/bundle", () => {
  test("the tree is the tarball's layout: bin/parachute-core and its aliases, runtime/bun, lib/, entitlements, licence, notices, source, version", () => {
    const d = dir();
    const want = [
      "bin/parachute-core",
      "bin/parachute",
      "bin/parachute-vault",
      "runtime/bun",
      "lib/package.json",
      "lib/bun.lock",
      "lib/packages/cli/src/parachute-core.ts",
      "entitlements/bun.plist",
      "package.json",
      "LICENSE",
      "THIRD-PARTY-NOTICES.txt",
      "SOURCE.md",
      "VERSION",
    ];
    const missing = want.filter((f) => !existsSync(join(d, f)));
    must(missing.length === 0, `the tree lacks ${missing.join(", ")}`);
    for (const f of ["bin/parachute-core", "bin/parachute", "bin/parachute-vault", "runtime/bun"]) {
      must((lstatSync(realpathSync(join(d, f))).mode & 0o111) !== 0, `${f} is not executable`);
    }
    expect(rootPkg().name).toBe("@openparachute/core");
    const plist = readFileSync(join(d, "entitlements/bun.plist"), "utf8");
    expect([...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])).toEqual(["com.apple.security.cs.allow-jit"]);
    expect(readFileSync(join(d, "LICENSE"), "utf8")).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(readFileSync(join(d, "VERSION"), "utf8").split("\n")[0]).toBe(`parachute-core ${rootPkg().version}`);
  });

  test("it runs on its own pinned Bun: with no Bun on PATH, version --json names the Bun in release/bun.json", () => {
    const d = dir();
    must(existsSync(join(d, "runtime/bun")), "no runtime/bun in the tree");
    const env = { PATH: NO_BUN_PATH, HOME: mkdtempSync(join(candidate().scratch, "nobun-")), LANG: "C.UTF-8" };
    const which = run(["sh", "-c", "command -v bun || true"], env);
    must(which.out.trim() === "", `setup: there is a bun on ${NO_BUN_PATH}: ${which.out.trim()}`);
    expect(run([join(d, "runtime/bun"), "--version"], env).out.trim()).toBe(pin.version);
    for (const name of ["parachute-core", "parachute", "parachute-vault"]) {
      const r = run([join(d, "bin", name), "version", "--json"], env);
      must(r.code === 0, `bin/${name} version --json with no Bun on PATH exited ${r.code}: ${r.err.slice(-400)}`);
      expect({ name, bun: JSON.parse(r.out).bun }).toEqual({ name, bun: pin.version });
    }
  });

  test("the tarball unpacks to exactly this tree, and SHA256SUMS names its hash", async () => {
    const info = candidate();
    const tarball = process.env.CANDIDATE_TARBALL ?? join(dirname(info.dir), "dist", `${bundleName()}.tar.gz`);
    must(existsSync(tarball), `no tarball at ${tarball} (bun run build:core packs one; CI passes CANDIDATE_TARBALL)`);
    expect(basename(tarball)).toBe(`${bundleName()}.tar.gz`);
    const sums = join(dirname(tarball), "SHA256SUMS");
    must(existsSync(sums), `no SHA256SUMS next to ${tarball}`);
    const line = readFileSync(sums, "utf8").split("\n").find((l) => l.endsWith(`  ${basename(tarball)}`));
    must(line, `SHA256SUMS has no line for ${basename(tarball)}`);
    expect(line!.split("  ")[0]).toBe(sha256(tarball));
    const out = mkdtempSync(join(info.scratch, "unpack-"));
    const x = run(["tar", "-xzf", tarball, "-C", out], { PATH: NO_BUN_PATH });
    must(x.code === 0, `tar -xzf failed: ${x.err}`);
    expect(readdirSync(out)).toEqual([bundleName()]);
    expect(await treeHash(join(out, bundleName()))).toBe(info.sha256);
    rmSync(out, { recursive: true, force: true });
  }, 120_000);

  test("lib/ has no local embedding stack, no dev tools, and native code only for this platform", () => {
    const lib = join(dir(), "lib");
    const names = new Set([...installedPackages(lib).values()].map((p) => p.slice(0, p.lastIndexOf("@"))));
    const unwanted = ["onnxruntime-node", "onnxruntime-web", "onnxruntime-common", "sharp", "@huggingface/transformers", "typescript", "@biomejs/biome", "bun-types"];
    must(unwanted.every((n) => !names.has(n)), `lib/ ships ${unwanted.filter((n) => names.has(n)).join(", ")}`);
    expect(names.has("@node-rs/argon2")).toBe(true);
    const natives = files(lib, (f) => f.endsWith(".node"));
    expect(natives.length).toBeGreaterThan(0);
    const wrong = natives.map((f) => ({ f, t: nativeTarget(join(lib, f)) })).filter((n) => n.t !== platform);
    must(wrong.length === 0, `native code for another platform: ${wrong.map((w) => `${w.f} (${w.t})`).join(", ")}`);
    // The admin pages are built into the tree, where hub and vault look for them.
    for (const p of ["packages/hub/web/ui/dist/index.html", "packages/vault/web/ui/dist/index.html"]) must(existsSync(join(lib, p)), `lib/${p} is missing`);
  });

  test("THIRD-PARTY-NOTICES.txt names every package in lib/ with its licence, and SOURCE.md names the commit", () => {
    const d = dir();
    must(existsSync(join(d, "THIRD-PARTY-NOTICES.txt")), "no THIRD-PARTY-NOTICES.txt");
    const notices = readFileSync(join(d, "THIRD-PARTY-NOTICES.txt"), "utf8");
    const listed = new Set([...notices.matchAll(/^(\S+@\S+)  \(/gm)].map((m) => m[1]));
    const pkgs = [...new Set(installedPackages(join(d, "lib")).values())];
    expect(pkgs.length).toBeGreaterThan(50);
    const unlisted = pkgs.filter((p) => !listed.has(p));
    must(unlisted.length === 0, `not in the notices: ${unlisted.slice(0, 10).join(", ")}`);
    expect(notices).toContain(`bun@${pin.version}`);
    expect(notices).toContain("JavaScriptCore");
    const manifest = JSON.parse(readFileSync(join(d, "CANDIDATE.json"), "utf8"));
    const source = readFileSync(join(d, "SOURCE.md"), "utf8");
    const commit = source.match(/at commit `([0-9a-f]{40})`/)?.[1];
    must(commit, "SOURCE.md names no full commit");
    expect(commit!.startsWith(manifest.core_commit)).toBe(true);
    expect(source).toContain(`https://github.com/ParachuteComputer/parachute-core/tree/${commit}`);
  });

  test("from a path with a space and no Bun on PATH: create a vault, serve, sign in (argon2), the admin page, a write and a read, then install", async () => {
    const p = await place("bundle-run");
    const copy = join(p.user, "with space", "parachute core");
    mkdirSync(dirname(copy), { recursive: true });
    cpSync(dir(), copy, { recursive: true, dereference: false, verbatimSymlinks: true });
    const bin = join(copy, "bin", "parachute-core");
    const vaultName = `bnd${randomBytes(3).toString("hex")}`;
    const port = await freePort();
    const origin = await p.expose(port);
    const admin = { username: "owner", password: `pw-${randomBytes(12).toString("hex")}` };
    const env = { PATH: NO_BUN_PATH, PORT: String(port), PARACHUTE_HUB_ORIGIN: origin, PARACHUTE_BIND_HOST: "127.0.0.1" };

    const create = await p.run([bin, "vault", "create", vaultName, "--no-mirror", "--json"], env);
    must(create.code === 0, `vault create from "${copy}" exited ${create.code}: ${create.stderr.slice(-600)}`);
    const box = p.spawn([bin, "serve"], { ...env, PARACHUTE_INITIAL_ADMIN_USERNAME: admin.username, PARACHUTE_INITIAL_ADMIN_PASSWORD: admin.password });
    const up = await until(async () => box.proc.exitCode !== null || (await safeFetch(`${origin}/vault/${vaultName}/mcp`)).status === 401, 60_000);
    must(up && box.proc.exitCode === null, `serve from "${copy}" did not come up (exit ${box.proc.exitCode}):\n${box.log().slice(-1500)}`);

    // Both the hub and the vault child it started run on the copy's own runtime/bun.
    const ours = processesOf(join(copy, "runtime", "bun"), copy);
    expect({
      hub: ours.some((l) => l.includes(`${copy}/lib/`) && l.includes("/src/parachute-core.ts serve")),
      vault: ours.some((l) => l.includes(`${copy}/lib/`) && l.includes("/src/parachute-vault.ts serve")),
    }).toEqual({ hub: true, vault: true });

    // A password sign-in hashes and verifies with argon2, the one native addon, loaded from the payload.
    expect(await signIn(origin, admin.username, `${admin.password}-wrong`)).toBeUndefined();
    expect(await signIn(origin, admin.username, admin.password)).toBeString();

    const page = await safeFetch(`${origin}/admin/`);
    expect({ status: page.status, type: page.headers.get("content-type")?.split(";")[0] }).toEqual({ status: 200, type: "text/html" });
    expect(await page.text()).toContain("/admin/assets/");

    const rot = await p.run([bin, "auth", "rotate-operator"], env);
    must(rot.code === 0, `auth rotate-operator exited ${rot.code}: ${rot.stderr.slice(-400)}`);
    const mint = await p.run([bin, "auth", "mint-token", "--scope", `vault:${vaultName}:write`], env);
    const token = mint.stdout.trim().split("\n").pop()!.trim();
    must(mint.code === 0 && token.split(".").length === 3, `mint-token exited ${mint.code}: ${mint.stderr.slice(-400)}`);
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const w = await safeFetch(`${origin}/vault/${vaultName}/api/notes`, { method: "POST", headers: auth, body: JSON.stringify({ content: "made-up bundle note", path: "bundle/one" }) });
    expect(w.status).toBe(201);
    const r = await safeFetch(`${origin}/vault/${vaultName}/api/notes?limit=50&include_content=true`, { headers: auth });
    expect(r.status).toBe(200);
    expect(JSON.stringify(await r.json())).toContain("made-up bundle note");
    expect(await box.stop()).toBe(0);

    // And it installs from there (the prefix lock is an OS lock on each platform), then runs as installed.
    const prefix = join(p.user, "installed here");
    const inst = await p.run([bin, "install", "--prefix", prefix], env);
    must(inst.code === 0, `install from "${copy}" exited ${inst.code}: ${inst.stderr.slice(-400)}`);
    const v = await p.run([join(prefix, "bin", "parachute-core"), "version", "--json"], env);
    expect({ code: v.code, bun: v.code === 0 ? JSON.parse(v.stdout).bun : v.stderr.slice(-300) }).toEqual({ code: 0, bun: pin.version });
  }, 180_000);

  test("a bundle whose unusable runtime/bun refuses to start, rather than run a Bun found on PATH", async () => {
    const scratch = mkdtempSync(join(candidate().scratch, "noruntime-"));
    const copy = join(scratch, "bundle");
    cpSync(dir(), copy, { recursive: true, dereference: false, verbatimSymlinks: true });
    chmodSync(join(copy, "runtime", "bun"), 0o644);
    // A stand-in Bun on PATH that leaves a mark if it is ever run.
    const fake = join(scratch, "fakebin");
    const mark = join(scratch, "fake-bun-ran");
    mkdirSync(fake);
    writeFileSync(join(fake, "bun"), `#!/bin/sh\ntouch '${mark}'\necho '{"name":"@openparachute/core","bun":"fake"}'\n`, { mode: 0o755 });
    const env = { PATH: `${fake}:${NO_BUN_PATH}`, HOME: scratch, LANG: "C.UTF-8" };
    for (const name of ["parachute-core", "parachute", "parachute-vault"]) {
      const r = run([join(copy, "bin", name), "version", "--json"], env);
      expect({ name, refused: r.code !== 0, ranPathBun: existsSync(mark), says: /runtime\/bun/.test(r.err) }).toEqual({ name, refused: true, ranPathBun: false, says: true });
    }
    rmSync(scratch, { recursive: true, force: true });
  }, 120_000);

  test.skipIf(process.platform !== "darwin")("macOS: every Mach-O is signed ad hoc with the hardened runtime; only runtime/bun has entitlements, allow-jit", () => {
    const d = dir();
    const machO = files(d, (f) => isMachO(join(d, f)));
    expect(machO).toContain("runtime/bun");
    const problems: string[] = [];
    for (const f of machO) {
      const path = join(d, f);
      const v = run(["codesign", "--verify", "--strict", path], { PATH: NO_BUN_PATH });
      if (v.code !== 0) problems.push(`${f}: does not verify: ${v.err.trim()}`);
      const info = run(["codesign", "-dvvv", path], { PATH: NO_BUN_PATH }).err;
      if (!/Signature=adhoc/.test(info)) problems.push(`${f}: not signed ad hoc`);
      if (!/flags=0x[0-9a-f]*\(.*runtime.*\)/.test(info)) problems.push(`${f}: no hardened runtime`);
      const ent = run(["codesign", "-d", "--entitlements", "-", "--xml", path], { PATH: NO_BUN_PATH }).out;
      const keys = [...ent.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
      const want = f === "runtime/bun" ? ["com.apple.security.cs.allow-jit"] : [];
      if (JSON.stringify(keys) !== JSON.stringify(want)) problems.push(`${f}: entitlements ${JSON.stringify(keys)}, want ${JSON.stringify(want)}`);
    }
    must(problems.length === 0, problems.join("; "));
  }, 120_000);
});
