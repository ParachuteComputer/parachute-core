/**
 * When this hub runs as part of `@openparachute/core` (v0.8), core's `parachute` command sets
 * `PARACHUTE_CORE_ROOT` to the package's root before it loads the hub's CLI (packages/cli/src/dispatch.ts).
 * Two 0.7 habits are wrong there, and both made a fresh `parachute init` a 0.7 install in all but name:
 *
 *   - the unit ran the hub's own `src/cli.ts serve`, which skips core's serve (the vault in this process,
 *     the takeover refusal, the newer-data check), and
 *   - `install vault` ran `bun add -g @openparachute/vault`, pulling 0.7.x from npm next to the vault core
 *     already carries.
 *
 * Outside core (the env unset) every function here returns null and the hub behaves as it did in 0.7.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CORE_ROOT_ENV = "PARACHUTE_CORE_ROOT";

/** Core's package root, when this hub runs inside core and the root has core's entry. */
export function coreRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = env[CORE_ROOT_ENV];
  if (!root) return null;
  return existsSync(join(root, "packages", "cli", "src", "parachute-core.ts")) ? root : null;
}

/**
 * What the hub unit runs instead of the hub's own `src/cli.ts`: core's entry (its `serve` starts the vault in
 * this process), and core's `bin` first on the unit's PATH, so a command the hub runs by name
 * (`parachute-vault create`, and `parachute-vault serve` on the child path) is core's own.
 */
export function coreUnitEntry(
  env: NodeJS.ProcessEnv = process.env,
): { cliPath: string; binDir: string } | null {
  const root = coreRoot(env);
  if (!root) return null;
  return {
    cliPath: join(root, "packages", "cli", "src", "parachute-core.ts"),
    binDir: join(root, "packages", "cli", "bin"),
  };
}

/**
 * Whether a systemd unit's text starts core: `…/bin/parachute-core serve` (the takeover's unit) or Bun on core's
 * `parachute-core.ts` (what `init` writes inside core). A unit that starts anything else by the hub's unit name is
 * the 0.7 hub's: the takeover pauses it (fenced off, stopped, disabled; TAKEOVER_FENCE) and leaves its file, since
 * starting it would put the old hub on a home core serves.
 */
export function unitStartsCore(text: string): boolean {
  return /^[ \t]*ExecStart[ \t]*=.*parachute-core(\.ts)?["']?([ \t]+\S+)?[ \t]+serve\b/m.test(text);
}

/**
 * The drop-in a takeover puts beside each old unit it pauses (packages/cli/src/takeover.ts), in
 * `~/.config/systemd/user/<unit>.d/`. Its `AssertPathExists=!/` never holds, so systemd refuses every start of the
 * unit while it is there, whoever asks: a person, 0.7's own `parachute start`, a unit that wants it (#127: a paused
 * hub unit with Restart=always took the port while core was stopped for an upgrade). Not `systemctl mask`: masking
 * puts a link where the unit file is, and the 0.7 unit file lives in that very folder; rollback needs the file.
 * A takeover's rollback removes the drop-in.
 */
export const TAKEOVER_FENCE = "parachute-core-took-over.conf";
const FENCE_LINE = "AssertPathExists=!/";

/** The systemd user unit folder: `$XDG_CONFIG_HOME/systemd/user`, else `~/.config/systemd/user`. */
export function userUnitDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "systemd", "user");
}

export function fencePath(unit: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(userUnitDir(env), `${unit}.d`, TAKEOVER_FENCE);
}

/** The fence's text, for the takeover of `home`. */
export function fenceText(home: string, unit: string): string {
  // On a comment line: a line break in the path must not end the comment.
  home = home.replace(/[\r\n]/g, " ");
  return [
    `# Written by parachute-core takeover for ${home}: parachute-core.service serves that home now, so ${unit}`,
    "# (the 0.7 program) must not start, by hand, by a restart or because another unit wants it. Its own file is",
    "# left as it was for the way back: `parachute-core takeover --rollback` removes this file and puts it back on.",
    "[Unit]",
    FENCE_LINE,
    "",
  ].join("\n");
}

/**
 * The old units this home's takeover paused that could start again: the home's record says taken over, the unit's
 * file is still in the user unit folder and doesn't start core, and its fence isn't there (a home taken over before
 * the fence, or the file taken away). null when the home isn't taken over (no record, interrupted or rolled back) or
 * this isn't Linux. Files only: no unit manager call, so doctor and serve can ask cheaply.
 */
export function unfencedOldUnits(home: string, env: NodeJS.ProcessEnv = process.env): string[] | null {
  if (process.platform !== "linux") return null;
  let rec: { state?: unknown; paused?: unknown };
  try {
    rec = JSON.parse(readFileSync(join(home, "takeover.json"), "utf8"));
  } catch {
    return null;
  }
  if (rec?.state !== "taken-over" || !Array.isArray(rec.paused)) return null;
  const dir = userUnitDir(env);
  const fenced = (unit: string) => {
    try {
      return readFileSync(fencePath(unit, env), "utf8").split("\n").some((l) => l.trim() === FENCE_LINE);
    } catch {
      return false;
    }
  };
  const out: string[] = [];
  for (const u of rec.paused) {
    const name = (u as { name?: unknown })?.name;
    if (typeof name !== "string" || !/^parachute[\w@.-]*\.service$/.test(name)) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    if (!unitStartsCore(text) && !fenced(name)) out.push(name);
  }
  return out;
}

/** The folder of a module core carries itself (the vault), so the installer registers it instead of downloading it. */
export function bundledModuleDir(
  packageName: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const root = coreRoot(env);
  if (!root || packageName !== "@openparachute/vault") return null;
  const dir = join(root, "packages", "vault");
  return existsSync(join(dir, "package.json")) ? dir : null;
}

/**
 * Is `dir` the vault of some copy of core (this one, an older bundle copy under `.store/`, a source checkout)?
 * A core vault sits at `<core>/packages/vault`, beside `<core>/packages/cli/src/parachute-core.ts`.
 */
export function isCoreVaultDir(dir: string): boolean {
  return existsSync(join(dir, "..", "cli", "src", "parachute-core.ts"));
}

/** Has `parachute-core takeover` moved this home to core? Then core's vault serves it, whatever the row says. */
export function takenOver(home: string): boolean {
  try {
    return JSON.parse(readFileSync(join(home, "takeover.json"), "utf8"))?.state === "taken-over";
  } catch {
    return false;
  }
}

/**
 * The folder of this core's vault, when that is what serves this home: the row points at a core copy's vault (this
 * one, or an older bundle copy), or takeover moved the home to core (its row may still name the old npm vault).
 * Null outside core, and on a box a pre-0.8.0-pre.3 `init` set up with npm's 0.7 vault, which that vault still serves.
 */
export function servingCoreVaultDir(
  installDir: string | undefined,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const dir = bundledModuleDir("@openparachute/vault", env);
  if (!dir) return null;
  return (installDir !== undefined && isCoreVaultDir(installDir)) || takenOver(home) ? dir : null;
}
