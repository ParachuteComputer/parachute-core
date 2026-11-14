// `parachute stop | start | restart` on a box whose service is core's own unit.
//
// The takeover writes `parachute-core.service` (takeover.ts): a systemd user unit that runs
// `<prefix>/bin/parachute-core serve` on the home. The hub's own stop/start/restart know only `parachute-hub.service`
// (the 0.7 name): on a taken-over box they said "No supervised hub unit is installed", or, with a pidfile left from
// the detached days, offered a migration that writes a hub unit running the hub's own serve, which skips everything
// core's serve does first (the release step and its backup, the rolled-back refusal).
//
// So when `parachute-core.service` is there, serves this home, and no hub unit is beside it, those three verbs are
// the unit's: `systemctl --user <verb> parachute-core.service`. They open no database, so they also work from a
// newer release while the older one still serves (after `parachute upgrade` installed it): the restart is what
// moves the service to the release the links name, and that release's serve takes the step, backup first.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

/** Whether core's own unit is what serves `home`: its file is there, names this home, and no hub unit is beside it. */
export function coreUnitServes(home: string): boolean {
  if (process.platform !== "linux") return false;
  const dir = join(process.env.XDG_CONFIG_HOME || join(process.env.HOME || homedir(), ".config"), "systemd", "user");
  const path = join(dir, CORE_UNIT);
  if (!existsSync(path) || existsSync(join(dir, HUB_UNIT))) return false;
  try {
    const serves = unitHome(readFileSync(path, "utf8"));
    return serves !== "unknown" && real(serves) === real(home);
  } catch {
    return false;
  }
}

/** Run `systemctl --user <verb> parachute-core.service`; the exit code. */
export function coreUnitVerb(verb: string): number {
  const r = Bun.spawnSync(["systemctl", "--user", verb, CORE_UNIT], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if (r.exitCode === 0) console.log(`parachute ${verb}: ${CORE_UNIT} ${verb === "stop" ? "stopped" : verb === "start" ? "started" : "restarted"} (systemctl --user ${verb} ${CORE_UNIT})`);
  else console.error(`parachute ${verb}: systemctl --user ${verb} ${CORE_UNIT} exited ${r.exitCode}`);
  return r.exitCode ?? 1;
}
