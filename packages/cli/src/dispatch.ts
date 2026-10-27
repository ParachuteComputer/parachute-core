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
// Lane A1 moves the code in and keeps the vault a child process: `serve` is still the hub's, and the hub starts its
// vault as `parachute-vault serve`. bin/ puts itself first on PATH (bin/parachute-core), so that child is this
// install's own vault, never an older `parachute-vault` found on PATH (PLAN §2.1).
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION } from "@openparachute/vault/core/src/schema.ts";
import core from "../../../package.json" with { type: "json" };

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
    "  parachute-core <command>          the hub's commands (what `parachute <command>` was): serve, auth, …",
    "",
    "The hub's commands, for reference:",
    "",
  ].join("\n");
}

/** What a name and its arguments run: a built-in answer, or one of the moved CLIs with the arguments it gets. */
export function route(role: Role, argv: string[]): { print: string } | { cli: "hub" | "vault"; argv: string[] } {
  const cli = role === "vault" || (role === "core" && argv[0] === "vault") ? "vault" : "hub";
  const args = role === "core" && argv[0] === "vault" ? argv.slice(1) : argv;
  const [cmd, ...rest] = args;
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    return { print: rest.includes("--json") ? JSON.stringify(versionJson()) : core.version };
  }
  return { cli, argv: args };
}

/** Run as `role` with this process's arguments. The moved CLIs run in this process, as if started directly. */
export async function dispatch(role: Role): Promise<void> {
  const argv = process.argv.slice(2);
  const r = route(role, argv);
  if ("print" in r) {
    console.log(r.print);
    return;
  }
  if (role === "core" && r.cli === "hub" && (argv.length === 0 || ["help", "--help", "-h"].includes(argv[0]!))) {
    console.log(coreHelp());
  }
  const entry = r.cli === "hub" ? HUB_CLI : VAULT_CLI;
  // Both CLIs read process.argv.slice(2) when they load, and may start themselves again from process.argv[1].
  process.argv = [process.argv[0]!, entry, ...r.argv];
  await import(entry);
}
