// lifecycle/upgrade, through the service unit: the way back is real only if the unit goes back with it.
//
// A machine laid out as the versioned installer leaves one (install.ts): <prefix>/.store/<version>-<id>/, a link
// <prefix>/<version>, and <prefix>/bin/parachute{,-core} → ../<version>/bin/…; a unit whose ExecStart is
// <prefix>/bin/parachute-core serve. The real 0.8 (pins.json previous_core) is installed and serves through the
// unit; then the candidate is installed beside it by its own `install --prefix`. (systemd is the outside system:
// the machine's systemctl is the contracts' stand-in, which runs each unit's ExecStart for real.)
//   - the unit's next start runs 0.9, which backs up first and records the exact version it came from;
//   - `upgrade --rollback` marks the home and points the links back at 0.8's copy: after a restart the unit runs
//     0.8, and 0.8 serves every record 0.9 wrote;
//   - 0.9 then leaves the home alone (exit 7, nothing opened or changed): a command, and the server a unit still
//     pointing at 0.9 would start. Before this, such a unit moved the home forward again at its next restart;
//   - `upgrade`, run with 0.9, is the way forward again: refused while 0.8 serves, then the backup, the record, the
//     links, and the unit runs 0.9 with what 0.8 wrote meanwhile.
// Red on next afe6ce72: the rollback left the links on 0.9 (`out.links` undefined), so the restarted unit ran 0.9.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { candidate, freePort, until } from "../candidate-lib.ts";
import { must, rest, safeFetch } from "../lib.ts";
import { dbHolders, fileHashes, newMachine, serving, type Machine } from "./_takeover-lib.ts";

const UNIT = "parachute-core.service";
let m: Machine;
const vault = `un${randomBytes(3).toString("hex")}`;
let origin = "";
let base: Record<string, string> = {};
let prefix = "";
let v08 = "";
let v09 = "";
let writer = "";
let nine = "";
const ids: Record<string, string> = {};
const wrote: Record<string, string> = {};

const info = candidate();
const prevBin = join(info.previousCoreDir, "bin", "parachute");
const prevVaultBin = join(info.previousCoreDir, "bin", "parachute-vault");
const versionOf = (dir: string) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version as string;
const release = () => JSON.parse(readFileSync(join(m.home, "run", "release.json"), "utf8"));
const backups = () => {
  const d = join(dirname(m.home), "parachute-upgrade");
  return existsSync(d) ? readdirSync(d).sort() : [];
};
const api = (token: string) => rest(`${origin}/vault/${vault}`, token);
const link = () => readlinkSync(join(prefix, "bin", "parachute-core"));
/** The command of a given installed version, whatever <prefix>/bin points at. */
const binOf = (version: string, name = "parachute") => join(prefix, version, "bin", name);
/** What a person types: <prefix>/bin/parachute, the release the links name. */
const linked = (args: string[]) => m.run([join(prefix, "bin", "parachute"), ...args], { env: base });

/** Start the unit and wait until it serves the vault; `version()` is the release its process runs from. */
async function unitUp(what: string) {
  const started = await m.run(["systemctl", "--user", "start", UNIT]);
  must(started.code === 0, `${what}: systemctl start exited ${started.code}: ${started.stderr.slice(-400)}`);
  const s = await serving(m, { vaultName: vault, origin }, UNIT);
  return {
    ...s,
    /** The store copy the unit's process runs from: `<version>-<id>`, read from its command line. */
    runs() {
      const cmds = dbHolders(m.home).map((h) => h.cmd).join("\n");
      return /\/\.store\/([^/\s]+)\//.exec(cmds)?.[1] ?? `nothing from the store (${cmds.slice(0, 200)})`;
    },
  };
}

async function post(token: string, key: string, content: string, tags: string[] = []) {
  const r = await api(token).post("/notes", { path: `unit/${key}-${randomBytes(2).toString("hex")}`, content, tags });
  must(r.status === 201, `writing ${key} gave ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  ids[key] = r.body.id;
  wrote[key] = content;
}

beforeAll(async () => {
  must(existsSync(prevBin), `no build of the previous release at ${info.previousCoreDir}: run \`bun run build:previous\``);
  [v08, v09] = [versionOf(info.previousCoreDir), versionOf(info.dir)];
  m = await newMachine("upgrade-unit", { oldInstall: false });
  prefix = join(m.user, ".local", "share", "parachute");
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  base = { PORT: String(port), PARACHUTE_HUB_ORIGIN: origin };
  // 0.8, installed by its own installer, and the unit that runs whatever <prefix>/bin names.
  const installed = await m.run([prevBin, "install", "--prefix", prefix], { env: base });
  must(installed.code === 0 && link() === `../${v08}/bin/parachute-core`, `setup: 0.8's install exited ${installed.code}: ${installed.stderr.slice(-600)}`);
  const env = { ...base, PARACHUTE_HOME: m.home, PARACHUTE_BIND_HOST: "127.0.0.1", PARACHUTE_INITIAL_ADMIN_USERNAME: "owner", PARACHUTE_INITIAL_ADMIN_PASSWORD: `pw-${randomBytes(12).toString("hex")}` };
  writeFileSync(
    join(m.unitDir, UNIT),
    `[Unit]\nDescription=Parachute (a made-up unit for the contracts)\n\n[Service]\nExecStart=${join(prefix, "bin", "parachute-core")} serve\n${Object.entries(env).map(([k, v]) => `Environment=${k}=${v}\n`).join("")}Restart=on-failure\n\n[Install]\nWantedBy=default.target\n`,
  );
  const made = await m.run([prevVaultBin, "create", vault, "--no-mirror", "--json"], { env: { ...base, EMBEDDINGS_ENABLED: "false" } });
  must(made.code === 0, `setup: 0.8 parachute-vault create exited ${made.code}: ${made.stderr.slice(-600)}`);
  await m.expose(port);
  const unit = await unitUp("0.8 through the unit");
  try {
    must(unit.runs().startsWith(`${v08}-`), `setup: the unit runs ${unit.runs()}, not ${v08}`);
    must((await linked(["auth", "rotate-operator"])).code === 0, "setup: 0.8 auth rotate-operator");
    const minted = await linked(["auth", "mint-token", "--scope", `vault:${vault}:read vault:${vault}:write`, "--label", "old-writer"]);
    writer = minted.stdout.trim().split("\n").pop()!.trim();
    must(minted.code === 0 && writer.split(".").length === 3, `setup: mint exited ${minted.code}: ${minted.stderr.slice(-600)}`);
    await post(writer, "plan", "A made-up plan for the community garden.", ["project"]);
  } finally {
    await unit.stop();
  }
}, 240_000);

afterAll(async () => {
  await m?.run(["systemctl", "--user", "stop", UNIT]);
  await m?.dispose();
});

describe("lifecycle/upgrade through the service unit", () => {
  test("0.9 installed beside 0.8 while 0.8 serves: `parachute restart` is the unit's, and its next start runs 0.9, backs up first, and records the exact version before", async () => {
    // As it goes on a live box: 0.8 serves through the unit while 0.9 is installed beside it.
    const old = await unitUp("0.8 through the unit");
    expect(old.runs().startsWith(`${v08}-`)).toBe(true);
    const r = await m.run([join(info.dir, "bin", "parachute"), "install", "--prefix", prefix], { env: base });
    must(r.code === 0, `0.9's install exited ${r.code}: ${r.stderr.slice(-600)}`);
    expect(link()).toBe(`../${v09}/bin/parachute-core`);
    expect(existsSync(binOf(v08))).toBe(true); // the copy to go back to is kept
    // `parachute` is 0.9 now, and 0.8 still serves. No step is taken under it, and an old name refused there is not
    // counted in the home either.
    expect((await linked(["auth", "list-users"])).code).toBe(7);
    expect(existsSync(join(m.home, "run"))).toBe(false);
    expect(backups()).toEqual([]);
    // The service is core's own unit, so `restart` is that unit's (the hub's restart knows only a hub unit, and on
    // such a box said none was installed): through the service manager, opening nothing itself.
    const calls = m.systemctlCalls().length;
    const restarted = await linked(["restart"]);
    must(restarted.code === 0, `parachute restart exited ${restarted.code}: ${restarted.stderr.slice(-600)} ${restarted.stdout.slice(-300)}`);
    expect(m.systemctlCalls().slice(calls).join("\n")).toContain(`restart ${UNIT}`);
    const unit = { ...(await serving(m, { vaultName: vault, origin }, UNIT)), runs: old.runs };
    try {
      expect(unit.runs().startsWith(`${v09}-`)).toBe(true);
      expect(release()).toMatchObject({ version: v09, previous: v08, state: "current" }); // not just "0.8"
      expect(backups().length).toBe(1);
      expect(backups()[0]!.startsWith(`${v08}-to-${v09}-`)).toBe(true);
      const made = await linked(["keys", "new", "nine-writer", "--vault", vault, "--can", "write"]);
      must(made.code === 0, `keys new exited ${made.code}: ${made.stderr.slice(-600)}`);
      nine = made.stdout.trim().split("\n").pop()!.trim();
      await post(nine, "nine", "Written under 0.9 with a key made by keys new.", ["project"]);
      await post(writer, "nine2", "A second record written under 0.9, by 0.8's key.", ["pinned"]);
      const edited = await api(nine).patch(`/notes/${ids.plan}`, { content: "The garden plan, edited under 0.9.", force: true });
      must(edited.status === 200, `editing under 0.9 gave ${edited.status}: ${JSON.stringify(edited.body).slice(0, 300)}`);
      wrote.plan = "The garden plan, edited under 0.9.";
    } finally {
      await unit.stop();
    }
  }, 240_000);

  test("upgrade --rollback points the unit's links back: after a restart the unit runs 0.8 and serves every record 0.9 wrote", async () => {
    const r = await linked(["upgrade", "--rollback", "--json"]);
    must(r.code === 0, `upgrade --rollback exited ${r.code}: ${r.stderr.slice(-600)}`);
    const out = JSON.parse(r.stdout.trim().split("\n").pop()!);
    expect(out).toMatchObject({ rolled_back: true, mode: "code-only", from: v09, to: v08, links: { moved: true, to: v08 } });
    expect(link()).toBe(`../${v08}/bin/parachute-core`);
    expect(readlinkSync(join(prefix, "bin", "parachute"))).toBe(`../${v08}/bin/parachute`);
    expect(release()).toMatchObject({ version: v09, previous: v08, state: "rolled-back" });

    // The restart: nothing about the unit changed, only what its ExecStart resolves to.
    const unit = await unitUp("0.8 through the unit, after the rollback");
    try {
      expect(unit.runs().startsWith(`${v08}-`)).toBe(true);
      expect((await linked(["version"])).stdout.trim()).toBe(v08);
      for (const key of Object.keys(ids)) {
        const got = await api(writer).get(`/notes/${ids[key]}`);
        expect({ key, status: got.status, content: got.body?.content }).toEqual({ key, status: 200, content: wrote[key] });
      }
      expect((await api(nine).get(`/notes/${ids.plan}`)).status).toBe(200); // a key 0.9 made is a token 0.8 verifies
      await post(writer, "eight", "Written under 0.8 after the rollback.", ["project"]);

      // 0.9 leaves a rolled-back home alone, also while 0.8 serves it: its commands, and `upgrade` itself until
      // the server is stopped.
      const cmd = await m.run([binOf(v09), "keys", "list"], { env: base });
      expect(cmd.code).toBe(7);
      expect(cmd.stderr).toContain(`rolled back to ${v08}`);
      const early = await m.run([binOf(v09), "upgrade"], { env: base });
      expect(early.code).toBe(7);
      expect(early.stderr).toContain("a Parachute server is running");
      expect(release().state).toBe("rolled-back");
    } finally {
      await unit.stop();
    }
  }, 240_000);

  test("0.9 refuses the rolled-back home (a command, and the server a unit still on 0.9 would start) and changes nothing", async () => {
    const before = { files: Object.fromEntries(fileHashes(m.home)), backups: backups() };
    // Every way in: ordinary commands, the vault's own name, the settings file, an old name (its use is counted in
    // the home), and the host's two commands, which check a home their own way.
    const ways: string[][] = [["keys", "list"], ["status"], ["doctor"], ["config", "set", "server.port", "1"], ["auth", "list-users"], ["vault", "list"], ["bootstrap", "--embedded", "--home", m.home, "--json"], ["serve", "--embedded", "--home", m.home]];
    for (const args of ways) {
      const r = await m.run([binOf(v09), ...args], { env: base });
      expect(`${args.join(" ")}: exit ${r.code}`).toBe(`${args.join(" ")}: exit 7`);
      expect(r.stderr).toContain("parachute upgrade");
    }
    // What a unit left pointing at 0.9 (or 0.9 started by hand) runs: it must stop, not serve and move forward.
    const box = m.spawn([binOf(v09, "parachute-core"), "serve"], { env: { ...base, PARACHUTE_BIND_HOST: "127.0.0.1" } });
    const stopped = await until(() => box.proc.exitCode !== null, 30_000, 100);
    if (!stopped) await box.stop("SIGKILL", 2000);
    must(stopped, `0.9's serve kept running on a rolled-back home:\n${box.log().slice(-1200)}`);
    expect(box.proc.exitCode).toBe(7);
    expect(box.log()).toContain(`rolled back to ${v08}`);
    // Nothing serves: no answer at all, or none from a server.
    expect(await safeFetch(`${origin}/health`).then((r) => r.status, () => 0)).not.toBe(200);
    expect({ files: Object.fromEntries(fileHashes(m.home)), backups: backups() }).toEqual(before);
  }, 120_000);

  test("upgrade, run with 0.9, is the way forward again: a new backup, the record, the links, and the unit runs 0.9", async () => {
    const r = await m.run([binOf(v09), "upgrade", "--json"], { env: base });
    must(r.code === 0, `upgrade exited ${r.code}: ${r.stderr.slice(-800)}`);
    const out = JSON.parse(r.stdout.trim().split("\n").pop()!);
    expect(out).toMatchObject({ upgraded: true, step: true, from: v08, to: v09, links: { moved: true, to: v09 } });
    expect(link()).toBe(`../${v09}/bin/parachute-core`);
    expect(release()).toMatchObject({ version: v09, previous: v08, state: "current" });
    expect(backups().length).toBe(2);
    expect(out.backup).toBe(join(dirname(m.home), "parachute-upgrade", backups()[1]!));

    const unit = await unitUp("0.9 through the unit, forward again");
    try {
      expect(unit.runs().startsWith(`${v09}-`)).toBe(true);
      for (const key of Object.keys(ids)) {
        const got = await api(writer).get(`/notes/${ids[key]}`);
        expect({ key, status: got.status, content: got.body?.content }).toEqual({ key, status: 200, content: wrote[key] });
      }
    } finally {
      await unit.stop();
    }
  }, 240_000);
});
