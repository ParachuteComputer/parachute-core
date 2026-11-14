// First-run takeover on a Mac, where the old hub runs as a launchd agent (computer.parachute.hub) and a Cloudflare
// tunnel runs as another (computer.parachute.cloudflared.<tunnel>), as Prism's hosts and its move plan have it.
//
// `parachute-core takeover` must do for launchd what it does for systemd: find the old hub's agent by evidence (its
// process has this home's data open), leave every other agent alone (the tunnel, whatever it is called), say in a
// dry run what it would do, unload the old agent and move its plist out of ~/Library/LaunchAgents (so it doesn't
// start again at login), run v0.8 as a launchd agent of its own (computer.parachute.core, with the old agent's
// environment), and on --rollback put back every plist and load what was loaded.
//
// There is no Mac in CI. launchd is an outside system, so `launchctl` is a fake (_takeover-lib.ts withLaunchd) that
// runs each agent's ProgramArguments for real from its plist, as the fake systemctl runs units; no Parachute code is
// faked. The machine is the same as takeover.test.ts's (the stock 0.7 programs from `bun add -g`, a stock home,
// a network of its own), with no systemd units.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freePort, until } from "../candidate-lib.ts";
import { rest, safeFetch } from "../lib.ts";
import { agentPlist, core, json, makeStockHome, must, newMachine, readNotes, requireCore, withLaunchd, type Launchd, type Machine, type StockHome } from "./_takeover-lib.ts";

const HUB = "computer.parachute.hub";
// A tunnel named so that a rule reading "hub" or "vault" in a label would take it for the old programs.
const TUNNEL = "computer.parachute.cloudflared.vault-tunnel";
const CORE = "computer.parachute.core";

let machines: Machine[] = [];
afterEach(async () => {
  for (const m of machines) await m.dispose();
  machines = [];
});

interface Box {
  m: Machine;
  s: StockHome;
  l: Launchd;
  hubFile: string;
  tunnelFile: string;
}

/** Until the vault answers at the old origin (an MCP 401 that names it). */
async function waitServing(s: StockHome, what: string, log: () => string): Promise<void> {
  const up = await until(async () => {
    const r = await safeFetch(`${s.origin}/vault/${s.vaultName}/mcp`);
    return r.status === 401 && (r.headers.get("www-authenticate") ?? "").includes(`/vault/${s.vaultName}/`);
  }, 60_000);
  must(up, `${what} is not serving vault ${s.vaultName}:\n${log().slice(-2000)}`);
}

const readLog = (p: string) => () => (existsSync(p) ? readFileSync(p, "utf8").replace(/pvk_[A-Za-z0-9_-]+/g, "pvk_<redacted>") : "");

/**
 * A Mac as Prism's hosts have it: the old hub as Parachute's own agent (the 0.7 hub's plist: bun, the hub's cli.ts,
 * serve, with the home's settings), loaded and serving the stock home; a tunnel agent loaded beside it.
 */
async function macBox(label: string): Promise<Box> {
  const m = await newMachine(label, { units: {} });
  machines.push(m);
  const l = withLaunchd(m);
  const s = await makeStockHome(m);
  const hubLog = join(m.home, "hub", "logs", "hub.log");
  mkdirSync(join(m.home, "hub", "logs"), { recursive: true });
  const hubFile = await l.install(
    HUB,
    agentPlist(
      HUB,
      [join(m.bunDir, "bin", "bun"), join(m.bunDir, "install", "global", "node_modules", "@openparachute", "hub", "src", "cli.ts"), "serve"],
      {
        PARACHUTE_BIND_HOST: "127.0.0.1",
        PARACHUTE_HOME: m.home,
        PORT: String(s.port),
        PARACHUTE_HUB_ORIGIN: s.origin,
        PARACHUTE_HUB_JWKS_ORIGIN: s.origin,
        PATH: `${m.bunDir}/bin:/usr/local/bin:/usr/bin:/bin`,
        BUN_INSTALL: m.bunDir,
      },
      hubLog,
    ),
  );
  await waitServing(s, HUB, readLog(hubLog));
  // The tunnel: a stand-in cloudflared that runs until stopped, with the connector's own plist shape.
  const cloudflared = join(m.user, ".fake", "cloudflared");
  writeFileSync(cloudflared, "#!/bin/sh\nexec sleep 100000\n", { mode: 0o755 });
  const tunnelFile = await l.install(TUNNEL, agentPlist(TUNNEL, [cloudflared, "tunnel", "--config", join(m.home, "cloudflared", "vault-tunnel.yml"), "run"], {}, join(m.user, "cloudflared.log")));
  must(l.agent(TUNNEL).pid > 0 && l.agent(HUB).pid > 0, "setup: the hub and tunnel agents aren't both running");
  return { m, s, l, hubFile, tunnelFile };
}

/** launchctl calls since `from` that name `label`. */
const callsFor = (l: Launchd, label: string, from: number) => l.calls().slice(from).filter((c) => c.includes(label));

describe("takeover with launchd agents (macOS)", () => {
  test("the dry run names the old hub's agent as the one it pauses, leaves the tunnel alone, and changes nothing; serve refuses, naming that agent only", async () => {
    const { m, s, l, hubFile, tunnelFile } = await macBox("tkl-dry");
    const hubText = readFileSync(hubFile, "utf8");
    const hubPid = l.agent(HUB).pid;
    const tunnelPid = l.agent(TUNNEL).pid;
    const calls = l.calls().length;

    const r = await core(m, ["takeover", "--home", m.home, "--dry-run", "--json"]);
    must(r.code === 0, `takeover --dry-run exited ${r.code}: ${r.stderr.slice(-800)}`);
    const j = json(r, "takeover --dry-run --json");
    const hub = j.units.find((u: any) => u.name === HUB);
    const tunnel = j.units.find((u: any) => u.name === TUNNEL);
    expect(hub).toMatchObject({ manager: "launchd", old: true, active: true, pid: hubPid, file: hubFile });
    expect(tunnel).toMatchObject({ manager: "launchd", old: false, active: true, pid: tunnelPid });
    // Every process holding the data is the hub agent's.
    expect(j.running.length).toBeGreaterThan(0);
    for (const h of j.running) expect(h.unit).toBe(HUB);
    const plan = j.plan.join("\n");
    expect(plan).toContain(`pause ${HUB} (unload, and move its plist out of ~/Library/LaunchAgents`);
    expect(plan).not.toContain(TUNNEL);
    expect(plan).toContain(`run it from now on as the launchd agent ${CORE}`);

    const text = await core(m, ["takeover", "--home", m.home, "--dry-run"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(`launchd agent ${HUB}: running (pid ${hubPid}), loads at login (has this home's data open: it will be paused, its plist moved aside)`);
    expect(text.stdout).toContain(`launchd agent ${TUNNEL}: running (pid ${tunnelPid}), loads at login (doesn't have this home's data open: left alone)`);

    // Nothing changed: no launchctl call but `list`, both agents as they were, the plists byte for byte, no core agent.
    expect(l.calls().slice(calls).filter((c) => c !== "list")).toEqual([]);
    expect(l.agent(HUB)).toEqual({ loaded: true, pid: hubPid });
    expect(l.agent(TUNNEL)).toEqual({ loaded: true, pid: tunnelPid });
    expect(readFileSync(hubFile, "utf8")).toBe(hubText);
    expect(existsSync(tunnelFile)).toBe(true);
    expect(existsSync(join(l.agentsDir, `${CORE}.plist`))).toBe(false);
    expect(existsSync(join(m.home, "takeover.json"))).toBe(false);

    // serve refuses this home while the old hub's agent has it, and doesn't count the tunnel as the old programs.
    const sr = await m.run([requireCore(m.info), "serve", "--listen", `127.0.0.1:${await freePort()}`], { timeoutMs: 30_000 });
    must(sr.code !== 137, "serve started on a home the old hub's agent still has (still running after 30 s)");
    expect(sr.code).toBe(7);
    expect(sr.stderr).toContain(`the launchd agent ${HUB}`);
    expect(sr.stderr).not.toContain(TUNNEL);
    expect(s.notes.length).toBeGreaterThan(0);
  }, 180_000);

  test("takeover unloads the old hub's agent and moves its plist aside, runs v0.8 as computer.parachute.core on the same notes, and rollback puts the plist back and loads it; the tunnel is never touched", async () => {
    const { m, s, l, hubFile, tunnelFile } = await macBox("tkl-round");
    const hubText = readFileSync(hubFile, "utf8");
    const tunnelText = readFileSync(tunnelFile, "utf8");
    const tunnelPid = l.agent(TUNNEL).pid;
    const notesBefore = (await readNotes(s.origin, s.vaultName, s.readPass)).notes;
    const calls = l.calls().length;

    const t = await core(m, ["takeover", "--home", m.home, "--yes", "--json"]);
    must(t.code === 0, `takeover --yes exited ${t.code}: ${t.stderr.slice(-1500)}`);
    const done = json(t, "takeover --yes --json");
    expect(done.core_unit).toBe(CORE);

    // The old hub: unloaded, its plist out of ~/Library/LaunchAgents, byte for byte in the backup folder's launchd/.
    expect(l.agent(HUB)).toEqual({ loaded: false, pid: 0 });
    expect(existsSync(hubFile)).toBe(false);
    const aside = join(done.backup, "launchd", `${HUB}.plist`);
    expect(existsSync(aside)).toBe(true);
    expect(readFileSync(aside, "utf8")).toBe(hubText);
    expect(callsFor(l, HUB, calls)).toContain(`bootout gui/${process.getuid?.()}/${HUB}`);

    // Core's agent: its own plist, core's program, the old agent's environment (home, port, origin), loaded and running.
    const coreFile = join(l.agentsDir, `${CORE}.plist`);
    const corePlist = readFileSync(coreFile, "utf8");
    expect(corePlist).toContain("<string>serve</string>");
    expect(corePlist).toMatch(/<string>[^<]*\/bin\/parachute-core<\/string>/);
    expect(corePlist).not.toContain("@openparachute/hub");
    for (const v of [m.home, String(s.port), s.origin]) expect(corePlist).toContain(`<string>${v}</string>`);
    expect(l.agent(CORE).loaded).toBe(true);
    expect(l.agent(CORE).pid).toBeGreaterThan(0);

    // v0.8 serves the same notes at the same origin, to a pass the old hub minted before.
    await waitServing(s, CORE, readLog(join(m.home, "hub", "logs", "hub.log")));
    const got = await readNotes(s.origin, s.vaultName, s.readPass);
    expect(got.status).toBe(200);
    expect(got.notes).toEqual(notesBefore);
    const made = await rest(`${s.origin}/vault/${s.vaultName}`, s.writePass).post("/notes", {
      path: "garden/written-under-core-on-a-mac",
      content: "Sowed broad beans along the fence in November.",
      tags: ["made-up"],
    });
    expect(made.status).toBe(201);

    // Back: core's agent unloaded and its plist out of ~/Library/LaunchAgents; the old plist back, byte for byte, loaded.
    const r = await core(m, ["takeover", "--rollback", "--yes", "--json"]);
    must(r.code === 0, `takeover --rollback --yes exited ${r.code}: ${r.stderr.slice(-1500)}`);
    expect(l.agent(CORE)).toEqual({ loaded: false, pid: 0 });
    expect(existsSync(coreFile)).toBe(false);
    expect(existsSync(join(done.backup, "launchd", `${CORE}.plist`))).toBe(true);
    expect(readFileSync(hubFile, "utf8")).toBe(hubText);
    expect(existsSync(aside)).toBe(false);
    expect(l.agent(HUB).loaded).toBe(true);
    await waitServing(s, `${HUB} after the rollback`, readLog(join(m.home, "hub", "logs", "hub.log")));
    const api = rest(`${s.origin}/vault/${s.vaultName}`, s.writePass);
    const back = await api.get(`/notes/${made.body.id}`);
    expect(back.status).toBe(200);
    expect(back.body.content).toBe("Sowed broad beans along the fence in November.");

    // The tunnel ran throughout, untouched: same process, same plist, never named in a launchctl call.
    expect(l.agent(TUNNEL)).toEqual({ loaded: true, pid: tunnelPid });
    expect(readFileSync(tunnelFile, "utf8")).toBe(tunnelText);
    expect(callsFor(l, TUNNEL, calls)).toEqual([]);
  }, 240_000);

  test("an old agent that isn't running and whose plist doesn't say which home it serves (the 0.7 vault's wrapper) is refused before anything changes", async () => {
    const { m, l, hubFile } = await macBox("tkl-unseen");
    const wrapper = join(m.home, "vault", "start.sh");
    mkdirSync(join(m.home, "vault"), { recursive: true });
    const vaultFile = await l.install("computer.parachute.vault", agentPlist("computer.parachute.vault", ["/bin/bash", wrapper], {}, join(m.user, "vault.log")), { load: false });
    const hubPid = l.agent(HUB).pid;
    const calls = l.calls().length;

    const r = await core(m, ["takeover", "--home", m.home, "--yes"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("computer.parachute.vault looks like the old hub or vault, isn't running, and its plist doesn't say which home it serves");
    expect(r.stderr).toContain("Nothing was changed.");
    expect(l.calls().slice(calls).filter((c) => c !== "list")).toEqual([]);
    expect(l.agent(HUB)).toEqual({ loaded: true, pid: hubPid });
    expect(existsSync(hubFile)).toBe(true);
    expect(existsSync(vaultFile)).toBe(true);
    expect(existsSync(join(m.home, "takeover.json"))).toBe(false);
  }, 180_000);
});
