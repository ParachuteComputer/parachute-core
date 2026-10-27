// v0.8's identity: a new package and command, so nobody's update of the old ones becomes v0.8, and installing v0.8
// never touches the old global install. Aaron's 10-27 requirement (PLAN §8.1 "Install", identity section being
// added; lane D builds the tarball and its install step).
//
// v0.8 ships as npm package @openparachute/core with the global command `parachute-core`. @openparachute/hub
// (`parachute`) and @openparachute/vault (`parachute-vault`) never get a 0.8. The tarball has bin/parachute-core,
// plus bin/parachute and bin/parachute-vault aliases inside the unpacked folder only (for Prism and Benjamin's
// suite), which our installer never links onto a shared PATH. `parachute-core version --json` →
// {name: "@openparachute/core", version, schema, bun}. `bin/parachute-core install --prefix <dir>` puts the
// unpacked tree in <dir>/<version>/ and links <dir>/bin/parachute-core. Neither that, nor unpacking and running
// `bin/parachute-core serve`, changes ~/.bun/install/global, ~/.bun/bin/parachute{,-vault} or the npm global
// prefix, and `parachute` on PATH still resolves to the old hub afterwards.
//
// The machine (_takeover-lib.ts) has the stock 0.7 hub and vault laid out as `bun add -g` does, with BUN_INSTALL
// and NPM_CONFIG_PREFIX pointing into the throwaway HOME. The first run is on a fresh, empty Parachute home: with
// no existing home there is nothing to take over, so serve runs (takeover.test.ts covers an existing home).
//
// Lane A1 (the name and bins) made the first three green on the core build. The install step is lane D's: until
// then `parachute-core install` is still the hub's module installer. On the stock build all four are red (no root
// package.json, programs from lib/hub = @openparachute/hub, no bin/parachute-core). The setup test proves the old
// global install is real.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { red } from "../lib.ts";
import { candidate, freePort, safeFetch, until } from "../candidate-lib.ts";
import { holders, json, must, newMachine, oldInstallHash, oldStock, requireCore, treeHash, type Machine } from "./_takeover-lib.ts";

const NO_INSTALL = /parachute-core install --prefix exited \d+/;

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
  test("the package is @openparachute/core and links only parachute-core, never @openparachute/hub or @openparachute/vault", () => {
    const pkg = candidatePackage();
    must(pkg.name !== "@openparachute/hub" && pkg.name !== "@openparachute/vault", `package name is ${pkg.name}`);
    must(pkg.name === "@openparachute/core", `package name is ${pkg.name}, not @openparachute/core`);
    // What `npm i -g` / `bun add -g` would link onto PATH: only parachute-core, never the old commands.
    expect(Object.keys(pkg.bin)).toEqual(["parachute-core"]);
  });

  test("the candidate has bin/parachute-core, with bin/parachute and bin/parachute-vault as aliases in its folder", async () => {
    const c = candidate();
    requireCore(c);
    // The aliases (for Prism and Benjamin's suite) run core, not the old programs.
    const m = await machine("id-alias", false);
    for (const alias of ["parachute", "parachute-vault"]) {
      const r = await m.run([join(c.dir, "bin", alias), "version", "--json"]);
      expect({ alias, name: json(r, `bin/${alias} version --json`).name }).toEqual({ alias, name: "@openparachute/core" });
    }
  }, 120_000);

  test("`parachute-core version --json` says @openparachute/core, its version, schema and Bun", async () => {
    const m = await machine("id-version", false);
    const r = await m.run([requireCore(m.info), "version", "--json"]);
    expect(r.code).toBe(0);
    const v = json(r, "parachute-core version --json");
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

  red("install and first run leave the old global packages byte-identical, and parachute still resolves to the old hub", { reason: NO_INSTALL, lane: "D" }, async () => {
    const stock = await oldStock();
    const m = await machine("id-install");
    const before = { bun: await oldInstallHash(m), npm: await treeHash(m.npmPrefix) };
    const unchanged = async (step: string) => {
      const now = { bun: await oldInstallHash(m), npm: await treeHash(m.npmPrefix) };
      expect({ step, ...now }).toEqual({ step, ...before });
    };
    const bin = requireCore(m.info);

    // 1. Unpacked and run in place: `bin/parachute-core serve` on a fresh home.
    await firstRun(m, bin, join(m.user, ".parachute"));
    await unchanged("unpack and serve");

    // 2. The install step, then the installed command's first run on another fresh home.
    const prefix = join(m.user, ".local/share/parachute");
    const inst = await m.run([bin, "install", "--prefix", prefix]);
    must(inst.code === 0, `parachute-core install --prefix exited ${inst.code}: ${inst.stderr.slice(-600)}`);
    await unchanged("install");
    const version = json(await m.run([bin, "version", "--json"]), "parachute-core version --json").version;
    expect(existsSync(join(prefix, version, "bin", "parachute-core"))).toBe(true);
    expect(lstatSync(join(prefix, "bin", "parachute-core")).isSymbolicLink()).toBe(true);
    // The aliases stay inside the unpacked folder: the shared bin has only parachute-core.
    expect(readdirSync(join(prefix, "bin"))).toEqual(["parachute-core"]);
    await firstRun(m, join(prefix, "bin", "parachute-core"), join(m.user, ".parachute-installed"));
    await unchanged("installed first run");

    // 3. With the install on PATH, `parachute` is still the old hub and `parachute-core` is core.
    const path = `${join(prefix, "bin")}:${m.env().PATH}`;
    const r = await m.run(["sh", "-c", "command -v parachute; parachute --version; command -v parachute-core; parachute-core version --json"], { env: { PATH: path } });
    const [hub, hubV, coreAt, coreJson] = r.stdout.trim().split("\n");
    expect(hub).toBe(join(m.user, ".bun/bin/parachute"));
    expect(hubV).toBe(stock.hubVersion);
    expect(coreAt).toBe(join(prefix, "bin", "parachute-core"));
    expect(JSON.parse(coreJson!).name).toBe("@openparachute/core");
    await unchanged("after");
  }, 180_000);
});
