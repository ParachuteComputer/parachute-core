// `parachute` is the command of Parachute v0.8 (Aaron, 10-27: "`parachute` is the go-to name for this new parachute
// system"); `parachute-core` stays as an alias for now. Under `parachute`, every command the hub had in 0.7 runs as it
// did (Prism's PARACHUTE_BIN and Benjamin's suite call it so), and what only v0.8 has is added where 0.7 had nothing:
//
//   parachute install [--prefix <dir>]   installs this program (install.ts); 0.7's hub printed its usage and exited 1
//                                        (`install --help` is still the hub's)
//   parachute install <module> …         still the hub's module installer, as in 0.7
//   parachute takeover …                 moves a home the old 0.7 programs keep onto v0.8 (lane E)
//   parachute, parachute help            this program's own lines first, then the hub's help
//
// Everything else (`vault <command>` included, which goes through the hub's own `vault` command) is the hub's.
import core from "../../../package.json" with { type: "json" };
import type { Role } from "./dispatch.ts";

/** The flags of `install` that take a value, the hub's (--tag, --channel) and core's (--prefix). */
const VALUE_FLAGS = new Set(["--prefix", "--tag", "--channel"]);

/** Whether `install`'s arguments name a module (`install vault`, `install --tag rc vault`): the hub's installer. */
export function namesModule(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (VALUE_FLAGS.has(a)) i++;
    else if (!a.startsWith("-")) return true;
  }
  return false;
}

export function isHelp(argv: string[]): boolean {
  return argv.length === 0 || ["help", "--help", "-h"].includes(argv[0]!);
}

/** Which role `parachute <argv>` runs as: core's for what only v0.8 has, the hub's for everything 0.7 had. */
export function primaryRole(argv: string[]): Role {
  const [cmd, ...rest] = argv;
  // `install --help` stays the hub's module-installer help, as in 0.7; this program's install is in `parachute help`.
  if (cmd === "install" && !namesModule(rest) && !["--help", "-h"].includes(rest[0] ?? "")) return "core";
  if (cmd === "takeover") return "core";
  return "hub";
}

/** The lines `parachute` prints before the hub's own help. */
export function primaryHelp(): string {
  return [
    `parachute ${core.version}: Parachute's vault and hub as one program (${core.name}).`,
    "",
    "  parachute version [--json]          this program's name, version, data schema and Bun",
    "  parachute install [--prefix <dir>]  install this program for you (default ~/.local/share/parachute-core)",
    "  parachute bootstrap --embedded …    set up a host-managed home in one step (see `bootstrap --help`)",
    "  parachute vault <command>           the vault's commands",
    "  parachute <command>                 the hub's commands, as in 0.7: serve, auth, …",
    "",
    "  parachute-core <command>            the same program under its other name. Where an older Parachute's",
    "                                      `parachute` comes first on your PATH, `parachute-core` is this one.",
    "",
    "The hub's commands, for reference:",
    "",
  ].join("\n");
}
