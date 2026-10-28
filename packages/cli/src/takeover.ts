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
//      the data. Pausing comes before the backup so the backup is the bytes as they rest, copied exactly;
//    - back up every file of the home to <home>/../parachute-takeover/<timestamp>/home/, with manifest.json (a
//      sha256 per file, checked against the copy);
//    - start v0.8 on the same home (a check run on a free loopback port, with the old issuer) and check every
//      answer: /api/ready, the issuer, every live signing key in the JWKS, and per vault a read pass, its note count
//      and a read; then stop it;
//    - write <home>/takeover.json (the record), and if a unit ran the old hub, hand the home to a new unit,
//      parachute-core.service, and check it is up.
//    If a check fails it puts everything back (the backup too, when the check run migrated data) and exits 8.
// 4. The old programs stay installed, byte-identical, and off. Nothing is converted beyond the named migrations.
// 5. --rollback stops v0.8 (its unit) and puts the old units back as they were. Code-only when there were no
//    migrations, so every write made under v0.8 is kept; otherwise it first exports every note changed since the
//    takeover, then restores the backup.
//
// Exit codes: 0 done · 1 another error (nothing to roll back, a platform not built yet) · 2 flags, or no --yes
// where nobody can be asked · 5 no room for the backup · 6 newer data (dispatch) · 7 an old process holds the data
// · 8 a check failed after start (it put everything back).
//
// `parachute-core serve` on a home the old programs still own, with no takeover record, refuses with exit 7 and says
// to run takeover (oldOwner(), called from dispatch).
import { Database, constants } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import core from "../../../package.json" with { type: "json" };
import { databases, homeDir, schemaOf } from "./home.ts";
import { bundleRoot } from "./install.ts";

export const EXIT = { ok: 0, failed: 1, usage: 2, noRoom: 5, held: 7, checkFailed: 8 } as const;
export const RECORD_FILE = "takeover.json";
const CORE_UNIT = "parachute-core.service";
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
  /** Runs the old hub or vault: the takeover pauses it. Other Parachute units (a tunnel, scribe) are left alone. */
  old: boolean;
}

export interface Holder {
  pid: number;
  cmd: string;
  /** The systemd unit the process belongs to, if any. */
  unit?: string;
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
  others: string[];
  record: Record_ | null;
}

interface Record_ {
  state: "taken-over" | "rolled-back";
  at: string;
  rolled_back_at?: string;
  version: string;
  home: string;
  backup: string;
  rollback: "code-only" | "restore-backup";
  migrations: string[];
  paused: { name: string; manager: "systemd"; active: boolean; enabled: boolean }[];
  core_unit: string | null;
  issuer: string;
}

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

/** Parachute's systemd user units (not core's own), with state; and which of them run the old programs. */
function systemdUnits(): Unit[] {
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
    let text = "";
    if (file) {
      try {
        text = readFileSync(file, "utf8");
      } catch {}
    } else {
      text = run(["systemctl", "--user", "cat", name]).stdout;
    }
    const execs = text.split("\n").filter((l) => /^\s*ExecStart\s*=/.test(l)).join("\n");
    const active = run(["systemctl", "--user", "is-active", name]).stdout.trim() === "active";
    const enabled = run(["systemctl", "--user", "is-enabled", name]).stdout.trim() === "enabled";
    out.push({ name, manager: "systemd", active, enabled, ...(file ? { file } : {}), old: OLD_UNIT_NAMES.has(name) || OLD_COMMAND.test(execs) });
  }
  return out;
}

/** Parachute's launchd agents (macOS): reported; pausing them is not built yet. */
function launchdUnits(): Unit[] {
  if (process.platform !== "darwin") return [];
  const dir = join(userHome(), "Library", "LaunchAgents");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /parachute/i.test(f) && f.endsWith(".plist"));
  } catch {}
  return files.sort().map((f) => {
    const label = f.replace(/\.plist$/, "");
    let text = "";
    try {
      text = readFileSync(join(dir, f), "utf8");
    } catch {}
    const active = run(["launchctl", "list", label]).code === 0;
    return { name: label, manager: "launchd" as const, active, enabled: true, file: join(dir, f), old: OLD_COMMAND.test(text) || /hub|vault/i.test(label) };
  });
}

/** Every SQLite file of the home's databases (with -wal and -shm). */
function dataFiles(home: string): string[] {
  const dbs = databases(home, { hub: 0, vault: 0 }).map((d) => join(home, d.rel));
  return dbs.flatMap((d) => [d, `${d}-wal`, `${d}-shm`]);
}

/** Processes (not this one) holding any of the home's databases open, with the systemd unit each belongs to. */
export function holders(home: string): Holder[] {
  const files = new Set(dataFiles(home));
  const out: Holder[] = [];
  if (process.platform === "linux") {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      let fds: string[] = [];
      try {
        fds = readdirSync(`/proc/${name}/fd`);
      } catch {
        continue;
      }
      const holds = fds.some((fd) => {
        try {
          return files.has(readlinkSync(`/proc/${name}/fd/${fd}`));
        } catch {
          return false;
        }
      });
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
      out.push({ pid: Number(name), cmd, ...(unit ? { unit } : {}) });
    }
    return out;
  }
  const existing = [...files].filter((f) => existsSync(f));
  if (existing.length === 0 || !Bun.which("lsof")) return out;
  const r = run(["lsof", "-t", ...existing]);
  for (const pid of new Set(r.stdout.split(/\s+/).filter(Boolean).map(Number))) {
    if (pid === process.pid) continue;
    out.push({ pid, cmd: run(["ps", "-o", "command=", "-p", String(pid)]).stdout.trim() });
  }
  return out;
}

/** A query on a database without changing a byte of the home (immutable, or a scratch copy when it has a WAL). */
function readOnly<T>(path: string, q: (db: Database) => T): T {
  const wal = `${path}-wal`;
  if (!(existsSync(wal) && statSync(wal).size > 0)) {
    const uri = encodeURI(path).replace(/\?/g, "%3F").replace(/#/g, "%23");
    const db = new Database(`file:${uri}?immutable=1`, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
    try {
      return q(db);
    } finally {
      db.close();
    }
  }
  const scratch = join(tmpdir(), `.parachute-takeover-read-${randomBytes(4).toString("hex")}`);
  mkdirSync(scratch, { mode: 0o700 });
  try {
    copyFileSync(path, join(scratch, "db"));
    copyFileSync(wal, join(scratch, "db-wal"));
    const db = new Database(join(scratch, "db"), { readonly: true });
    try {
      return q(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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
  return r && (r.state === "taken-over" || r.state === "rolled-back") ? (r as Record_) : null;
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
      if (!dir || !existsSync(join(dir, "package.json")) || ours(dir)) continue;
      const pkg = readJson(join(dir, "package.json"));
      if (pkg?.name === "@openparachute/hub" || pkg?.name === "@openparachute/vault") why.push(`${pkg.name} ${pkg.version} in ${dir}`);
    }
  }
  for (const name of OLD_UNIT_NAMES) if (existsSync(join(systemdUnitDir(), name))) why.push(`the unit ${name}`);
  if (process.platform === "darwin") {
    for (const u of launchdUnits()) if (u.old) why.push(`the launchd agent ${u.name}`);
  }
  return why.length ? [...new Set(why)].join(", ") : null;
}

/** Everything step 1 finds, changing nothing. */
export async function detect(home: string): Promise<Detected> {
  const { HUB_SCHEMA_VERSION } = await import("@openparachute/hub/src/hub-db.ts");
  const { SCHEMA_VERSION } = await import("@openparachute/vault/core/src/schema.ts");
  const { resolveHubIssuer } = await import("@openparachute/hub/src/hub-issuer.ts");
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
  const others = Array.isArray(rows)
    ? rows.map((r: any) => String(r?.name ?? "")).filter((n: string) => n && n !== "parachute-vault" && n !== "parachute-hub")
    : [];
  return {
    home,
    old: oldInstalls(),
    units: [...systemdUnits(), ...launchdUnits()],
    running: holders(home),
    vaults,
    hub_schema: hubSchema,
    migrations,
    rollback: migrations.length ? "restore-backup" : "code-only",
    issuer: resolveHubIssuer(undefined, home),
    size_bytes: treeSize(home),
    others,
    record: readRecord(home),
  };
}

// ── plain words ──────────────────────────────────────────────────────────────────────────────────────────────

const tilde = (p: string) => (p.startsWith(userHome() + "/") ? `~/${p.slice(userHome().length + 1)}` : p);

function size(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

function plan(d: Detected): string[] {
  const pause = d.units.filter((u) => u.old && (u.active || u.enabled)).map((u) => u.name);
  const steps = [
    pause.length ? `pause ${pause.join(" and ")} (stop and disable; the unit files stay)` : "nothing to pause: no old unit is on",
    `back up the home to ${tilde(join(dirname(d.home), "parachute-takeover"))}/<time>/, with a sha256 for every file`,
    `start v0.8 (${core.name} ${core.version}) on the same home and check every vault answers with the same notes`,
  ];
  if (d.units.some((u) => u.old && u.manager === "systemd")) steps.push(`run it from now on as ${CORE_UNIT}`);
  steps.push("leave the old programs installed, as they are, and off");
  return steps;
}

export function describe(d: Detected): string {
  const lines: string[] = [];
  const prog = (p: OldProgram | null, what: string) => (p ? `${what} ${p.version}` : null);
  const found = [prog(d.old.hub, "hub"), prog(d.old.vault, "vault")].filter(Boolean);
  const where = [...new Set([d.old.hub, d.old.vault].filter((p): p is OldProgram => !!p).map((p) => tilde(p.path.split("/install/global/")[0]!.split("/lib/node_modules/")[0]!)))];
  lines.push(found.length ? `Found Parachute ${found.join(" and ")} installed in ${where.join(" and ")}.` : "No old Parachute programs are installed globally (bun or npm).");
  for (const u of d.units) {
    const state = `${u.active ? "running" : "not running"}, ${u.enabled ? "starts at login" : "off at login"}`;
    lines.push(`  ${u.manager} unit ${u.name}: ${state}${u.old ? "" : " (not the old hub or vault: left alone)"}`);
  }
  for (const h of d.running) lines.push(`  process ${h.pid} has the data open${h.unit ? ` (${h.unit})` : ""}: ${h.cmd.slice(0, 120)}`);
  const notes = d.vaults.reduce((n, v) => n + v.notes, 0);
  lines.push(`The home ${tilde(d.home)} holds ${d.vaults.length} vault${d.vaults.length === 1 ? "" : "s"} (${size(d.size_bytes)}):`);
  for (const v of d.vaults) lines.push(`  ${v.name}: ${v.notes} notes, schema ${v.schema}`);
  if (d.vaults.length > 1) lines.push(`  ${notes} notes in all`);
  if (d.hub_schema !== null) lines.push(`  hub.db: schema ${d.hub_schema}`);
  if (d.others.length) lines.push(`Also registered: ${d.others.join(", ")}. v0.8 doesn't run ${d.others.length === 1 ? "it" : "them"}; left as ${d.others.length === 1 ? "it is" : "they are"}.`);
  if (d.migrations.length === 0) {
    lines.push("v0.8 will use this data as it is: nothing is converted. Going back is starting the old programs again (`parachute-core takeover --rollback`).");
  } else {
    lines.push("Opening this home with v0.8 runs these migrations:");
    for (const m of d.migrations) lines.push(`  ${m}`);
    lines.push("Going back means restoring the backup: `parachute-core takeover --rollback` exports every note changed since, then restores it.");
  }
  if (d.record?.state === "taken-over") lines.push(`This home was already taken over on ${d.record.at} (backup ${tilde(d.record.backup)}).`);
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

/** Every regular file under `root`, relative to it. */
function files(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const r = rel ? join(rel, name) : name;
      const st = lstatSync(join(root, r));
      if (st.isDirectory()) walk(r);
      else if (st.isFile()) out.push(r);
    }
  };
  walk("");
  return out;
}

/** Copy every file of the home, byte for byte, with a manifest; check each copy against its hash. */
function backup(home: string, dest: string): { files: number; bytes: number } {
  const into = join(dest, "home");
  mkdirSync(into, { recursive: true, mode: 0o700 });
  const manifest: Record<string, string> = {};
  let bytes = 0;
  for (const rel of files(home)) {
    const from = join(home, rel);
    const to = join(into, rel);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(from, to);
    const h = sha256(from);
    if (sha256(to) !== h) throw new Error(`the backup copy of ${rel} doesn't match the original`);
    manifest[rel] = h;
    bytes += statSync(from).size;
  }
  writeFileSync(join(dest, "manifest.json"), `${JSON.stringify({ home, at: new Date().toISOString(), files: manifest }, null, 2)}\n`, { mode: 0o600 });
  return { files: Object.keys(manifest).length, bytes };
}

/** Put the backup's bytes back as the home; what was there moves aside (`<home>.after-takeover-<time>`). */
function restore(home: string, dest: string): string {
  const manifest = readJson(join(dest, "manifest.json"))?.files as Record<string, string> | undefined;
  if (!manifest) throw new Error(`no manifest in ${dest}`);
  const staged = `${home}.restoring-${randomBytes(3).toString("hex")}`;
  for (const [rel, h] of Object.entries(manifest)) {
    const to = join(staged, rel);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(join(dest, "home", rel), to);
    if (sha256(to) !== h) throw new Error(`the backup's ${rel} doesn't match its manifest`);
  }
  const aside = `${home}.after-takeover-${stamp()}`;
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
 * Start v0.8 on the home (a check run: this program's own `serve` on a free loopback port, with the old issuer)
 * and check every answer. Returns the problems found (empty when all is well); it always stops the check run.
 */
async function checkRun(d: Detected, kids: string[], log: (s: string) => void): Promise<string[]> {
  const port = freePort();
  const hub = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // The old issuer, so tokens issued before carry it; keys and revocations from this check run's own hub, whatever
  // the caller's shell says (a JWKS origin left over from the old box points where nothing listens now).
  Object.assign(env, { PARACHUTE_HOME: d.home, PARACHUTE_HUB_ORIGIN: d.issuer, PARACHUTE_HUB_JWKS_ORIGIN: hub, PARACHUTE_TAKEOVER_CHECK: "1" });
  for (const k of ["PORT", "PARACHUTE_BIND_HOST", "PARACHUTE_HUB_ORIGINS", "VAULT_BIND"]) delete env[k];
  const logPath = join(tmpdir(), `parachute-takeover-check-${process.pid}.log`);
  const proc = Bun.spawn([process.execPath, CORE_ENTRY, "serve", "--listen", `127.0.0.1:${port}`], {
    env,
    stdin: "ignore",
    stdout: Bun.file(logPath),
    stderr: Bun.file(logPath),
  });
  const problems: string[] = [];
  try {
    const ready = await waitUntil(async () => proc.exitCode !== null || (await getJson(`${hub}/api/ready`)).status === 200, 90_000, 300);
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
    else log(`  the issuer and all ${kids.length} live signing keys are the same: every token issued before still verifies`);
    for (const v of d.vaults) {
      const m = Bun.spawnSync([process.execPath, CORE_ENTRY, "auth", "mint-token", "--scope", `vault:${v.name}:read`, "--expires-in", "300", "--label", "takeover-check", "--json"], {
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      let token: string | undefined;
      try {
        token = JSON.parse(m.stdout.toString().trim().split("\n").pop() ?? "").token;
      } catch {}
      if (!token) {
        problems.push(`vault ${v.name}: couldn't mint a read pass for the check (${m.stderr.toString().trim().slice(-200)})`);
        continue;
      }
      const info = await getJson(`${hub}/vault/${encodeURIComponent(v.name)}/api/vault?include_stats=true`, token);
      const count = info.body?.stats?.totalNotes;
      const one = await getJson(`${hub}/vault/${encodeURIComponent(v.name)}/api/notes?limit=1`, token);
      if (info.status !== 200 || count !== v.notes) problems.push(`vault ${v.name}: HTTP ${info.status}, ${count ?? "no"} notes, want ${v.notes}`);
      else if (one.status !== 200 || (v.notes > 0 && !(Array.isArray(one.body) ? one.body.length : one.body?.notes?.length))) problems.push(`vault ${v.name}: reading a note gave HTTP ${one.status}`);
      else log(`  vault ${v.name}: ${count} notes, read ok`);
    }
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
    rmSync(logPath, { force: true });
  }
}

/** The command a unit runs core with: the installed `<prefix>/bin/parachute-core` when this copy is installed. */
function coreCommand(): string {
  const root = bundleRoot();
  if (!root) return `${process.execPath} ${CORE_ENTRY}`;
  const store = root.lastIndexOf("/.store/");
  if (store >= 0) {
    const bin = join(root.slice(0, store), "bin", "parachute-core");
    if (existsSync(bin)) return bin;
  }
  return join(root, "bin", "parachute-core");
}

/** The environment the old hub's unit gave it (PORT, bind, origins, drop-ins), as systemd lines for core's unit. */
function unitEnvironment(unit: string): string[] {
  const out: string[] = [];
  const show = run(["systemctl", "--user", "show", unit, "-p", "Environment", "-p", "EnvironmentFiles"]).stdout;
  for (const line of show.split("\n")) {
    if (line.startsWith("Environment=")) {
      for (const m of line.slice("Environment=".length).matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
        const kv = m[1] ?? m[2]!;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(kv)) out.push(`Environment=${JSON.stringify(kv)}`);
      }
    } else if (line.startsWith("EnvironmentFiles=")) {
      const path = line.slice("EnvironmentFiles=".length).replace(/\s*\(ignore_errors=(yes|no)\)\s*$/, "").trim();
      if (path) out.push(`EnvironmentFile=-${path}`);
    }
  }
  return out;
}

function writeCoreUnit(d: Detected, from: string): string {
  const path = join(systemdUnitDir(), CORE_UNIT);
  const env = unitEnvironment(from);
  if (!env.some((l) => l.includes("PARACHUTE_HOME="))) env.unshift(`Environment=${JSON.stringify(`PARACHUTE_HOME=${d.home}`)}`);
  const text = [
    "[Unit]",
    `Description=Parachute ${core.version} (parachute-core): took over from ${from} on ${new Date().toISOString().slice(0, 10)}`,
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=${coreCommand()} serve`,
    ...env,
    "Restart=on-failure",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o644 });
  return path;
}

/** Is core's unit up: active and staying so; and when it names its process, answering /api/ready on its port. */
async function coreUnitUp(d: Detected): Promise<string | null> {
  const active = () => run(["systemctl", "--user", "is-active", CORE_UNIT]).stdout.trim() === "active";
  if (!(await waitUntil(active, 30_000, 500))) return `${CORE_UNIT} did not become active`;
  await Bun.sleep(3000);
  if (!active()) return `${CORE_UNIT} stopped again within 3 s`;
  const pid = Number(/MainPID=(\d+)/.exec(run(["systemctl", "--user", "show", CORE_UNIT, "-p", "MainPID"]).stdout)?.[1] ?? 0);
  if (pid > 0) {
    const issuerPort = Number(new URL(d.issuer).port || 0);
    const port = issuerPort || 1939;
    const ok = await waitUntil(async () => (await getJson(`http://127.0.0.1:${port}/api/ready`)).status === 200, 60_000, 500);
    if (!ok) return `${CORE_UNIT} (pid ${pid}) is not answering /api/ready on port ${port}`;
  }
  return null;
}

function writeRecord(home: string, r: Record_): void {
  const p = join(home, RECORD_FILE);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, p);
}

/** Put the old units back as they were: enabled ones enabled, running ones started. */
function resumeUnits(paused: Record_["paused"]): string[] {
  const errors: string[] = [];
  for (const u of paused) {
    try {
      if (u.enabled) systemctl("enable", u.name);
      if (u.active) systemctl("start", u.name);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  return errors;
}

async function takeOver(d: Detected, say: (s: string) => void): Promise<{ backup: string; record: Record_; core_unit: string | null }> {
  if (d.units.some((u) => u.old && u.manager === "launchd" && (u.active || u.enabled))) {
    throw new Exit(EXIT.failed, "the old programs run as launchd agents; taking those over isn't built yet (macOS). Nothing was changed.");
  }
  const toPause = d.units.filter((u) => u.old && u.manager === "systemd" && (u.active || u.enabled));
  const pausable = new Set(toPause.map((u) => u.name));
  const outside = d.running.filter((h) => !h.unit || !pausable.has(h.unit));
  if (outside.length) {
    throw new Exit(EXIT.held, `an old process holds the data and isn't run by a unit this can pause: ${outside.map((h) => `pid ${h.pid} (${h.cmd.slice(0, 80)})`).join(", ")}. Stop it, then run takeover again. Nothing was changed.`);
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
  const putBack = (why: string) => {
    const errors = resumeUnits(paused);
    return errors.length ? `${why}; putting the old units back also failed: ${errors.join("; ")}` : why;
  };
  for (const u of toPause) {
    say(`Pausing ${u.name} …`);
    paused.push({ name: u.name, manager: "systemd", active: u.active, enabled: u.enabled });
    try {
      if (u.active) systemctl("stop", u.name);
      if (u.enabled) systemctl("disable", u.name);
    } catch (err) {
      throw new Exit(EXIT.failed, putBack(`pausing ${u.name} failed: ${(err as Error).message}`));
    }
  }
  if (!(await waitUntil(() => holders(d.home).length === 0, 20_000, 250))) {
    const still = holders(d.home);
    throw new Exit(EXIT.held, putBack(`after pausing the old units, still holding the data: ${still.map((h) => `pid ${h.pid} (${h.cmd.slice(0, 80)})`).join(", ")}; the old units were put back`));
  }

  const dest = join(backupRoot, stamp());
  say(`Backing up ${tilde(d.home)} to ${tilde(dest)} …`);
  let copied: { files: number; bytes: number };
  try {
    copied = backup(d.home, dest);
  } catch (err) {
    throw new Exit(EXIT.failed, putBack(`the backup failed: ${(err as Error).message}`));
  }
  say(`  ${copied.files} files, ${size(copied.bytes)}, each checked against its sha256 (manifest.json)`);

  // Any rollback from here puts the backup back first if v0.8 has migrated the data.
  const undo = (why: string): Exit => {
    let msg = why;
    if (d.migrations.length) {
      try {
        const aside = restore(d.home, dest);
        msg += `; the backup was restored (what v0.8 left is in ${aside})`;
      } catch (err) {
        msg += `; restoring the backup failed too: ${(err as Error).message}. The backup is in ${dest}`;
      }
    }
    return new Exit(EXIT.checkFailed, putBack(msg) + ". The old programs are back as they were.");
  };

  const kids = liveKids(d.home);
  say("Starting v0.8 on the same data and checking every answer …");
  const problems = await checkRun(d, kids, say);
  if (problems.length) throw undo(`a check failed: ${problems.join("; ")}`);

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

  const hubUnit = toPause.find((u) => u.manager === "systemd" && /hub/.test(u.name)) ?? toPause[0];
  if (hubUnit) {
    say(`Starting v0.8 as ${CORE_UNIT} …`);
    try {
      writeCoreUnit(d, hubUnit.name);
      systemctl("daemon-reload");
      systemctl("enable", "--now", CORE_UNIT);
      const down = await coreUnitUp(d);
      if (down) throw new Error(down);
      record.core_unit = CORE_UNIT;
      writeRecord(d.home, record);
    } catch (err) {
      run(["systemctl", "--user", "disable", "--now", CORE_UNIT]);
      rmSync(join(d.home, RECORD_FILE), { force: true });
      throw undo(`starting ${CORE_UNIT} failed: ${(err as Error).message}`);
    }
  }
  return { backup: dest, record, core_unit: record.core_unit };
}

/** Changed notes since `since`, per vault, exported to `dir` before a restore (JSON, one file per vault). */
function exportChanged(home: string, since: string, dir: string): number {
  let n = 0;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const d of databases(home, { hub: 0, vault: 0 })) {
    if (d.rel === "hub.db") continue;
    const name = basename(dirname(d.rel));
    const rows = readOnly(join(home, d.rel), (db) =>
      db.query("SELECT id, path, content, metadata, created_at, updated_at FROM notes WHERE created_at > ? OR updated_at > ?").all(since, since),
    );
    if (rows.length) writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
    n += rows.length;
  }
  return n;
}

async function rollBack(home: string, say: (s: string) => void): Promise<Record<string, unknown>> {
  const record = readRecord(home);
  if (!record || record.state !== "taken-over") throw new Exit(EXIT.failed, `${tilde(home)} has no takeover to roll back${record ? ` (it was rolled back on ${record.rolled_back_at})` : ""}`);
  if (record.core_unit) {
    say(`Stopping ${record.core_unit} …`);
    const r = run(["systemctl", "--user", "disable", "--now", record.core_unit]);
    if (r.code !== 0) throw new Exit(EXIT.failed, `stopping ${record.core_unit} failed: ${(r.stderr || r.stdout).trim()}`);
  }
  if (!(await waitUntil(() => holders(home).length === 0, 20_000, 250))) {
    const still = holders(home);
    throw new Exit(EXIT.held, `still holding the data: ${still.map((h) => `pid ${h.pid} (${h.cmd.slice(0, 80)})`).join(", ")}. Stop it, then run takeover --rollback again.`);
  }
  let exported = 0;
  let aside: string | undefined;
  if (record.rollback === "restore-backup") {
    const dir = join(record.backup, `changed-since-takeover-${stamp()}`);
    exported = exportChanged(home, record.at, dir);
    say(`Exported ${exported} notes changed since the takeover to ${tilde(dir)}`);
    aside = restore(home, record.backup);
    say(`Restored the backup; what v0.8 left is in ${tilde(aside)}`);
  }
  for (const u of record.paused) say(`Putting ${u.name} back (${u.enabled ? "enabled" : "disabled"}, ${u.active ? "running" : "stopped"}) …`);
  const errors = resumeUnits(record.paused);
  const done: Record_ = { ...record, state: "rolled-back", rolled_back_at: new Date().toISOString() };
  writeRecord(home, done);
  if (errors.length) throw new Exit(EXIT.failed, `putting the old units back failed: ${errors.join("; ")}`);
  return { rolled_back: true, rollback: record.rollback, exported_notes: exported, ...(aside ? { moved_aside: aside } : {}), units: record.paused.map((u) => u.name) };
}

export async function takeover(args: string[]): Promise<number> {
  const say = (line: string) => console.error(`parachute-core takeover: ${line}`);
  try {
    const f = parseFlags(args);
    if (f.help) {
      console.log(takeoverHelp());
      return EXIT.ok;
    }
    const home = resolve(f.home ?? homeDir());
    const out = (s: string) => (f.json ? console.error(s) : console.log(s));
    if (f.rollback) {
      const record = readRecord(home);
      if (!f.yes) {
        if (!record || record.state !== "taken-over") throw new Exit(EXIT.failed, `${tilde(home)} has no takeover to roll back`);
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
    if (!existsSync(home)) throw new Exit(EXIT.failed, `there is no Parachute home at ${tilde(home)}: nothing to take over`);
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

