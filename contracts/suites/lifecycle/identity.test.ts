// v0.8's identity: a new package, so nobody's update of the old ones becomes v0.8, and installing v0.8 never touches
// the old global install. Aaron's 10-27 requirement (PLAN §2.5, §8.1 "Install"; lane D built the tarball and its
// install step). Its command is `parachute` (Aaron, 10-27: "`parachute` is the go-to name for this new parachute
// system"; lane R), with `parachute-core` kept as an alias.
//
// v0.8 ships as npm package @openparachute/core with the commands `parachute` and `parachute-core`.
// @openparachute/hub (`parachute`) and @openparachute/vault (`parachute-vault`) never get a 0.8. The tarball has
// bin/parachute, bin/parachute-core and bin/parachute-vault; `parachute-vault` stays inside the unpacked folder (for
// Prism and Benjamin's suite) and our installer never links it onto a shared PATH. `parachute version --json` →
// {name: "@openparachute/core", version, schema, bun}. `bin/parachute install --prefix <dir>` puts the unpacked
// tree in <dir>/<version>/ and links <dir>/bin/parachute and <dir>/bin/parachute-core. Neither that, nor unpacking
// and running `bin/parachute serve`, changes ~/.bun/install/global, ~/.bun/bin/parachute{,-vault} or the npm global
// prefix. Where the old hub's `parachute` comes first on PATH, it still resolves to the old hub afterwards, and the
// install says so and names `parachute-core`; with the install's bin first, `parachute` is v0.8.
//
// The machine (_takeover-lib.ts) has the stock 0.7 hub and vault laid out as `bun add -g` does, with BUN_INSTALL
// and NPM_CONFIG_PREFIX pointing into the throwaway HOME. The first run is on a fresh, empty Parachute home: with
// no existing home there is nothing to take over, so serve runs (takeover.test.ts covers an existing home).
//
// Lane A1 (the name and bins) made the first three green on the core build; lane D's install step (packages/cli
// src/install.ts) the fourth; lane R moved the command to `parachute`. On the stock build all four fail (no root
// package.json, programs from lib/hub = @openparachute/hub, no bin/parachute-core). The setup test proves the old
// global install is real.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { candidate, freePort, safeFetch, until } from "../candidate-lib.ts";
import { holders, json, must, newMachine, oldInstallHash, oldStock, requireCore, treeHash, type Machine } from "./_takeover-lib.ts";

let machines: Machine[] = [];
afterEach(async () => {
  for (const m of machines) await m.dispose();
  machines = [];
});

async function machine(label: string, oldInstall = true): Promise<Machine> {
  const m = await newMachine(label, { oldInstall });
  machines.push(m);
  return m;
}

/** The candidate's package name and bins, from the package.json at its root (what npm and bun publish and link). */
function candidatePackage(): { name: string; version: string; bin: Record<string, string> } {
  const dir = candidate().dir;
  const root = join(dir, "package.json");
  if (!existsSync(root)) {
    // No root package: say which packages its programs come from (the stock build runs lib/hub and lib/vault).
    const libs = existsSync(join(dir, "lib")) ? readdirSync(join(dir, "lib")).sort().filter((d) => existsSync(join(dir, "lib", d, "package.json"))) : [];
    const names = libs.map((d) => JSON.parse(readFileSync(join(dir, "lib", d, "package.json"), "utf8")).name as string);
    throw new Error(`package name is ${names.join(" + ") || "unknown"} (no package.json at the candidate root; its programs come from ${libs.map((d) => `lib/${d}`).join(", ")})`);
  }
  const pkg = JSON.parse(readFileSync(root, "utf8"));
  const bin = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {});
  return { name: pkg.name, version: pkg.version, bin };
}

/** Start `<bin> serve` on a fresh home on the machine, wait for it to answer, stop it. The first run. */
async function firstRun(m: Machine, bin: string, home: string): Promise<void> {
  const port = await freePort();
  const origin = await m.expose(port);
  const box = m.spawn([bin, "serve"], {
    env: { PARACHUTE_HOME: home, PORT: String(port), PARACHUTE_HUB_ORIGIN: origin, PARACHUTE_BIND_HOST: "127.0.0.1" },
  });
  try {
    const up = await until(async () => box.proc.exitCode !== null || (await safeFetch(`${origin}/health`)).ok, 60_000);
    must(up && box.proc.exitCode === null, `first run of ${bin} serve did not come up (exit ${box.proc.exitCode}):\n${box.log().slice(-1500)}`);
  } finally {
    await box.stop();
  }
}

describe("identity: setup", () => {
  test("setup works: the old global install is laid out as bun -g does, and parachute on PATH is the old hub", async () => {
    const stock = await oldStock();
    const m = await machine("id-setup");
    const r = await m.run(["sh", "-c", "command -v parachute; command -v parachute-vault; parachute --version; parachute-vault --version"]);
    expect(r.code).toBe(0);
    const [hub, vault, hubV, vaultV] = r.stdout.trim().split("\n");
    expect([hub, vault]).toEqual([join(m.user, ".bun/bin/parachute"), join(m.user, ".bun/bin/parachute-vault")]);
    expect(hubV).toBe(stock.hubVersion);
    expect(vaultV).toContain(stock.vaultVersion);
    // The links are bun's: relative, into install/global/node_modules/@openparachute.
    expect(lstatSync(hub!).isSymbolicLink()).toBe(true);
    const global = join(m.user, ".bun/install/global");
    expect(JSON.parse(readFileSync(join(global, "node_modules/@openparachute/hub/package.json"), "utf8")).name).toBe("@openparachute/hub");
    expect(JSON.parse(readFileSync(join(global, "node_modules/@openparachute/vault/package.json"), "utf8")).name).toBe("@openparachute/vault");
    // Running the old programs leaves their install as it was, so a changed hash means someone else changed it.
    const a = await oldInstallHash(m);
    await m.run(["parachute", "--help"]);
    expect(await oldInstallHash(m)).toBe(a);
  }, 120_000);
});

describe("identity", () => {
  test("the package is @openparachute/core and links parachute and parachute-core, never parachute-vault", () => {
    const pkg = candidatePackage();
    must(pkg.name !== "@openparachute/hub" && pkg.name !== "@openparachute/vault", `package name is ${pkg.name}`);
    must(pkg.name === "@openparachute/core", `package name is ${pkg.name}, not @openparachute/core`);
    // What `npm i -g` / `bun add -g` would link onto PATH: the command and its alias, never the old vault's name.
    expect(Object.keys(pkg.bin).sort()).toEqual(["parachute", "parachute-core"]);
  });

  test("the candidate has bin/parachute, with bin/parachute-core and bin/parachute-vault in its folder", async () => {
    const c = candidate();
    requireCore(c);
    // Every name runs core, not the old programs.
    const m = await machine("id-alias", false);
    for (const alias of ["parachute", "parachute-core", "parachute-vault"]) {
      const r = await m.run([join(c.dir, "bin", alias), "version", "--json"]);
      expect({ alias, name: json(r, `bin/${alias} version --json`).name }).toEqual({ alias, name: "@openparachute/core" });
    }
  }, 120_000);

  test("`parachute version --json` says @openparachute/core, its version, schema and Bun", async () => {
    const m = await machine("id-version", false);
    requireCore(m.info);
    const r = await m.run([join(m.info.dir, "bin", "parachute"), "version", "--json"]);
    expect(r.code).toBe(0);
    const v = json(r, "parachute version --json");
    expect(v.name).toBe("@openparachute/core");
    expect(v.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(v.schema).toBeDefined();
    expect(typeof v.bun).toBe("string");
    const root = join(m.info.dir, "package.json");
    if (existsSync(root)) expect(v.version).toBe(JSON.parse(readFileSync(root, "utf8")).version);
  }, 120_000);

  // PLAN §2.1: in the child process model the hub starts its vault from its own install, never from PATH, so on a
  // box like uni (old parachute-vault 0.7.9 in ~/.bun/bin) it can't start the old vault on the same data.
  test("with the old parachute-vault first on PATH, the vault `parachute-core serve` starts is core's own", async () => {
    const m = await machine("id-child");
    const which = await m.run(["sh", "-c", "command -v parachute-vault"]);
    must(which.stdout.trim() === join(m.user, ".bun/bin/parachute-vault"), `setup: parachute-vault on PATH is ${which.stdout.trim()}`);
    const bin = requireCore(m.info);
    const vaultName = `own${randomBytes(3).toString("hex")}`;
    const port = await freePort();
    const origin = await m.expose(port);
    const env = { PORT: String(port), PARACHUTE_HUB_ORIGIN: origin, PARACHUTE_BIND_HOST: "127.0.0.1" };
    const create = await m.run([bin, "vault", "create", vaultName, "--no-mirror", "--json"], { env });
    must(create.code === 0, `parachute-core vault create exited ${create.code}: ${create.stderr.slice(-600)}`);
    const box = m.spawn([bin, "serve"], { env });
    try {
      const db = join(m.home, "vault", "data", vaultName, "vault.db");
      const up = await until(async () => box.proc.exitCode !== null || holders(db).length > 0, 60_000);
      must(up && box.proc.exitCode === null, `parachute-core serve did not start a vault on ${vaultName} (exit ${box.proc.exitCode}):\n${box.log().slice(-1500)}`);
      const held = holders(db);
      must(held.length === 1, `expected one process holding vault.db, got ${JSON.stringify(held)}`);
      // The vault runs as `bun <script> serve`; the script must be inside the candidate.
      const script = held[0]!.cmd.split(" ").slice(1).find((a) => !a.startsWith("-")) ?? "";
      const real = realpathSync(resolve(m.user, script));
      const dir = realpathSync(m.info.dir);
      must(real.startsWith(dir + "/"), `the hub started the vault from ${real}, not from core (${held[0]!.cmd})`);
    } finally {
      await box.stop();
    }
  }, 120_000);

  test("install and first run leave the old global packages byte-identical, and parachute still resolves to the old hub", async () => {
    const stock = await oldStock();
    const m = await machine("id-install");
    const before = { bun: await oldInstallHash(m), npm: await treeHash(m.npmPrefix) };
    const unchanged = async (step: string) => {
      const now = { bun: await oldInstallHash(m), npm: await treeHash(m.npmPrefix) };
      expect({ step, ...now }).toEqual({ step, ...before });
    };
    requireCore(m.info);
    const bin = join(m.info.dir, "bin", "parachute");

    // 1. Unpacked and run in place: `bin/parachute serve` on a fresh home.
    await firstRun(m, bin, join(m.user, ".parachute"));
    await unchanged("unpack and serve");

    // 2. The install step, then the installed command's first run on another fresh home.
    const prefix = join(m.user, ".local/share/parachute");
    const inst = await m.run([bin, "install", "--prefix", prefix]);
    must(inst.code === 0, `parachute install --prefix exited ${inst.code}: ${inst.stderr.slice(-600)}`);
    await unchanged("install");
    // The old hub's `parachute` comes first on this machine's PATH: the install says so and names the alias.
    must(
      inst.stdout.includes(`\`parachute\` on your PATH is an older Parachute (0.7's hub, @openparachute/hub): ${join(m.user, ".bun/bin/parachute")}`) &&
        inst.stdout.includes("run this version as `parachute-core`"),
      `the install did not name the older parachute first on PATH:\n${inst.stdout}`,
    );
    const version = json(await m.run([bin, "version", "--json"]), "parachute version --json").version;
    expect(existsSync(join(prefix, version, "bin", "parachute"))).toBe(true);
    // The command and its alias are linked; parachute-vault stays inside the unpacked folder.
    expect(readdirSync(join(prefix, "bin")).sort()).toEqual(["parachute", "parachute-core"]);
    for (const name of ["parachute", "parachute-core"]) expect(lstatSync(join(prefix, "bin", name)).isSymbolicLink()).toBe(true);
    await firstRun(m, join(prefix, "bin", "parachute"), join(m.user, ".parachute-installed"));
    await unchanged("installed first run");

    // Again, from the bundle (a second complete copy; <version> switches to it and the first is kept, since a running
    // serve may use it), then from the installed copy itself (nothing copied). The installed command keeps working.
    for (const [from, copies] of [[bin, 2], [join(prefix, "bin", "parachute"), 2]] as const) {
      const again = await m.run([from, "install", "--prefix", prefix]);
      must(again.code === 0, `parachute install again (from ${from}) exited ${again.code}: ${again.stderr.slice(-600)}`);
      expect(json(await m.run([join(prefix, "bin", "parachute"), "version", "--json"]), "installed version --json").version).toBe(version);
      expect({ from, copies: readdirSync(join(prefix, ".store")).filter((n) => !n.startsWith(".")).length }).toEqual({ from, copies });
    }
    await unchanged("installed again");

    // 3. With the install on PATH after the old one, `parachute` is still the old hub and `parachute-core` is core.
    //    With it first, `parachute` is core, and the old hub is still there by its own path.
    const ask = "command -v parachute; parachute --version; command -v parachute-core; parachute-core version --json; parachute version --json";
    const after = await m.run(["sh", "-c", ask], { env: { PATH: `${m.env().PATH}:${join(prefix, "bin")}` } });
    const [hub, hubV, coreAt, coreJson] = after.stdout.trim().split("\n");
    expect(hub).toBe(join(m.user, ".bun/bin/parachute"));
    expect(hubV).toBe(stock.hubVersion);
    expect(coreAt).toBe(join(prefix, "bin", "parachute-core"));
    expect(JSON.parse(coreJson!).name).toBe("@openparachute/core");
    const first = await m.run(["sh", "-c", ask], { env: { PATH: `${join(prefix, "bin")}:${m.env().PATH}` } });
    const [ours, , , , oursJson] = first.stdout.trim().split("\n");
    expect(ours).toBe(join(prefix, "bin", "parachute"));
    expect(JSON.parse(oursJson!).name).toBe("@openparachute/core");
    expect((await m.run([join(m.user, ".bun/bin/parachute"), "--version"])).stdout.trim()).toBe(stock.hubVersion);
    await unchanged("after");
  }, 180_000);

  test("install never replaces another program's `parachute`: a prefix holding the old one, a link shaped like ours, a bin or store linked elsewhere, is refused", async () => {
    const m = await machine("id-foreign");
    const before = { bun: await oldInstallHash(m), npm: await treeHash(m.npmPrefix), listing: readdirSync(join(m.user, ".bun")).sort() };
    const bin = join(requireCore(m.info), "..", "parachute");
    // --prefix ~/.bun: its bin/ is the old global bin, with the old hub's `parachute` in it.
    const into = await m.run([bin, "install", "--prefix", join(m.user, ".bun")]);
    expect({ code: into.code, says: /not this installer's/.test(into.stderr) }).toEqual({ code: 2, says: true });
    // A prefix whose bin/ is a link to the old global bin.
    const prefix = join(m.user, "linked-prefix");
    mkdirSync(prefix);
    symlinkSync(join(m.user, ".bun", "bin"), join(prefix, "bin"));
    const linked = await m.run([bin, "install", "--prefix", prefix]);
    expect({ code: linked.code, says: /link to another folder/.test(linked.stderr), left: readdirSync(prefix) }).toEqual({ code: 2, says: true, left: ["bin"] });
    // Another program's link of the shape this installer makes (../<version>/bin/parachute), into its own folder.
    const shaped = join(m.user, "shaped-prefix");
    mkdirSync(join(shaped, "0.7.0", "bin"), { recursive: true });
    writeFileSync(join(shaped, "0.7.0", "bin", "parachute"), "#!/bin/sh\necho another program\n", { mode: 0o755 });
    mkdirSync(join(shaped, "bin"));
    symlinkSync("../0.7.0/bin/parachute", join(shaped, "bin", "parachute"));
    const look = await m.run([bin, "install", "--prefix", shaped]);
    expect({ code: look.code, says: /not this installer's/.test(look.stderr), link: readlinkSync(join(shaped, "bin", "parachute")), left: readdirSync(shaped).sort() }).toEqual({ code: 2, says: true, link: "../0.7.0/bin/parachute", left: ["0.7.0", "bin"] });
    // A prefix whose .store is a link to a folder elsewhere (holding something shaped like a half-done copy).
    const elsewhere = join(m.user, "elsewhere");
    mkdirSync(join(elsewhere, "0.1.0-deadbeef.tmp"), { recursive: true });
    writeFileSync(join(elsewhere, "keep.txt"), "made-up file\n");
    const stored = join(m.user, "stored-prefix");
    mkdirSync(stored);
    symlinkSync(elsewhere, join(stored, ".store"));
    const st = await m.run([bin, "install", "--prefix", stored]);
    expect({ code: st.code, says: /link to another folder/.test(st.stderr), elsewhere: readdirSync(elsewhere).sort() }).toEqual({ code: 2, says: true, elsewhere: ["0.1.0-deadbeef.tmp", "keep.txt"] });
    expect({ bun: await oldInstallHash(m), npm: await treeHash(m.npmPrefix), listing: readdirSync(join(m.user, ".bun")).sort() }).toEqual(before);
    const r = await m.run([join(m.user, ".bun/bin/parachute"), "--version"]);
    expect(r.stdout.trim()).toBe((await oldStock()).hubVersion);
  }, 120_000);

  test("install: one at a time per prefix (a held lock refuses a second install; two at once leave one complete copy)", async () => {
    const m = await machine("id-lock", false);
    const bin = requireCore(m.info);
    const prefix = join(m.user, ".local/share/parachute");
    mkdirSync(join(prefix, ".store"), { recursive: true });
    // Another install, as the OS sees it: a process holding the prefix's lock (flock(1), the same lock install takes).
    const holder = m.spawn(["flock", "-o", join(prefix, ".store", ".lock"), "sleep", "600"]);
    must(await until(async () => (await m.run(["flock", "-n", join(prefix, ".store", ".lock"), "true"])).code !== 0, 10_000), "setup: the holder never took the lock");
    const busy = await m.run([bin, "install", "--prefix", prefix]);
    expect({ code: busy.code, says: /another install/.test(busy.stderr), copies: readdirSync(join(prefix, ".store")).filter((n) => !n.startsWith(".")) }).toEqual({ code: 1, says: true, copies: [] });
    // The holder gone (killed: the kernel drops its lock), installs go ahead. Two at once: each either completes or
    // says another install is running, and what is left is complete copies only, with the command working.
    await holder.stop("SIGKILL");
    const both = await Promise.all([1, 2].map(() => m.run([bin, "install", "--prefix", prefix])));
    for (const r of both) must(r.code === 0 || (r.code === 1 && /another install/.test(r.stderr)), `a concurrent install exited ${r.code}: ${r.stderr.slice(-400)}`);
    must(both.some((r) => r.code === 0), "neither concurrent install completed");
    const store = readdirSync(join(prefix, ".store")).filter((n) => !n.startsWith("."));
    expect(store.filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(store.length).toBe(both.filter((r) => r.code === 0).length);
    expect(json(await m.run([join(prefix, "bin", "parachute"), "version", "--json"]), "installed version --json").name).toBe("@openparachute/core");
  }, 180_000);
});
