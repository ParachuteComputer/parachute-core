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
  parseLaunchctlList,
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

  test("an unreadable plist under the old hub's label still looks old (so takeover refuses rather than guess its home)", () => {
    expect(agentLooksOld("computer.parachute.hub", null)).toBe(true);
    expect(agentHome(null, USER)).toBe("unknown");
    expect(agentLooksOld("computer.parachute.cloudflared.vault", null)).toBe(false);
  });
});

describe("parseLaunchctlList", () => {
  test("every loaded label with its pid, 0 for none", () => {
    const out = "PID\tStatus\tLabel\n412\t0\tcomputer.parachute.hub\n-\t0\tcomputer.parachute.cloudflared.vault\n-\t-9\tcom.apple.x\n";
    expect(parseLaunchctlList(out)).toEqual(new Map([["computer.parachute.hub", 412], ["computer.parachute.cloudflared.vault", 0], ["com.apple.x", 0]]));
  });
  test("output that isn't that table is null (takeover then can't see what is loaded)", () => {
    expect(parseLaunchctlList("")).toBeNull();
    expect(parseLaunchctlList('{\n\t"PID" = 412;\n};')).toBeNull();
  });
});
