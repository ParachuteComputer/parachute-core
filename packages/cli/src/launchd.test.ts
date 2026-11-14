// What takeover reads from a launchd plist (launchd.ts): which agent is the old hub or vault, and which home it serves.
// Reading a cloudflared tunnel as the old hub would pause the box's public address; reading another home's hub as
// this one's would stop the wrong Parachute. The plists here are the ones Parachute's own code writes (the 0.7 hub's
// agent, its cloudflared connector, the vault's wrapper agent and its backup schedule), rendered by that code.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderLaunchdPlist as renderTunnel } from "@openparachute/hub/src/cloudflare/connector-service.ts";
import { buildHubManagedUnit, renderManagedLaunchdPlist } from "@openparachute/hub/src/managed-unit.ts";
import {
  agentEnv,
  agentHome,
  agentLooksOld,
  agentProgram,
  parseLaunchctlPrint,
  parsePlist,
  plistComment,
  readAgentPlist,
  renderPlist,
  type PlistDict,
} from "./launchd.ts";

// The vault's modules read PARACHUTE_HOME when loaded (and refuse a test run without one): a scratch one here.
process.env.PARACHUTE_HOME ??= mkdtempSync(join(tmpdir(), "launchd-test-home-"));
const { generatePlist: renderVaultAgent } = await import("@openparachute/vault/src/launchd.ts");
const { generateBackupPlist } = await import("@openparachute/vault/src/backup-launchd.ts");

const USER = "/Users/op";
const HUB_CLI = `${USER}/.bun/install/global/node_modules/@openparachute/hub/src/cli.ts`;

/** The 0.7 hub's own agent (computer.parachute.hub), as `parachute init` writes it. */
function hubAgent(parachuteHome: string): string {
  const unit = buildHubManagedUnit({
    parachuteHome,
    bunInstall: `${USER}/.bun`,
    path: `${USER}/.bun/bin:/usr/local/bin:/usr/bin:/bin`,
    cliPath: HUB_CLI,
    logPath: `${parachuteHome}/hub/logs/hub.log`,
    deps: { which: () => `${USER}/.bun/bin/bun` } as any,
  });
  return renderManagedLaunchdPlist(unit);
}

const dict = (text: string): PlistDict => {
  const d = readAgentPlist(text);
  if (!d) throw new Error(`not a plist dict: ${text.slice(0, 200)}`);
  return d;
};

describe("parsePlist", () => {
  test("reads the 0.7 hub's agent as launchd would: label, program, environment, keep-alive, throttle", () => {
    const d = dict(hubAgent(`${USER}/.parachute`));
    expect(d.Label).toBe("computer.parachute.hub");
    expect(agentProgram(d)).toEqual([`${USER}/.bun/bin/bun`, HUB_CLI, "serve"]);
    expect(agentEnv(d)).toMatchObject({ PARACHUTE_HOME: `${USER}/.parachute`, PORT: "1939", PARACHUTE_BIND_HOST: "127.0.0.1", BUN_INSTALL: `${USER}/.bun` });
    expect(d.KeepAlive).toBe(true);
    expect(typeof d.ThrottleInterval).toBe("number");
    expect(d.StandardOutPath).toBe(`${USER}/.parachute/hub/logs/hub.log`);
  });

  test("what renderPlist writes reads back the same: entities, nested dicts, numbers, booleans, empty containers", () => {
    const value: PlistDict = {
      Label: "computer.parachute.core",
      ProgramArguments: ["/Applications/Prism Host/bin/parachute-core", "serve"],
      EnvironmentVariables: { PARACHUTE_HOME: "/Users/op/A & B <home>", QUOTE: `"it's"` },
      KeepAlive: { SuccessfulExit: false },
      RunAtLoad: true,
      ThrottleInterval: 10,
      Ratio: 0.5,
      Nothing: [],
      Empty: {},
      Blank: "",
    };
    const text = renderPlist(value, "a note");
    expect(parsePlist(text)).toEqual(value);
  });

  test("a comment holding '--', backslashes or a quote is still one XML comment, and reads back exactly", () => {
    const note = `written for "/Users/op/odd--home\\-x\\\\y-" -`;
    const text = renderPlist({ Label: "x" }, note);
    expect(text.match(/<!--/g)?.length).toBe(1);
    expect(/<!-- ([\s\S]*?) -->/.exec(text)![1]).not.toContain("--");
    expect(plistComment(text)).toBe(note);
    expect(parsePlist(text)).toEqual({ Label: "x" });
  });

  test("a binary plist, a duplicate key, stray markup or a second value is refused (its agent's home is then unknown)", () => {
    expect(() => parsePlist("bplist00\u0000\u0001")).toThrow(/binary/);
    expect(() => parsePlist(`<plist><dict><key>A</key><string>1</string><key>A</key><string>2</string></dict></plist>`)).toThrow(/twice/);
    expect(() => parsePlist(`<plist><dict><key>A</key><string>x<b>y</b></string></dict></plist>`)).toThrow();
    expect(() => parsePlist(`<plist><string>a</string><string>b</string></plist>`)).toThrow();
    expect(() => parsePlist(`<plist><dict><key>A</key><wat/></dict></plist>`)).toThrow(/unknown element/);
    expect(readAgentPlist("not a plist")).toBeNull();
    expect(readAgentPlist(`<plist><array/></plist>`)).toBeNull();
  });
});

describe("which agents are the old hub or vault", () => {
  test("the 0.7 hub's agent is, and serves the home its plist names", () => {
    const d = dict(hubAgent("/Volumes/Data/parachute"));
    expect(agentLooksOld("computer.parachute.hub", d)).toBe(true);
    expect(agentHome(d, USER)).toBe("/Volumes/Data/parachute");
  });

  test("an old hub run by its own program name (`parachute serve`), under any label, is; its home defaults to ~/.parachute", () => {
    const d = dict(renderPlist({ Label: "local.my-hub", ProgramArguments: [`${USER}/.bun/bin/parachute`, "serve"] }));
    expect(agentLooksOld("local.my-hub", d)).toBe(true);
    expect(agentHome(d, USER)).toBe(`${USER}/.parachute`);
    const other = dict(renderPlist({ Label: "local.x", ProgramArguments: [`${USER}/.bun/bin/parachute`, "serve"], EnvironmentVariables: { HOME: "/Users/other" } }));
    expect(agentHome(other, USER)).toBe("/Users/other/.parachute");
  });

  test("a cloudflared tunnel is never, whatever the tunnel is called (even 'vault' or 'hub')", () => {
    for (const tunnelName of ["vault", "hub", "my-vault-tunnel"]) {
      const text = renderTunnel({ tunnelName, cloudflaredPath: "/opt/homebrew/bin/cloudflared", configPath: `${USER}/.parachute/cloudflared/${tunnelName}.yml`, logPath: `${USER}/.parachute/cloudflared/${tunnelName}.log` });
      const d = dict(text);
      expect(d.Label).toBe(`computer.parachute.cloudflared.${tunnelName}`);
      expect(agentLooksOld(String(d.Label), d)).toBe(false);
    }
  });

  test("the 0.7 vault's own agent is (by its label), but runs a wrapper, so its home is unknown", () => {
    const d = dict(renderVaultAgent());
    expect(d.Label).toBe("computer.parachute.vault");
    expect(agentLooksOld("computer.parachute.vault", d)).toBe(true);
    expect(agentHome(d, USER)).toBe("unknown");
  });

  test("the vault's scheduled backup agent isn't (it runs `vault backup`, not serve)", () => {
    const text = generateBackupPlist({ bunPath: `${USER}/.bun/bin/bun`, cliPath: `${USER}/.bun/install/global/node_modules/@openparachute/vault/src/cli.ts`, schedule: "daily" } as any);
    const d = dict(text);
    expect(agentLooksOld(String(d.Label), d)).toBe(false);
  });

  test("core's own agent never is, even under the old hub's label or with the old hub's folder on its PATH", () => {
    const core = "/Users/op/.bun/install/global/node_modules/@openparachute/core";
    const d = dict(renderPlist({ Label: "computer.parachute.hub", ProgramArguments: [`${core}/bin/parachute-core`, "serve"], EnvironmentVariables: { PATH: `${HUB_CLI}:/usr/bin` } }));
    expect(agentLooksOld("computer.parachute.hub", d)).toBe(false);
    expect(agentHome(d, USER)).toBe("unknown");
  });

  test("the old hub's agent running a hub from a folder named parachute-core (a checkout of this repo) isn't taken for core", () => {
    const d = dict(renderPlist({ Label: "computer.parachute.hub", ProgramArguments: [`${USER}/.bun/bin/bun`, `${USER}/Code/parachute-core/packages/hub/src/cli.ts`, "serve"] }));
    expect(agentLooksOld("computer.parachute.hub", d)).toBe(true);
    const core = dict(renderPlist({ Label: "x", ProgramArguments: [`${USER}/.bun/bin/bun`, `${USER}/Code/parachute-core/packages/cli/src/parachute-core.ts`, "serve"] }));
    expect(agentLooksOld("computer.parachute.hub", core)).toBe(false);
    for (const args of [["/bin/sh", "-c", "exec ~/.bun/bin/parachute-core serve"], ["bunx", "parachute-core@0.8", "serve"], ["node", "/opt/core/dist/parachute-core.mjs", "serve"]]) {
      expect(agentLooksOld("computer.parachute.hub", dict(renderPlist({ Label: "computer.parachute.hub", ProgramArguments: args })))).toBe(false);
    }
  });

  test("an unreadable plist under the old hub's label still looks old (so takeover refuses rather than guess its home)", () => {
    expect(agentLooksOld("computer.parachute.hub", null)).toBe(true);
    expect(agentHome(null, USER)).toBe("unknown");
    expect(agentLooksOld("computer.parachute.cloudflared.vault", null)).toBe(false);
  });
});

describe("parseLaunchctlPrint", () => {
  test("a loaded job's pid, from its top-level pid line; 0 when it has no process", () => {
    const running = "gui/501/computer.parachute.hub = {\n\tactive count = 1\n\tpath = /Users/op/Library/LaunchAgents/computer.parachute.hub.plist\n\tstate = running\n\n\tprogram = /Users/op/.bun/bin/bun\n\tenvironment = {\n\t\tPORT => 1939\n\t}\n\n\tpid = 412\n\timmediate reason = speculative\n}\n";
    expect(parseLaunchctlPrint(running)).toBe(412);
    expect(parseLaunchctlPrint("gui/501/computer.parachute.hub = {\n\tstate = not running\n\tlast exit code = 1\n}\n")).toBe(0);
  });
  test("a pid line inside a nested block isn't the job's", () => {
    expect(parseLaunchctlPrint("gui/501/x = {\n\tstate = not running\n\tendpoints = {\n\t\tpid = 99\n\t}\n}\n")).toBe(0);
  });
  test("output that isn't a job's description is null (takeover then can't see whether it is loaded)", () => {
    expect(parseLaunchctlPrint("")).toBeNull();
    expect(parseLaunchctlPrint("PID\tStatus\tLabel\n412\t0\tcomputer.parachute.hub\n")).toBeNull();
  });
});
