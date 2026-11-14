// `parachute upgrade`: what it accepts, `--check`, and the upgrade itself.
//
//   parachute upgrade [--channel latest|next|beta] [--json]      the newer release from this home's channel; or, on
//                                                                a home another release served last, the step
//   parachute upgrade --check [--json]                           the step to this release, run on a throwaway copy
//   parachute upgrade --rollback [--restore] [--yes] [--json]    back to the release before (release.ts)
//   parachute upgrade <service> [--channel rc|latest] [--tag <name>] [--allow-downgrade]
//                                                                a module the hub installed: the hub's own upgrade
//
// **Nothing is touched before the arguments are understood.** Every other command's first act on an older home is
// the step itself (release.ts beforeOpen: back the databases up, record the release). `upgrade` is the one command
// people run to ask about that step, so its arguments are read first (parseUpgrade, from dispatch.ts, before any
// check of the home): an unknown flag or service exits 2 with the home byte for byte as it was. The blocker this
// closes (2026-11-13): `upgrade --check` wasn't built, so 0.9 backed the home up, recorded it as moved to 0.9
// (`state: current`), and only then said `unknown service "--check"`, on a home 0.8 still served.
//
// **`--check` never writes to the home it is asked about.** No backup of it, no run/release.json, not even the
// release lock. It works on a copy:
//   1. a scratch folder beside the home (the same filesystem, where the real backup will go), removed at the end
//      however the command ends, and at the next check if this one was killed;
//   2. every database copied consistently (VACUUM INTO, read the way the newer-data check reads: never a byte of
//      the home changed, also while a server has it open), and the small files a command reads (settings).
//      Attachments, mirrors and logs are left out: the step doesn't read them. The release record goes along
//      without its paths (copyRecord): it names the home's real backup folder, and nothing on the copy may write
//      there;
//   3. this same program run on the copy, as the first command on the home would run: the newer-data check, the
//      backup, the record, then every database opened by this release (the hub's keys, each vault's types and tags);
//   4. the report: what the step did on the copy, what it would refuse, and what moved a schema number (which makes
//      the way back a restore).
// It starts no server, so nothing listens, no module starts and nothing leaves the machine.
// Exit codes: 0 the step ran clean on the copy · 1 it failed or would be refused (the report says what) · 2 usage ·
// 5 no room for the copy · 6 the home was written by a newer release.
//
// **`parachute upgrade` with no service** does one of two things, and says which:
//   - on a home this release already serves: it reads the home's channel (run/release.json `channel`: the npm
//     dist-tag `latest`, `next` or `beta`; `--channel` changes it), asks the registry which version that is, and
//     installs it when it is newer. A copy installed under a prefix (install.ts) downloads that version's bundle
//     and its SHA256SUMS from the release, checks the sum, and runs the new bundle's own `install --prefix`: the
//     links switch, the old copy stays (the way back). An npm or bun install runs that package manager. A
//     prerelease channel also looks at `latest`, so a box on `beta` reaches the stable release when it ships. The
//     running server is not restarted: the next start runs the new release, and backs up first;
//   - on a home another release served last, or one rolled back: it takes the step with this release (release.ts
//     stepForward: the backup, the record), points the install's links at this release, and says to start it. It
//     is refused while a server holds the data (exit 7). This is the only way a rolled-back home moves forward.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import core from "../../../package.json" with { type: "json" };
import { USAGE_LOG, readUsage } from "./front.ts";
import { databases, readDatabase, schemaOf } from "./home.ts";
import { bundleRoot, hasVersion, installedPrefix } from "./install.ts";
import { defaultChannel, Exit, RELEASE_FILE, readRelease, stepForward, withReleaseLock, writeRelease, type Recheck, type Release } from "./release.ts";

export type UpgradeAsk =
  | { kind: "usage"; message: string }
  | { kind: "help" }
  | { kind: "check"; json: boolean }
  | { kind: "rollback" }
  /** The hub's own upgrade (a module, or its sweep), with the arguments to hand it. */
  | { kind: "hub"; service: string; argv: string[] }
  /** This program's own upgrade: the step on an older home, else the newer release from the home's channel. */
  | { kind: "core"; channel?: string; json: boolean };

/** The channels core is published on (RELEASING.md): npm dist-tags. */
export const CHANNELS = ["latest", "next", "beta"];

export function upgradeUsage(): string {
  return [
    "usage: parachute upgrade [--channel latest|next|beta] [--json]",
    "       parachute upgrade --check [--json]",
    "       parachute upgrade --rollback [--restore] [--yes] [--json]",
    "       parachute upgrade <service> [--channel rc|latest] [--tag <name>] [--allow-downgrade]",
  ].join("\n");
}

export function upgradeHelp(): string {
  return [
    `parachute upgrade (${core.name} ${core.version})`,
    "",
    "  parachute upgrade [--channel latest|next|beta] [--json]",
    "      Install the newer release from this home's channel (the old copy is kept). The server is not",
    "      restarted: its next start runs the new release, and backs every database up first.",
    "      On a home another release served last, or one that was rolled back: take the step with this release",
    "      (stop Parachute first).",
    "  parachute upgrade --check [--json]",
    "      Run the step to this release on a throwaway copy of the home and say what it did: the backup, each",
    "      database opened by this release, anything it would refuse. The home itself is not changed: no backup,",
    "      no release record. Safe while an older release is serving the home.",
    "  parachute upgrade --rollback [--restore] [--yes] [--json]",
    "      Back to the release before this one: the home is marked, and the install's links point at the",
    "      previous copy again. --restore puts the backup's databases back (notes changed since are exported",
    "      first).",
    "  parachute upgrade <service> [--channel rc|latest] [--tag <name>] [--allow-downgrade]",
    "      Upgrade a module the hub installed. The hub and the vault are part of this program.",
    "",
    "The first command of a newer release on a home backs every database up before it opens one.",
  ].join("\n");
}

/**
 * What `parachute upgrade <args>` asks for. Pure: it reads nothing and changes nothing, so dispatch calls it before
 * any check or step on the home.
 *
 * The hub's own upgrade is handed `argv`, rebuilt here from what was understood, never the words as typed: whatever
 * this lets through, the hub's parser accepts, so nothing is refused as a usage error after the step. Whether the
 * hub will find the service named (`service`) is the hub's own to say, and dispatch asks it, also before the step
 * (hub commands/upgrade.ts upgradeTargetProblem: the lookup the command itself makes, without its writes).
 */
export function parseUpgrade(args: string[]): UpgradeAsk {
  const usage = (message: string): UpgradeAsk => ({ kind: "usage", message });
  if (args.some((a) => a === "--help" || a === "-h")) return { kind: "help" };
  const has = (flag: string) => args.includes(flag);
  if (has("--check")) {
    const other = args.find((a) => a !== "--check" && a !== "--json");
    if (other !== undefined) return usage(other.startsWith("-") ? `--check doesn't go with ${other}` : `--check takes no service name ("${other}"): it checks the whole home`);
    return { kind: "check", json: has("--json") };
  }
  if (has("--rollback")) {
    const other = args.find((a) => !["--rollback", "--restore", "--yes", "-y", "--json"].includes(a));
    if (other !== undefined) return usage(`unknown argument '${other}' with --rollback`);
    return { kind: "rollback" };
  }
  // A service named: the hub's own upgrade of that module, with the flags it has, each with the value it needs.
  // None named: this program's upgrade, from the home's channel.
  const services: string[] = [];
  let channel: string | undefined;
  let tag: string | undefined;
  let allowDowngrade = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.startsWith("--channel=") || a.startsWith("--tag=") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (name === "--allow-downgrade") allowDowngrade = true;
    else if (name === "--json") json = true;
    else if (name === "--channel" || name === "--tag") {
      const value = eq > 0 ? a.slice(eq + 1) : args[++i];
      if (!value || value.startsWith("-")) return usage(`${name} needs a value`);
      if (name === "--channel") channel = value;
      else tag = value;
    } else if (a.startsWith("-") || a === "") return usage(a === "" ? "an empty argument" : `unknown flag ${a}`);
    else services.push(a);
  }
  if (services.length > 1) return usage(`one service at a time ("${services[0]}", "${services[1]}")`);
  const svc = services[0];
  if (svc !== undefined) {
    if (json) return usage("--json doesn't go with a service");
    if (channel !== undefined && channel !== "rc" && channel !== "latest") return usage(`a module's --channel is "rc" or "latest" (got "${channel}")`);
    return { kind: "hub", service: svc, argv: [svc, ...(channel ? ["--channel", channel] : []), ...(tag ? ["--tag", tag] : []), ...(allowDowngrade ? ["--allow-downgrade"] : [])] };
  }
  if (tag !== undefined) return usage("--tag goes with a service (a module's upgrade); this program follows its channel");
  if (allowDowngrade) return usage("--allow-downgrade goes with a service (a module's upgrade); this program never moves to an older release");
  if (channel !== undefined && !CHANNELS.includes(channel)) return usage(`--channel must be one of ${CHANNELS.join(", ")} (got "${channel}")`);
  return { kind: "core", ...(channel ? { channel } : {}), json };
}

// ── --check ──────────────────────────────────────────────────────────────────────────────────────────────────

export const EXIT = { ok: 0, problems: 1, usage: 2, noRoom: 5 } as const;
/** Written into a copy made by --check, and only there, holding that check's own word (COPY_WORD_ENV). */
const COPY_MARK = ".parachute-upgrade-check-copy";
/** The copy the run on the copy was started for, and the word its mark holds. */
const COPY_ENV = "PARACHUTE_UPGRADE_CHECK_COPY";
const COPY_WORD_ENV = "PARACHUTE_UPGRADE_CHECK_WORD";
const SCRATCH_PREFIX = ".parachute-upgrade-check-";
/** Folders the step never reads: a vault's attachments and its git mirror, logs, and package trees. */
const LEFT_OUT = new Set(["assets", "mirror", "logs", "node_modules", ".git"]);
/** Where a folder's children are vaults by name, whatever the name (a vault may be called `logs`). */
const VAULT_FOLDERS = new Set([join("vault", "data"), "vaults", join("vault", "vaults")]);
/** Larger files are not settings: left out of the copy (and counted). */
const SMALL = 1024 * 1024;

const size = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

/**
 * Whether this process is the run on a copy that `--check` started, and `home` is that copy: the environment names
 * it, it sits where a check puts its copy (`<scratch>/home`), and its mark holds the word that check made up. A home
 * that fails any of these is never taken for a copy, so the step on a copy can't be reached on a real home.
 */
export function isCheckCopy(home: string): boolean {
  const word = process.env[COPY_WORD_ENV];
  if (!word || process.env[COPY_ENV] !== home || basename(home) !== "home" || !basename(dirname(home)).startsWith(SCRATCH_PREFIX)) return false;
  try {
    return readFileSync(join(home, COPY_MARK), "utf8").trim() === word;
  } catch {
    return false;
  }
}

interface VaultReport {
  name: string;
  opens: boolean;
  notes?: number;
  types?: number;
  tags?: number;
  error?: string;
}

interface CopyReport {
  release: { version: string; previous: string | null; backup: string | null; state: string } | null;
  hub: { opens: boolean; keys?: number; error?: string };
  vaults: VaultReport[];
  refusals: string[];
}

const oneLine = (err: unknown) => String((err as Error)?.message ?? err).split("\n")[0]!.slice(0, 300);

/**
 * The run on the copy, after dispatch has taken the step on it (the newer-data check, the backup, the record): open
 * every database with this release, as its commands and its server would, and print what was found as one JSON line.
 * Refuses any home that is not a copy `--check` made.
 */
export async function openCopy(home: string): Promise<number> {
  if (!isCheckCopy(home)) {
    console.error("parachute upgrade --check: this is not a copy made by --check; nothing was opened");
    return EXIT.usage;
  }
  const report: CopyReport = { release: null, hub: { opens: false }, vaults: [], refusals: [] };
  const r = readRelease(home);
  if (r) report.release = { version: r.version, previous: r.previous, backup: r.backup, state: r.state };
  // What `serve` checks before it opens anything: parachute.yaml. (Whether the old 0.7 programs still own the home
  // is judged on the home itself, by the check that started this run: nothing names this copy.)
  const { applyParachuteYaml, SettingsError } = await import("./settings.ts");
  try {
    applyParachuteYaml(home, { server: true });
  } catch (err) {
    if (!(err instanceof SettingsError)) throw err;
    report.refusals.push(`serve would stop on parachute.yaml: ${oneLine(err)}`);
  }
  if (existsSync(join(home, "hub.db"))) {
    try {
      const { hubDbPath, openHubDb } = await import("@openparachute/hub/src/hub-db.ts");
      const { listKeys } = await import("@openparachute/hub/src/keys.ts");
      const db = openHubDb(hubDbPath(home));
      try {
        report.hub = { opens: true, keys: listKeys(db).length };
      } finally {
        db.close();
      }
    } catch (err) {
      report.hub = { opens: false, error: oneLine(err) };
    }
  } else report.hub = { opens: true }; // no hub.db yet: nothing to open
  const { listVaults } = await import("@openparachute/vault/src/config.ts");
  const { getVaultStore, closeAllStores } = await import("@openparachute/vault/src/vault-store.ts");
  for (const name of listVaults()) {
    // A database the copy couldn't take (unreadable in the home) is already reported; opening would make a new one.
    if (!existsSync(join(home, "vault", "data", name, "vault.db"))) continue;
    try {
      const db = getVaultStore(name).db;
      const notes = (db.query("SELECT count(*) AS n FROM notes").get() as { n: number }).n;
      const kinds = db.query("SELECT kind, count(*) AS n FROM tags GROUP BY kind").all() as { kind: string | null; n: number }[];
      const types = kinds.filter((k) => k.kind === "type").reduce((n, k) => n + k.n, 0);
      report.vaults.push({ name, opens: true, notes, types, tags: kinds.reduce((n, k) => n + k.n, 0) - types });
    } catch (err) {
      report.vaults.push({ name, opens: false, error: oneLine(err) });
    }
  }
  closeAllStores(true);
  console.log(JSON.stringify(report));
  return EXIT.ok;
}

/** This program, as a command: the bundle's own bin/parachute-core, or (from a checkout) Bun on its entry. */
function self(): string[] {
  const root = bundleRoot();
  return root ? [join(root, "bin", "parachute-core")] : [process.execPath, join(import.meta.dir, "parachute-core.ts")];
}

/** Scratch folders an earlier check left when it was killed: each names its process, and that process is gone. */
function clearStale(parent: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(parent).filter((n) => n.startsWith(SCRATCH_PREFIX));
  } catch {}
  for (const n of names) {
    const dir = join(parent, n);
    try {
      if (!lstatSync(dir).isDirectory() || !existsSync(join(dir, "home", COPY_MARK))) continue;
      const pid = Number(readFileSync(join(dir, "pid"), "utf8").trim());
      // Only a folder that names a process, and whose process is gone, is removed. Anything else is left.
      if (!Number.isInteger(pid) || pid <= 1) continue;
      try {
        process.kill(pid, 0);
        continue; // that check is still running
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") continue;
      }
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Not ours to judge: left where it is.
    }
  }
}

/**
 * Copy the home's small files (settings) into `to`; never a database, a lock, a socket or a link. The release record
 * is not copied as it is (copyRecord): it names the home's real backup folder.
 */
function copySmallFiles(home: string, to: string, dbFiles: Set<string>): number {
  let left = 0;
  const walk = (rel: string) => {
    for (const name of readdirSync(join(home, rel)).sort()) {
      const r = rel ? join(rel, name) : name;
      const st = lstatSync(join(home, r));
      if (st.isDirectory()) {
        if ((LEFT_OUT.has(name) && !VAULT_FOLDERS.has(rel)) || name.startsWith(SCRATCH_PREFIX)) continue;
        mkdirSync(join(to, r), { recursive: true, mode: 0o700 });
        walk(r);
      } else if (st.isFile()) {
        // Never another check's mark (a home restored from a killed check's leftovers): this copy has its own.
        if (dbFiles.has(r) || r === COPY_MARK) continue;
        // run/ holds this machine's running state (locks, pids, sockets); only the usage log travels as it is.
        if (rel === "run" && r !== USAGE_LOG) continue;
        if (st.size > SMALL) {
          left++;
          continue;
        }
        copyFileSync(join(home, r), join(to, r));
        chmodSync(join(to, r), 0o600);
      }
    }
  };
  walk("");
  return left;
}

/**
 * The copy's release record: the home's own, without the paths that lead back out of the copy. The record names
 * the real backup folder (and, after a restore, where the live databases were moved), and the step writes there:
 * it copies a database the backup had skipped into that backup once it can be read. On the copy that must not
 * happen, so the copy's record names no backup and no skipped database, and the report says what waits instead.
 */
function copyRecord(was: Release | undefined, copy: string): void {
  if (!was) return;
  const { skipped: _skipped, moved_aside: _aside, moved_aside_retries: _retries, ...rest } = was;
  mkdirSync(join(copy, "run"), { recursive: true, mode: 0o700 });
  writeFileSync(join(copy, RELEASE_FILE), `${JSON.stringify({ ...rest, backup: null }, null, 2)}\n`, { mode: 0o600 });
}

/** A consistent copy of one database, tried again when a writer's checkpoint tore the read (home.ts readDatabase). */
function copyDatabase(from: string, to: string, outside: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(to, { force: true });
      readDatabase(from, (db) => db.run("VACUUM INTO ?", [to]), outside);
      return;
    } catch (err) {
      if (attempt >= 3 || !/malformed|locked|busy|disk I\/O/i.test(String((err as Error)?.message))) throw err;
      Bun.sleepSync(300 * attempt);
    }
  }
}

/** `parachute upgrade --check [--json]` on `home`: the exit code. */
export async function check(asked: string, opts: { json: boolean }): Promise<number> {
  const home = resolve(asked);
  const say = (s: string) => (opts.json ? console.error(s) : console.log(s));
  const out: Record<string, unknown> = { check: "problems", home, from: null, to: core.version, refusals: [], problems: [] };
  const problems: string[] = [];
  const finish = (code: number, verdict: "ok" | "problems" | "refused" | "no-room", refusals: string[] = []) => {
    Object.assign(out, { check: verdict, refusals, problems });
    for (const p of refusals) say(`  would refuse: ${p}`);
    for (const p of problems) say(`  problem: ${p}`);
    say(code === EXIT.ok ? `The step to ${core.version} ran clean on the copy. Nothing here was changed: no backup, no release record.` : "Nothing here was changed: no backup, no release record.");
    if (opts.json) console.log(JSON.stringify(out));
    return code;
  };
  if (!existsSync(home)) {
    problems.push(`there is no Parachute home at ${home} (set PARACHUTE_HOME to check another)`);
    return finish(EXIT.problems, "problems");
  }
  const was = readRelease(home);
  // A home the old 0.7 programs still own is the takeover's: this release takes no step on it and its serve refuses
  // it. Judged here, on the home itself: the copy has another path, so nothing on this machine would name it.
  if (!was) {
    const { serveRefusal } = await import("./takeover.ts");
    const refused = serveRefusal(home);
    if (refused) return finish(EXIT.problems, "refused", [`${oneLine(refused)} \`parachute takeover --dry-run\` says what it would do.`]);
  }
  if (was?.state === "restoring") return finish(EXIT.problems, "refused", [`a restore on this home was interrupted; \`parachute upgrade --rollback --restore --yes\` finishes it`]);
  const parent = dirname(home);
  const dbs = databases(home, { hub: 0, vault: 0 });
  const dbFiles = new Set(dbs.flatMap((d) => [d.rel, `${d.rel}-wal`, `${d.rel}-shm`, `${d.rel}-journal`]));
  const bytes = dbs.reduce((n, d) => n + statSync(join(home, d.rel)).size + (existsSync(join(home, `${d.rel}-wal`)) ? statSync(join(home, `${d.rel}-wal`)).size : 0), 0);
  // The copy, then the step's own backup of the copy: twice the databases, in the place the real backup will use.
  let place = parent;
  try {
    clearStale(parent);
    rmSync(mkdtempSync(join(parent, SCRATCH_PREFIX)), { recursive: true });
  } catch {
    place = tmpdir(); // the home's parent can't be written: the system's temp folder
    clearStale(place);
    // The real step puts its backup beside the home, and would stop there.
    problems.push(`${parent} can't be written: the step's backup goes to ${join(parent, "parachute-upgrade")}, so the first command of ${core.version} on this home would fail before it backs up`);
  }
  const free = statfsSync(place);
  if (free.bavail * free.bsize < bytes * 2.2 + 100e6) {
    problems.push(`the check copies the databases twice (the copy, then the step's own backup of it): ${size(bytes * 2)} needed, ${place} has ${size(free.bavail * free.bsize)} free`);
    return finish(EXIT.noRoom, "no-room");
  }
  const scratch = mkdtempSync(join(place, SCRATCH_PREFIX));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const gone = () => rmSync(scratch, { recursive: true, force: true });
  // A signal ends the run on the copy and removes the copy before this process goes.
  const onSignal = () => {
    child?.kill("SIGKILL");
    gone();
    process.exit(130);
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const sig of signals) process.once(sig, onSignal);
  try {
    chmodSync(scratch, 0o700);
    writeFileSync(join(scratch, "pid"), `${process.pid}\n`, { mode: 0o600 });
    const copy = join(scratch, "home");
    const word = randomBytes(16).toString("hex");
    mkdirSync(copy, { mode: 0o700 });
    writeFileSync(join(copy, COPY_MARK), `${word}\n`, { mode: 0o600 });
    say(`parachute upgrade --check: the step to ${core.version} on a copy of ${home}. Nothing here is changed.`);
    // 1. The copy.
    const t0 = Date.now();
    const left = copySmallFiles(home, copy, dbFiles);
    copyRecord(was, copy);
    const before: Record<string, number | null> = {};
    let copied = 0;
    for (const d of dbs) {
      const to = join(copy, d.rel);
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      try {
        copyDatabase(join(home, d.rel), to, parent);
        chmodSync(to, 0o600);
        before[d.rel] = schemaOf(to, scratch) ?? null;
        copied++;
      } catch (err) {
        rmSync(to, { force: true });
        problems.push(`can't read ${d.rel} (${oneLine(err)}): the step would leave it out of its backup, and the command that needs it would fail`);
      }
      await Bun.sleep(0); // let a signal in between databases
    }
    say(`  copied ${copied} of ${dbs.length} database${dbs.length === 1 ? "" : "s"} (${size(bytes)}) in ${seconds(Date.now() - t0)}${left ? `; ${left} larger file${left === 1 ? "" : "s"} left out (not settings)` : ""}`);
    Object.assign(out, { databases: dbs.length, bytes, copy_ms: Date.now() - t0 });
    // 2. This program on the copy, as the home's first command would run. Its environment names the copy only.
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: scratch, PARACHUTE_HOME: copy, [COPY_ENV]: copy, [COPY_WORD_ENV]: word, PARACHUTE_OFFLINE: "1", EMBEDDINGS_ENABLED: "false", PARACHUTE_DEPRECATIONS: "0" };
    for (const k of ["LANG", "LC_ALL", "TZ", "TMPDIR"]) if (process.env[k]) env[k] = process.env[k]!;
    const t1 = Date.now();
    child = Bun.spawn([...self(), "upgrade", "--check", "--json"], { env, cwd: scratch, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, errText, exitCode] = await Promise.all([new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text(), child.exited]);
    child = undefined;
    const stepMs = Date.now() - t1;
    const stderr = errText.split(scratch).join("<copy>");
    let report: CopyReport | undefined;
    try {
      report = JSON.parse(stdout.trim().split("\n").pop() ?? "") as CopyReport;
    } catch {}
    if (exitCode !== 0 || !report) {
      const why = stderr.trim().split("\n").filter(Boolean).slice(-6).join(" / ");
      return finish(exitCode === 6 ? 6 : EXIT.problems, "refused", [`the step stopped on the copy with exit ${exitCode}: ${why || "no message"}`]);
    }
    // 3. The report.
    const rel = report.release;
    const current = !!was && was.version === core.version && was.state === "current";
    const from = current ? was.previous : (rel?.previous ?? was?.version ?? null);
    Object.assign(out, { from, step_ms: stepMs });
    if (current) {
      out.backup = { databases: 0, skipped: was.skipped ?? [] };
      say(`  this home is on ${core.version} already: no step to take, no new backup`);
      if (was.skipped?.length) say(`  still waiting to be backed up (unreadable when the step was taken): ${was.skipped.join(", ")}. The next command that can read it backs it up first.`);
    } else if (rel?.backup) {
      const manifest = JSON.parse(readFileSync(join(rel.backup, "manifest.json"), "utf8")) as { files: Record<string, string>; skipped?: string[] };
      const n = Object.keys(manifest.files).length;
      out.backup = { databases: n, skipped: manifest.skipped ?? [] };
      say(`  ${from ?? "an older release"} → ${core.version}: the step backs up ${n} database${n === 1 ? "" : "s"} first, then records the release (${seconds(stepMs)} on the copy, opening included)`);
    } else {
      out.backup = { databases: 0, skipped: [] };
      say(`  no backup would be taken: ${rel ? "this release made the home, or its own takeover just moved it" : existsSync(join(home, "embedded.json")) ? "a host application manages this home and keeps its own backups" : "nothing here can be recorded yet"}`);
    }
    out.hub = report.hub;
    if (!report.hub.opens) problems.push(`hub.db does not open with ${core.version}: ${report.hub.error}`);
    else if (report.hub.keys === undefined) say("  hub.db: none here yet");
    else say(`  hub.db: opens; ${report.hub.keys} key${report.hub.keys === 1 ? "" : "s"} (a token an older release minted becomes a key)`);
    out.vaults = report.vaults;
    // Every vault database that was copied must have been opened: one the run on the copy didn't find (its folder
    // is a link, or has no vault.yaml) was not tried, and saying nothing would pass it as clean.
    const opened = new Set(report.vaults.map((v) => v.name));
    for (const d of dbs) {
      if (d.rel === "hub.db" || !(d.rel in before) || opened.has(basename(dirname(d.rel)))) continue;
      problems.push(`${d.rel} was copied but not opened on the copy (its folder is a link, an older layout, or has no vault.yaml): not checked`);
    }
    for (const v of report.vaults) {
      if (v.opens) say(`  vault ${v.name}: opens; ${v.notes} note${v.notes === 1 ? "" : "s"}, ${v.types} type${v.types === 1 ? "" : "s"}, ${v.tags} tag${v.tags === 1 ? "" : "s"}`);
      else problems.push(`vault ${v.name} does not open with ${core.version}: ${v.error}`);
    }
    // A schema number that moved means the older release can't open that database again: the way back is --restore.
    const moved: string[] = [];
    for (const d of dbs) {
      if (!(d.rel in before)) continue;
      let after: number | null = null;
      try {
        after = schemaOf(join(copy, d.rel), scratch) ?? null;
      } catch {}
      if ((after ?? 0) > (before[d.rel] ?? 0)) moved.push(`${d.rel} (${before[d.rel] ?? "none"} → ${after})`);
    }
    out.schema_moved = moved;
    if (!current) say(moved.length ? `  schema numbers move: ${moved.join(", ")}. The older release can't open these afterwards: the way back is \`upgrade --rollback --restore\`` : "  no schema number moves: the older release still opens every database, so the way back keeps every write (`upgrade --rollback`)");
    const old = Object.entries(readUsage(home).names).map(([name, row]) => ({ name, count: row.count, last_seen: row.last_seen }));
    out.old_names = old;
    if (old.length) say(`  old names this home's usage log has seen (\`parachute changes\` says what each is now): ${old.map((o) => `${o.name} ×${o.count}`).join(", ")}`);
    const ok = problems.length === 0 && report.refusals.length === 0;
    return finish(ok ? EXIT.ok : EXIT.problems, ok ? "ok" : "problems", report.refusals);
  } finally {
    for (const sig of signals) process.off(sig, onSignal);
    gone();
  }
}

// ── upgrade (no service): the step, or the newer release from the home's channel ─────────────────────────────

const REGISTRY = "https://registry.npmjs.org";
const RELEASES = "https://github.com/ParachuteComputer/parachute-core/releases/download";
const FETCH_PREFIX = ".fetch-";

/** Where versions are looked up and bundles downloaded: npm's own setting and ours, else the public ones. */
function sources(env: NodeJS.ProcessEnv = process.env): { registry: string; releases: string } {
  const trim = (u: string) => u.replace(/\/+$/, "");
  return {
    registry: trim(env.npm_config_registry || env.NPM_CONFIG_REGISTRY || REGISTRY),
    releases: trim(env.PARACHUTE_RELEASES_URL || RELEASES),
  };
}

/** The versions the registry's dist-tags name for this package: {latest: "0.8.0", beta: "0.9.0-pre.1", …}. */
async function distTags(registry: string): Promise<Record<string, string>> {
  const url = `${registry}/${core.name.replace("/", "%2f")}`;
  const res = await fetch(url, { headers: { accept: "application/vnd.npm.install-v1+json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  const tags = ((await res.json()) as { "dist-tags"?: Record<string, string> })["dist-tags"];
  if (!tags || typeof tags !== "object") throw new Error(`${url} names no dist-tags`);
  return tags;
}

/**
 * The version to move to on `channel`, or null when this one is the newest: the channel's own, and on a prerelease
 * channel also `latest`'s, whichever is higher. (A box on `beta` must reach the stable release when it ships;
 * `latest` is never moved to a prerelease.) Never an older version, and never one that isn't a version.
 */
export function pickVersion(tags: Record<string, string>, channel: string, installed: string): { version: string; tag: string } | null {
  let best: { version: string; tag: string } | null = null;
  for (const tag of channel === "latest" ? ["latest"] : [channel, "latest"]) {
    const v = tags[tag];
    if (typeof v !== "string" || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v)) continue;
    if (Bun.semver.order(v, installed) <= 0) continue;
    if (!best || Bun.semver.order(v, best.version) > 0) best = { version: v, tag };
  }
  return best;
}

async function download(url: string, to: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  await Bun.write(to, res);
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

/**
 * Download `version`'s bundle for this platform, check it against the release's SHA256SUMS, unpack it beside the
 * store and run its own `install --prefix <base>`. Nothing in `base` changes until that install switches the links;
 * a failed download or a wrong sum leaves it as it was.
 */
async function installBundle(base: string, version: string, releases: string, say: (s: string) => void): Promise<void> {
  const store = join(base, ".store");
  for (const n of readdirSync(store)) if (n.startsWith(FETCH_PREFIX)) rmSync(join(store, n), { recursive: true, force: true }); // an interrupted fetch
  const name = `parachute-core-${version}-${process.platform}-${process.arch}`;
  const dir = mkdtempSync(join(store, FETCH_PREFIX));
  try {
    const from = `${releases}/v${version}`;
    say(`  downloading ${name}.tar.gz from ${from}`);
    const sums = await fetch(`${from}/SHA256SUMS`, { signal: AbortSignal.timeout(60_000) });
    if (!sums.ok) throw new Error(`${from}/SHA256SUMS answered HTTP ${sums.status}: release ${version} has no bundle for download yet`);
    const want = (await sums.text()).split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[1]?.replace(/^\*/, "") === `${name}.tar.gz`)?.[0];
    if (!want || !/^[0-9a-f]{64}$/.test(want)) throw new Error(`the release's SHA256SUMS has no line for ${name}.tar.gz (no bundle for this platform)`);
    const tgz = join(dir, `${name}.tar.gz`);
    await download(`${from}/${name}.tar.gz`, tgz);
    const got = await sha256File(tgz);
    if (got !== want) throw new Error(`the download's sha256 is ${got.slice(0, 16)}…, and SHA256SUMS says ${want.slice(0, 16)}…: not installed`);
    say(`  sha256 matches SHA256SUMS (${want.slice(0, 16)}…)`);
    const tar = Bun.spawnSync(["tar", "xzf", tgz, "-C", dir], { stdout: "ignore", stderr: "pipe" });
    if (tar.exitCode !== 0) throw new Error(`unpacking failed: ${tar.stderr.toString().trim().split("\n").pop()}`);
    const root = join(dir, name);
    let inside = "";
    try {
      inside = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    } catch {}
    if (inside !== version || !existsSync(join(root, "bin", "parachute"))) throw new Error(`the bundle isn't ${core.name} ${version} (it says ${inside || "nothing"}): not installed`);
    // The new release installs itself: its own copy into the store, its own switch of the links, the old copy kept.
    const run = Bun.spawnSync([join(root, "bin", "parachute"), "install", "--prefix", base], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    for (const line of `${run.stdout}${run.stderr}`.trim().split("\n").filter(Boolean)) say(`  ${line}`);
    if (run.exitCode !== 0) throw new Error(`${version}'s own install exited ${run.exitCode}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** How this copy of the program was installed, which decides how a newer one is. */
function installKind(): { how: "bundle"; base: string } | { how: "package"; manager: string[] } | { how: "none"; why: string } {
  const base = installedPrefix();
  if (base) return { how: "bundle", base };
  if (bundleRoot()) return { how: "none", why: "this is an unpacked bundle that was never installed: run its `parachute install` first, then `parachute upgrade` from there" };
  const root = join(import.meta.dir, "..", "..", "..");
  if (root.includes(`/node_modules/${core.name}`)) return { how: "package", manager: root.includes("/.bun/") ? ["bun", "add", "-g"] : ["npm", "install", "-g"] };
  return { how: "none", why: "this is a source checkout: `git pull`, then run it" };
}

/** `parachute upgrade [--channel <tag>] [--json]` on `home`: the exit code. `recheck`: the newer-data check. */
export async function upgradeCore(home: string, ask: { channel?: string; json: boolean }, recheck: Recheck): Promise<number> {
  const say = (s: string) => (ask.json ? console.error(s) : console.log(s));
  const out: Record<string, unknown> = { upgraded: false, from: core.version, to: core.version };
  const done = (code: number) => {
    if (ask.json) console.log(JSON.stringify(out));
    return code;
  };
  try {
    const was = readRelease(home);
    const hasData = existsSync(home) && !existsSync(join(home, "embedded.json")) && databases(home, { hub: 0, vault: 0 }).length > 0;
    if (hasData && !(was && was.version === core.version && was.state === "current")) {
      // Another release served this home last (or it was rolled back): the step, with this release.
      const from = was ? (was.state === "rolled-back" ? was.previous : was.version) : "an older release";
      say(`parachute upgrade: ${from} → ${core.version} on ${home}`);
      const { release, links } = stepForward(home, say, recheck);
      if (!release || release.version !== core.version) throw new Exit(EXIT.problems, "this home can't be moved by this command (nothing readable in it, or the old 0.7 programs still own it: `parachute takeover`)");
      if (ask.channel && release.channel !== ask.channel) withReleaseLock(home, () => writeRelease(home, { ...readRelease(home)!, channel: ask.channel }));
      Object.assign(out, { upgraded: true, step: true, from: release.previous, to: core.version, backup: release.backup, channel: ask.channel ?? release.channel, links });
      say(`This home is on ${core.version}${release.backup ? `; its databases as ${release.previous} left them are in ${release.backup}` : ""}.`);
      say(links.moved ? `${links.bin} runs ${core.version}: start it (its unit, or \`parachute serve\`).` : `Start ${core.version} on it now (\`parachute serve\`, or its unit once that runs ${core.version}).`);
      return done(EXIT.ok);
    }
    // This release serves the home already: is there a newer one on its channel?
    const channel = ask.channel ?? was?.channel ?? defaultChannel();
    out.channel = channel;
    if (ask.channel && was && was.channel !== ask.channel) {
      withReleaseLock(home, () => {
        const r = readRelease(home);
        if (r) writeRelease(home, { ...r, channel: ask.channel });
      });
      say(`This home follows ${ask.channel} now${was.channel ? ` (it followed ${was.channel})` : ""}.`);
    }
    if (process.env.PARACHUTE_OFFLINE === "1") throw new Exit(EXIT.problems, "PARACHUTE_OFFLINE=1: not asking the registry. Nothing was changed.");
    const { registry, releases } = sources();
    let tags: Record<string, string>;
    try {
      tags = await distTags(registry);
    } catch (err) {
      throw new Exit(EXIT.problems, `couldn't ask ${registry} which version ${channel} is (${oneLine(err)}). Nothing was changed.`);
    }
    const pick = pickVersion(tags, channel, core.version);
    if (!pick) {
      say(`parachute upgrade: ${core.version} is the newest on ${channel}${tags[channel] ? ` (${channel} is ${tags[channel]})` : ` (the registry has no ${channel} yet)`}. Nothing to do.`);
      return done(EXIT.ok);
    }
    say(`parachute upgrade: ${core.version} → ${pick.version} (${pick.tag === channel ? channel : `${pick.tag}, newer than ${channel}`})`);
    const kind = installKind();
    if (kind.how === "none") throw new Exit(EXIT.problems, `${pick.version} is out, but ${kind.why}. Nothing was changed.`);
    if (kind.how === "bundle") {
      try {
        await installBundle(kind.base, pick.version, releases, say);
      } catch (err) {
        throw new Exit(EXIT.problems, `${oneLine(err)}. Nothing was changed: ${join(kind.base, "bin", "parachute")} still runs ${core.version}.`);
      }
      if (!hasVersion(kind.base, pick.version)) throw new Exit(EXIT.problems, `${pick.version} did not land in ${kind.base}`);
      out.prefix = kind.base;
    } else {
      const cmd = [...kind.manager, `${core.name}@${pick.version}`];
      say(`  ${cmd.join(" ")}`);
      const run = Bun.spawnSync(cmd, { stdin: "ignore", stdout: ask.json ? "ignore" : "inherit", stderr: "inherit" });
      if (run.exitCode !== 0) throw new Exit(EXIT.problems, `${cmd.join(" ")} exited ${run.exitCode}; ${core.version} is still what runs`);
    }
    Object.assign(out, { upgraded: true, to: pick.version, how: kind.how });
    say(`Parachute ${pick.version} is installed${kind.how === "bundle" ? `; ${core.version} is kept beside it` : ""}. What is running now is still ${core.version}: restart Parachute (\`parachute restart\`, or its unit) to run ${pick.version}.`);
    say(`Its first start backs every database up before it opens one. \`parachute upgrade --check\` with ${pick.version} tries that on a copy first.`);
    return done(EXIT.ok);
  } catch (caught) {
    const err = caught instanceof Exit ? caught : new Exit(EXIT.problems, oneLine(caught));
    if (err.message) console.error(`parachute upgrade: ${err.message}`);
    Object.assign(out, { upgraded: false, error: err.message, exit: err.code });
    return done(err.code);
  }
}
