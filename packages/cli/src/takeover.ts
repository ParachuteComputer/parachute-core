// `parachute-core takeover` (v0.8 PLAN §8.0, lane E): v0.8's first run on a machine where the old hub and vault
// (0.7, `@openparachute/hub` / `@openparachute/vault`) already keep a home.
//
//   parachute-core takeover [--home <dir>] [--dry-run] [--yes] [--json]
//   parachute-core takeover --rollback [--home <dir>] [--yes] [--json]
//
// 1. Detect: the home (--home, PARACHUTE_HOME, ~/.parachute); the old programs installed (bun or npm globals, with
//    versions) or running (any process holding hub.db or a vault.db); their units (systemd user units, launchd
//    agents) with active and enabled state; each vault with its note count and schema; the hub's schema; the
//    migrations opening the home would run.
// 2. Say it in plain words. --dry-run stops here and changes nothing. Without --yes it asks (on a terminal).
// 3. On yes:
//    - refuse with exit 7, changing nothing, if an old process holds the data outside a unit it can pause (it
//      names the pid);
//    - pause the old units (stop, then disable; never mask, never edit their files), and wait until nothing holds
//      the data. On macOS an old launchd agent is unloaded (`launchctl bootout`) and its plist moved out of
//      ~/Library/LaunchAgents into the backup folder's launchd/, so it doesn't start at login (launchd.ts says which
//      agents are old; a cloudflared tunnel never is). Pausing comes before the backup so the backup is the bytes as
//      they rest, copied exactly;
//    - back up every file of the home to <home>/../parachute-takeover/<timestamp>/home/, with manifest.json (a
//      sha256 per file, checked against the copy);
//    - start v0.8 on the same home (a check run on a free loopback port, with the old issuer) and check every
//      answer: /api/ready, the issuer, every live signing key in the JWKS, and per vault a read pass, its note count
//      and a read; then stop it;
//    - write <home>/takeover.json (the record), and if a unit ran the old hub, hand the home to a new unit,
//      parachute-core.service (on macOS the launchd agent computer.parachute.core, with the old agent's environment),
//      and check it is up.
//    If a check fails it puts everything back (the backup too, when the check run migrated data) and exits 8.
// 4. The old programs stay installed, byte-identical, and off. Nothing is converted beyond the named migrations.
// 5. --rollback stops v0.8 (its unit; on macOS its agent, whose plist moves into the backup folder) and puts the old
//    units back as they were (an agent's plist back in ~/Library/LaunchAgents, loaded again if it was). Code-only when there were no
//    migrations, so every write made under v0.8 is kept; otherwise it first exports every note changed since the
//    takeover, then restores the backup.
//
// Exit codes: 0 done · 1 another error (nothing to roll back, a unit or agent it can't see) · 2 flags, or no --yes
// where nobody can be asked · 5 no room for the backup · 6 newer data (dispatch) · 7 an old process holds the data
// · 8 a check failed after start (it put everything back).
//
// `parachute-core serve` on a home the old programs still own, with no takeover record, refuses with exit 7 and says
// to run takeover (oldOwner(), called from dispatch).
import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dlopen, FFIType } from "bun:ffi";
import core from "../../../package.json" with { type: "json" };
import { databases, homeDir, readDatabase, schemaOf } from "./home.ts";
import { bundleRoot } from "./install.ts";
import {
  CORE_AGENT,
  LAUNCHD_PATH,
  agentEnabled,
  agentEnv,
  agentHome,
  agentLooksOld,
  parseLaunchctlList,
  plistComment,
  readAgentPlist,
  renderPlist,
  type PlistDict,
} from "./launchd.ts";

export const EXIT = { ok: 0, failed: 1, usage: 2, noRoom: 5, held: 7, checkFailed: 8 } as const;
export const RECORD_FILE = "takeover.json";
const CORE_UNIT = "parachute-core.service";
/** The first line of a core unit a takeover writes, followed by the home: rollback checks it before touching the unit. */
const CORE_UNIT_MARK = "written by parachute-core takeover for";
const CORE_ENTRY = fileURLToPath(new URL("./parachute-core.ts", import.meta.url));
/** The old programs' own unit names. Any other unit whose command runs the old hub or vault counts too. */
const OLD_UNIT_NAMES = new Set(["parachute-hub.service", "parachute-vault.service"]);
const OLD_COMMAND = /(^|[\s/])(parachute|parachute-vault) serve\b|@openparachute\/(hub|vault)\b/;

class Exit extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

// ── detection ────────────────────────────────────────────────────────────────────────────────────────────────

export interface OldProgram {
  name: "@openparachute/hub" | "@openparachute/vault";
  version: string;
  path: string;
  via: "bun" | "npm";
}

export interface Unit {
  name: string;
  manager: "systemd" | "launchd";
  active: boolean;
  enabled: boolean;
  file?: string;
  /** A launchd agent's process (0: loaded with none, or not loaded; `active` says whether it is loaded). */
  pid?: number;
  /** Runs the old hub or vault: the takeover pauses it. Other Parachute units (a tunnel, scribe) are left alone. */
  old: boolean;
  /**
   * Looks like the old hub or vault (its name or command), is enabled, but isn't running: what it serves can't be
   * seen, so takeover won't go ahead until it is started (and seen) or disabled.
   */
  unseen?: boolean;
}

export interface Holder {
  pid: number;
  cmd: string;
  /** The systemd unit (or Parachute launchd agent) the process belongs to, if any. */
  unit?: string;
  /** It also has another home's databases open (a hub.db or vault.db that isn't this home's). */
  other?: boolean;
}

export interface VaultInfo {
  name: string;
  notes: number;
  schema: number;
}

export interface Detected {
  home: string;
  old: { hub: OldProgram | null; vault: OldProgram | null };
  units: Unit[];
  running: Holder[];
  vaults: VaultInfo[];
  hub_schema: number | null;
  migrations: string[];
  rollback: "code-only" | "restore-backup";
  issuer: string;
  size_bytes: number;
  /**
   * Entries the backup can't copy as they are (links that lead out of the home, sockets): the takeover refuses while
   * there are any. A link that stays inside the home (a library's version links) is copied as a link.
   */
  uncopyable: string[];
  others: string[];
  /**
   * Registered modules whose command v0.8 won't find on the PATH it will run with (the old hub unit's, see
   * handOverEnv): its supervisor looks each command up there before starting it, so such a module never starts,
   * /api/ready stays false and the takeover's check fails (10-29).
   */
  unfound: { name: string; command: string }[];
  /** The old unit whose environment that PATH is (handOverUnit), or null: the caller's (no old unit is on). */
  path_from: string | null;
  record: Record_ | null;
}

interface Record_ {
  /**
   * "taking-over" is written before anything is paused and stays until the takeover ends either way, so a run that
   * was interrupted (an ssh drop, a reboot) is found and put back by the next takeover or --rollback.
   */
  state: "taking-over" | "taken-over" | "rolled-back";
  /**
   * How far a "taking-over" run got: "checking", v0.8 may have migrated the data; "handing-over", core's unit may also
   * have taken writes from clients (they are exported before any restore).
   */
  stage?: "pausing" | "backed-up" | "checking" | "handing-over";
  /** The process running a "taking-over" takeover: while it lives, another takeover leaves the home alone. */
  pid?: number;
  at: string;
  rolled_back_at?: string;
  /** Set once a rollback has restored the backup, so a retried rollback doesn't restore it again. */
  restored_at?: string;
  moved_aside?: string;
  version: string;
  home: string;
  backup: string;
  rollback: "code-only" | "restore-backup";
  migrations: string[];
  paused: Paused[];
  core_unit: string | null;
  /** Which manager core_unit is under; absent in records from before launchd agents were taken over: systemd. */
  core_manager?: "systemd" | "launchd";
  issuer: string;
}

/**
 * An old unit the takeover paused, as it was. systemd: `active` it ran (started again on the way back), `enabled` it
 * started at boot. launchd: `active` it ran with this home's data open (put back, it must have it open again),
 * `loaded` launchd had it loaded (bootstrapped again on the way back), `file` its plist in ~/Library/LaunchAgents and
 * `aside` where the takeover moved it (moved back on the way back).
 */
type Paused =
  | { name: string; manager: "systemd"; active: boolean; enabled: boolean }
  | { name: string; manager: "launchd"; active: boolean; enabled: boolean; loaded: boolean; file: string; aside: string };

const userHome = () => process.env.HOME || homedir();

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function pkgAt(dir: string, name: OldProgram["name"], via: "bun" | "npm"): OldProgram | null {
  const pkg = readJson(join(dir, "package.json"));
  return pkg?.name === name && typeof pkg.version === "string" ? { name, version: pkg.version, path: dir, via } : null;
}

/** The old hub and vault installed globally: bun's global folder, then npm's usual prefixes. */
export function oldInstalls(env: NodeJS.ProcessEnv = process.env): Detected["old"] {
  const places: [string, "bun" | "npm"][] = [
    [join(env.BUN_INSTALL || join(userHome(), ".bun"), "install", "global", "node_modules"), "bun"],
    ...[env.NPM_CONFIG_PREFIX, env.npm_config_prefix, join(userHome(), ".npm-global"), "/usr/local", "/usr", "/opt/homebrew"]
      .filter((p): p is string => !!p)
      .map((p) => [join(p, "lib", "node_modules"), "npm"] as [string, "npm"]),
  ];
  const find = (name: OldProgram["name"]) => {
    for (const [dir, via] of places) {
      const p = pkgAt(join(dir, name), name, via);
      if (p) return p;
    }
    return null;
  };
  return { hub: find("@openparachute/hub"), vault: find("@openparachute/vault") };
}

function run(argv: string[], opts: { env?: Record<string, string> } = {}): { code: number; stdout: string; stderr: string } {
  const bin = Bun.which(argv[0]!);
  if (!bin) return { code: 127, stdout: "", stderr: `${argv[0]}: not found` };
  const r = Bun.spawnSync([bin, ...argv.slice(1)], { env: { ...process.env, ...opts.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

const systemdUnitDir = () => join(process.env.XDG_CONFIG_HOME || join(userHome(), ".config"), "systemd", "user");

/**
 * Split an `Environment=` value into its assignments, for the plain forms only: words separated by whitespace, each
 * bare or wholly in "…" or '…'. Any backslash (systemd's escapes: \\x20, \\s, …) or quoting that doesn't close gives
 * undefined: the home is then "unknown", and callers take the safe side rather than guess.
 */
export function systemdWords(value: string): string[] | undefined {
  if (value.includes("\\")) return undefined;
  const out: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | undefined;
  for (const c of value) {
    if (quote) {
      if (c === quote) quote = undefined;
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) out.push(word);
      word = "";
      inWord = false;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote) return undefined;
  if (inWord) out.push(word);
  return out;
}

/**
 * The assignments in an environment file, read only when every line of it is unambiguous: blank, a comment (a line
 * starting with # or ;), or `KEY=value` on one line, with no backslash and either no quotes or one pair around the
 * whole value. Anything else (a value that goes on over lines, escapes, odd quoting) is null: unknown, because an
 * unrelated variable's text could then read as an assignment. The last assignment of a name wins, as in systemd.
 */
function envFileVars(body: string): Map<string, string> | null {
  const vars = new Map<string, string>();
  for (const line of body.split("\n")) {
    if (/^\s*$/.test(line) || /^\s*[#;]/.test(line)) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line); // no `export`: systemd isn't a shell
    if (!m) return null;
    const raw = m[2]!;
    if (raw.includes("\\") || raw.includes("$")) return null;
    let value = raw;
    const q = raw[0];
    if (q === '"' || q === "'") {
      if (raw.length < 2 || !raw.endsWith(q) || raw.slice(1, -1).includes(q)) return null;
      value = raw.slice(1, -1);
    } else if (/["']/.test(raw)) return null;
    vars.set(m[1]!, value);
  }
  return vars;
}

/** PARACHUTE_HOME from an environment file (see envFileVars): null when the file is ambiguous, undefined when unset. */
function envFileHome(body: string): string | undefined | null {
  const vars = envFileVars(body);
  return vars === null ? null : vars.get("PARACHUTE_HOME");
}

/** systemd's specifiers in a value: %h (the user's home) and %% (a percent); any other one is null: unknown. */
function specifiers(v: string): string | null {
  let out = "";
  for (let i = 0; i < v.length; i++) {
    if (v[i] !== "%") {
      out += v[i];
      continue;
    }
    const n = v[++i];
    if (n === "%") out += "%";
    else if (n === "h") out += userHome();
    else return null;
  }
  return out;
}

/**
 * The user manager's own environment, which every unit inherits, as `systemctl --user show-environment` prints it
 * (values as printed: one systemd had to quote reads `$'…'`); null when systemd can't say.
 */
function managerEnv(): Map<string, string> | null {
  const r = run(["systemctl", "--user", "show-environment"]);
  if (r.code !== 0) return null;
  const env = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) env.set(line.slice(0, i), line.slice(i + 1));
  }
  return env;
}

/**
 * The inside of a value systemd printed quoted, decoded: its backslash escapes are cescape_char's (`\\`, `\'`, `\"`,
 * the C escapes, other bytes as octal `\NNN` or `\xHH`) and, in the "…" form, `\$` and `` \` `` (SHELL_NEED_ESCAPE).
 * null for anything else, or for an unescaped `end` (the quoting ended early: not one value).
 */
function unescapeShown(body: string, end: string, also = ""): string | null {
  const C: Record<string, number> = { a: 7, b: 8, e: 27, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, "'": 39, '"': 34, "?": 63 };
  const chars = [...body];
  const bytes: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === end) return null;
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const n = chars[++i];
    if (n === undefined) return null;
    if (n in C) bytes.push(C[n]!);
    else if (also.includes(n)) bytes.push(n.charCodeAt(0));
    else if (/[0-7]/.test(n)) {
      let o = n;
      while (o.length < 3 && /[0-7]/.test(chars[i + 1] ?? "")) o += chars[++i];
      if (parseInt(o, 8) > 255) return null;
      bytes.push(parseInt(o, 8));
    } else if (n === "x" && /[0-9a-fA-F]/.test(chars[i + 1] ?? "")) {
      let h = chars[++i]!;
      if (/[0-9a-fA-F]/.test(chars[i + 1] ?? "")) h += chars[++i];
      bytes.push(parseInt(h, 16));
    } else return null;
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * A value as `systemctl show-environment` prints it, decoded: as it is, or (when it has a space, a quote, a glob
 * character, …) systemd's `$'…'` form (shell_maybe_quote with SHELL_ESCAPE_POSIX), see unescapeShown. null for
 * anything else, so the caller can say it couldn't be read.
 */
export function managerValue(v: string): string | null {
  if (!v.startsWith("$'")) return v;
  if (v.length < 3 || !v.endsWith("'")) return null;
  return unescapeShown(v.slice(2, -1), "'");
}

/** PARACHUTE_HOME in the user manager's own environment, which every unit inherits; null when systemd can't say. */
function managerHome(): string | undefined | null {
  const env = managerEnv();
  if (env === null) return null;
  const v = env.get("PARACHUTE_HOME");
  if (v === undefined) return undefined;
  return /[\\'"$]/.test(v) ? null : v;
}

/**
 * The home a unit serves, by systemd's rules (systemd.exec(5)), reading only what is unambiguous:
 *   - variables from `EnvironmentFile=` override `Environment=`, whatever the order of the lines; within each kind
 *     the last assignment wins; an empty `Environment=` or `EnvironmentFile=` resets that kind's list;
 *   - with neither, the user manager's environment, then ~/.parachute;
 *   - "unknown" for anything else: systemd escapes or odd quoting, specifiers other than %h and %%, an environment
 *     file it can't read whole (see envFileHome), `UnsetEnvironment=` or `PassEnvironment=` naming PARACHUTE_HOME,
 *     or a manager environment systemd won't report. Callers then take the safe side (never pause; serve refuses).
 */
export function unitHome(text: string, manager: () => string | undefined | null = managerHome): string | "unknown" {
  let fromEnv: string | undefined;
  let files: { path: string; optional: boolean }[] = [];
  let section = "";
  for (const line of text.split("\n")) {
    if (/^\s*[#;]/.test(line)) continue;
    // A continuation joins lines into one (systemd.syntax(7)): not read here.
    if (/\\\s*$/.test(line)) return "unknown";
    const head = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (head) {
      section = head[1]!;
      continue;
    }
    if (section !== "Service") continue; // Environment= counts only in [Service]
    if (/^\s*(UnsetEnvironment|PassEnvironment)\s*=.*\bPARACHUTE_HOME\b/.test(line)) return "unknown";
    if (/^\s*Exec\w*\s*=.*\bPARACHUTE_HOME\b/.test(line)) return "unknown"; // a command that sets it itself
    const env = /^\s*Environment\s*=\s*(.*)$/.exec(line)?.[1];
    if (env !== undefined) {
      if (env.trim() === "") fromEnv = undefined;
      const words = systemdWords(env);
      if (!words) return "unknown";
      for (const w of words) {
        if (!w.startsWith("PARACHUTE_HOME=")) continue;
        const v = specifiers(w.slice("PARACHUTE_HOME=".length));
        if (v === null || v.includes("$")) return "unknown";
        fromEnv = v;
      }
      continue;
    }
    const file = /^\s*EnvironmentFile\s*=\s*(.*)$/.exec(line)?.[1]?.trim();
    if (file !== undefined) {
      if (file === "") {
        files = [];
        continue;
      }
      const path = specifiers(file.replace(/^-/, ""));
      if (path === null) return "unknown";
      files.push({ path, optional: file.startsWith("-") });
    }
  }
  let fromFiles: string | undefined;
  for (const f of files) {
    let body: string;
    try {
      body = readFileSync(f.path, "utf8");
    } catch {
      if (f.optional && !existsSync(f.path)) continue; // systemd skips a missing optional file
      return "unknown";
    }
    const v = envFileHome(body);
    if (v === null) return "unknown";
    if (v !== undefined) fromFiles = v;
  }
  // An explicit empty value is set (the program then uses ~/.parachute, as configDir does); only an absent one falls
  // through to the manager's environment.
  const set = fromFiles ?? fromEnv;
  if (set !== undefined) return set || join(userHome(), ".parachute");
  const fromManager = manager();
  if (fromManager === null) return "unknown";
  return fromManager || join(userHome(), ".parachute");
}

/**
 * The home a running process was given: PARACHUTE_HOME in /proc/<pid>/environ, else its HOME's .parachute (the
 * hub's and vault's configDir). undefined when it can't be read (not Linux, another user's process).
 */
function processHome(pid: number): string | undefined {
  try {
    const vars = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    const get = (k: string) => vars.find((v) => v.startsWith(`${k}=`))?.slice(k.length + 1);
    const set = get("PARACHUTE_HOME");
    if (set) return set;
    const home = get("HOME");
    return home ? join(home, ".parachute") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Does the unit serve `home`? `unsure` is the answer when its home can't be established: false where serving would
 * mean pausing it (never pause what may be another home's), true where it would mean refusing to start (serve).
 */
function unitServes(text: string, home: string, unsure: boolean): boolean {
  const theirs = unitHome(text);
  if (theirs === "unknown") return unsure;
  return sameHome(theirs, home);
}

function sameHome(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

/**
 * The unit's effective configuration: systemd's own `cat` (the unit file and every drop-in, wherever they are; a
 * later PARACHUTE_HOME overrides an earlier one). Only when systemd can't say, the user folder's file and drop-ins.
 */
function unitText(name: string): string {
  const cat = run(["systemctl", "--user", "cat", name]);
  if (cat.code === 0 && /^\[Service\]/m.test(cat.stdout)) return cat.stdout;
  const dir = systemdUnitDir();
  let text = "";
  try {
    text = readFileSync(join(dir, name), "utf8");
  } catch {
    return "";
  }
  try {
    for (const f of readdirSync(join(dir, `${name}.d`)).sort()) if (f.endsWith(".conf")) text += `\n${readFileSync(join(dir, `${name}.d`, f), "utf8")}`;
  } catch {}
  return text;
}

/** Does the unit run the old hub or vault (by its name, unless its command is core's; or by its command)? */
function runsOld(name: string, text: string): boolean {
  const execs = text.split("\n").filter((l) => /^\s*ExecStart\s*=/.test(l)).join("\n");
  if (/parachute-core/.test(execs)) return false;
  return OLD_UNIT_NAMES.has(name) || OLD_COMMAND.test(execs);
}

/** The names of Parachute's systemd user units (core's own included), from the user folder and systemd's list. */
function parachuteUnitNames(): string[] {
  if (process.platform !== "linux" || !Bun.which("systemctl")) return [];
  const names = new Set<string>();
  try {
    for (const f of readdirSync(systemdUnitDir())) if (/^parachute[\w@.-]*\.service$/.test(f)) names.add(f);
  } catch {}
  for (const line of run(["systemctl", "--user", "list-unit-files", "--no-legend", "--no-pager", "parachute*"]).stdout.split("\n")) {
    const m = /^(parachute[\w@.-]*\.service)\s/.exec(line.trim());
    if (m) names.add(m[1]!);
  }
  return [...names].sort();
}

/** Parachute's systemd user units (not core's own), with state; and which of them run the old programs on `home`. */
function systemdUnits(home: string, held: Holder[]): Unit[] {
  if (process.platform !== "linux" || !Bun.which("systemctl")) return [];
  const names = new Set<string>();
  const dir = systemdUnitDir();
  try {
    for (const f of readdirSync(dir)) if (/^parachute[\w@.-]*\.service$/.test(f)) names.add(f);
  } catch {}
  const listed = run(["systemctl", "--user", "list-unit-files", "--no-legend", "--no-pager", "parachute*"]);
  for (const line of listed.stdout.split("\n")) {
    const m = /^(parachute[\w@.-]*\.service)\s/.exec(line.trim());
    if (m) names.add(m[1]!);
  }
  names.delete(CORE_UNIT);
  const out: Unit[] = [];
  for (const name of [...names].sort()) {
    const file = existsSync(join(dir, name)) ? join(dir, name) : undefined;
    const text = unitText(name);
    const state = run(["systemctl", "--user", "is-active", name]).stdout.trim();
    const active = state === "active";
    const enabled = run(["systemctl", "--user", "is-enabled", name]).stdout.trim() === "enabled";
    // Paused only on evidence: a process of this unit has this home's databases open (holders(): by device and
    // inode). What its configuration says decides nothing here; that can't be read reliably (wrappers, bind mounts,
    // working directories, systemd's grammar).
    const running = !["inactive", "failed", "unknown", ""].includes(state);
    const holds = held.some((h) => h.unit === name);
    const looksOld = runsOld(name, text);
    out.push({
      name,
      manager: "systemd",
      active,
      enabled,
      ...(file ? { file } : {}),
      old: holds,
      ...(looksOld && !holds && !running && enabled ? { unseen: true } : {}),
    });
  }
  return out;
}

// ── launchd (macOS) ──────────────────────────────────────────────────────────────────────────────────────────
// Looked for wherever there is a `launchctl`: macOS (/bin/launchctl), or the contracts' fake one on Linux. A Linux box
// has none, so nothing here runs there.

const agentsDir = () => join(userHome(), "Library", "LaunchAgents");
const coreAgentFile = () => join(agentsDir(), `${CORE_AGENT}.plist`);

function launchctlBin(): string | null {
  return Bun.which("launchctl") ?? (process.platform === "darwin" && existsSync("/bin/launchctl") ? "/bin/launchctl" : null);
}

const launchdHere = () => launchctlBin() !== null;
/** The domain a person's agents load into (the one ~/Library/LaunchAgents loads into at login). */
const guiDomain = () => `gui/${process.getuid?.() ?? 501}`;

function launchctl(...args: string[]): { code: number; stdout: string; stderr: string } {
  const bin = launchctlBin();
  return bin ? run([bin, ...args]) : { code: 127, stdout: "", stderr: "launchctl: not found" };
}

/** Every loaded launchd job with its pid (0: none), from `launchctl list`; null when launchctl can't say. */
function launchdJobs(): Map<string, number> | null {
  if (!launchdHere()) return null;
  const r = launchctl("list");
  return r.code === 0 ? parseLaunchctlList(r.stdout) : null;
}

interface AgentFile {
  label: string;
  file: string;
  /** null: not an XML plist with a top-level dict (binary, or not well formed): its home can't be read. */
  plist: PlistDict | null;
}

/** Parachute's agents in ~/Library/LaunchAgents (a plist whose name has "parachute" in it), core's own not included. */
function agentFiles(): AgentFile[] {
  if (!launchdHere()) return [];
  let names: string[] = [];
  try {
    names = readdirSync(agentsDir()).filter((f) => /parachute/i.test(f) && f.endsWith(".plist"));
  } catch {}
  const out: AgentFile[] = [];
  for (const f of names.sort()) {
    const file = join(agentsDir(), f);
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {}
    const plist = readAgentPlist(text);
    const label = typeof plist?.Label === "string" ? plist.Label : f.replace(/\.plist$/, "");
    if (label !== CORE_AGENT) out.push({ label, file, plist });
  }
  return out;
}

/**
 * Parachute's launchd agents, with state, and which of them run the old programs on `home`: the same evidence as
 * systemd's (a process of the agent has this home's data open), and one thing more, since a plist is the whole of an
 * agent's configuration: an agent that isn't running but whose plist starts the old program itself on this home at
 * login (agentHome) is paused too, so it can't start beside v0.8 at the next login. One that looks old and isn't
 * running, whose home its plist doesn't say (a wrapper script, an unreadable plist), is `unseen`: takeover refuses.
 * Any other agent (a cloudflared tunnel, a backup schedule) is left alone, whatever its name.
 */
function launchdUnits(home: string, held: Holder[]): Unit[] {
  const files = agentFiles();
  if (!files.length) return [];
  const jobs = launchdJobs();
  return files.map((a) => {
    const loaded = jobs?.has(a.label) ?? false;
    const pid = jobs?.get(a.label) ?? 0;
    const enabled = agentEnabled(a.plist);
    const holds = held.some((h) => h.unit === a.label);
    const looksOld = agentLooksOld(a.label, a.plist);
    const theirs = agentHome(a.plist, userHome());
    // Not running (or launchctl can't say), so only its plist can tell what it would serve at login.
    const idle = !holds && (pid === 0 || jobs === null) && looksOld && enabled;
    const atLogin = idle && jobs !== null && theirs !== "unknown" && sameHome(theirs, home);
    return {
      name: a.label,
      manager: "launchd" as const,
      active: loaded,
      enabled,
      file: a.file,
      pid,
      old: holds || atLogin,
      ...(idle && (jobs === null || theirs === "unknown") ? { unseen: true } : {}),
    };
  });
}

/** The pid of every loaded Parachute agent (core's own included) that has a process: holders are attributed to them. */
function agentRoots(): [string, number][] {
  if (!launchdHere()) return [];
  const labels = new Set([...agentFiles().map((a) => a.label), CORE_AGENT]);
  return [...(launchdJobs() ?? new Map<string, number>())].filter(([label, pid]) => labels.has(label) && pid > 0);
}

/** The home named on the mark comment of core's agent plist, if it has one (as writeCoreAgent wrote it). */
function coreAgentMark(): string | undefined {
  try {
    const c = plistComment(readFileSync(coreAgentFile(), "utf8")) ?? "";
    if (!c.startsWith(`${CORE_UNIT_MARK} `)) return undefined;
    const m = /^"(?:[^"\\]|\\.)*"/.exec(c.slice(CORE_UNIT_MARK.length + 1));
    return m ? (JSON.parse(m[0]) as string) : undefined;
  } catch {
    return undefined;
  }
}

/** Move a file (a plist) to `to`, making its folder; across file systems by copy, then removing the original. */
function moveFile(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

/** Where a file goes in `dir` without replacing one there: its own name, else with a time on it. */
function freeName(dir: string, name: string): string {
  const p = join(dir, name);
  return existsSync(p) ? join(dir, `${name}.${stamp()}`) : p;
}

/** Every SQLite file of the home's databases (with -wal and -shm). */
function dataFiles(home: string): string[] {
  let real = home;
  try {
    real = realpathSync(home); // /proc/<pid>/fd links name real paths
  } catch {}
  const dbs = databases(home, { hub: 0, vault: 0 }).map((d) => join(real, d.rel));
  return dbs.flatMap((d) => [d, `${d}-wal`, `${d}-shm`]);
}

/** Processes (not this one) holding any of the home's databases open, with the systemd unit each belongs to. */
export function holders(home: string): Holder[] {
  const files = dataFiles(home);
  const out: Holder[] = [];
  if (process.platform === "linux") {
    // Compared by device and inode, read through /proc/<pid>/fd: the open file itself, whatever path, symlink, bind
    // mount or working directory the process reached it by.
    const ids = new Set<string>();
    for (const f of files) {
      try {
        const st = statSync(f);
        ids.add(`${st.dev}:${st.ino}`);
      } catch {}
    }
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      let fds: string[] = [];
      try {
        fds = readdirSync(`/proc/${name}/fd`);
      } catch {
        continue;
      }
      let holds = false;
      let other = false;
      for (const fd of fds) {
        let st;
        try {
          st = statSync(`/proc/${name}/fd/${fd}`);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        if (ids.has(`${st.dev}:${st.ino}`)) holds = true;
        else {
          let link = "";
          try {
            link = readlinkSync(`/proc/${name}/fd/${fd}`);
          } catch {}
          if (/(^|\/)(hub|vault)\.db(-wal|-shm)?$/.test(link)) other = true;
        }
      }
      if (!holds) continue;
      let cmd = "";
      let unit: string | undefined;
      try {
        cmd = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").join(" ").trim();
      } catch {}
      try {
        // The innermost service in the cgroup path (…/user@1000.service/app.slice/parachute-hub.service): the
        // user's own manager (user@<uid>.service) is never the unit that runs it.
        const services = [...readFileSync(`/proc/${name}/cgroup`, "utf8").matchAll(/\/([\w@.-]+\.service)(?=\/|$)/gm)].map((m) => m[1]!);
        unit = services.filter((u) => !u.startsWith("user@")).pop();
      } catch {}
      out.push({ pid: Number(name), cmd, ...(unit ? { unit } : {}), ...(other ? { other } : {}) });
    }
    return out;
  }
  const existing = files.filter((f) => existsSync(f));
  if (existing.length === 0 || !Bun.which("lsof")) return out;
  const r = run(["lsof", "-t", ...existing]);
  for (const pid of new Set(r.stdout.split(/\s+/).filter(Boolean).map(Number))) {
    if (pid === process.pid) continue;
    out.push({ pid, cmd: run(["ps", "-o", "command=", "-p", String(pid)]).stdout.trim() });
  }
  return out;
}

/** The parent of every process (Linux: /proc; elsewhere `ps`). */
function parents(): Map<number, number> {
  const parent = new Map<number, number>();
  if (process.platform !== "linux") {
    for (const line of run(["ps", "-A", "-o", "pid=", "-o", "ppid="]).stdout.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (m) parent.set(Number(m[1]), Number(m[2]));
    }
    return parent;
  }
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      parent.set(Number(name), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch {}
  }
  return parent;
}

/** Every process of a unit: its MainPID and descendants, and every process its cgroup names as the unit. */
function unitProcesses(unit: string): number[] {
  const out = new Set<number>();
  const root = mainPid(unit);
  const parent = parents();
  for (const pid of parent.keys()) {
    for (let p: number | undefined = pid, hops = 0; root > 0 && p && p > 1 && hops < 64; p = parent.get(p), hops++) {
      if (p === root) {
        out.add(pid);
        break;
      }
    }
    try {
      const services = [...readFileSync(`/proc/${pid}/cgroup`, "utf8").matchAll(/\/([\w@.-]+\.service)(?=\/|$)/gm)].map((m) => m[1]!);
      if (services.filter((u) => !u.startsWith("user@")).pop() === unit) out.add(pid);
    } catch {}
  }
  return [...out];
}

/**
 * Is it safe to stop and disable `unit` for `home`? Each of its processes (not only the ones holding this home's data)
 * is checked for another home's databases, and systemd must answer, completely, which other units a stop or disable
 * would reach (`allowed` may be reached). A launchd agent reaches no other agent: only its processes are checked.
 * Returns what is wrong, or null.
 */
function unsafeToStop(unit: string, home: string, allowed: Set<string>, manager: Unit["manager"] = "systemd"): string | null {
  if (manager === "launchd") return otherHomeDb(unit, agentProcesses(unit), home);
  return otherHomeDb(unit, unitProcesses(unit), home) ?? reachOf(unit, allowed);
}

/** Every process of a launchd agent: its pid and that pid's descendants. */
function agentProcesses(label: string): number[] {
  const root = launchdJobs()?.get(label) ?? 0;
  if (root <= 0) return [];
  const parent = parents();
  const out: number[] = [];
  for (const pid of parent.keys()) {
    for (let p: number | undefined = pid, hops = 0; p && p > 1 && hops < 64; p = parent.get(p), hops++) {
      if (p === root) {
        out.push(pid);
        break;
      }
    }
  }
  return out;
}

/**
 * Does any of `pids` have another home's database (a hub.db or vault.db that isn't this home's) open? What is wrong, or
 * null. Compared by device and inode: Linux reads each open file through /proc; elsewhere `lsof` names it.
 */
function otherHomeDb(unit: string, pids: number[], home: string): string | null {
  if (!pids.length) return null;
  const ours = new Set<string>();
  for (const f of dataFiles(home)) {
    try {
      const st = statSync(f);
      ours.add(`${st.dev}:${st.ino}`);
    } catch {}
  }
  const isDb = (p: string) => /(^|\/)(hub|vault)\.db(-wal|-shm)?$/.test(p);
  const theirs = (pid: number, path: string) => `${unit} also has another home's database open (pid ${pid}: ${path}); stopping it would stop that home too`;
  if (process.platform === "linux") {
    for (const pid of pids) {
      let fds: string[] = [];
      try {
        fds = readdirSync(`/proc/${pid}/fd`);
      } catch {
        continue;
      }
      for (const fd of fds) {
        try {
          const link = readlinkSync(`/proc/${pid}/fd/${fd}`);
          if (!isDb(link)) continue;
          const st = statSync(`/proc/${pid}/fd/${fd}`);
          if (!ours.has(`${st.dev}:${st.ino}`)) return theirs(pid, link);
        } catch {}
      }
    }
    return null;
  }
  // lsof -F: "p<pid>" starts each process, "n<name>" each open file.
  const r = run(["lsof", "-n", "-P", "-F", "pn", "-p", pids.join(",")]);
  let pid = 0;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && isDb(line.slice(1))) {
      try {
        const st = statSync(line.slice(1));
        if (!ours.has(`${st.dev}:${st.ino}`)) return theirs(pid, line.slice(1));
      } catch {
        return theirs(pid, line.slice(1)); // open, but not where its name says: not provably this home's
      }
    }
  }
  return null;
}

/**
 * Which other units a stop or disable of `unit` would reach, as systemd says (and its [Install] Also=): what is wrong,
 * or null when it reaches none outside `allowed`, and systemd answered completely.
 */
function reachOf(unit: string, allowed: Set<string>): string | null {
  // RequiredBy/BoundBy/ConsistsOf every systemd reports; PropagatesStopTo (v249) and UpheldBy (v248) only newer ones,
  // and one that doesn't know them can't have them set. `Also=` is an [Install] line, not a property: read from the
  // unit's effective text.
  const must = ["RequiredBy", "BoundBy", "ConsistsOf"];
  const keys = [...must, "PropagatesStopTo", "UpheldBy"];
  const r = run(["systemctl", "--user", "show", unit, ...keys.flatMap((k) => ["-p", k])]);
  const got = new Map(r.stdout.split("\n").map((l) => /^(\w+)=(.*)$/.exec(l.trim())).filter((m): m is RegExpExecArray => !!m).map((m) => [m[1]!, m[2]!]));
  if (r.code !== 0 || must.some((k) => !got.has(k))) return `systemd didn't say which units stopping ${unit} would reach (systemctl show exited ${r.code})`;
  const also = unitText(unit)
    .split("\n")
    .flatMap((l) => (/^\s*Also\s*=\s*(.*)$/.exec(l)?.[1] ?? "").split(/\s+/));
  const reach = [...keys.flatMap((k) => (got.get(k) ?? "").split(/\s+/)), ...also].filter((x) => x && !allowed.has(x) && x !== unit && x !== "default.target");
  return reach.length ? `stopping or disabling ${unit} would also reach ${reach.join(", ")}` : null;
}

/**
 * holders(), each attributed to the unit whose main process it is or descends from (a unit's MainPID and its children
 * are its processes, as its cgroup holds them); a holder of none of `units` keeps its cgroup's unit.
 */
export function heldBy(home: string, units: string[]): Holder[] {
  const held = holders(home);
  if (held.length === 0) return held;
  // systemd units (as asked) on Linux; and every Parachute launchd agent that has a process, wherever launchctl is.
  const roots = [...(process.platform === "linux" ? units.map((u) => [u, mainPid(u)] as [string, number]) : []), ...agentRoots()].filter(([, pid]) => pid > 0);
  if (!roots.length) return held;
  const parent = parents();
  for (const h of held) {
    for (let p: number | undefined = h.pid, hops = 0; p && p > 1 && hops < 64; p = parent.get(p), hops++) {
      const root = roots.find(([, pid]) => pid === p);
      if (root) {
        h.unit = root[0];
        break;
      }
    }
  }
  return held;
}

/** A query on a database without changing a byte of the home (home.ts readDatabase: immutable, or a scratch link). */
function readOnly<T>(path: string, q: (db: Database) => T): T {
  return readDatabase(path, q, dirname(dirname(path)));
}

function treeSize(root: string): number {
  let n = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) n += st.size;
    }
  };
  if (existsSync(root)) walk(root);
  return n;
}

function readRecord(home: string): Record_ | null {
  const r = readJson(join(home, RECORD_FILE));
  return r && (r.state === "taking-over" || r.state === "taken-over" || r.state === "rolled-back") ? (r as Record_) : null;
}

/** Is `dir` inside this program's own install (so a services.json row pointing there is core's, not the old one's)? */
function ours(dir: string): boolean {
  const mine = resolve(import.meta.dir, "..", "..", "..");
  try {
    const real = realpathSync(dir);
    const root = realpathSync(mine);
    return real === root || real.startsWith(`${root}/`);
  } catch {
    return false;
  }
}

/**
 * Whether the old programs still own `home`, for `serve`'s refusal: the home has data, no takeover has been done
 * (or it was rolled back), and either a services.json row points at an old install outside this program, or an
 * old hub or vault unit exists. Cheap: files only, no process scan or unit manager call.
 */
export function oldOwner(home: string): string | null {
  const hasData = databases(home, { hub: 0, vault: 0 }).length > 0;
  if (!hasData) return null;
  if (readRecord(home)?.state === "taken-over") return null;
  const why: string[] = [];
  const rows = readJson(join(home, "services.json"))?.services;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const dir = typeof row?.installDir === "string" ? row.installDir : undefined;
      // Any copy of core's own vault (an older bundle copy under .store/ included) is 0.8, not an old program.
      if (!dir || !existsSync(join(dir, "package.json")) || ours(dir) || existsSync(join(dir, "..", "cli", "src", "parachute-core.ts"))) continue;
      const pkg = readJson(join(dir, "package.json"));
      if (pkg?.name === "@openparachute/hub" || pkg?.name === "@openparachute/vault") why.push(`${pkg.name} ${pkg.version} in ${dir}`);
    }
  }
  for (const name of OLD_UNIT_NAMES) {
    if (!existsSync(join(systemdUnitDir(), name))) continue;
    const text = unitText(name);
    if (runsOld(name, text) && unitServes(text, home, true)) why.push(`the unit ${name}`);
  }
  // An agent that looks like the old hub or vault and serves this home by its plist, or might (a wrapper).
  for (const a of agentFiles()) {
    if (!agentLooksOld(a.label, a.plist)) continue;
    const theirs = agentHome(a.plist, userHome());
    if (theirs === "unknown" || sameHome(theirs, home)) why.push(`the launchd agent ${a.label}`);
  }
  return why.length ? [...new Set(why)].join(", ") : null;
}

/** Everything step 1 finds, changing nothing. */
export async function detect(home: string): Promise<Detected> {
  const { HUB_SCHEMA_VERSION } = await import("@openparachute/hub/src/hub-db.ts");
  const { SCHEMA_VERSION } = await import("@openparachute/vault/core/src/schema.ts");
  const { resolveHubIssuer } = await import("@openparachute/hub/src/hub-issuer.ts");
  const held = heldBy(home, parachuteUnitNames());
  const vaults: VaultInfo[] = [];
  const migrations: string[] = [];
  let hubSchema: number | null = null;
  for (const d of databases(home, { hub: HUB_SCHEMA_VERSION, vault: SCHEMA_VERSION })) {
    const path = join(home, d.rel);
    const schema = schemaOf(path, dirname(home)) ?? 0;
    if (d.rel === "hub.db") {
      hubSchema = schema;
      if (schema < HUB_SCHEMA_VERSION) migrations.push(`hub.db: schema ${schema} → ${HUB_SCHEMA_VERSION}`);
      continue;
    }
    const name = basename(dirname(path));
    const notes = readOnly(path, (db) => (db.query("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n);
    vaults.push({ name, notes, schema });
    if (schema < SCHEMA_VERSION) migrations.push(`vault ${name}: schema ${schema} → ${SCHEMA_VERSION}`);
    if (!d.rel.startsWith(join("vault", "data"))) migrations.push(`vault ${name}: moved from ${dirname(d.rel)} to vault/data/${name}`);
  }
  const rows = readJson(join(home, "services.json"))?.services;
  const moduleRows: any[] = Array.isArray(rows) ? rows.filter((r: any) => r?.name && r.name !== "parachute-vault" && r.name !== "parachute-hub") : [];
  const others = moduleRows.map((r) => String(r.name));
  const units = [...systemdUnits(home, held), ...launchdUnits(home, held)];
  const record = readRecord(home);
  const from = handOverUnit(units, record?.state === "taking-over" ? record.paused : []);
  return {
    home,
    old: oldInstalls(),
    units,
    running: held,
    vaults,
    hub_schema: hubSchema,
    migrations,
    rollback: migrations.length ? "restore-backup" : "code-only",
    issuer: resolveHubIssuer(undefined, home),
    size_bytes: treeSize(home),
    uncopyable: entries(home).other,
    others,
    unfound: await unfoundModules(moduleRows, corePath(handOverEnv(from).env.PATH ?? "")),
    path_from: from?.name ?? null,
    record,
  };
}

/**
 * The rows whose start command v0.8's supervisor won't find: it resolves the command the way boot does (resolveSpec)
 * and looks it up with Bun.which on the PATH the process started with (a PATH changed later isn't seen), so `path` is
 * the one v0.8 starts with. A row with no command to start (or one that can't be read) isn't counted.
 */
async function unfoundModules(rows: any[], path: string): Promise<{ name: string; command: string }[]> {
  const out: { name: string; command: string }[] = [];
  if (!rows.length) return out;
  const { resolveSpec } = await import("@openparachute/hub/src/commands/serve-boot.ts");
  const { shortNameForManifest } = await import("@openparachute/hub/src/service-spec.ts");
  for (const row of rows) {
    const name = String(row.name);
    let command: string | undefined;
    try {
      command = (await resolveSpec(shortNameForManifest(name) ?? name, row))?.startCmd?.(row)?.[0];
    } catch {}
    if (command && Bun.which(command, { PATH: path }) === null) out.push({ name, command });
  }
  return out;
}

// ── plain words ──────────────────────────────────────────────────────────────────────────────────────────────

const tilde = (p: string) => (p.startsWith(userHome() + "/") ? `~/${p.slice(userHome().length + 1)}` : p);

function size(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

/** The units an interrupted takeover paused (its record still says "taking-over"): they are put back first. */
const cutOff = (d: Detected) => (d.record?.state === "taking-over" ? d.record.paused.map((u) => u.name) : []);

function plan(d: Detected): string[] {
  const back = cutOff(d);
  const cut = d.record?.state === "taking-over" ? d.record.paused : [];
  const managed = [...d.units.filter((u) => u.old).map((u) => [u.name, u.manager] as const), ...cut.map((u) => [u.name, u.manager] as const)];
  const pause = (m: Unit["manager"]) => [...new Set(managed.filter(([, x]) => x === m).map(([n]) => n))];
  const [units, agents] = [pause("systemd"), pause("launchd")];
  const backupRoot = tilde(join(dirname(d.home), "parachute-takeover"));
  const steps = [
    ...(back.length ? [`put ${back.join(" and ")} back as before, since the interrupted takeover paused ${back.length === 1 ? "it" : "them"}`] : []),
    ...(units.length ? [`pause ${units.join(" and ")} (stop and disable; the unit files stay)`] : []),
    ...(agents.length
      ? [`pause ${agents.join(" and ")} (unload, and move ${agents.length === 1 ? "its plist" : "their plists"} out of ~/Library/LaunchAgents into ${backupRoot}/<time>/launchd/, so ${agents.length === 1 ? "it doesn't" : "they don't"} start at login; rollback moves ${agents.length === 1 ? "it" : "them"} back)`]
      : []),
    ...(units.length || agents.length ? [] : ["nothing to pause: no old unit is on"]),
    `back up the home to ${backupRoot}/<time>/, with a sha256 for every file`,
    `start v0.8 (${core.name} ${core.version}) on the same home and check every vault answers with the same notes`,
  ];
  const from = handOverUnit(d.units, cut);
  if (from?.manager === "systemd") steps.push(`run it from now on as ${CORE_UNIT}`);
  if (from?.manager === "launchd") steps.push(`run it from now on as the launchd agent ${CORE_AGENT} (${tilde(coreAgentFile())}, with ${from.name}'s environment)`);
  steps.push("leave the old programs installed, as they are, and off");
  return steps;
}

const agentState = (u: Unit) =>
  `${u.active ? (u.pid ? `running (pid ${u.pid})` : "loaded, not running") : "not loaded"}, ${u.enabled ? "loads at login" : "off at login (Disabled)"}`;

function agentWhy(u: Unit, cut: string[]): string {
  if (u.old && u.pid) return " (has this home's data open: it will be paused, its plist moved aside)";
  if (u.old) return " (not running, but its plist starts the old programs on this home at login: its plist will be moved aside)";
  if (cut.includes(u.name)) return " (paused by the interrupted takeover: put back first, then paused again)";
  if (u.unseen) return " (looks like the old hub or vault, but isn't running and its plist doesn't say which home it serves: load it, or move it out of ~/Library/LaunchAgents, before taking over)";
  return " (doesn't have this home's data open: left alone)";
}

export function describe(d: Detected): string {
  const lines: string[] = [];
  const prog = (p: OldProgram | null, what: string) => (p ? `${what} ${p.version}` : null);
  const found = [prog(d.old.hub, "hub"), prog(d.old.vault, "vault")].filter(Boolean);
  const where = [...new Set([d.old.hub, d.old.vault].filter((p): p is OldProgram => !!p).map((p) => tilde(p.path.split("/install/global/")[0]!.split("/lib/node_modules/")[0]!)))];
  lines.push(found.length ? `Found Parachute ${found.join(" and ")} installed in ${where.join(" and ")}.` : "No old Parachute programs are installed globally (bun or npm).");
  for (const u of d.units) {
    if (u.manager === "launchd") {
      lines.push(`  launchd agent ${u.name}: ${agentState(u)}${agentWhy(u, cutOff(d))}`);
      continue;
    }
    const state = `${u.active ? "running" : "not running"}, ${u.enabled ? "starts at login" : "off at login"}`;
    const why = u.old
      ? " (has this home's data open: it will be paused)"
      : cutOff(d).includes(u.name)
        ? " (paused by the interrupted takeover: put back first, then paused again)"
        : u.unseen
        ? " (enabled but not running, so which home it serves can't be seen: start it, or disable it, before taking over)"
        : " (doesn't have this home's data open: left alone)";
    lines.push(`  ${u.manager} unit ${u.name}: ${state}${why}`);
  }
  for (const h of d.running) lines.push(`  process ${h.pid} has the data open${h.unit ? ` (${h.unit})` : ""}: ${h.cmd.slice(0, 120)}`);
  const notes = d.vaults.reduce((n, v) => n + v.notes, 0);
  lines.push(`The home ${tilde(d.home)} holds ${d.vaults.length} vault${d.vaults.length === 1 ? "" : "s"} (${size(d.size_bytes)}):`);
  for (const v of d.vaults) lines.push(`  ${v.name}: ${v.notes} notes, schema ${v.schema}`);
  if (d.vaults.length > 1) lines.push(`  ${notes} notes in all`);
  if (d.hub_schema !== null) lines.push(`  hub.db: schema ${d.hub_schema}`);
  // Seen in rehearsals: core's supervisor boots these rows as the old hub did (the app, scribe), with the program installed beside the old hub.
  if (d.others.length) lines.push(`Also registered: ${d.others.join(", ")}. v0.8 starts ${d.others.length === 1 ? "it" : "them"} from services.json as the old hub did, with the installed program, which stays as it is.`);
  const from = d.path_from;
  for (const u of d.unfound) {
    lines.push(`Warning: v0.8 won't find \`${u.command}\` (${u.name}) on the PATH it will run with (${from ? `${from}'s` : "this shell's"}), so it can't start ${u.name}, and the takeover's check will fail and put everything back. Install it there, or set PATH in ${from ?? "this shell"}${from ? " (a drop-in)" : ""}, then look again.`);
  }
  if (d.migrations.length === 0) {
    lines.push("v0.8 will use this data as it is: nothing is converted. Going back is starting the old programs again (`parachute-core takeover --rollback`).");
  } else {
    lines.push("Opening this home with v0.8 runs these migrations:");
    for (const m of d.migrations) lines.push(`  ${m}`);
    lines.push("Going back means restoring the backup: `parachute-core takeover --rollback` exports every note changed since, then restores it.");
  }
  if (d.uncopyable.length) lines.push(`The home has ${d.uncopyable.length} entr${d.uncopyable.length === 1 ? "y" : "ies"} the backup can't copy as ${d.uncopyable.length === 1 ? "it is" : "they are"} (links out of it, or sockets): ${d.uncopyable.slice(0, 5).join(", ")}. Takeover won't go ahead until ${d.uncopyable.length === 1 ? "it is" : "they are"} replaced by the real files.`);
  if (d.record?.state === "taken-over") lines.push(`This home was already taken over on ${d.record.at} (backup ${tilde(d.record.backup)}).`);
  if (d.record?.state === "taking-over") {
    const units = d.record.paused.map((u) => u.name).join(" and ") || "the old programs";
    const restoring = (d.record.stage === "checking" || d.record.stage === "handing-over") && d.record.migrations.length > 0 && d.record.backup && !d.record.restored_at;
    lines.push(`A takeover of this home started on ${d.record.at} was interrupted. Taking over (or --rollback) first puts ${units} back as ${d.record.paused.length === 1 ? "it was" : "they were"}${restoring ? `, restoring the backup ${tilde(d.record.backup)} since v0.8 may have started migrating the data` : ""}.`);
  }
  lines.push("With your yes, it will:");
  for (const s of plan(d)) lines.push(`  - ${s}`);
  return lines.join("\n");
}

// ── doing it ─────────────────────────────────────────────────────────────────────────────────────────────────

function parseFlags(args: string[]) {
  const f = { home: undefined as string | undefined, dryRun: false, yes: false, json: false, rollback: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dry-run") f.dryRun = true;
    else if (a === "--yes" || a === "-y") f.yes = true;
    else if (a === "--json") f.json = true;
    else if (a === "--rollback") f.rollback = true;
    else if (a === "--help" || a === "-h" || a === "help") f.help = true;
    else if (a === "--home" || a.startsWith("--home=")) {
      const v = a === "--home" ? args[++i] : a.slice("--home=".length);
      if (!v || v.startsWith("--")) throw new Exit(EXIT.usage, "--home needs a folder");
      if (f.home !== undefined) throw new Exit(EXIT.usage, "--home given twice");
      f.home = v;
    } else throw new Exit(EXIT.usage, `unexpected argument "${a}"`);
  }
  if (f.rollback && f.dryRun) throw new Exit(EXIT.usage, "--rollback and --dry-run can't be combined");
  return f;
}

export function takeoverHelp(): string {
  return `parachute-core takeover: move a home the old Parachute (hub and vault 0.7) keeps onto v0.8

Usage:
  parachute-core takeover [--home <dir>] [--dry-run] [--yes] [--json]
  parachute-core takeover --rollback [--home <dir>] [--yes] [--json]

It finds the home (--home, PARACHUTE_HOME, ~/.parachute), the old programs (installed or running) and their
units, and says what it found. With your yes it pauses the old units, backs the home up to
<home>/../parachute-takeover/<time>/, starts v0.8 on the same data and checks every vault answers, then hands
the home to v0.8. The old programs stay installed and off. --rollback goes back.

On macOS the old hub's launchd agent (computer.parachute.hub) is unloaded and its plist moved into the backup
folder (launchd/), and v0.8 runs as the agent computer.parachute.core. Other agents (a cloudflared tunnel) are
left alone. --rollback moves the plist back and loads it again.

  --dry-run   say what it found and would do; change nothing
  --yes       go ahead without asking
  --json      print the findings (and the outcome) as JSON

Exit codes: 0 done · 1 other errors · 2 flags · 5 no room for the backup · 7 an old process holds the data
· 8 a check failed after start (everything was put back)
`;
}

function confirm(question: string): boolean {
  if (!process.stdin.isTTY) return false;
  const answer = prompt(question) ?? "";
  return /^y(es)?$/i.test(answer.trim());
}

function systemctl(...args: string[]): void {
  const r = run(["systemctl", "--user", ...args]);
  if (r.code !== 0) throw new Error(`systemctl --user ${args.join(" ")} exited ${r.code}: ${(r.stderr || r.stdout).trim()}`);
}

async function waitUntil(fn: () => boolean | Promise<boolean>, ms: number, step = 200): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() >= end) return false;
    await Bun.sleep(step);
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Every regular file and folder under `root`, relative to it; every link whose target stays inside `root` (read as
 * written, relative to the link's folder: `libggml.so -> libggml.so.0`), with that target; and anything else it
 * can't copy as it is (a link leading out, a socket).
 */
export function entries(root: string): { files: string[]; dirs: string[]; links: [string, string][]; other: string[] } {
  const out = { files: [] as string[], dirs: [] as string[], links: [] as [string, string][], other: [] as string[] };
  const top = resolve(root);
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const r = rel ? join(rel, name) : name;
      const st = lstatSync(join(root, r));
      if (st.isDirectory()) {
        out.dirs.push(r);
        walk(r);
      } else if (st.isFile()) out.files.push(r);
      else if (st.isSymbolicLink()) {
        const target = readlinkSync(join(root, r));
        const to = resolve(top, dirname(r), target);
        if (to.startsWith(`${top}/`)) out.links.push([r, target]);
        else out.other.push(r);
      } else out.other.push(r);
    }
  };
  walk("");
  return out;
}

/** Copy every file of the home, byte for byte, and its inner links as links, with a manifest; check each copy. */
export function backup(home: string, dest: string): { files: number; bytes: number } {
  const into = join(dest, "home");
  mkdirSync(into, { recursive: true, mode: 0o700 });
  const manifest: Record<string, string> = {};
  let bytes = 0;
  const all = entries(home);
  for (const rel of all.dirs) mkdirSync(join(into, rel), { recursive: true, mode: 0o700 });
  // The takeover's own record is its bookkeeping, not the home's data: a restore never brings an old one back.
  all.files = all.files.filter((rel) => rel !== RECORD_FILE && !rel.startsWith(`${RECORD_FILE}.`));
  for (const rel of all.files) {
    const from = join(home, rel);
    const to = join(into, rel);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(from, to);
    const h = sha256(from);
    if (sha256(to) !== h) throw new Error(`the backup copy of ${rel} doesn't match the original`);
    manifest[rel] = h;
    bytes += statSync(from).size;
  }
  const links: Record<string, string> = {};
  for (const [rel, target] of all.links) {
    symlinkSync(target, join(into, rel));
    if (readlinkSync(join(into, rel)) !== target) throw new Error(`the backup copy of the link ${rel} doesn't match the original`);
    links[rel] = target;
  }
  writeFileSync(join(dest, "manifest.json"), `${JSON.stringify({ home, at: new Date().toISOString(), files: manifest, folders: all.dirs, links }, null, 2)}\n`, { mode: 0o600 });
  return { files: Object.keys(manifest).length, bytes };
}

/**
 * Put the backup's bytes (and links) back as the home; what was there moves aside (`<home>.after-takeover-<time>`).
 * `keep`, given where the old home goes, is the record to put in the restored home before it takes the home's place,
 * so a run cut off right after the swap still finds its record.
 */
export function restore(home: string, dest: string, keep?: (aside: string) => Record_): string {
  const read = readJson(join(dest, "manifest.json"));
  const manifest = read?.files as Record<string, string> | undefined;
  if (!manifest) throw new Error(`no manifest in ${dest}`);
  const staged = `${home}.restoring-${randomBytes(3).toString("hex")}`;
  mkdirSync(staged, { mode: 0o700 });
  for (const rel of (read.folders ?? []) as string[]) mkdirSync(join(staged, rel), { recursive: true, mode: 0o700 });
  for (const [rel, h] of Object.entries(manifest)) {
    const to = join(staged, rel);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(join(dest, "home", rel), to);
    if (sha256(to) !== h) throw new Error(`the backup's ${rel} doesn't match its manifest`);
  }
  for (const [rel, target] of Object.entries((read.links ?? {}) as Record<string, string>)) {
    mkdirSync(dirname(join(staged, rel)), { recursive: true, mode: 0o700 });
    symlinkSync(target, join(staged, rel));
  }
  const aside = `${home}.after-takeover-${stamp()}`;
  if (keep) writeFileSync(join(staged, RECORD_FILE), `${JSON.stringify(keep(aside), null, 2)}\n`, { mode: 0o600 });
  renameSync(home, aside);
  renameSync(staged, home);
  return aside;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

async function getJson(url: string, token?: string): Promise<{ status: number; body: any }> {
  try {
    const r = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10_000), redirect: "manual" });
    const text = await r.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: r.status, body };
  } catch {
    return { status: 0, body: undefined };
  }
}

/** The kids of hub.db's signing keys that still sign or verify (not retired), read without touching the home. */
function liveKids(home: string): string[] {
  const p = join(home, "hub.db");
  if (!existsSync(p)) return [];
  return readOnly(p, (db) => (db.query("SELECT kid FROM signing_keys WHERE retired_at IS NULL").all() as { kid: string }[]).map((r) => r.kid));
}

/**
 * Processes left from a check run on `home`: the check run marks its environment (PARACHUTE_TAKEOVER_CHECK=1 with this
 * home), and its modules (scribe, the app) inherit it. The supervisor starts each module in its own process group, so
 * when the check run dies without stopping them (killed, or its session dropped) they live on, holding the modules'
 * ports, and the next v0.8 can't start them (seen in a rehearsal: an orphaned module still on its port). Linux only.
 */
function checkLeftovers(home: string): number[] {
  if (process.platform !== "linux") return [];
  const out: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const vars = readFileSync(`/proc/${name}/environ`, "utf8").split("\0");
      const theirs = vars.find((v) => v.startsWith("PARACHUTE_HOME="))?.slice("PARACHUTE_HOME=".length);
      if (vars.includes("PARACHUTE_TAKEOVER_CHECK=1") && theirs && sameHome(theirs, home)) out.push(Number(name));
    } catch {}
  }
  return out;
}

/** Stop what a check run left (SIGTERM, then SIGKILL after 10 s); the pids it stopped. */
async function stopCheckLeftovers(home: string): Promise<number[]> {
  const pids = checkLeftovers(home);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  if (pids.length && !(await waitUntil(() => checkLeftovers(home).length === 0, 10_000, 200))) {
    for (const pid of checkLeftovers(home)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await waitUntil(() => checkLeftovers(home).length === 0, 5_000, 100);
  }
  return pids;
}

/**
 * Start v0.8 on the home (a check run: this program's own `serve` on a free loopback port, with the old issuer)
 * and check every answer. Returns the problems found (empty when all is well); it always stops the check run.
 */
async function checkRun(d: Detected, kids: string[], from: From | undefined, log: (s: string) => void): Promise<string[]> {
  // Anything marked as this home's check run now is an earlier run's (this one hasn't started): it would hold the
  // modules' ports this check run needs.
  const stale = await stopCheckLeftovers(d.home);
  if (stale.length) log(`  stopped ${stale.length} process${stale.length === 1 ? "" : "es"} an earlier check run left (pid ${stale.join(", ")})`);
  const port = freePort();
  const hub = `http://127.0.0.1:${port}`;
  // The environment parachute-core.service will have (the old unit's: its PATH finds the modules' programs), then:
  const { env, unread } = handOverEnv(from);
  if (from) log(`  with ${from.name}'s environment, as ${from.manager === "launchd" ? CORE_AGENT : CORE_UNIT} will have it${unread.length ? ` (not read exactly, so left out here: ${unread.join(", ")})` : ""}`);
  // the old issuer, so tokens issued before carry it; keys and revocations from this check run's own hub, whatever
  // the caller's shell says (a JWKS origin left over from the old box points where nothing listens now).
  Object.assign(env, { PARACHUTE_HOME: d.home, PARACHUTE_HUB_ORIGIN: d.issuer, PARACHUTE_HUB_JWKS_ORIGIN: hub, PARACHUTE_TAKEOVER_CHECK: "1" });
  for (const k of ["PORT", "PARACHUTE_BIND_HOST", "PARACHUTE_HUB_ORIGINS", "VAULT_BIND"]) delete env[k];
  const logPath = join(tmpdir(), `parachute-takeover-check-${process.pid}.log`);
  // The command core's unit runs (in a bundle its bin/parachute-core, which puts the bundle's own bin and runtime
  // first on PATH), so the check run finds by name what the unit will: this install's own, then the unit's PATH.
  const proc = Bun.spawn([...coreCommand(), "serve", "--listen", `127.0.0.1:${port}`], {
    env,
    stdin: "ignore",
    stdout: Bun.file(logPath),
    stderr: Bun.file(logPath),
  });
  const problems: string[] = [];
  try {
    const ready = await waitUntil(async () => proc.exitCode !== null || (await isReady(hub)), 90_000, 300);
    if (!ready || proc.exitCode !== null) {
      let tail = "";
      try {
        tail = readFileSync(logPath, "utf8").trim().split("\n").slice(-6).join(" / ");
      } catch {}
      problems.push(`v0.8 did not become ready on this home (exit ${proc.exitCode ?? "none"}): ${tail.replace(/pvk_[\w-]+/g, "pvk_…")}`);
      return problems;
    }
    log(`  v0.8 is up on this home (check run on ${hub})`);
    const meta = await getJson(`${hub}/.well-known/oauth-authorization-server`);
    if (meta.body?.issuer !== d.issuer) problems.push(`the issuer is ${meta.body?.issuer}, not ${d.issuer} as before: tokens issued before wouldn't verify`);
    const jwks = await getJson(`${hub}/.well-known/jwks.json`);
    const served = new Set<string>((jwks.body?.keys ?? []).map((k: any) => k.kid));
    const missing = kids.filter((k) => !served.has(k));
    if (missing.length || jwks.status !== 200) problems.push(`the hub's keys (JWKS HTTP ${jwks.status}) lack ${missing.length} of the ${kids.length} live signing keys`);
    else log(`  the issuer and ${kids.length === 1 ? "the live signing key are" : `all ${kids.length} live signing keys are`} the same: every token issued before still verifies`);
    problems.push(...(await checkVaults(hub, d, log, true)));
    return problems;
  } finally {
    if (proc.exitCode === null) {
      proc.kill("SIGTERM");
      const done = await waitUntil(() => proc.exitCode !== null, 15_000);
      if (!done) {
        proc.kill("SIGKILL");
        problems.push("the check run did not stop within 15 s");
      } else if (proc.exitCode !== 0) problems.push(`the check run stopped with exit ${proc.exitCode}`);
      await proc.exited;
    }
    const left = await stopCheckLeftovers(d.home);
    if (left.length) log(`  stopped ${left.length} process${left.length === 1 ? "" : "es"} the check run left (pid ${left.join(", ")})`);
    rmSync(logPath, { force: true });
  }
}

/** /api/ready answers 200 with {ready: true}; in box mode it answers 200 with ready:false while a part isn't up. */
async function isReady(hub: string): Promise<boolean> {
  const r = await getJson(`${hub}/api/ready`);
  return r.status === 200 && r.body?.ready === true;
}

/**
 * A 5-minute read pass for one vault, signed with the home's own signing key and recorded in hub.db like any mint
 * (subject takeover-check). Not through `auth mint-token`: that needs a usable operator token, and an old home's may
 * not be one (one can be issued under the box's old hostname, which only the hub's server accepts; seen in a rehearsal), and
 * it would rotate one near expiry, writing operator.token in the home mid-takeover.
 */
async function mintCheckPass(d: Detected, vault: string): Promise<string> {
  const { openHubDb } = await import("@openparachute/hub/src/hub-db.ts");
  const { signAccessToken, recordTokenMint } = await import("@openparachute/hub/src/jwt-sign.ts");
  const { inferAudience } = await import("@openparachute/hub/src/jwt-audience.ts");
  const { OPERATOR_TOKEN_CLIENT_ID } = await import("@openparachute/hub/src/operator-token.ts");
  const scopes = [`vault:${vault}:read`];
  const db = openHubDb(join(d.home, "hub.db"));
  try {
    const minted = await signAccessToken(db, { sub: "takeover-check", scopes, audience: inferAudience(scopes), clientId: OPERATOR_TOKEN_CLIENT_ID, issuer: d.issuer, ttlSeconds: 300, vaultScope: [] });
    recordTokenMint(db, { jti: minted.jti, createdVia: "cli_mint", subject: "takeover-check", clientId: OPERATOR_TOKEN_CLIENT_ID, scopes, expiresAt: minted.expiresAt });
    return minted.token;
  } finally {
    db.close();
  }
}

/**
 * Per vault, through the hub at `hub`: a 5-minute read pass minted for the check, the vault's stats and one read.
 * `exact`: the note count must equal the count found on disk (the check run, which nothing else can reach); the
 * unit's v0.8 is reachable by every client, which may write as soon as it answers, so there it must only answer.
 */
async function checkVaults(hub: string, d: Detected, log: (s: string) => void, exact: boolean): Promise<string[]> {
  const problems: string[] = [];
  for (const v of d.vaults) {
    let token: string;
    try {
      token = await mintCheckPass(d, v.name);
    } catch (err) {
      problems.push(`vault ${v.name}: couldn't mint a read pass for the check (${String((err as Error).message).slice(-200)})`);
      continue;
    }
    const info = await getJson(`${hub}/vault/${encodeURIComponent(v.name)}/api/vault?include_stats=true`, token);
    const count = info.body?.stats?.totalNotes;
    const one = await getJson(`${hub}/vault/${encodeURIComponent(v.name)}/api/notes?limit=1`, token);
    if (info.status !== 200 || typeof count !== "number" || (exact && count !== v.notes)) problems.push(`vault ${v.name}: HTTP ${info.status}, ${count ?? "no"} notes${exact ? `, want ${v.notes}` : ""}`);
    else if (one.status !== 200 || (count > 0 && !(Array.isArray(one.body) ? one.body.length : one.body?.notes?.length))) problems.push(`vault ${v.name}: reading a note gave HTTP ${one.status}`);
    else log(`  vault ${v.name}: ${count} notes, read ok`);
  }
  return problems;
}

/**
 * The PATH core starts with when its unit gives it `path`: in a bundle, bin/parachute-core (coreCommand) puts the
 * bundle's own bin and runtime first (packages/cli/bin/parachute-core); from a source checkout it runs on `path`.
 */
function corePath(path: string): string {
  const root = bundleRoot();
  return root ? [join(root, "lib", "packages", "cli", "bin"), join(root, "runtime"), path].join(":") : path;
}

/** The command a unit runs core with: the installed `<prefix>/bin/parachute-core` when this copy is installed. */
function coreCommand(): string[] {
  const root = bundleRoot();
  if (!root) return [process.execPath, CORE_ENTRY];
  const store = root.lastIndexOf("/.store/");
  if (store >= 0) {
    const bin = join(root.slice(0, store), "bin", "parachute-core");
    if (existsSync(bin)) return [bin];
  }
  return [join(root, "bin", "parachute-core")];
}

/** The port core's unit will listen on: the unit's PORT, else the old hub's hub/run/hub.port, else 1939. */
function unitPort(env: string[], home: string): number {
  for (const line of env) {
    const m = /PORT=(\d{1,5})"?$/.exec(line);
    if (m && /^Environment="PORT=/.test(line)) return Number(m[1]);
  }
  for (const line of env) {
    const file = /^EnvironmentFile=-(.+)$/.exec(line)?.[1]?.replace(/%%/g, "%");
    if (!file) continue;
    try {
      const m = /^\s*(?:export\s+)?PORT=["']?(\d{1,5})/m.exec(readFileSync(file, "utf8"));
      if (m) return Number(m[1]);
    } catch {}
  }
  try {
    const n = Number(readFileSync(join(home, "hub", "run", "hub.port"), "utf8").trim());
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  } catch {}
  return 1939;
}

/** The TCP ports a process listens on (Linux: its socket inodes against /proc/net/tcp and tcp6; elsewhere lsof). */
function listeningPorts(pid: number): number[] {
  if (process.platform !== "linux") {
    const r = run(["lsof", "-n", "-P", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-F", "n"]);
    return [...new Set(r.stdout.split("\n").map((l) => /^n.*:(\d+)$/.exec(l)?.[1]).filter((p): p is string => !!p).map(Number))];
  }
  const inodes = new Set<string>();
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (m) inodes.add(m[1]!);
      } catch {}
    }
  } catch {
    return [];
  }
  const ports = new Set<number>();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = readFileSync(table, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length > 9 && f[3] === "0A" && inodes.has(f[9]!)) ports.add(parseInt(f[1]!.split(":")[1]!, 16));
    }
  }
  return [...ports];
}

/**
 * A value for a systemd unit line: quoted, with `%` (specifiers), `\\` and `"` escaped, and control characters as
 * `\xHH` (systemd C-unescapes Environment=), so a value with a line break stays one line of the unit.
 */
const unitQuote = (v: string) =>
  `"${v
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%")
    .replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`)}"`;

/**
 * The environment the old hub's unit gave it (PORT, bind, origins, PATH, BUN_INSTALL, drop-ins), as systemd has it
 * loaded: its Environment= assignments (`KEY=value`, in order) and its environment files.
 */
function unitEnv(unit: string): { vars: string[]; files: string[] } {
  const vars: string[] = [];
  const files: string[] = [];
  const show = run(["systemctl", "--user", "show", unit, "-p", "Environment", "-p", "EnvironmentFiles"]).stdout;
  for (const line of show.split("\n")) {
    if (line.startsWith("Environment=")) {
      for (const m of line.slice("Environment=".length).matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
        // systemd prints a value it had to quote as "…" (shell_maybe_quote): `\\`, `\"`, `\$`, `` \` `` and, for a
        // control character, cescape_char's C escape (`\t`, `\n`, `\033`), not the letter after the backslash.
        const kv = m[1] !== undefined ? (unescapeShown(m[1], '"', "$`") ?? m[1].replace(/\\(.)/g, "$1")) : m[2]!;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(kv)) vars.push(kv);
      }
    } else if (line.startsWith("EnvironmentFiles=")) {
      const path = line.slice("EnvironmentFiles=".length).replace(/\s*\(ignore_errors=(yes|no)\)\s*$/, "").trim();
      if (path) files.push(path);
    }
  }
  return { vars, files };
}

/** The old hub's unit environment (unitEnv) as systemd lines for core's unit. */
export function unitEnvironment(unit: string): string[] {
  const { vars, files } = unitEnv(unit);
  return [...vars.map((kv) => `Environment=${unitQuote(kv)}`), ...files.map((f) => `EnvironmentFile=-${f.replace(/%/g, "%%")}`)];
}

/**
 * The environment v0.8 runs with once `from` is handed over, for the check run and the dry run, built as systemd
 * builds parachute-core.service's: the user manager's environment (managerEnv; a unit with no PATH of its own runs
 * with the manager's), then the unit's own over it (unitEnv; an environment file's assignments win over
 * Environment=). The caller's environment is only the ground under those (HOME, LANG, …, and anything systemd won't
 * report). Without this, a takeover run under `systemd-run --user` checked v0.8 with the user manager's PATH, where
 * the modules' programs (in Bun's global bin) aren't, though the unit's PATH has them (10-29); and one
 * run from a shell would check with the shell's PATH what the unit runs with the manager's.
 * `unread`: what couldn't be read exactly (an environment file, see envFileVars; a manager value, see managerValue),
 * left out here; systemd still gives it to the unit. No unit (a home a hand-run process served): the caller's environment, as it is.
 */
export function handOverEnv(given: string | From | undefined, base: NodeJS.ProcessEnv = process.env): { env: Record<string, string>; unread: string[] } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  const unread: string[] = [];
  if (!given) return { env, unread };
  if (typeof given !== "string" && given.manager === "launchd") {
    // launchd gives an agent its plist's EnvironmentVariables over the user's session, and its own PATH when the
    // plist sets none (an agent never gets a shell's PATH).
    env.PATH = LAUNCHD_PATH;
    if (given.plist) Object.assign(env, agentEnv(given.plist));
    else unread.push(`${given.name}'s plist`);
    return { env, unread };
  }
  const from = typeof given === "string" ? given : given.name;
  for (const [k, raw] of managerEnv() ?? []) {
    const v = managerValue(raw);
    if (v === null) unread.push(`the user manager's ${k}`); // the caller's stays for that name
    else env[k] = v;
  }
  const { vars, files } = unitEnv(from);
  for (const kv of vars) {
    const i = kv.indexOf("=");
    env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  for (const f of files.flatMap((pattern) => {
    const paths = envFilePaths(pattern);
    if (paths === null) unread.push(pattern); // systemd reads what it matches; it isn't read here
    return paths ?? [];
  })) {
    let body: string;
    try {
      body = readFileSync(f, "utf8");
    } catch {
      if (existsSync(f)) unread.push(f); // a missing one is skipped, as core's unit (EnvironmentFile=-) skips it
      continue;
    }
    const got = envFileVars(body);
    if (got === null) unread.push(f);
    else for (const [k, v] of got) env[k] = v;
  }
  return { env, unread };
}

/**
 * The files an EnvironmentFile= path names: itself, or, for a wildcard (systemd.exec: "an absolute filename or
 * wildcard expression"), the matches in its folder, as systemd finds them: execute.c exec_context_load_environment
 * calls safe_glob(fn, 0), glibc glob(3) with no flags, in the manager's C locale (it never calls setlocale). So no
 * brace expansion, a leading dot only matched by a literal one, bytes in byte order. null (named in `unread`): a
 * wildcard in a folder name, a pattern glob3Component can't follow exactly, or a folder that can't be listed (glob(3)
 * would skip it silently; here what it holds is unknown, not empty).
 */
function envFilePaths(pattern: string): string[] | null {
  if (!/[*?[\\]/.test(pattern)) return [pattern];
  const dir = dirname(pattern);
  if (/[*?[\\]/.test(dir)) return null;
  const matches = glob3Component(Buffer.from(basename(pattern), "utf8").toString("latin1"));
  if (matches === null) return null;
  let names: Buffer[];
  try {
    names = readdirSync(dir, { encoding: "buffer" });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // No folder (or not a folder): glob(3) finds nothing, skipped as core's unit (EnvironmentFile=-) skips it.
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    return null;
  }
  return names
    .map((b) => b.toString("latin1"))
    .filter(matches)
    .sort()
    .map((n) => join(dir, Buffer.from(n, "latin1").toString("utf8")));
}

const POSIX_CLASSES: Record<string, string> = {
  alnum: "0-9A-Za-z", alpha: "A-Za-z", blank: " \\t", cntrl: "\\x00-\\x1f\\x7f", digit: "0-9", graph: "\\x21-\\x7e",
  lower: "a-z", print: "\\x20-\\x7e", punct: "!-\\/:-@\\[-`{-~", space: " \\t\\n\\v\\f\\r", upper: "A-Z", xdigit: "0-9A-Fa-f",
};
const reByte = (c: string) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`;

/**
 * A matcher for one path component of a glob(3) pattern as glibc reads it with no flags in the C locale (fnmatch with
 * FNM_PERIOD): `*`, `?`, `[…]` (`!`/`^` negation, a leading `]` literal, ranges, `[:class:]`), `\\` quoting the next
 * byte; braces and everything else literal; a name's leading dot matched only by a literal (or quoted) dot. Pattern
 * and names are byte strings (latin1). What glibc matches nothing for (a reversed range, an unknown class, a trailing
 * backslash) matches nothing here. null: `[.x.]` / `[=x=]`, not followed here.
 */
function glob3Component(p: string): ((name: string) => boolean) | null {
  const none = () => false;
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "\\") {
      if (i + 1 === p.length) return none;
      re += reByte(p[++i]!);
    } else if (c === "?") re += "[^]";
    else if (c === "*") re += "[^]*";
    else if (c === "[") {
      let j = i + 1;
      const negate = p[j] === "!" || p[j] === "^";
      if (negate) j++;
      let set = "";
      let closed = false;
      let bad = false;
      for (let first = true; j < p.length; first = false) {
        let a = p[j]!;
        if (a === "]" && !first) {
          closed = true;
          break;
        }
        if (a === "[" && (p[j + 1] === "." || p[j + 1] === "=")) return null;
        if (a === "[" && p[j + 1] === ":") {
          const k = p.indexOf(":]", j + 2);
          if (k < 0) break;
          const cls = POSIX_CLASSES[p.slice(j + 2, k)];
          if (cls === undefined) bad = true;
          else set += cls;
          j = k + 2;
          continue;
        }
        if (a === "\\") {
          if (j + 1 >= p.length) break;
          a = p[++j]!;
        }
        j++;
        if (p[j] === "-" && j + 1 < p.length && p[j + 1] !== "]") {
          let b = p[j + 1]!;
          j += 2;
          if (b === "\\") {
            if (j >= p.length) break;
            b = p[j++]!;
          }
          if (b < a) bad = true;
          else set += `${reByte(a)}-${reByte(b)}`;
        } else set += reByte(a);
      }
      if (!closed) re += reByte("["); // no closing ]: a literal [
      else if (bad) return none;
      else {
        re += `[${negate ? "^" : ""}${set}]`;
        i = j;
      }
    } else re += reByte(c);
  }
  const rx = new RegExp(`^${re}$`);
  const dot = p.startsWith(".") || p.startsWith("\\.");
  return (name) => (dot || !name.startsWith(".")) && rx.test(name);
}

/** The old unit (or agent) core's takes over from, and takes its environment from; an agent's plist as it was read. */
export type From = { manager: "systemd"; name: string } | { manager: "launchd"; name: string; plist: PlistDict | null };

/**
 * The old unit core's unit takes over from (and takes its environment from): the old hub's, else the first one paused.
 * `cut`: what an interrupted takeover paused (an agent's plist is then where that run moved it).
 */
function handOverUnit(units: Unit[], cut: Paused[] = []): From | undefined {
  const old = new Map<string, { manager: Unit["manager"]; file?: string }>();
  for (const u of units.filter((x) => x.old)) old.set(u.name, { manager: u.manager, file: u.file });
  for (const p of cut) if (!old.has(p.name)) old.set(p.name, p.manager === "launchd" ? { manager: "launchd", file: existsSync(p.aside) ? p.aside : p.file } : { manager: "systemd" });
  const names = [...old.keys()];
  const name = names.find((n) => /hub/.test(n)) ?? names[0];
  if (name === undefined) return undefined;
  const u = old.get(name)!;
  if (u.manager === "systemd") return { manager: "systemd", name };
  let text = "";
  try {
    text = u.file ? readFileSync(u.file, "utf8") : "";
  } catch {}
  return { manager: "launchd", name, plist: readAgentPlist(text) };
}

function writeCoreUnit(d: Detected, from: string): { path: string; port: number } {
  const path = join(systemdUnitDir(), CORE_UNIT);
  const env = unitEnvironment(from);
  if (!env.some((l) => l.includes("PARACHUTE_HOME="))) env.unshift(`Environment=${unitQuote(`PARACHUTE_HOME=${d.home}`)}`);
  const text = [
    `# ${CORE_UNIT_MARK} ${d.home}`,
    "[Unit]",
    `Description=Parachute ${core.version} (parachute-core): took over from ${from} on ${new Date().toISOString().slice(0, 10)}`,
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=${coreCommand().map(unitQuote).join(" ")} serve`,
    ...env,
    "Restart=on-failure",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o644 });
  return { path, port: unitPort(env, d.home) };
}

/**
 * Core's launchd agent, in ~/Library/LaunchAgents, in place of the old hub's: core's command, and the old agent's
 * environment, log files, working folder and throttle (as core's systemd unit takes the old unit's environment), with
 * PARACHUTE_HOME when that had none. Started at login, and again when it exits with a failure.
 */
function writeCoreAgent(d: Detected, from: Extract<From, { manager: "launchd" }>): { path: string; port: number } {
  const old = from.plist ?? {};
  const env = agentEnv(old);
  if (!env.PARACHUTE_HOME) env.PARACHUTE_HOME = d.home;
  const dict: PlistDict = {
    Label: CORE_AGENT,
    ProgramArguments: [...coreCommand(), "serve"],
    EnvironmentVariables: env,
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false },
  };
  for (const k of ["WorkingDirectory", "StandardOutPath", "StandardErrorPath", "ThrottleInterval"]) if (old[k] !== undefined) dict[k] = old[k]!;
  const path = coreAgentFile();
  const mark = `${CORE_UNIT_MARK} ${JSON.stringify(d.home)}; took over from ${JSON.stringify(from.name)} on ${new Date().toISOString().slice(0, 10)}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderPlist(dict, mark), { mode: 0o644 });
  const port = /^\d{1,5}$/.test(env.PORT ?? "") ? Number(env.PORT) : unitPort([], d.home);
  return { path, port };
}

const mainPid = (unit: string) => Number(/MainPID=(\d+)/.exec(run(["systemctl", "--user", "show", unit, "-p", "MainPID"]).stdout)?.[1] ?? 0);

/**
 * Is core's unit up: active, with a process systemd names, answering /api/ready on its port, and still the same
 * process a few seconds later (not crash-looping). Anything less is a failed hand-over.
 */
async function coreUnitUp(port: number, d: Detected, log: (s: string) => void, manager: Unit["manager"] = "systemd"): Promise<string | null> {
  const CORE = manager === "launchd" ? CORE_AGENT : CORE_UNIT;
  // launchd: loaded with a process is up; unloaded is failed (KeepAlive restarts a crash: the pid check below sees it).
  const agentPid = () => launchdJobs()?.get(CORE_AGENT) ?? 0;
  const active = manager === "launchd" ? () => agentPid() > 0 : () => run(["systemctl", "--user", "is-active", CORE_UNIT]).stdout.trim() === "active";
  const failed = manager === "launchd" ? () => !launchdJobs()?.has(CORE_AGENT) : () => run(["systemctl", "--user", "is-active", CORE_UNIT]).stdout.trim() === "failed";
  const corePid = manager === "launchd" ? agentPid : () => mainPid(CORE_UNIT);
  if (!(await waitUntil(() => failed() || (active() && corePid() > 0), 30_000, 500)) || failed()) return `${CORE} did not start a process that stays up`;
  const pid = corePid();
  // Where it listens is asked of its own process (the configuration's PORT is only the first guess): the port that
  // answers /api/ready with ready:true is the hub's.
  let hub = "";
  const ok = await waitUntil(async () => {
    if (!active()) return true;
    // Only ports its own process listens on count (the configured one first, if it is among them).
    const owned = listeningPorts(pid);
    for (const p of [...owned.filter((x) => x === port), ...owned.filter((x) => x !== port)]) {
      if (await isReady(`http://127.0.0.1:${p}`)) {
        hub = `http://127.0.0.1:${p}`;
        return true;
      }
    }
    return false;
  }, 60_000, 500);
  if (!ok || !active() || !hub) return `${CORE} (pid ${pid}) is not ready (tried port ${port} and the ports it listens on)`;
  if (!heldBy(d.home, [CORE_UNIT]).some((h) => h.unit === CORE)) return `${CORE} (pid ${pid}) answers, but none of its processes has this home's data open`;
  const problems = await checkVaults(hub, d, log, false);
  if (problems.length) return `${CORE} answers, but ${problems.join("; ")}`;
  await Bun.sleep(3000);
  if (!active() || corePid() !== pid) return `${CORE} stopped or restarted within 3 s of answering`;
  return null;
}

/**
 * Stop core's unit and confirm it: the stop command succeeded, systemd reports it inactive (or failed) with no
 * process, and nothing holds the home's data. Returns what is still wrong, or null when it is stopped.
 */
/**
 * Stop core's launchd agent and confirm it: unloaded, and nothing holds the home's data. Then its plist (only one this
 * takeover wrote for this home) moves out of ~/Library/LaunchAgents into `aside`, so it doesn't load at login.
 * Returns what is still wrong, or null when it is stopped.
 */
async function stopCoreAgent(home: string, aside: string): Promise<string | null> {
  if (launchdJobs()?.has(CORE_AGENT)) {
    const r = launchctl("bootout", `${guiDomain()}/${CORE_AGENT}`);
    if (r.code !== 0 && launchdJobs()?.has(CORE_AGENT) !== false) return `stopping ${CORE_AGENT} failed: ${(r.stderr || r.stdout).trim()}`;
  }
  if (!(await waitUntil(() => launchdJobs()?.has(CORE_AGENT) === false && holders(home).length === 0, 20_000, 250))) {
    const still = holders(home);
    return `${CORE_AGENT} is not confirmed stopped${still.length ? ` (still holding the data: ${still.map((h) => `pid ${h.pid}`).join(", ")})` : ""}`;
  }
  if (existsSync(coreAgentFile()) && coreAgentMark() === home) moveFile(coreAgentFile(), freeName(aside, `${CORE_AGENT}.plist`));
  return null;
}

async function stopCoreUnit(home: string): Promise<string | null> {
  const r = run(["systemctl", "--user", "disable", "--now", CORE_UNIT]);
  if (r.code !== 0) return `stopping ${CORE_UNIT} failed: ${(r.stderr || r.stdout).trim()}`;
  const down = () => ["inactive", "failed"].includes(run(["systemctl", "--user", "is-active", CORE_UNIT]).stdout.trim()) && mainPid(CORE_UNIT) === 0;
  if (!(await waitUntil(() => down() && holders(home).length === 0, 20_000, 250))) {
    const still = holders(home);
    return `${CORE_UNIT} is not confirmed stopped${still.length ? ` (still holding the data: ${still.map((h) => `pid ${h.pid}`).join(", ")})` : ""}`;
  }
  return null;
}

function writeRecord(home: string, r: Record_): void {
  const p = join(home, RECORD_FILE);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, p);
}

/** The home named on the mark line of the core unit file, if it has one. */
function readCoreUnitMark(): string | undefined {
  try {
    const first = readFileSync(join(systemdUnitDir(), CORE_UNIT), "utf8").split("\n")[0] ?? "";
    return first.startsWith(`# ${CORE_UNIT_MARK} `) ? first.slice(`# ${CORE_UNIT_MARK} `.length) : undefined;
  } catch {
    return undefined;
  }
}

/** Put the old units back as they were: enabled ones enabled, running ones started. */
function resumeUnits(paused: Record_["paused"]): string[] {
  const errors: string[] = [];
  for (const u of paused) {
    try {
      if (u.manager === "launchd") resumeAgent(u);
      else {
        if (u.enabled) systemctl("enable", u.name);
        if (u.active) systemctl("start", u.name);
      }
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  return errors;
}

/** A paused agent as it was: its plist back in ~/Library/LaunchAgents (unless one is there again), loaded if it was. */
function resumeAgent(u: Extract<Paused, { manager: "launchd" }>): void {
  if (existsSync(u.aside)) {
    if (existsSync(u.file)) throw new Error(`${u.file} is there again, so ${u.aside} wasn't moved back over it; compare them and move the right one into place`);
    moveFile(u.aside, u.file);
  }
  if (!existsSync(u.file)) throw new Error(`${u.name}'s plist is neither in ${u.file} nor in ${u.aside}`);
  if (!u.loaded) return;
  const jobs = launchdJobs();
  if (jobs === null) throw new Error(`launchctl didn't say whether ${u.name} is loaded; load it with \`launchctl bootstrap ${guiDomain()} ${u.file}\``);
  if (jobs.has(u.name)) return;
  const r = launchctl("bootstrap", guiDomain(), u.file);
  if (r.code !== 0 && !launchdJobs()?.has(u.name)) throw new Error(`launchctl bootstrap ${guiDomain()} ${u.file} exited ${r.code}: ${(r.stderr || r.stdout).trim()}`);
}

/** Pause an agent: unload it if it is loaded, then move its plist aside (`u.aside`). */
function pauseAgent(u: Extract<Paused, { manager: "launchd" }>): void {
  if (launchdJobs()?.has(u.name)) {
    const r = launchctl("bootout", `${guiDomain()}/${u.name}`);
    if (r.code !== 0 && launchdJobs()?.has(u.name) !== false) throw new Error(`launchctl bootout ${guiDomain()}/${u.name} exited ${r.code}: ${(r.stderr || r.stdout).trim()}`);
  }
  moveFile(u.file, u.aside);
}

/**
 * A restore cut off between its two renames leaves no home, and the restored copy (with its record) beside it as
 * `<home>.restoring-<id>`: put that copy in place. Returns the folder it used, or null when there was nothing to finish.
 */
function staleRestore(home: string): string | null {
  if (existsSync(home)) return null;
  let found: { path: string; at: number } | null = null;
  try {
    for (const name of readdirSync(dirname(home))) {
      if (!name.startsWith(`${basename(home)}.restoring-`)) continue;
      const path = join(dirname(home), name);
      const rec = readJson(join(path, RECORD_FILE));
      if (!rec?.restored_at) continue; // a restore that failed before its swap, not one cut off mid-swap
      const at = Date.parse(rec.restored_at);
      if (!found || at > found.at) found = { path, at };
    }
  } catch {}
  return found?.path ?? null;
}

function finishRestore(home: string, say: (s: string) => void): void {
  const staged = staleRestore(home);
  if (!staged) return;
  renameSync(staged, home);
  say(`A restore of ${tilde(home)} was cut off before the restored copy took its place; put it in place (${tilde(staged)} → ${tilde(home)}).`);
}

/**
 * The home's real folder, also while it is missing (a restore cut between its renames leaves a link to it
 * dangling): a link is followed by hand, and a missing folder is named by its real parent.
 */
export function realHome(p: string, hops = 0): string {
  try {
    return realpathSync(p);
  } catch {}
  try {
    if (hops < 32 && lstatSync(p).isSymbolicLink()) return realHome(resolve(dirname(p), readlinkSync(p)), hops + 1);
  } catch {}
  try {
    return join(realpathSync(dirname(p)), basename(p));
  } catch {
    return p;
  }
}

/**
 * One takeover or rollback of a home at a time: an exclusive flock(2) on `<home>.takeover.lock`, beside the home (not
 * in it: backups copy the home and restores swap it), held until this process exits however it exits, so it is never
 * stale. The descriptor is close-on-exec, so a check run or module that outlives this process never holds it.
 */
function holdTakeoverLock(home: string): boolean {
  const lib = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  // Keyed on the home's real path, so two runs reaching it by different paths (a link to it, or to a folder above it)
  // take the same lock.
  let real = home;
  try {
    real = realpathSync(home);
  } catch {}
  const fd = openSync(`${real}.takeover.lock`, "a", 0o600); // kept open: closing it would drop the lock
  const F_SETFD = 2;
  const FD_CLOEXEC = 1;
  lib.symbols.fcntl(fd, F_SETFD, FD_CLOEXEC);
  const LOCK_EX = 2;
  const LOCK_NB = 4;
  return lib.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0;
}

/** What a person does to put paused units back by hand: systemd's enable and start; an agent's plist moved back, loaded. */
function backBy(paused: Paused[]): string {
  const units = paused.filter((u) => u.manager === "systemd").map((u) => u.name);
  const agents = paused.flatMap((u) => (u.manager === "launchd" ? [`move ${u.aside} back to ${u.file}${u.loaded ? ` and \`launchctl bootstrap ${guiDomain()} ${u.file}\`` : ""}`] : []));
  return [...(units.length ? [`enable and start ${units.join(" and ")}`] : []), ...agents].join(", then ");
}

/** Where a takeover moves plists (the old agents', and core's on the way back): `launchd/` in its backup folder. */
function asideOf(rec: Record_, home: string): string {
  const agent = rec.paused.find((u) => u.manager === "launchd");
  if (agent?.manager === "launchd") return dirname(agent.aside);
  return join(rec.backup || join(dirname(home), "parachute-takeover", stamp()), "launchd");
}

/**
 * Put back a takeover that was cut off (its record still says "taking-over"): stop core's unit if that run had
 * started it, restore the backup if v0.8 may have migrated the data, then enable and start the old units it paused
 * and wait until they have the home's data open again, so the next detection sees them. Removes the record.
 */
async function putBackInterrupted(home: string, rec: Record_, say: (s: string) => void): Promise<{ units: string[]; exported: number }> {
  if (rec.pid && rec.pid !== process.pid) {
    let cmd = "";
    try {
      cmd = process.platform === "linux" ? readFileSync(`/proc/${rec.pid}/cmdline`, "utf8") : run(["ps", "-o", "command=", "-p", String(rec.pid)]).stdout;
    } catch {}
    if (cmd.includes("takeover")) throw new Exit(EXIT.held, `a takeover of this home is running now (pid ${rec.pid}, started ${rec.at}); let it finish. Nothing was changed.`);
  }
  const units = rec.paused.map((u) => u.name);
  say(`A takeover of this home started on ${rec.at} was interrupted; putting ${units.join(" and ") || "the old programs"} back first …`);
  if (rec.core_unit && rec.core_manager === "launchd" && coreAgentMark() === home) {
    const left = await stopCoreAgent(home, asideOf(rec, home));
    if (left) throw new Exit(EXIT.failed, `${left}; stop it, then run takeover again.`);
  } else if (rec.core_unit && rec.core_manager !== "launchd" && readCoreUnitMark() === home) {
    const left = await stopCoreUnit(home);
    if (left) throw new Exit(EXIT.failed, `${left}; stop it, then run takeover again.`);
  }
  const left = await stopCheckLeftovers(home);
  if (left.length) say(`  stopped ${left.length} process${left.length === 1 ? "" : "es"} its check run left (pid ${left.join(", ")})`);
  // Nothing of v0.8 (an orphaned check run) may hold the data; an old unit someone started again may.
  const mine = new Set(units);
  const inTheWay = () => heldBy(home, units).filter((h) => !(h.unit && mine.has(h.unit)));
  if (!(await waitUntil(() => inTheWay().length === 0, 20_000, 250))) {
    throw new Exit(EXIT.held, `still holding the data: ${inTheWay().map((h) => `pid ${h.pid} (${h.cmd.slice(0, 80)})`).join(", ")}. Stop it, then run takeover again.`);
  }
  let exported = 0;
  if ((rec.stage === "checking" || rec.stage === "handing-over") && rec.migrations.length && rec.backup && !rec.restored_at) {
    const held = heldBy(home, units);
    if (held.length) throw new Exit(EXIT.held, `the old programs were started again on data v0.8 may have migrated (pid ${held.map((h) => h.pid).join(", ")}); stop them, then run takeover again so the backup is restored first.`);
    // Whatever changed since the backup (core's unit may have taken writes before the cut) is exported first.
    const dir = join(rec.backup, `changed-since-takeover-${stamp()}`);
    exported = exportChanged(home, join(rec.backup, "home"), dir);
    if (exported) say(`  exported ${exported} note${exported === 1 ? "" : "s"} changed since the takeover began to ${tilde(dir)}`);
    // The record goes into the restored home with it, so a cut from here on still finds it (and won't restore again).
    const aside = restore(home, rec.backup, (a) => ({ ...rec, restored_at: new Date().toISOString(), moved_aside: a }));
    say(`  restored the backup ${tilde(rec.backup)}, since v0.8 may have started migrating the data (what it left is in ${tilde(aside)})`);
  }
  const errors = resumeUnits(rec.paused);
  if (errors.length) throw new Exit(EXIT.failed, `putting the old units back failed: ${errors.join("; ")}. Fix that and run takeover again.`);
  // The record goes only once the old units have the data open again: a unit systemd starts may still fail.
  const running = rec.paused.filter((u) => u.active).map((u) => u.name);
  if (running.length && !(await waitUntil(() => running.every((u) => heldBy(home, running).some((h) => h.unit === u)), 90_000, 500))) {
    throw new Exit(EXIT.failed, `${running.join(" and ")} ${running.length === 1 ? "was" : "were"} started again, but without this home's data open after 90 s; the record stays, so run takeover (or --rollback) again once ${running.length === 1 ? "it serves" : "they serve"} it.`);
  }
  rmSync(join(home, RECORD_FILE), { force: true });
  say(`  ${units.join(" and ") || "the old programs"} back as before`);
  return { units, exported };
}

async function takeOver(asked: Detected, say: (s: string) => void): Promise<{ backup: string; record: Record_; core_unit: string | null }> {
  // What was shown may have changed while the person decided: everything is found again now, and if the units to
  // pause or the processes holding the data differ, nothing is done.
  const d = await detect(asked.home);
  const shape = (x: Detected) => JSON.stringify([x.units.filter((u) => u.old || u.unseen).map((u) => [u.name, u.old, !!u.unseen]), x.running.map((h) => [h.pid, h.unit ?? ""]).sort()]);
  if (shape(d) !== shape(asked)) {
    throw new Exit(EXIT.failed, "what takeover found changed since it was shown (a unit or a process holding the data); nothing was changed. Run takeover again to see what it finds now.");
  }
  if (d.units.some((u) => u.old && u.manager === "launchd") && d.units.some((u) => u.old && u.manager === "systemd")) {
    throw new Exit(EXIT.failed, "the old programs run under both systemd and launchd here; takeover hands a home to one of them. Nothing was changed.");
  }
  if (d.uncopyable.length) {
    throw new Exit(EXIT.failed, `the home has entries the backup can't copy as they are (${d.uncopyable.slice(0, 5).join(", ")}): links that lead out of it, or sockets. Replace them with the real files, or back up yourself. Nothing was changed.`);
  }
  const coreUnitFile = join(systemdUnitDir(), CORE_UNIT);
  // What systemd has loaded under that name, wherever its file is: one outside the user folder is never shadowed.
  const loaded = run(["systemctl", "--user", "show", CORE_UNIT, "-p", "LoadState", "-p", "FragmentPath"]).stdout;
  const fragment = /^FragmentPath=(.*)$/m.exec(loaded)?.[1]?.trim() ?? "";
  if (/^LoadState=loaded$/m.test(loaded) && fragment && fragment !== coreUnitFile) {
    throw new Exit(EXIT.failed, `${CORE_UNIT} is already loaded from ${fragment}; this takeover won't shadow or replace it. Nothing was changed.`);
  }
  if (existsSync(coreUnitFile)) {
    // Replaced only when it is one a takeover of this home wrote (its mark line) and it is off.
    const state = run(["systemctl", "--user", "is-active", CORE_UNIT]).stdout.trim();
    const on = !["inactive", "failed"].includes(state) || run(["systemctl", "--user", "is-enabled", CORE_UNIT]).stdout.trim() === "enabled";
    if (readCoreUnitMark() !== d.home || on) {
      throw new Exit(EXIT.failed, `${CORE_UNIT} already exists (${tilde(coreUnitFile)})${on ? " and is on" : " and wasn't written by a takeover of this home"}; this takeover won't replace it. Nothing was changed.`);
    }
  }
  if (launchdHere()) {
    // Core's agent is written only where none is loaded, and over a plist only one a takeover of this home wrote.
    const jobs = launchdJobs();
    if (jobs === null && (existsSync(coreAgentFile()) || d.units.some((u) => u.manager === "launchd" && u.old))) {
      throw new Exit(EXIT.failed, "launchctl didn't say which agents are loaded (`launchctl list` failed); takeover won't pause or start agents it can't see. Nothing was changed.");
    }
    if (jobs?.has(CORE_AGENT)) throw new Exit(EXIT.failed, `the launchd agent ${CORE_AGENT} is already loaded; this takeover won't replace it. Nothing was changed.`);
    if (existsSync(coreAgentFile()) && coreAgentMark() !== d.home) {
      throw new Exit(EXIT.failed, `${CORE_AGENT} already exists (${tilde(coreAgentFile())}) and wasn't written by a takeover of this home; this takeover won't replace it. Nothing was changed.`);
    }
  }
  const toPause = d.units.filter((u) => u.old);
  // The unit core's unit replaces: its environment is the check run's and then core's unit's.
  const hubUnit = handOverUnit(d.units);
  const pausable = new Set(toPause.map((u) => u.name));
  // Stopping or disabling a unit can reach another home: another home's databases in any of its processes, or units
  // a stop or disable would reach (Also=, PropagatesStopTo=, units that require, bind to or are part of it).
  for (const u of toPause) {
    const why = unsafeToStop(u.name, d.home, pausable, u.manager);
    if (why) throw new Exit(EXIT.held, `${why}. Nothing was changed.`);
  }
  const outside = d.running.filter((h) => !h.unit || !pausable.has(h.unit));
  if (outside.length) {
    throw new Exit(EXIT.held, `an old process holds the data and isn't run by a unit this can pause: ${outside.map((h) => `pid ${h.pid} (${h.cmd.slice(0, 80)})`).join(", ")}. Stop it, then run takeover again. Nothing was changed.`);
  }
  const unseenAgents = d.units.filter((u) => u.unseen && u.manager === "launchd");
  if (unseenAgents.length) {
    const one = unseenAgents.length === 1;
    throw new Exit(
      EXIT.failed,
      `${unseenAgents.map((u) => u.name).join(" and ")} ${one ? "looks" : "look"} like the old hub or vault, ${one ? "isn't" : "aren't"} running, and ${one ? "its plist doesn't" : "their plists don't"} say which home ${one ? "it serves" : "they serve"} (launchd starts ${one ? "it" : "them"} at login). Load ${one ? "it" : "them"} (\`launchctl bootstrap ${guiDomain()} ${unseenAgents[0]!.file}\`) so takeover can see, or move ${one ? "its plist" : "their plists"} out of ~/Library/LaunchAgents if ${one ? "it doesn't" : "they don't"} serve this home; then run takeover again. Nothing was changed.`,
    );
  }
  const unseen = d.units.filter((u) => u.unseen);
  if (unseen.length) {
    throw new Exit(EXIT.failed, `${unseen.map((u) => u.name).join(" and ")} ${unseen.length === 1 ? "looks" : "look"} like the old hub or vault and ${unseen.length === 1 ? "is" : "are"} enabled but not running, so takeover can't see which home ${unseen.length === 1 ? "it serves" : "they serve"}. Start ${unseen.length === 1 ? "it" : "them"} (\`systemctl --user start ${unseen[0]!.name}\`) so takeover can see, or disable ${unseen.length === 1 ? "it" : "them"} if ${unseen.length === 1 ? "it doesn't" : "they don't"} serve this home; then run takeover again. Nothing was changed.`);
  }
  const backupRoot = join(dirname(d.home), "parachute-takeover");
  try {
    const free = statfsSync(dirname(d.home));
    if (free.bavail * free.bsize < d.size_bytes * 1.1 + 64e6) {
      throw new Exit(EXIT.noRoom, `the backup needs ${size(d.size_bytes)} and ${dirname(d.home)} has ${size(free.bavail * free.bsize)} free. Nothing was changed.`);
    }
  } catch (err) {
    if (err instanceof Exit) throw err;
  }

  const paused: Record_["paused"] = [];
  // The backup's folder, named now: a paused agent's plist goes into its launchd/ folder.
  const dest = join(backupRoot, stamp());
  const asideDir = join(dest, "launchd");
  const toPauseAs = (u: Unit): Paused =>
    u.manager === "launchd"
      ? { name: u.name, manager: "launchd", active: !!u.pid, enabled: u.enabled, loaded: u.active, file: u.file!, aside: join(asideDir, basename(u.file!)) }
      : { name: u.name, manager: "systemd", active: true, enabled: u.enabled };
  // Written before anything is paused: if this run is cut off (an ssh drop, a reboot), the next takeover or --rollback
  // finds it and puts the old units back (and the backup, once v0.8 may have migrated the data).
  const progress: Record_ = {
    state: "taking-over",
    stage: "pausing",
    at: new Date().toISOString(),
    version: core.version,
    home: d.home,
    backup: "",
    rollback: d.rollback,
    migrations: d.migrations,
    paused: toPause.map(toPauseAs),
    core_unit: null,
    issuer: d.issuer,
    pid: process.pid,
  };
  writeRecord(d.home, progress);
  const putBack = async (why: string): Promise<string> => {
    const errors = resumeUnits(paused);
    if (errors.length) return `${why}; putting the old units back also failed: ${errors.join("; ")}`;
    // The old units ran moments ago and systemd has them again (enabled, started): this run is over. Whether they
    // then serve is up to them (another program may have taken their port meanwhile; lifecycle/takeover's
    // "can't serve" contract). A run cut off before this point is what the record is for.
    rmSync(join(d.home, RECORD_FILE), { force: true });
    return why;
  };
  for (const u of toPause) {
    say(`Pausing ${u.name} …`);
    // systemd: it has the data open, so it runs (whatever systemd's word for it: active, activating, reloading):
    // stopped, and started again on rollback. launchd: unloaded, and its plist moved aside (pauseAgent).
    const entry = toPauseAs(u);
    paused.push(entry);
    try {
      if (entry.manager === "launchd") {
        pauseAgent(entry);
        say(`  unloaded, and its plist moved to ${tilde(entry.aside)}`);
      } else {
        systemctl("stop", u.name);
        if (u.enabled) systemctl("disable", u.name);
      }
    } catch (err) {
      throw new Exit(EXIT.failed, await putBack(`pausing ${u.name} failed: ${(err as Error).message}`));
    }
  }
  if (!(await waitUntil(() => holders(d.home).length === 0, 20_000, 250))) {
    const still = holders(d.home);
    throw new Exit(EXIT.held, await putBack(`after pausing the old units, still holding the data: ${still.map((h) => `pid ${h.pid} (${h.cmd.slice(0, 80)})`).join(", ")}; the old units were put back`));
  }

  say(`Backing up ${tilde(d.home)} to ${tilde(dest)} …`);
  let copied: { files: number; bytes: number };
  try {
    copied = backup(d.home, dest);
  } catch (err) {
    throw new Exit(EXIT.failed, await putBack(`the backup failed: ${(err as Error).message}`));
  }
  say(`  ${copied.files} files, ${size(copied.bytes)}, each checked against its sha256 (manifest.json)`);
  writeRecord(d.home, { ...progress, stage: "backed-up", backup: dest });

  // Any rollback from here puts the backup back first if v0.8 has migrated the data.
  // The old programs come back only once nothing of v0.8 holds the data, and (after a migration) only once the
  // backup is back; otherwise they stay paused and it says what is left to do.
  const undo = async (why: string): Promise<Exit> => {
    const still = holders(d.home);
    if (still.length) {
      return new Exit(EXIT.checkFailed, `${why}; v0.8 still holds the data (${still.map((h) => `pid ${h.pid}`).join(", ")}), so the old units stay paused. Stop it, then ${backBy(paused) || "start the old programs"} yourself; the backup is in ${dest}`);
    }
    let msg = why;
    if (d.migrations.length) {
      try {
        // Core's unit may have taken writes before its check failed: whatever differs from the backup is exported.
        const dir = join(dest, `changed-since-takeover-${stamp()}`);
        const exported = exportChanged(d.home, join(dest, "home"), dir);
        if (exported) msg += `; ${exported} note${exported === 1 ? "" : "s"} changed since the backup ${exported === 1 ? "is" : "are"} in ${dir}`;
        const aside = restore(d.home, dest, (a) => ({ ...progress, stage: "checking", backup: dest, restored_at: new Date().toISOString(), moved_aside: a }));
        msg += `; the backup was restored (what v0.8 left is in ${aside})`;
      } catch (err) {
        return new Exit(EXIT.checkFailed, `${why}; restoring the backup failed: ${(err as Error).message}. The old units stay paused, because the data may be migrated. Restore ${dest}/home over ${d.home} (manifest.json has every sha256), then ${backBy(paused)}.`);
      }
    }
    const back = await putBack(msg);
    return new Exit(EXIT.checkFailed, back === msg ? `${msg}. The old programs are back as they were.` : back);
  };

  // From here every failure, expected or not, puts everything back: the unit, the record, the backup if v0.8
  // migrated the data, and the old units.
  let unitTried = false;
  const coreManager: Unit["manager"] = hubUnit?.manager === "launchd" ? "launchd" : "systemd";
  const coreName = coreManager === "launchd" ? CORE_AGENT : CORE_UNIT;
  try {
    return await startAndHandOver();
  } catch (err) {
    const left = unitTried ? (coreManager === "launchd" ? await stopCoreAgent(d.home, asideDir) : await stopCoreUnit(d.home)) : null;
    if (left) {
      // v0.8 may still start or write: nothing is restored and the old units stay paused, so two servers never
      // share the data. The record stays too, so `takeover --rollback` can finish the job once it is stopped.
      throw new Exit(EXIT.checkFailed, `${(err as Error).message}; then ${left}. The old units stay paused and nothing was restored; stop ${coreName}, then run \`parachute-core takeover --rollback\`. The backup is in ${dest}`);
    }
    if (err instanceof Exit) throw err; // from undo(), which has already put back what it could
    // Not finished (a "taken-over" record may be there already) until undo() has put the old units back; it then
    // removes the record, or leaves this one for the next run to finish.
    writeRecord(d.home, { ...progress, stage: unitTried ? "handing-over" : "checking", backup: dest, core_unit: unitTried ? coreName : null, ...(unitTried ? { core_manager: coreManager } : {}) });
    throw await undo(`${(err as Error).message}`);
  }

  async function startAndHandOver(): Promise<{ backup: string; record: Record_; core_unit: string | null }> {
    const kids = liveKids(d.home);
    writeRecord(d.home, { ...progress, stage: "checking", backup: dest });
    say("Starting v0.8 on the same data and checking every answer …");
    const problems = await checkRun(d, kids, hubUnit, say);
    if (problems.length) throw await undo(`a check failed: ${problems.join("; ")}`);

    const record: Record_ = {
      state: "taken-over",
      at: new Date().toISOString(),
      version: core.version,
      home: d.home,
      backup: dest,
      rollback: d.rollback,
      migrations: d.migrations,
      paused,
      core_unit: null,
      issuer: d.issuer,
    };
    writeRecord(d.home, record);

    if (hubUnit?.manager === "launchd") {
      say(`Starting v0.8 as the launchd agent ${CORE_AGENT} …`);
      try {
        const agent = writeCoreAgent(d, hubUnit);
        unitTried = true;
        // Named in the record before it starts, so a rollback after a failed start knows to stop it.
        record.core_unit = CORE_AGENT;
        record.core_manager = "launchd";
        writeRecord(d.home, record);
        const r = launchctl("bootstrap", guiDomain(), agent.path);
        if (r.code !== 0) throw new Error(`launchctl bootstrap ${guiDomain()} ${agent.path} exited ${r.code}: ${(r.stderr || r.stdout).trim()}`);
        const down = await coreUnitUp(agent.port, d, say, "launchd");
        if (down) throw new Error(down);
      } catch (err) {
        throw new Error(`starting ${CORE_AGENT} failed: ${(err as Error).message}`);
      }
    } else if (hubUnit) {
      say(`Starting v0.8 as ${CORE_UNIT} …`);
      try {
        const unit = writeCoreUnit(d, hubUnit.name);
        systemctl("daemon-reload");
        // A drop-in the unit already had (Also=, a stop that propagates) could make enabling, stopping or disabling
        // it reach another unit: checked before it is ever enabled, so the cleanup's disable is safe too.
        const reach = reachOf(CORE_UNIT, new Set());
        if (reach) throw new Error(`${reach}; ${CORE_UNIT} was written but not enabled`);
        unitTried = true;
        // Named in the record before it starts, so a rollback after a failed start knows to stop it.
        record.core_unit = CORE_UNIT;
        writeRecord(d.home, record);
        systemctl("enable", "--now", CORE_UNIT);
        const down = await coreUnitUp(unit.port, d, say);
        if (down) throw new Error(down);
      } catch (err) {
        throw new Error(`starting ${CORE_UNIT} failed: ${(err as Error).message}`);
      }
    }
    return { backup: dest, record, core_unit: record.core_unit };
  }
}

/**
 * Every note that differs from the backup (new, changed or deleted since the takeover), per vault, exported to
 * `dir` as JSON before a restore puts the backup's notes back. Compared with the backup itself, not by timestamps,
 * which an import can set to anything.
 */
function exportChanged(home: string, backupHome: string, dir: string): number {
  let n = 0;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const byName = (root: string) =>
    new Map(databases(root, { hub: 0, vault: 0 }).filter((d) => d.rel !== "hub.db").map((d) => [basename(dirname(d.rel)), join(root, d.rel)]));
  const before = byName(backupHome);
  const now = byName(home);
  for (const name of new Set([...before.keys(), ...now.keys()])) {
    const path = now.get(name);
    const old = new Map<string, string>();
    const was = before.get(name);
    if (was) for (const r of readOnly(was, (db) => db.query("SELECT id, updated_at, content, metadata, path FROM notes").all() as any[])) old.set(r.id, JSON.stringify([r.updated_at, r.content, r.metadata, r.path]));
    // A vault deleted since the takeover has no rows now: every note of it is reported deleted.
    const rows = path ? (readOnly(path, (db) => db.query("SELECT id, path, content, metadata, created_at, updated_at FROM notes").all() as any[])) : [];
    const changed = rows.filter((r) => old.get(r.id) !== JSON.stringify([r.updated_at, r.content, r.metadata, r.path]));
    const ids = new Set(rows.map((r) => r.id));
    const deleted = [...old.keys()].filter((id) => !ids.has(id));
    if (changed.length || deleted.length) writeFileSync(join(dir, `${name}.json`), `${JSON.stringify({ ...(path ? {} : { vault_deleted: true }), changed, deleted_ids: deleted }, null, 2)}\n`, { mode: 0o600 });
    n += changed.length + deleted.length;
  }
  return n;
}

async function rollBack(home: string, say: (s: string) => void): Promise<Record<string, unknown>> {
  const record = readRecord(home);
  if (record?.state === "taking-over") {
    const { units, exported } = await putBackInterrupted(home, record, say);
    return { rolled_back: true, rollback: "interrupted", exported_notes: exported, units };
  }
  if (!record || record.state !== "taken-over") throw new Exit(EXIT.failed, `${tilde(home)} has no takeover to roll back${record ? ` (it was rolled back on ${record.rolled_back_at})` : ""}`);
  if (record.core_unit && record.core_manager === "launchd") {
    // Still this home's? Running: one of its processes has this home's data open and none another home's. Not
    // running: its plist still carries the mark this takeover wrote. Anything launchctl won't say: not touched.
    const label = record.core_unit;
    const jobs = launchdJobs();
    if (jobs === null) throw new Exit(EXIT.failed, `launchctl didn't say whether ${label} runs (\`launchctl list\` failed); rollback won't touch it.`);
    const pid = jobs.get(label) ?? 0;
    let why: string | null = null;
    if (pid === 0) why = existsSync(coreAgentFile()) && coreAgentMark() !== home ? "no longer carries this takeover's mark for this home" : null;
    else if (!heldBy(home, []).some((h) => h.unit === label)) why = "is running but none of its processes has this home's data open";
    else why = unsafeToStop(label, home, new Set(), "launchd");
    if (why) {
      const what = why.startsWith(label) ? why : `${label} ${why}`;
      throw new Exit(EXIT.failed, `${what}; it may serve another home now, so rollback won't touch it. Stop it yourself if it is this home's, then run takeover --rollback again.`);
    }
    say(`Stopping ${label} …`);
    const left = await stopCoreAgent(home, asideOf(record, home));
    if (left) throw new Exit(EXIT.failed, left);
  } else if (record.core_unit) {
    // Still this home's? Running: one of its processes has this home's data open, none another home's, and stopping it
    // reaches no other unit. Stopped: it still carries the mark this takeover wrote. Anything systemd won't say, or
    // a unit that runs with no process named: not touched.
    const shown = run(["systemctl", "--user", "show", record.core_unit, "-p", "ActiveState", "-p", "MainPID"]);
    const state = /^ActiveState=(.*)$/m.exec(shown.stdout)?.[1]?.trim();
    const pidText = /^MainPID=(\d+)$/m.exec(shown.stdout)?.[1];
    if (shown.code !== 0 || state === undefined || pidText === undefined) {
      throw new Exit(EXIT.failed, `systemd didn't say whether ${record.core_unit} runs (systemctl show exited ${shown.code}); rollback won't touch it.`);
    }
    const stopped = state === "inactive" || state === "failed";
    let why: string | null = null;
    if (stopped) {
      why = readCoreUnitMark() !== home ? "no longer carries this takeover's mark for this home" : reachOf(record.core_unit, new Set());
    } else if (Number(pidText) === 0) {
      why = `is ${state} but systemd names no process for it`;
    } else if (!heldBy(home, [record.core_unit]).some((h) => h.unit === record.core_unit)) {
      why = "is running but none of its processes has this home's data open";
    } else {
      why = unsafeToStop(record.core_unit, home, new Set());
    }
    if (why) {
      const what = why.startsWith(record.core_unit) ? why : `${record.core_unit} ${why}`;
      throw new Exit(EXIT.failed, `${what}; it may serve another home now, so rollback won't touch it. Stop it yourself if it is this home's, then run takeover --rollback again.`);
    }
    say(`Stopping ${record.core_unit} …`);
    const r = run(["systemctl", "--user", "disable", "--now", record.core_unit]);
    if (r.code !== 0) throw new Exit(EXIT.failed, `stopping ${record.core_unit} failed: ${(r.stderr || r.stdout).trim()}`);
  }
  // On a retry, old units already put back may hold the data again: they are not in the way.
  const resumed = new Set(record.paused.map((u) => u.name));
  const inTheWay = () => heldBy(home, [...resumed]).filter((h) => !(h.unit && resumed.has(h.unit) && (record.restored_at || record.rollback === "code-only")));
  if (!(await waitUntil(() => inTheWay().length === 0, 20_000, 250))) {
    const still = inTheWay();
    throw new Exit(EXIT.held, `still holding the data: ${still.map((h) => `pid ${h.pid} (${h.cmd.slice(0, 80)})`).join(", ")}. Stop it, then run takeover --rollback again.`);
  }
  let exported = 0;
  if (record.rollback === "restore-backup" && !record.restored_at) {
    const dir = join(record.backup, `changed-since-takeover-${stamp()}`);
    exported = exportChanged(home, join(record.backup, "home"), dir);
    say(`Exported ${exported} notes changed since the takeover to ${tilde(dir)}`);
    record.restored_at = new Date().toISOString();
    // The record (restored_at set) goes into the restored home with it: a cut from here on won't restore again.
    record.moved_aside = restore(home, record.backup, (a) => ({ ...record, moved_aside: a }));
    // Still "taken-over" until the old units are back: a rollback that fails from here can be run again, and it
    // won't restore the backup a second time.
    writeRecord(home, record);
    say(`Restored the backup; what v0.8 left is in ${tilde(record.moved_aside)}`);
  }
  for (const u of record.paused) {
    if (u.manager === "launchd") say(`Putting ${u.name} back (its plist into ${tilde(dirname(u.file))}${u.loaded ? ", loaded" : ", not loaded, as it was"}) …`);
    else say(`Putting ${u.name} back (${u.enabled ? "enabled" : "disabled"}, ${u.active ? "running" : "stopped"}) …`);
  }
  const errors = resumeUnits(record.paused);
  if (errors.length) {
    throw new Exit(EXIT.failed, `putting the old units back failed: ${errors.join("; ")}. v0.8 is stopped${record.restored_at ? " and the backup is restored" : ""}; fix that and run \`parachute-core takeover --rollback\` again`);
  }
  writeRecord(home, { ...record, state: "rolled-back", rolled_back_at: new Date().toISOString() });
  return { rolled_back: true, rollback: record.rollback, exported_notes: exported, ...(record.moved_aside ? { moved_aside: record.moved_aside } : {}), units: record.paused.map((u) => u.name) };
}

export async function takeover(args: string[]): Promise<number> {
  const say = (line: string) => console.error(`parachute-core takeover: ${line}`);
  try {
    const f = parseFlags(args);
    if (f.help) {
      console.log(takeoverHelp());
      return EXIT.ok;
    }
    // The real folder, once, for everything from here: a restore through a link to the home would replace the link,
    // and the old units, which name the real folder, would reopen the data the restore was meant to replace.
    const home = realHome(resolve(f.home ?? homeDir()));
    const out = (s: string) => (f.json ? console.error(s) : console.log(s));
    if (f.rollback) {
      if (!holdTakeoverLock(home)) throw new Exit(EXIT.held, `another takeover or rollback of ${tilde(home)} is running now; nothing was changed`);
      finishRestore(home, f.json ? say : out);
      const record = readRecord(home);
      if (!f.yes) {
        if (!record || (record.state !== "taken-over" && record.state !== "taking-over")) throw new Exit(EXIT.failed, `${tilde(home)} has no takeover to roll back`);
        out(`Rolling back stops v0.8${record.core_unit ? ` (${record.core_unit})` : ""} and puts ${record.paused.map((u) => u.name).join(" and ") || "the old programs"} back as they were.`);
        out(record.rollback === "code-only" ? "No data was converted, so every write made under v0.8 is kept." : `The data was migrated: every note changed since ${record.at} is exported first, then the backup ${tilde(record.backup)} is restored.`);
        if (!confirm("Roll back now? [y/N] ")) {
          if (!process.stdin.isTTY) throw new Exit(EXIT.usage, "not rolled back: pass --yes to go ahead");
          out("Not rolled back. Nothing was changed.");
          return EXIT.ok;
        }
      }
      const result = await rollBack(home, f.json ? say : out);
      if (f.json) console.log(JSON.stringify({ home, ...result }));
      else out("Rolled back: the old programs have this home again.");
      return EXIT.ok;
    }
    const unfinished = staleRestore(home);
    if (!existsSync(home) && !unfinished) throw new Exit(EXIT.failed, `there is no Parachute home at ${tilde(home)}: nothing to take over`);
    if (f.dryRun && unfinished) throw new Exit(EXIT.failed, `a restore of ${tilde(home)} was cut off before the restored copy took its place (${tilde(unfinished)}); \`parachute-core takeover --rollback --yes\` finishes it`);
    if (!f.dryRun && !holdTakeoverLock(home)) throw new Exit(EXIT.held, `another takeover or rollback of ${tilde(home)} is running now; nothing was changed`);
    if (!f.dryRun) finishRestore(home, out);
    const cut = readRecord(home);
    if (cut?.state === "taking-over" && !f.dryRun) {
      if (!f.yes && !confirm(`A takeover of this home started on ${cut.at} was interrupted. Put the old programs back first, then take over? [y/N] `)) {
        if (!process.stdin.isTTY) throw new Exit(EXIT.usage, "nothing was changed: an earlier takeover was interrupted; pass --yes to put it back and take over (or --dry-run to only look)");
        out("Nothing was changed.");
        return EXIT.ok;
      }
      await putBackInterrupted(home, cut, f.json ? say : out);
    }
    const d = await detect(home);
    const report = () => ({
      home: d.home,
      old: d.old,
      units: d.units,
      running: d.running,
      vaults: d.vaults,
      hub_schema: d.hub_schema,
      migrations: d.migrations,
      rollback: d.rollback,
      plan: plan(d),
      others: d.others,
      unfound: d.unfound,
    });
    if (!f.json || !f.yes) out(describe(d));
    if (f.dryRun) {
      if (f.json) console.log(JSON.stringify({ ...report(), backup: null, dry_run: true }));
      else out("Dry run: nothing was changed.");
      return EXIT.ok;
    }
    if (d.record?.state === "taken-over") throw new Exit(EXIT.failed, `already taken over on ${d.record.at}; \`parachute-core takeover --rollback\` goes back`);
    if (!f.yes && !confirm("Take over now? [y/N] ")) {
      if (!process.stdin.isTTY) throw new Exit(EXIT.usage, "nothing was changed: pass --yes to go ahead (or --dry-run to only look)");
      out("Nothing was changed.");
      return EXIT.ok;
    }
    const done = await takeOver(d, f.json ? say : out);
    if (f.json) console.log(JSON.stringify({ ...report(), backup: done.backup, core_unit: done.core_unit, taken_over: true }));
    else {
      out(`Done. v0.8 has this home${done.core_unit ? ` and runs as ${done.core_unit}` : ": start it with `parachute-core serve`"}.`);
      out(`The old programs are installed and off. Backup: ${tilde(done.backup)}. Going back: \`parachute-core takeover --rollback\`.`);
    }
    return EXIT.ok;
  } catch (err) {
    say((err as Error).message);
    return err instanceof Exit ? err.code : EXIT.failed;
  }
}

/** For dispatch: the refusal `serve` gives on a home the old programs still own, or null. */
export function serveRefusal(home: string): string | null {
  if (process.env.PARACHUTE_TAKEOVER_CHECK === "1") return null;
  const why = oldOwner(home);
  if (!why) return null;
  return [
    `parachute-core serve: an older Parachute still owns ${tilde(home)} (${why}).`,
    "Nothing was started or changed. Run `parachute-core takeover` to see what it found and move this home over to v0.8;",
    "it backs up first, and `parachute-core takeover --rollback` goes back.",
  ].join("\n");
}
