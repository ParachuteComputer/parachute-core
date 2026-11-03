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
import { existsSync } from "node:fs";
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
