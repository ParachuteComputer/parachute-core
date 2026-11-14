// `parachute config get|set|unset` and the start-up step that puts parachute.yaml into effect (T-463, 0.9.3).
// The file's format and the typed get/set API are in parachute-yaml.ts; this is what connects it to the hub and vault.
//
// Applying: before the hub or vault reads a setting, `applyParachuteYaml` copies each yaml setting into the env var the
// hub already reads for it, unless that env var is set (env wins). The hub and the vault, in this process or in a child
// that inherits the environment, then see the effective value with no change of their own. `vaults.<n>.description`
// goes to the vault's served-description overlay (vault src/config.ts `servedDescription`).
import { listVaults, readVaultConfig, setVaultOverrides } from "@openparachute/vault/src/config.ts";
import {
  FILE_NAME,
  FIXED_KEYS,
  SettingsError,
  checkValue,
  fileWarnings,
  keyInfo,
  loadSettings,
  parse,
  readText,
  setSetting,
  unsetSetting,
  unknownKey,
} from "./parachute-yaml.ts";

const list = (v: string | string[]): string => (Array.isArray(v) ? v.join(", ") : v);
const unset = (v: string | undefined) => v === undefined || v === "";

/**
 * Put the home's parachute.yaml into effect for this process (and any child it starts).
 * `server`: also the hub's server.* settings; false for the vault's own program, whose `PORT` is its own.
 * Returns the settings applied. Throws SettingsError (naming the line) when the file is broken.
 */
export function applyParachuteYaml(home: string, opts: { env?: NodeJS.ProcessEnv; server?: boolean } = {}): string[] {
  const env = opts.env ?? process.env;
  const settings = loadSettings(home);
  for (const w of fileWarnings(readText(home))) console.error(`parachute: ${w}`);
  const applied: string[] = [];
  const descriptions = new Map<string, { description?: string }>();
  for (const [key, value] of settings) {
    const info = keyInfo(key)!;
    if (info.env) {
      if (opts.server === false || !unset(env[info.env])) continue;
      env[info.env] = Array.isArray(value) ? value.join(",") : value;
      applied.push(key);
    } else {
      const m = /^vaults\.([^.]+)\.description$/.exec(key);
      if (m) {
        descriptions.set(m[1]!, { description: value as string });
        applied.push(key);
      }
    }
  }
  setVaultOverrides(descriptions);
  return applied;
}

/** Where one setting's effective value comes from. */
export interface Effective {
  key: string;
  /** Shown value ("(not set)" when nothing sets it). */
  value: string;
  source: "env" | "parachute.yaml" | "old file" | "default";
  /** `env PORT`, `parachute.yaml`, `old file vault.yaml`, `default`. */
  from: string;
  /** What this value overrides, for the line `get` prints. */
  overrides?: string;
}

function oldFileValue(key: string): { value: string; file: string } | undefined {
  const m = /^vaults\.([^.]+)\.description$/.exec(key);
  if (!m) return undefined;
  const d = readVaultConfig(m[1]!)?.description;
  return d ? { value: d, file: "vault.yaml" } : undefined;
}

/** The value in force for `key`, and where it came from: env, parachute.yaml, an old file, or the default. */
export function effective(home: string, key: string, env: NodeJS.ProcessEnv = process.env): Effective {
  const info = keyInfo(key);
  if (!info) throw unknownKey(key);
  const yaml = loadSettings(home).get(key);
  const old = oldFileValue(key);
  const envValue = info.env && !unset(env[info.env]) ? env[info.env]! : undefined;
  const lower: string[] = [];
  if (yaml !== undefined) lower.push(`parachute.yaml ${list(yaml)}`);
  if (old) lower.push(`${old.file} ${old.value}`);
  if (envValue !== undefined) return { key, value: envValue, source: "env", from: `env ${info.env}`, overrides: lower.length ? lower.join(", ") : undefined };
  if (yaml !== undefined) return { key, value: list(yaml), source: "parachute.yaml", from: "parachute.yaml", overrides: old ? `${old.file} ${old.value}` : undefined };
  if (old) return { key, value: old.value, source: "old file", from: `old file ${old.file}` };
  return { key, value: info.default, source: "default", from: "default" };
}

function line(e: Effective): string {
  const o = e.overrides ? `, overrides ${e.overrides}` : "";
  return `${e.key} = ${e.value} (${e.from}${o})`;
}

const USAGE = [
  "usage: parachute config get [key]",
  "       parachute config set <key> <value>",
  "       parachute config unset <key>",
  "",
  `The settings file is $PARACHUTE_HOME/${FILE_NAME}. Settings: ${[...FIXED_KEYS, "vaults.<name>.description"].join(", ")}.`,
  "An environment variable beats the file; `get` says which one is in force.",
].join("\n");

/** Every key worth listing: the fixed ones, and a description for each vault the file or the home has. */
function listedKeys(home: string): string[] {
  const names = new Set<string>(listVaults());
  for (const k of loadSettings(home).keys()) {
    const m = /^vaults\.([^.]+)\.description$/.exec(k);
    if (m) names.add(m[1]!);
  }
  return [...FIXED_KEYS, ...[...names].sort().map((n) => `vaults.${n}.description`)];
}

/** `parachute config …`. Returns the exit code: 0, or 2 for a bad key, value or file. */
export function configCommand(args: string[], home: string, env: NodeJS.ProcessEnv = process.env): number {
  const [verb, ...rest] = args;
  try {
    if (!verb || verb === "--help" || verb === "-h" || verb === "help") {
      console.log(USAGE);
      return verb ? 0 : 2;
    }
    if (verb === "get") {
      if (rest.length > 1) throw new SettingsError("get takes at most one key");
      for (const w of fileWarnings(readText(home))) console.error(`parachute config: ${w}`);
      for (const key of rest.length ? rest : listedKeys(home)) console.log(line(effective(home, key, env)));
      return 0;
    }
    if (verb === "set") {
      if (rest.length < 2) throw new SettingsError("usage: parachute config set <key> <value>");
      const [key, ...words] = rest;
      const stored = setSetting(home, key!, words.join(" "));
      const e = effective(home, key!, env);
      console.log(line(e));
      if (e.source === "env") console.log(`note: ${e.from} is set in this shell and wins over what was just written (${list(stored)}).`);
      return 0;
    }
    if (verb === "unset") {
      if (rest.length !== 1) throw new SettingsError("usage: parachute config unset <key>");
      const was = unsetSetting(home, rest[0]!);
      console.log(was ? `${rest[0]} removed from ${FILE_NAME}` : `${rest[0]} is not set in ${FILE_NAME}`);
      console.log(line(effective(home, rest[0]!, env)));
      return 0;
    }
    throw new SettingsError(`unknown command "${verb}". ${USAGE}`);
  } catch (err) {
    if (err instanceof SettingsError) {
      console.error(`parachute config: ${err.message}`);
      return 2;
    }
    throw err;
  }
}

export { SettingsError, checkValue, parse, readText };
