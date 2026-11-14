// lifecycle/upgrade: the 0.8 → 0.9 step on a home, and the way back (DESIGN-0.9 §6 "every step up to 1.0 has a
// migration path", §7 "data always migrates automatically, forward, with a backup first"; packages/cli/src/release.ts).
//
// The home is made by the real 0.8 (pins.json previous_core, `bun run build:previous`): a vault, a tag with fields,
// made-up notes and a minted key. Then the candidate:
//   - its first command backs the databases up, outside the home, before it opens them, and only once;
//   - it serves the home: 0.8's key still reads, the tag with fields is a type (the `kind` column added even
//     though 0.8 left the vault current by its own schema stamp), `keys list` names 0.8's key;
//   - `upgrade --rollback` refuses while anything holds the data (exit 7); stopped, it is code-only: 0.9's step
//     moved no schema number, so nothing on disk changes, and 0.8 serves every 0.9 write. 0.9 then picks up what
//     0.8 wrote meanwhile (and backs up again first);
//   - `upgrade --rollback --restore --yes` exports the notes changed since the backup (with their tags and links; a
//     tag-only change counts), then puts the backup back, and 0.8 serves that. A key revoked under 0.9 since the
//     backup stays refused, whether the backup held it or it was minted after; a key never revoked still reads;
//   - a home 0.9 made has no earlier release: no backup, nothing to roll back.
// Before any of that, on the home as 0.8 left it (the release blocker of 2026-11-13: `upgrade --check` wasn't built,
// so 0.9 backed the home up, recorded it as moved, and only then said `unknown service "--check"`):
//   - `upgrade` with an unknown flag or service exits 2 before it touches the home: every byte is as it was;
//   - `upgrade --check` runs the step on a throwaway copy (the backup, the record, every database opened by this
//     release) and reports. The home itself gets no backup, no record and no lock, even while 0.8 serves it.
// Each machine has its own network (the box holds 1940; _takeover-lib.ts). Red on 0.8 (no release record, no
// rollback); green from 0.9's release.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { candidate, freePort, newHome, until } from "../candidate-lib.ts";
import { cli } from "../candidate-lib.ts";
import { must, rest, safeFetch } from "../lib.ts";
import { dbHolders, fileHashes, makeStockHome, newMachine, core as coreOn, type Machine, type Proc } from "./_takeover-lib.ts";

let m: Machine;
const vault = `up${randomBytes(3).toString("hex")}`;
let origin = "";
let base: Record<string, string> = {};
let serveEnv: Record<string, string> = {};
let writer = "";
let nine = "";
const ids: Record<string, string> = {};

const info = candidate();
const prevBin = join(info.previousCoreDir, "bin", "parachute");
const prevVaultBin = join(info.previousCoreDir, "bin", "parachute-vault");
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const vaultDb = () => join(m.home, "vault", "data", vault, "vault.db");
const dbHashes = () => ({ hub: sha(join(m.home, "hub.db")), vault: sha(vaultDb()) });
const release = () => JSON.parse(readFileSync(join(m.home, "run", "release.json"), "utf8"));
const backups = () => {
  const d = join(dirname(m.home), "parachute-upgrade");
  return existsSync(d) ? readdirSync(d).sort() : [];
};
const api = (token: string) => rest(`${origin}/vault/${vault}`, token);

/** `parachute serve` from `bin` on the machine, up once it serves the vault; stop waits until nothing holds the data. */
async function serve(bin: string, what: string): Promise<Proc> {
  const box = m.spawn([bin, "serve"], { env: serveEnv });
  const up = await until(async () => {
    if (box.proc.exitCode !== null) return true;
    const r = await safeFetch(`${origin}/vault/${vault}/mcp`);
    return r.status === 401 && (r.headers.get("www-authenticate") ?? "").includes(`/vault/${vault}/`);
  }, 60_000);
  must(up && box.proc.exitCode === null, `${what} did not come up (exit ${box.proc.exitCode}):\n${box.log().slice(-2000)}`);
  const stop = box.stop;
  box.stop = async (signal, ms) => {
    const code = await stop(signal, ms);
    must(await until(() => dbHolders(m.home).length === 0, 15_000, 100), `${what} left the data held after it stopped`);
    return code;
  };
  return box;
}

const run = (bin: string, args: string[]) => m.run([bin, ...args], { env: base });
const core = (args: string[]) => run(info.bin, args);
const prev = (args: string[]) => run(prevBin, args);

async function mintWith(bin: string, label: string, level: "read" | "write" | "admin") {
  const levels = { read: ["read"], write: ["read", "write"], admin: ["read", "write", "admin"] }[level];
  const r = await run(bin, ["auth", "mint-token", "--scope", levels.map((l) => `vault:${vault}:${l}`).join(" "), "--label", label]);
  const t = r.stdout.trim().split("\n").pop()!.trim();
  must(r.code === 0 && t.split(".").length === 3, `mint ${label} exited ${r.code}: ${r.stderr.slice(-600)}`);
  return t;
}

/** A home the real 0.8 made on its own (no serve): the given vaults and a first account. */
async function homeBy08(label: string, vaults: string[]): Promise<string> {
  const home = newHome(label);
  const run08 = (bin: string, args: string[]) =>
    Bun.spawnSync([bin, ...args], { env: { PATH: `${info.runtimeDir}:/usr/bin:/bin`, HOME: dirname(home), PARACHUTE_HOME: home, EMBEDDINGS_ENABLED: "false" }, cwd: dirname(home) });
  for (const v of vaults) must(run08(prevVaultBin, ["create", v, "--no-mirror", "--json"]).exitCode === 0, `setup: 0.8 create ${v}`);
  must(run08(prevBin, ["auth", "set-password", "--username", "owner", "--password", `pw-${randomBytes(12).toString("hex")}`]).exitCode === 0, "setup: 0.8 set-password");
  return home;
}

async function post(token: string, key: string, content: string, tags: string[] = []) {
  const r = await api(token).post("/notes", { path: `upgrade/${key}-${randomBytes(2).toString("hex")}`, content, tags });
  must(r.status === 201, `writing ${key} gave ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  ids[key] = r.body.id;
}

beforeAll(async () => {
  must(existsSync(prevBin), `no build of the previous release at ${info.previousCoreDir}: run \`bun run build:previous\``);
  m = await newMachine("upgrade", { oldInstall: false });
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  base = { PORT: String(port), PARACHUTE_HUB_ORIGIN: origin };
  serveEnv = { ...base, PARACHUTE_BIND_HOST: "127.0.0.1", PARACHUTE_INITIAL_ADMIN_USERNAME: "owner", PARACHUTE_INITIAL_ADMIN_PASSWORD: `pw-${randomBytes(12).toString("hex")}` };
  // A home as 0.8 leaves it.
  const made = await m.run([prevVaultBin, "create", vault, "--no-mirror", "--json"], { env: { ...base, EMBEDDINGS_ENABLED: "false" } });
  must(made.code === 0, `setup: 0.8 parachute-vault create exited ${made.code}: ${made.stderr.slice(-600)}`);
  await m.expose(port);
  const box = await serve(prevBin, "0.8 serve");
  try {
    const rot = await prev(["auth", "rotate-operator"]);
    must(rot.code === 0, `setup: 0.8 auth rotate-operator exited ${rot.code}: ${rot.stderr.slice(-600)}`);
    writer = await mintWith(prevBin, "old-writer", "write");
    const admin = await mintWith(prevBin, "old-admin", "admin");
    const t = await api(admin).put("/tags/project", { fields: { status: { type: "string" } } });
    must(t.status === 200 || t.status === 201, `setup: a tag with fields gave ${t.status}: ${JSON.stringify(t.body).slice(0, 300)}`);
    await post(writer, "plan", "A made-up plan for the community garden.", ["project"]);
    await post(writer, "label", "Bring the seed catalogue on Saturday.", ["pinned"]);
  } finally {
    await box.stop();
  }
  expect(existsSync(join(m.home, "run", "release.json"))).toBe(false);
  // The vault as 0.8 leaves it once it has served: current by 0.8's own lights (its schema stamp, T-412's path
  // index), so 0.9's first open takes the "already current" path. A 0.8 from before T-412 left no such index and hid
  // the kind bug (audit L2-01).
  const eight = new Database(vaultDb(), { readonly: true });
  const cols = (eight.query("PRAGMA table_info(tags)").all() as { name: string }[]).map((c) => c.name);
  const nocase = eight.query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_notes_path_nocase'").get();
  eight.close();
  must(nocase !== null, "setup: the 0.8 build left no idx_notes_path_nocase; previous_core must be a 0.8 with T-412");
  expect(cols).not.toContain("kind");
}, 240_000);

afterAll(async () => {
  await m?.dispose();
});

/**
 * Every file of the home by hash, what sits beside it, and every file of its upgrade backups by hash: what a command
 * that "touches nothing" must leave equal.
 */
const footprint = (home: string) => ({
  files: existsSync(home) ? Object.fromEntries(fileHashes(home)) : null,
  backups: existsSync(join(dirname(home), "parachute-upgrade")) ? Object.fromEntries(fileHashes(join(dirname(home), "parachute-upgrade"))) : null,
  // (the machine keeps the log of each server the test itself starts there)
  beside: readdirSync(dirname(home)).filter((n) => !/^parachute-serve-\d+\.log$/.test(n)).sort(),
});

describe("lifecycle/upgrade", () => {
  test("upgrade with an unknown flag or service exits 2 before it touches the home: no backup, no record, no lock", async () => {
    const before = footprint(m.home);
    // `--chekc` and `--dry-run` are flags it doesn't have; `nosuch` is no service; the rest pair a real flag with
    // one that doesn't go with it. Each used to be answered only after the home had been backed up and recorded.
    // An empty --tag, and `scribe` (a module the hub knows, not installed here), passed a first parser and were
    // refused by the hub's own after the step (review of #119).
    for (const args of [["--chekc"], ["--dry-run"], ["nosuch"], ["--check", "--bogus"], ["--check", "vault"], ["--check", "--rollback"], ["--rollback", "--bogus"], ["--channel"], ["vault", "--channel", "nightly"], ["--tag", ""], ["vault", "--tag", ""], ["scribe"], [""]]) {
      const r = await core(["upgrade", ...args]);
      expect(`${args.join(" ")}: exit ${r.code}`).toBe(`${args.join(" ")}: exit 2`);
      expect(r.stderr).toContain("usage: parachute upgrade");
      expect(footprint(m.home)).toEqual(before);
    }
    // The vault has no upgrade of its own; asked under its names, the answer is the same, and as early.
    for (const argv of [[info.bin, "vault", "upgrade", "--check"], [info.vaultBin, "upgrade", "--check"], [join(info.dir, "bin", "parachute-core"), "vault", "upgrade", "--chekc"]]) {
      const r = await run(argv[0]!, argv.slice(1));
      expect(`${argv.slice(1).join(" ")}: exit ${r.code}`).toBe(`${argv.slice(1).join(" ")}: exit 2`);
      expect(r.stderr).toContain("parachute upgrade");
      expect(footprint(m.home)).toEqual(before);
    }
    // Asking how it works is not a step either.
    const help = await core(["upgrade", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--check");
    expect(footprint(m.home)).toEqual(before);
  }, 120_000);

  test("upgrade --check runs the step on a throwaway copy and reports; the home gets no backup, no record and no lock", async () => {
    const db08 = new Database(vaultDb(), { readonly: true });
    const count = (sql: string) => (db08.query(sql).get() as { n: number }).n;
    // What 0.8 left: its notes (ours and the guides it seeds) and its tags, one of them with fields.
    const [notes, allTags] = [count("SELECT count(*) AS n FROM notes"), count("SELECT count(*) AS n FROM tags")];
    db08.close();
    const before = footprint(m.home);
    const r = await core(["upgrade", "--check", "--json"]);
    must(r.code === 0, `upgrade --check exited ${r.code}: ${r.stderr.slice(-1200)}`);
    expect(footprint(m.home)).toEqual(before); // every byte of the home, and nothing new beside it (the copy is gone)
    const out = JSON.parse(r.stdout.trim().split("\n").pop()!);
    expect(out).toMatchObject({ check: "ok", from: "0.8", refusals: [], problems: [] });
    expect(out.to).toBe(JSON.parse((await core(["version", "--json"])).stdout).version);
    // What the step did, on the copy: backed both databases up, then opened them with this release.
    expect(out.backup.databases).toBe(2);
    // Every note is there, and the tag with fields is a type on the copy (0.8's vault has no kinds at all).
    expect(out.vaults).toEqual([{ name: vault, opens: true, notes, types: 1, tags: allTags - 1 }]);
    expect(out.hub).toMatchObject({ opens: true });
    expect(out.hub.keys).toBeGreaterThanOrEqual(2); // 0.8's two tokens, adopted as keys on the copy

    // In plain words too, and the same promise: nothing here was changed.
    const plain = await core(["upgrade", "--check"]);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain(`vault ${vault}: opens`);
    expect(plain.stdout).toMatch(/nothing (here )?was changed/i);
    expect(footprint(m.home)).toEqual(before);

    // MIGRATION's first live step: 0.9's check while 0.8 still serves the home. It reports, and 0.8 keeps serving a
    // home with no record and no backup (the server itself writes its databases, so bytes aren't compared here).
    const box = await serve(prevBin, "0.8 serve");
    try {
      const live = await core(["upgrade", "--check", "--json"]);
      must(live.code === 0, `upgrade --check beside a running 0.8 exited ${live.code}: ${live.stderr.slice(-1200)}`);
      expect(JSON.parse(live.stdout.trim().split("\n").pop()!)).toMatchObject({ check: "ok", from: "0.8" });
      expect((await api(writer).get(`/notes/${ids.plan}`)).status).toBe(200);
      // No other 0.9 command takes the step under 0.8's server: the home is not recorded as moved while 0.8 serves
      // it. But the commands that stop or look at that server still run from here (a newer release was just
      // installed, the links name it, and the old server is what runs), and they record nothing either.
      const cmd = await core(["keys", "list"]);
      expect(cmd.code).toBe(7);
      expect(cmd.stderr).toContain("a Parachute server is running");
      expect(existsSync(join(m.home, "run", "release.json"))).toBe(false);
      const status = await core(["status"]);
      expect(status.code).not.toBe(7);
      expect(status.stderr).not.toContain("a Parachute server is running");
      expect(existsSync(join(m.home, "run", "release.json"))).toBe(false);
      expect(backups()).toEqual([]);
      expect((await api(writer).get(`/notes/${ids.plan}`)).status).toBe(200); // and 0.8 still serves
    } finally {
      await box.stop();
    }
    expect(existsSync(join(m.home, "run", "release.json"))).toBe(false);
    expect(existsSync(join(m.home, "run", "release.lock"))).toBe(false);
    expect(backups()).toEqual([]);
    expect(footprint(m.home).beside).toEqual(before.beside);
  }, 240_000);

  test("upgrade --check says what the step would refuse, and exits 1: a database it can't read", async () => {
    const home = await homeBy08("up-check-broken", ["goodv", "brokenv"]);
    const db = join(home, "vault", "data", "brokenv", "vault.db");
    for (const f of [`${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
    writeFileSync(db, "Made-up bytes that are not a database.\n".repeat(200));
    const before = footprint(home);
    const r = await cli(home, ["upgrade", "--check", "--json"]);
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout.trim().split("\n").pop()!);
    expect(out).toMatchObject({ check: "problems" });
    expect(out.problems.join("\n")).toContain("vault/data/brokenv/vault.db");
    expect(out.vaults).toEqual(expect.arrayContaining([expect.objectContaining({ name: "goodv", opens: true })]));
    expect(footprint(home)).toEqual(before);
  }, 120_000);

  test("upgrade names a service only where the hub will find it; a home named by a relative path is checked all the same", async () => {
    const home = await homeBy08("up-services", ["goodv"]);
    // Whether a service is there is the hub's own lookup, asked before the step. Each of these the hub refused only
    // after the home was backed up and recorded (reviews of #119): it resolves a third-party row by its install
    // folder and takes the first row of a name; it drops a retired module's row; it stops on a row it can't
    // validate, and on a file it can't parse, even for `upgrade hub` and the sweep.
    const services = join(home, "services.json");
    const good = JSON.parse(readFileSync(services, "utf8"));
    must(good.services?.length >= 1, "setup: 0.8 registered its vault");
    const row = (name: string, port: number, extra: Record<string, unknown> = {}) => ({ name, port, paths: [`/${name}`], health: `/${name}/health`, version: "1.0.0", ...extra });
    const cases: [string, unknown[] | string, string[][]][] = [
      ["a row without an install folder", [...good.services, row("made-up-module", 47991)], [["made-up-module"]]],
      ["two rows of one name, the first without a folder", [...good.services, row("made-up-module", 47991), row("made-up-module", 47992, { installDir: dirname(home) })], [["made-up-module"]]],
      ["a module the hub knows, with a row and no install", [...good.services, row("parachute-scribe", 47994)], [["scribe"]]],
      ["a retired module's row", [row("parachute-agent", 47993, { installDir: dirname(home) })], [["parachute-agent"]]],
      ["a row the hub can't validate", [...good.services, row("made-up-module", 0)], [["hub"], ["vault"]]],
      ["a file that isn't JSON", "Made-up bytes that are not JSON.\n", [["hub"], ["vault"]]],
    ];
    for (const [what, rows, argvs] of cases) {
      writeFileSync(services, typeof rows === "string" ? rows : JSON.stringify({ ...good, services: rows }, null, 2));
      const before = footprint(home);
      for (const args of argvs) {
        const r = await cli(home, ["upgrade", ...args]);
        expect(`${what}: upgrade ${args.join(" ")}: exit ${r.code}`).toBe(`${what}: upgrade ${args.join(" ")}: exit 2`);
        expect(footprint(home)).toEqual(before); // services.json too: the lookup heals nothing on the way
      }
    }
    writeFileSync(services, JSON.stringify(good, null, 2));
    const before = footprint(home);
    // cli() runs in the home's parent, so the home's own name is a relative path to it.
    const r = await cli(home, ["upgrade", "--check", "--json"], { env: { PARACHUTE_HOME: basename(home) } });
    must(r.code === 0, `upgrade --check with a relative PARACHUTE_HOME exited ${r.code}: ${r.stderr.slice(-800)}`);
    expect(JSON.parse(r.stdout.trim().split("\n").pop()!)).toMatchObject({ check: "ok", home, from: "0.8" });
    expect(footprint(home)).toEqual(before);
  }, 120_000);

  test("upgrade --check opens every vault it copied, whatever its name; leftovers of a killed check are swept, and never recursed into", async () => {
    // `logs` and `mirror` are folder names the copy leaves out elsewhere; as vaults they must be copied and opened.
    const home = await homeBy08("up-check-names", ["logs", "mirror", "plainv"]);
    // What a check killed outright leaves beside the home: its copy, its mark, and the pid of a process now gone.
    const gone = Bun.spawnSync(["true"]).pid;
    const stale = join(dirname(home), ".parachute-upgrade-check-stale1");
    const other = join(dirname(home), ".parachute-upgrade-check-other1"); // no pid it can read: not its to remove
    for (const [dir, pid] of [[stale, `${gone}\n`], [other, "not a pid\n"]] as const) {
      mkdirSync(join(dir, "home"), { recursive: true });
      writeFileSync(join(dir, "home", ".parachute-upgrade-check-copy"), "an earlier check's word\n");
      writeFileSync(join(dir, "pid"), pid);
    }
    // And a home put back from such a leftover carries the old mark: the check must not take its copy for a home.
    writeFileSync(join(home, ".parachute-upgrade-check-copy"), "an earlier check's word\n");
    const before = footprint(home);
    const r = await cli(home, ["upgrade", "--check", "--json"]);
    must(r.code === 0, `upgrade --check exited ${r.code}: ${r.stderr.slice(-1200)}`);
    const out = JSON.parse(r.stdout.trim().split("\n").pop()!);
    expect(out).toMatchObject({ check: "ok", problems: [], refusals: [] });
    expect(out.vaults.map((v: any) => [v.name, v.opens]).sort()).toEqual([["logs", true], ["mirror", true], ["plainv", true]]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(other)).toBe(true);
    rmSync(other, { recursive: true });
    expect({ ...footprint(home), beside: footprint(home).beside.filter((n) => n !== basename(stale)) }).toEqual({ ...before, beside: before.beside.filter((n) => n !== basename(stale) && n !== basename(other)) });
  }, 120_000);

  test("upgrade --check on a home the old 0.7 programs still own says so (exit 1): it is the takeover's, and no step would be taken", async () => {
    const old = await newMachine("up-old-owner");
    try {
      await makeStockHome(old);
      const before = footprint(old.home);
      const r = await coreOn(old, ["upgrade", "--check", "--json"]);
      expect(r.code).toBe(1);
      const out = JSON.parse(r.stdout.trim().split("\n").pop()!);
      expect(out).toMatchObject({ check: "refused", problems: [] });
      expect(out.refusals.join("\n")).toContain("takeover");
      expect(footprint(old.home)).toEqual(before);
    } finally {
      await old.dispose();
    }
  }, 240_000);
  test("0.9's first command on a 0.8 home backs its databases up first, outside the home, and only once", async () => {
    const before = dbHashes();
    const r = await core(["keys", "list", "--json"]);
    must(r.code === 0, `keys list exited ${r.code}: ${r.stderr.slice(-600)}`);
    expect(r.stderr).toContain("0.8 → ");
    const keys = JSON.parse(r.stdout);
    expect(keys.find((k: any) => k.name === "old-writer")).toMatchObject({ status: "active", levels: { [vault]: "write" } });

    const rel = release();
    expect(rel).toMatchObject({ previous: "0.8", state: "current" });
    expect(rel.version).toBe(JSON.parse((await core(["version", "--json"])).stdout).version);
    expect(backups().length).toBe(1);
    expect(rel.backup.startsWith(join(dirname(m.home), "parachute-upgrade") + "/")).toBe(true);
    const manifest = JSON.parse(readFileSync(join(rel.backup, "manifest.json"), "utf8"));
    expect(Object.keys(manifest.files).sort()).toEqual(["hub.db", join("vault", "data", vault, "vault.db")].sort());
    for (const [file, hash] of Object.entries(manifest.files)) expect(sha(join(rel.backup, "home", file))).toBe(hash as string);
    // The copy is the home as 0.8 left it: before 0.9 added its keys table.
    const copy = new Database(join(rel.backup, "home", "hub.db"), { readonly: true });
    expect(copy.query("SELECT 1 FROM sqlite_master WHERE name = 'keys'").get()).toBeNull();
    copy.close();
    expect(before.hub).not.toBe(dbHashes().hub); // 0.9 did open it (its keys table), after the copy

    await core(["keys", "list"]);
    expect(backups().length).toBe(1);

    // The check on a home this release already serves: no step to report, and the real backup is not touched.
    const now = footprint(m.home);
    const again = await core(["upgrade", "--check", "--json"]);
    must(again.code === 0, `upgrade --check on a current home exited ${again.code}: ${again.stderr.slice(-800)}`);
    expect(JSON.parse(again.stdout.trim().split("\n").pop()!)).toMatchObject({ check: "ok", from: "0.8", backup: { databases: 0 } });
    expect(again.stderr).toContain("already");
    expect(footprint(m.home)).toEqual(now);
  }, 120_000);

  test("0.9 serves the 0.8 home: 0.8's key reads, a tag with fields is a type, 0.9 writes; rollback waits for it to stop", async () => {
    const box = await serve(info.bin, "0.9 serve");
    try {
      // 0.9 gave the vault 0.8 made its `kind` column (one additive ALTER, no schema number).
      const db = new Database(vaultDb(), { readonly: true });
      expect((db.query("PRAGMA table_info(tags)").all() as { name: string }[]).map((c) => c.name)).toContain("kind");
      db.close();
      expect((await api(writer).get(`/notes/${ids.plan}`)).body).toMatchObject({ types: ["project"] });
      expect((await api(writer).get(`/notes/${ids.label}`)).body).toMatchObject({ types: [], tags: ["pinned"] });
      const made = await core(["keys", "new", "nine-writer", "--vault", vault, "--can", "write"]);
      must(made.code === 0, `keys new exited ${made.code}: ${made.stderr.slice(-600)}`);
      nine = made.stdout.trim().split("\n").pop()!.trim();
      await post(nine, "nine", "Written under 0.9 with a key made by keys new.", ["project"]);
      const held = await core(["upgrade", "--rollback"]);
      expect(held.code).toBe(7);
    } finally {
      await box.stop();
    }
  }, 180_000);

  test("rollback, code-only: nothing on disk changes, 0.8 serves every 0.9 write, and 0.9 then picks up 0.8's", async () => {
    const before = dbHashes();
    const r = await core(["upgrade", "--rollback", "--json"]);
    must(r.code === 0, `upgrade --rollback exited ${r.code}: ${r.stderr.slice(-600)}`);
    expect(JSON.parse(r.stdout.trim().split("\n").pop()!)).toMatchObject({ rolled_back: true, mode: "code-only", to: "0.8" });
    expect(dbHashes()).toEqual(before);
    expect(release().state).toBe("rolled-back");

    const box = await serve(prevBin, "0.8 serve after the rollback");
    try {
      expect((await api(writer).get(`/notes/${ids.nine}`)).body?.content).toBe("Written under 0.9 with a key made by keys new.");
      expect((await api(nine).get(`/notes/${ids.plan}`)).status).toBe(200); // a 0.9 key is a token 0.8 verifies
      await post(writer, "eight", "Written under 0.8 after the rollback.", ["project", "eight-label"]);
      await mintWith(prevBin, "after-rollback", "read");
    } finally {
      await box.stop();
    }

    // 0.9 leaves the rolled-back home alone (exit 7, nothing changed) until `upgrade` asks for the step again.
    const mark = footprint(m.home);
    const refused = await core(["keys", "list", "--json"]);
    expect(refused.code).toBe(7);
    expect(refused.stderr).toContain("parachute upgrade");
    expect(footprint(m.home)).toEqual(mark);
    const forward = await core(["upgrade", "--json"]);
    must(forward.code === 0, `upgrade exited ${forward.code}: ${forward.stderr.slice(-600)}`);
    expect(JSON.parse(forward.stdout.trim().split("\n").pop()!)).toMatchObject({ upgraded: true, step: true, from: "0.8" });
    const again = await core(["keys", "list", "--json"]);
    must(again.code === 0, `keys list exited ${again.code}: ${again.stderr.slice(-600)}`);
    expect(JSON.parse(again.stdout).map((k: any) => k.name)).toEqual(expect.arrayContaining(["old-writer", "nine-writer", "after-rollback"]));
    expect(backups().length).toBe(2); // forward again, backed up again
    expect(release()).toMatchObject({ previous: "0.8", state: "current" });

    // 0.9 again reads what 0.8 wrote meanwhile: a type stays a type, a label 0.8 made is a tag.
    const back = await serve(info.bin, "0.9 serve after 0.8's writes");
    try {
      expect((await api(writer).get(`/notes/${ids.eight}`)).body).toMatchObject({ types: ["project"], tags: expect.arrayContaining(["eight-label"]) });
      const listed = await api(writer).get(`/notes?tag=project`);
      expect(listed.status).toBe(200);
    } finally {
      await back.stop();
    }
  }, 300_000);

  test("rollback --restore: notes changed since the backup are exported, the backup's databases go back, and 0.8 serves them", async () => {
    // Since the second backup, under 0.9: a note with a tag and a link; a note whose only change is a tag; a key that
    // existed at the backup is revoked; a key is minted and revoked. None of those revocations may be undone.
    let late = "";
    let madeSince = "";
    const box = await serve(info.bin, "0.9 serve");
    try {
      await post(writer, "late", "Written under 0.9 after the second backup.", ["late-tag"]);
      const linked = await api(writer).patch(`/notes/${ids.late}`, { links: { add: [{ target: ids.plan, relationship: "follows" }] }, force: true });
      must(linked.status === 200, `linking the late note gave ${linked.status}: ${JSON.stringify(linked.body).slice(0, 300)}`);
      const tagged = await api(writer).patch(`/notes/${ids.eight}`, { tags: { add: ["tagged-late"] }, force: true });
      must(tagged.status === 200, `tagging the 0.8 note gave ${tagged.status}: ${JSON.stringify(tagged.body).slice(0, 300)}`);
      must((await core(["keys", "revoke", "nine-writer"])).code === 0, "keys revoke nine-writer");
      const made = await core(["keys", "new", "late-key", "--vault", vault, "--can", "read"]);
      must(made.code === 0, `keys new late-key exited ${made.code}: ${made.stderr.slice(-600)}`);
      late = made.stdout.trim().split("\n").pop()!.trim();
      expect((await api(late).get(`/notes/${ids.plan}`)).status).toBe(200); // a real, working key
      must((await core(["keys", "revoke", "late-key"])).code === 0, "keys revoke late-key");
      // And a key minted since the backup and never revoked: the restored hub won't know it, so it must not go on
      // working where nobody could list or revoke it.
      const kept = await core(["keys", "new", "made-since", "--vault", vault, "--can", "read"]);
      must(kept.code === 0, `keys new made-since exited ${kept.code}: ${kept.stderr.slice(-600)}`);
      madeSince = kept.stdout.trim().split("\n").pop()!.trim();
      expect((await api(madeSince).get(`/notes/${ids.plan}`)).status).toBe(200);
    } finally {
      await box.stop();
    }
    expect((await core(["upgrade", "--rollback", "--restore"])).code).toBe(2); // no --yes, nobody to ask
    const r = await core(["upgrade", "--rollback", "--restore", "--yes", "--json"]);
    must(r.code === 0, `upgrade --rollback --restore exited ${r.code}: ${r.stderr.slice(-600)}`);
    const out = JSON.parse(r.stdout.trim().split("\n").pop()!);
    expect(out).toMatchObject({ rolled_back: true, mode: "restore" });
    expect(out.exported_notes).toBeGreaterThanOrEqual(1);
    expect(out.revocations_kept).toBeGreaterThanOrEqual(2);
    const exported = readdirSync(out.exported_to).map((f) => readFileSync(join(out.exported_to, f), "utf8")).join("\n");
    expect(exported).toContain("Written under 0.9 after the second backup.");
    // The export holds tags and links too, and a note whose only change is a tag counts as changed.
    const changed = readdirSync(out.exported_to).flatMap((f) => JSON.parse(readFileSync(join(out.exported_to, f), "utf8")).changed as any[]);
    const lateRow = changed.find((n) => n.id === ids.late);
    expect(lateRow?.tags).toContain("late-tag");
    expect(lateRow?.links).toEqual(expect.arrayContaining([expect.objectContaining({ target_id: ids.plan, relationship: "follows" })]));
    expect(changed.find((n) => n.id === ids.eight)?.tags).toContain("tagged-late");

    const back = await serve(prevBin, "0.8 serve on the restored home");
    try {
      expect((await api(writer).get(`/notes/${ids.late}`)).status).toBe(404);
      expect((await api(writer).get(`/notes/${ids.eight}`)).status).toBe(200); // a key never revoked still works
      // A key revoked since the backup stays revoked, whether it was in the backup or minted after it.
      expect((await api(nine).get(`/notes/${ids.plan}`)).status).toBe(401);
      expect((await api(late).get(`/notes/${ids.plan}`)).status).toBe(401);
      expect((await api(madeSince).get(`/notes/${ids.plan}`)).status).toBe(401); // made since the backup: gone
    } finally {
      await back.stop();
    }
    expect((await core(["upgrade", "--rollback"])).code).toBe(1); // nothing left to roll back
  }, 240_000);

  test("a database that can't be read: named, left out of the backup, no crash; the command goes on and fails its own way", async () => {
    // A vault that can't open must stop serve with its own exit (lifecycle/shutdown "vault start failure"); the
    // upgrade step must not crash first and hide that.
    const home = newHome("up-unreadable");
    must((await cli(home, ["create", "brokenv", "--no-mirror", "--json"], { vault: true, env: { EMBEDDINGS_ENABLED: "false" } })).code === 0, "setup: vault create");
    const db = join(home, "vault", "data", "brokenv", "vault.db");
    for (const f of [`${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
    writeFileSync(db, "Made-up bytes that are not a database.\n".repeat(200));
    const r = await cli(home, ["user", "list"]);
    expect(r.stderr).toContain("can't read vault/data/brokenv/vault.db; it is not in any upgrade backup");
    expect(r.stderr).not.toMatch(/SQLiteError|^\s+at /m);
    expect(existsSync(join(home, "run", "release.json"))).toBe(false);
    expect(existsSync(join(dirname(home), "parachute-upgrade"))).toBe(false);
  }, 120_000);

  test("two 0.9 commands opening a 0.8 home at once take one backup between them", async () => {
    const home = await homeBy08("up-race", ["goodv"]);
    const both = await Promise.all([cli(home, ["user", "list"]), cli(home, ["user", "list"])]);
    expect(both.map((b) => b.code)).toEqual([0, 0]);
    const dirs = readdirSync(join(dirname(home), "parachute-upgrade"));
    expect(dirs.length).toBe(1);
    expect(JSON.parse(readFileSync(join(home, "run", "release.json"), "utf8")).backup).toBe(join(dirname(home), "parachute-upgrade", dirs[0]!));
    // The one backup is the home as 0.8 left it: before 0.9 added its keys table.
    const copy = new Database(join(dirname(home), "parachute-upgrade", dirs[0]!, "home", "hub.db"), { readonly: true });
    expect(copy.query("SELECT 1 FROM sqlite_master WHERE name = 'keys'").get()).toBeNull();
    copy.close();
  }, 120_000);

  test("a vault the backup skipped, repaired later, is backed up before 0.9 first opens it", async () => {
    // A home 0.8 made, with two vaults; one can't be read when 0.9 first opens the home.
    const home = await homeBy08("up-recovered", ["goodv", "laterv"]);
    const db = join(home, "vault", "data", "laterv", "vault.db");
    const healthy = readFileSync(db);
    for (const f of [`${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
    writeFileSync(db, "Made-up bytes that are not a database.\n".repeat(200));

    const first = await cli(home, ["user", "list"]);
    expect(first.stderr).toContain("can't read vault/data/laterv/vault.db");
    const rel = JSON.parse(readFileSync(join(home, "run", "release.json"), "utf8"));
    expect(rel.skipped).toEqual(["vault/data/laterv/vault.db"]);
    const manifest = () => JSON.parse(readFileSync(join(rel.backup, "manifest.json"), "utf8"));
    expect(Object.keys(manifest().files).sort()).toEqual(["hub.db", "vault/data/goodv/vault.db"]);

    writeFileSync(db, healthy); // repaired: the 0.8 bytes are back
    // The check on this home must not do the catching up: the record names the real backup folder, and the step on
    // the copy used to write the repaired vault into it (review of #119), saying "nothing here was changed".
    const before = footprint(home);
    const checked = await cli(home, ["upgrade", "--check", "--json"]);
    must(checked.code === 0, `upgrade --check on a home with a skipped database exited ${checked.code}: ${checked.stderr.slice(-800)}`);
    expect(JSON.parse(checked.stdout.trim().split("\n").pop()!).backup.skipped).toEqual(["vault/data/laterv/vault.db"]);
    expect(footprint(home)).toEqual(before);
    const second = await cli(home, ["user", "list"]);
    expect(second.stderr).toContain("vault/data/laterv/vault.db can be read now; backed it up first");
    expect(Object.keys(manifest().files).sort()).toEqual(["hub.db", "vault/data/goodv/vault.db", "vault/data/laterv/vault.db"]);
    expect(manifest().skipped).toBeUndefined();
    // The copy is the vault as 0.8 left it: 0.9 hadn't opened it (no `kind` on its tags).
    const copy = new Database(join(rel.backup, "home", "vault", "data", "laterv", "vault.db"), { readonly: true });
    expect((copy.query("PRAGMA table_info(tags)").all() as { name: string }[]).some((c) => c.name === "kind")).toBe(false);
    copy.close();
    expect(JSON.parse(readFileSync(join(home, "run", "release.json"), "utf8")).skipped).toBeUndefined();
  }, 120_000);

  test("a home 0.9 made has no earlier release: no backup, nothing to roll back", async () => {
    const home = newHome("up-fresh");
    must((await cli(home, ["user", "password", "--username", "owner", "--password", `pw-${randomBytes(12).toString("hex")}`])).code === 0, "setup: user password");
    must((await cli(home, ["create", "fresh", "--no-mirror", "--json"], { vault: true, env: { EMBEDDINGS_ENABLED: "false" } })).code === 0, "setup: vault create");
    const r = await cli(home, ["keys", "list"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("backing up");
    expect(existsSync(join(dirname(home), "parachute-upgrade"))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "run", "release.json"), "utf8"))).toMatchObject({ previous: null, backup: null });
    expect((await cli(home, ["upgrade", "--rollback"])).code).toBe(1);
  }, 120_000);
});
