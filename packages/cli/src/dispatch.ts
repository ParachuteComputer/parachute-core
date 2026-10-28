// The one command of Parachute v0.8 (PLAN §2.5), under three names:
//
//   parachute-core <command>   the hub's commands (serve, auth, …), `vault <command>` for the vault's, and `version`
//   parachute <command>        the hub's commands, as @openparachute/hub 0.7 had them
//   parachute-vault <command>  the vault's commands, as @openparachute/vault 0.7 had them
//
// `parachute` and `parachute-vault` are aliases inside the unpacked folder only, for Prism's PARACHUTE_BIN /
// PARACHUTE_VAULT_BIN and Benjamin's suite. Our installer never links them onto a shared PATH.
//
// Every name answers `version` / `--version` with core's version, and `version --json` with
// {name: "@openparachute/core", version, schema, bun}: it is one program with one version.
//
// `serve` (under `parachute-core` and `parachute`) runs the vault inside this process (lane A2, ./serve.ts). Until the
// Nov 3 decision the child path stays (`PARACHUTE_PROCESS_MODEL=child`): `serve` is the hub's, and the hub starts its
// vault as `parachute-vault serve`. bin/ puts itself first on PATH (bin/parachute-core), so that child is this
// install's own vault, never an older `parachute-vault` found on PATH (PLAN §2.1).
//
// Before any command runs, under every name (lane B, PLAN §3, fixes 3 and 4):
//   - the umask is 077, so every folder this program (or a child it starts) creates is 0700 and every file 0600,
//     the databases' -wal and -shm included;
//   - a home with a database newer than this program is refused with exit 6, before anything opens it, so the home
//     is byte-identical afterwards. Only `version` still answers (help is a command: the moved CLIs touch the home
//     before they read their arguments);
//   - `serve --embedded` puts back loosened modes, and `serve --embedded` or `serve --offline` runs offline:
//     PARACHUTE_OFFLINE=1 for this process and every child (no registry lookup, Buzz poller, model download,
//     outbound webhook or mirror push).
//
// `parachute-core install` installs this bundle (install.ts, lane D). It is no longer the hub's module installer,
// which runs `bun add -g` into the old global install; `parachute install` (the hub's name) still is.
//
// Lane C: `serve --embedded` is core's own (embedded.ts), after those checks on the home it names (--home, else
// PARACHUTE_HOME). Lane E: so is `bootstrap --embedded` (bootstrap.ts), the host's one-step setup, behind the same
// checks on the home it names. `parachute-core takeover` (takeover.ts) moves a home the old programs keep onto v0.8,
// and a box `serve` on such a home refuses with exit 7 until it has. While it holds a home, the commands that install, upgrade, expose, migrate or drive modules
// are refused with managed_by_host, exit 2 (managed.ts, PLAN §3).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION } from "@openparachute/vault/core/src/schema.ts";
import core from "../../../package.json" with { type: "json" };
import { homeDir, newerData, repairModes } from "./home.ts";
import { managedRefusal } from "./managed.ts";

export type Role = "core" | "hub" | "vault";

const HUB_CLI = fileURLToPath(import.meta.resolve("@openparachute/hub/src/cli.ts"));
const VAULT_CLI = fileURLToPath(import.meta.resolve("@openparachute/vault/src/cli.ts"));

export function versionJson(): { name: string; version: string; schema: number; bun: string } {
  // schema: the vault's data schema (vault core/src/schema.ts), what a newer-data check compares (PLAN §3, E7).
  return { name: core.name, version: core.version, schema: SCHEMA_VERSION, bun: Bun.version };
}

function coreHelp(): string {
  return [
    `parachute-core ${core.version}: Parachute's vault and hub as one program.`,
    "",
    "  parachute-core version [--json]   this program's name, version, data schema and Bun",
    "  parachute-core vault <command>    the vault's commands (what `parachute-vault <command>` was)",
    "  parachute-core install [--prefix <dir>]   install this bundle for you (default ~/.local/share/parachute-core)",
    "  parachute-core bootstrap --embedded …     set up a host-managed home in one step (see `bootstrap --help`)",
    "  parachute-core takeover [--dry-run]       move a home the old hub and vault (0.7) keep onto v0.8",
    "  parachute-core <command>          the hub's commands (what `parachute <command>` was): serve, auth, …",
    "",
    "The hub's commands, for reference:",
    "",
  ].join("\n");
}

/** What a name and its arguments run: a built-in answer, or one of the moved CLIs with the arguments it gets. */
export function route(
  role: Role,
  argv: string[],
): { print: string } | { install: string[] } | { embedded: string[] } | { bootstrap: string[] } | { takeover: string[] } | { cli: "hub" | "vault"; argv: string[] } {
  if (role === "core" && argv[0] === "install") return { install: argv.slice(1) };
  if (role === "core" && argv[0] === "takeover") return { takeover: argv.slice(1) };
  const cli = role === "vault" || (role === "core" && argv[0] === "vault") ? "vault" : "hub";
  const args = role === "core" && argv[0] === "vault" ? argv.slice(1) : argv;
  const [cmd, ...rest] = args;
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    return { print: rest.includes("--json") ? JSON.stringify(versionJson()) : core.version };
  }
  if (cli === "hub" && cmd === "serve" && rest.includes("--embedded")) return { embedded: rest };
  if (cli === "hub" && cmd === "bootstrap") return { bootstrap: rest };
  return { cli, argv: args };
}

/** Exit codes (PLAN §3): 6, data newer than this binary; 5, a home that can't be used (here: can't be checked). */
export const EXIT_NEWER_DATA = 6;
export const EXIT_HOME_UNUSABLE = 5;
/** Exit 7 (PLAN §8.0): the old programs still own the home; run `parachute-core takeover`. */
export const EXIT_OLD_PROGRAMS = 7;


/**
 * The vault child of `serve --embedded` (child path) stops when that serve is gone, even after a SIGKILL that
 * gave it no chance to stop its vault: a SIGTERM to itself runs the vault's own shutdown. Without this, the
 * orphan keeps the vault port and its databases open (PLAN §2.2, §3 "parent death").
 */
function stopWithEmbeddedParent(): void {
  const raw = process.env.PARACHUTE_EMBEDDED_PARENT;
  if (raw === undefined) return;
  const parent = Number(raw);
  // Started for an embedded serve that is already gone: there is nothing to serve for.
  if (!Number.isInteger(parent) || parent <= 1 || process.ppid !== parent) {
    console.error(`parachute-vault serve: the serve --embedded that started it (pid ${raw}) is gone; not starting`);
    process.exit(75);
  }
  const timer = setInterval(() => {
    if (process.ppid === parent) return;
    clearInterval(timer); // once: the vault's own shutdown takes it from here
    process.kill(process.pid, "SIGTERM");
  }, 500);
  timer.unref();
}

/**
 * `--home <dir>` or `--home=<dir>` among `serve --embedded`'s arguments, if given, and whether it is given more
 * than once (serve refuses that with exit 2, and nothing may check or repair a home before it does).
 */
function homeFlag(args: string[]): { home?: string; twice: boolean } {
  const found: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--home") found.push(args[i + 1] ?? "");
    else if (args[i]!.startsWith("--home=")) found.push(args[i]!.slice("--home=".length));
  }
  return { home: found[0], twice: found.length > 1 };
}

/** Run as `role` with this process's arguments. The moved CLIs run in this process, as if started directly. */
export async function dispatch(role: Role): Promise<void> {
  process.umask(0o077);
  const argv = process.argv.slice(2);
  const r = route(role, argv);
  if ("print" in r) {
    console.log(r.print);
    return;
  }
  if ("install" in r) {
    const { install } = await import("./install.ts");
    process.exit(install(r.install));
  }
  // `serve --embedded` and `bootstrap` name their home with --home or PARACHUTE_HOME; with neither they exit 2
  // before touching anything (embedded.ts, bootstrap.ts), so there is no home to check.
  const embeddedArgs = "embedded" in r ? r.embedded : undefined;
  const bootstrapArgs = "bootstrap" in r ? r.bootstrap : undefined;
  const hostArgs = embeddedArgs ?? bootstrapArgs;
  const takeoverArgs = "takeover" in r ? r.takeover : undefined;
  if (hostArgs || takeoverArgs) {
    const flag = homeFlag(hostArgs ?? takeoverArgs!);
    if (flag.twice) {
      console.error(`parachute ${embeddedArgs ? "serve --embedded" : bootstrapArgs ? "bootstrap" : "takeover"}: --home given twice`);
      process.exit(2);
    }
    if (flag.home) process.env.PARACHUTE_HOME = resolve(flag.home);
  }
  const home = homeDir();
  // Every command but `version` (answered above) runs behind the check, help included: the moved CLIs do work on
  // the home before they read their arguments (the vault moves older layouts first), so `serve --help` is a command.
  if (!hostArgs || process.env.PARACHUTE_HOME) {
    const { HUB_SCHEMA_VERSION } = await import("@openparachute/hub/src/hub-db.ts");
    const { newer, unchecked } = newerData(home, { hub: HUB_SCHEMA_VERSION, vault: SCHEMA_VERSION });
    const name = role === "core" ? "parachute-core" : role === "hub" ? "parachute" : "parachute-vault";
    if (newer.length > 0) {
      console.error(`${name}: this home was written by a newer Parachute (${core.name} ${core.version} here):`);
      for (const line of newer) console.error(`  ${line}`);
      console.error("Nothing was opened or changed. Run the newer version, or restore a backup made for this one.");
      process.exit(EXIT_NEWER_DATA);
    }
    if (unchecked.length > 0) {
      console.error(`${name}: can't check this home's data without changing it:`);
      for (const line of unchecked) console.error(`  ${line}`);
      console.error("Nothing was opened or changed. Stop what holds it open, or make room in the temp folder, and retry.");
      process.exit(EXIT_HOME_UNUSABLE);
    }
  }
  if (embeddedArgs) {
    process.env.PARACHUTE_OFFLINE = "1";
    if (process.env.PARACHUTE_HOME) for (const line of repairModes(home)) console.error(`parachute: mode repaired: ${line}`);
    const { serveEmbedded } = await import("./embedded.ts");
    process.exit(await serveEmbedded(embeddedArgs));
  }
  if (bootstrapArgs) {
    // bootstrap --embedded opens the home like serve --embedded does, so it puts back loosened modes too (PLAN §3).
    if (process.env.PARACHUTE_HOME && bootstrapArgs.includes("--embedded")) {
      for (const line of repairModes(home)) console.error(`parachute: mode repaired: ${line}`);
    }
    const { bootstrap } = await import("./bootstrap.ts");
    process.exit(await bootstrap(bootstrapArgs));
  }
  if (takeoverArgs) {
    const { takeover } = await import("./takeover.ts");
    process.exit(await takeover(takeoverArgs));
  }
  if (!("cli" in r)) return;
  const refusal = managedRefusal(r.cli, r.argv);
  if (refusal) {
    console.error(refusal);
    process.exit(2);
  }
  if (r.cli === "vault" && r.argv[0] === "serve") stopWithEmbeddedParent();
  // Lane E (PLAN §8.0): a box serve on a home the old 0.7 programs still own refuses with exit 7 and points at
  // `parachute-core takeover`, before it opens anything.
  if (r.cli === "hub" && r.argv[0] === "serve" && !["--help", "-h"].includes(r.argv[1] ?? "")) {
    const { serveRefusal } = await import("./takeover.ts");
    const refused = serveRefusal(home);
    if (refused) {
      console.error(refused);
      process.exit(EXIT_OLD_PROGRAMS);
    }
  }
  if (r.cli === "hub" && r.argv[0] === "serve") {
    if (r.argv.includes("--offline")) process.env.PARACHUTE_OFFLINE = "1";
    // The hub's `serve` takes no --offline of its own: it reads PARACHUTE_OFFLINE.
    r.argv = r.argv.filter((a) => a !== "--offline");
  }
  if (role === "core" && r.cli === "hub" && (argv.length === 0 || ["help", "--help", "-h"].includes(argv[0]!))) {
    console.log(coreHelp());
  }
  if (r.cli === "hub" && r.argv[0] === "serve") {
    const { processModel, serveInProcess } = await import("./serve.ts");
    if (processModel() === "in-process") await serveInProcess(r.argv.slice(1));
  }
  const entry = r.cli === "hub" ? HUB_CLI : VAULT_CLI;
  // Both CLIs read process.argv.slice(2) when they load, and may start themselves again from process.argv[1].
  process.argv = [process.argv[0]!, entry, ...r.argv];
  await import(entry);
}
