// `parachute stop | start | restart` on a box whose service is core's own unit.
//
// The takeover writes `parachute-core.service` (takeover.ts): a systemd user unit that runs
// `<prefix>/bin/parachute-core serve` on the home. The hub's own stop/start/restart know only `parachute-hub.service`
// (the 0.7 name): on a taken-over box they said "No supervised hub unit is installed", or, with a pidfile left from
// the detached days, offered a migration that writes a hub unit running the hub's own serve, which skips everything
// core's serve does first (the release step and its backup, the rolled-back refusal).
//
// So when `parachute-core.service` is there, runs core and serves this home, those three verbs are the unit's,
// unless a hub unit that itself runs core is beside it (one `parachute init` wrote: the hub's own verbs know that
// one). A hub unit that runs the 0.7 hub is the takeover's leftover: it pauses the old units (stopped, disabled)
// and leaves their files, and the hub's verbs would start that old hub on a home core serves. Inside core the
// hub no longer drives such a unit at all (hub-unit.ts), whichever verb or module is named. The verbs are the
// core unit's: `systemctl --user <verb> parachute-core.service`. They open no database, so they also work from a
// newer release while the older one still serves (after `parachute upgrade` installed it): the restart is what
// moves the service to the release the links name, and that release's serve takes the step, backup first.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { unitStartsCore } from "@openparachute/hub/src/core-host.ts";
import { unitHome } from "./takeover.ts";

export const CORE_UNIT = "parachute-core.service";
const HUB_UNIT = "parachute-hub.service";
export const UNIT_VERBS = ["stop", "start", "restart"];

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * Whether core's own unit is what serves `home`: its file is there, starts core and names this home, and no hub
 * unit that also starts core is beside it. (A hub unit that starts the 0.7 hub is the takeover's paused leftover;
 * the hub itself never drives that one inside core: hub-unit.ts isHubUnitInstalled.) Anything it can't read plainly
 * (a masked or hand-shaped unit, a drop-in that changes what is started or where) is left to the hub's verbs.
 */
export function coreUnitServes(home: string): boolean {
  if (process.platform !== "linux") return false;
  const dir = join(process.env.XDG_CONFIG_HOME || join(process.env.HOME || homedir(), ".config"), "systemd", "user");
  try {
    const text = readFileSync(join(dir, CORE_UNIT), "utf8");
    if (!unitStartsCore(text)) return false;
    if (existsSync(join(dir, HUB_UNIT)) && unitStartsCore(readFileSync(join(dir, HUB_UNIT), "utf8"))) return false;
    const dropIns = join(dir, `${CORE_UNIT}.d`);
    if (existsSync(dropIns)) {
      for (const f of readdirSync(dropIns)) {
        if (f.endsWith(".conf") && /ExecStart|PARACHUTE_HOME|EnvironmentFile/.test(readFileSync(join(dropIns, f), "utf8"))) return false;
      }
    }
    const serves = unitHome(text);
    return serves !== "unknown" && real(serves) === real(home);
  } catch {
    return false;
  }
}

/**
 * Whether `stop|start|restart <args>` is about the whole service: no name, or `hub`, whatever flags ride along
 * (`--hub-origin <url>` is the hub's, and takes a value).
 */
export function wholeService(args: string[]): boolean {
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--hub-origin") i++;
    else if (!a.startsWith("-")) names.push(a);
  }
  return names.length === 0 || (names.length === 1 && names[0] === "hub");
}

/** Run `systemctl --user <verb> parachute-core.service`; the exit code. */
export function coreUnitVerb(verb: string): number {
  const r = Bun.spawnSync(["systemctl", "--user", verb, CORE_UNIT], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if (r.exitCode === 0) console.log(`parachute ${verb}: ${CORE_UNIT} ${verb === "stop" ? "stopped" : verb === "start" ? "started" : "restarted"} (systemctl --user ${verb} ${CORE_UNIT})`);
  else console.error(`parachute ${verb}: systemctl --user ${verb} ${CORE_UNIT} exited ${r.exitCode}`);
  return r.exitCode ?? 1;
}
