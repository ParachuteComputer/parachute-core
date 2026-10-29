// The 0.9 front door (DESIGN-0.9 §1, §6): one command, about a dozen verbs you can guess.
//
//   parachute setup | serve | start | stop | restart | status | logs | doctor | vault | keys | user | backup
//             | upgrade | changes | version
//
// Each new verb runs code that is already here (the hub's and the vault's commands); this file only maps names.
// Every old name keeps working through 0.9: it runs as it did and prints one line on stderr saying what replaced it,
// never on stdout, so `--json` parsers don't break. The line is printed only where the replacement works in this
// build (`state: "live"` in changes-0.9.json), and each use is counted in `run/deprecations.json` (the usage log that
// makes removal at 1.0 safe).
//
// Prism's embedded contract v1 is frozen (DESIGN §7): on a host-managed home (its `embedded.json`, or a home a
// `serve --embedded` holds) the old names print nothing and count nothing, and `serve --embedded` / `bootstrap
// --embedded` never do. `parachute-vault` (Prism's PARACHUTE_VAULT_BIN) is not routed here at all.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import core from "../../../package.json" with { type: "json" };
import changesMap from "./changes-0.9.json" with { type: "json" };
import { embeddedHolder } from "./managed.ts";
import { namesModule } from "./primary.ts";

export interface Change {
  kind: "command" | "mcp-tool" | "endpoint" | "setting" | "credential";
  old: string;
  new: string | null;
  action: "keep" | "merge" | "move" | "rename" | "drop";
  reason: string;
  since: string;
  removed_in: string | null;
  state: "live" | "planned";
}

export interface ChangeMap {
  schema: 1;
  from: string;
  to: string;
  version: string;
  status: string;
  rule: string;
  upgrade_policy: string;
  waypoint: string;
  changes: Change[];
}

export const CHANGES = changesMap as unknown as ChangeMap;

/** An old name was used: what to say, and which change-map entry explains it. */
export interface Notice {
  /** What the person typed, e.g. `auth mint-token`. */
  used: string;
  /** What replaces it, e.g. `keys new <name>`; null when it goes with nothing in its place. */
  now: string | null;
  /** The change map's `old`, e.g. `parachute auth mint-token`. */
  entry: string;
}

/** What `parachute <argv>` runs: the argv the existing commands take, and a notice when an old name was used. */
export interface Door {
  argv: string[];
  notice?: Notice;
}

type Rewrite = (rest: string[]) => string[];

/**
 * New verbs, mapped onto today's commands (longest prefix first). `keys` and `changes` are answered by core itself
 * (keys.ts, changes below), so they pass through unchanged.
 */
const VERBS: [string[], Rewrite][] = [
  [["user", "list"], (r) => ["auth", "list-users", ...r]],
  [["user", "password"], (r) => ["auth", "set-password", ...r]],
  [["user", "2fa"], (r) => ["auth", "2fa", ...r]],
  [["user", "pubkey", "add"], (r) => ["auth", "link-pubkey", ...r]],
  [["setup", "expose"], (r) => ["expose", ...r]],
  // `setup mcp [claude]`: the vault's MCP installer, which wires Claude Code (its one client today).
  [["setup", "mcp"], (r) => ["vault", "mcp-install", ...(["claude", "claude-code"].includes(r[0] ?? "") ? r.slice(1) : r)]],
  [["setup", "transcription"], (r) => ["vault", "transcription", "install", ...r]],
  [["vault", "new"], (r) => ["vault", "create", ...r]],
  [["vault", "pack", "rm"], (r) => ["vault", "packs", "remove", ...r]],
  [["vault", "pack"], (r) => ["vault", "packs", ...r]],
  [["vault", "channel", "attach"], (r) => ["vault", "attach-channel", ...r]],
  [["vault", "channel", "detach"], (r) => ["vault", "detach-channel", ...r]],
  [["vault", "channel", "list"], (r) => ["vault", "list-channels", ...r]],
  [["vault", "channel", "sync"], (r) => ["vault", "sync-channels", ...r]],
  [["backup", "now"], (r) => ["vault", "backup", ...r]],
  [["backup", "list"], (r) => ["vault", "backup", "status", ...r]],
  [["backup", "status"], (r) => ["vault", "backup", "status", ...r]],
  [["backup", "schedule"], (r) => ["vault", "backup", "--schedule", ...r]],
  [["backup"], (r) => ["vault", "backup", ...r]],
  // `tokens` is what agents type looking for their keys (DESIGN §1, real use): an alias of `keys`, with no notice.
  [["tokens"], (r) => ["keys", ...r]],
];

/** Old names, each tied to its change-map entry. Only entries whose replacement is live in this build print. */
const OLD: { match: string[]; now: string | null; entry: string; when?: (rest: string[]) => boolean }[] = [
  { match: ["auth", "mint-token"], now: "keys new <name>", entry: "parachute auth mint-token" },
  { match: ["auth", "revoke-token"], now: "keys revoke <name>", entry: "parachute auth revoke-token <jti>" },
  { match: ["auth", "pending-clients"], now: "keys list --pending", entry: "parachute auth pending-clients" },
  { match: ["auth", "approve-client"], now: "keys approve <client>", entry: "parachute auth approve-client <id>" },
  { match: ["auth", "list-users"], now: "user list", entry: "parachute auth list-users" },
  { match: ["auth", "set-password"], now: "user password", entry: "parachute auth set-password" },
  { match: ["auth", "link-pubkey"], now: "user pubkey add", entry: "parachute auth link-pubkey" },
  { match: ["auth", "2fa"], now: "user 2fa", entry: "parachute auth 2fa" },
  { match: ["expose"], now: "setup expose", entry: "parachute expose tailnet|public|cloudflare [off]" },
  { match: ["migrate"], now: null, entry: "parachute migrate [--list|--to-supervised|--teardown]" },
  // `install <module>`: there are no modules any more. Core's own `install` (no module named) is not an old name.
  { match: ["install"], now: "setup, or upgrade", entry: "parachute install <service>", when: namesModule },
  { match: ["vault", "create"], now: "vault new", entry: "parachute-vault create <name> [--mint]" },
  { match: ["vault", "packs"], now: "vault pack", entry: "parachute-vault packs add|list|remove, add-pack" },
  { match: ["vault", "add-pack"], now: "vault pack add", entry: "parachute-vault packs add|list|remove, add-pack" },
  { match: ["vault", "remove"], now: "vault rm", entry: "parachute vault rename|remove (hub cascade)" },
  { match: ["vault", "attach-channel"], now: "vault channel attach", entry: "parachute vault attach-|detach-|list-|sync-channels" },
  { match: ["vault", "detach-channel"], now: "vault channel detach", entry: "parachute vault attach-|detach-|list-|sync-channels" },
  { match: ["vault", "list-channels"], now: "vault channel list", entry: "parachute vault attach-|detach-|list-|sync-channels" },
  { match: ["vault", "sync-channels"], now: "vault channel sync", entry: "parachute vault attach-|detach-|list-|sync-channels" },
  { match: ["vault", "mcp-install"], now: "setup mcp", entry: "parachute-vault mcp-install" },
  { match: ["vault", "transcription", "install"], now: "setup transcription", entry: "parachute-vault transcription install" },
  { match: ["vault", "tokens"], now: "keys", entry: "parachute-vault tokens list|revoke" },
  { match: ["vault", "backup"], now: "backup", entry: "parachute-vault backup [status] [--schedule]" },
];

const startsWith = (argv: string[], prefix: string[]) => prefix.every((p, i) => argv[i] === p);
const isHelpArg = (a: string | undefined) => a === "--help" || a === "-h" || a === "help";

export function entryFor(old: string): Change | undefined {
  return CHANGES.changes.find((c) => c.old === old);
}

/** Map `parachute <argv>` onto the commands that exist. Pure: no files are read. */
export function frontDoor(argv: string[]): Door {
  for (const [prefix, rewrite] of VERBS) {
    if (startsWith(argv, prefix)) return { argv: rewrite(argv.slice(prefix.length)) };
  }
  // `setup --embedded …` is `bootstrap --embedded …` (Prism's contract v2 name; v1 keeps `bootstrap`).
  if (argv[0] === "setup" && argv.includes("--embedded")) return { argv: ["bootstrap", ...argv.slice(1)] };
  for (const o of OLD) {
    if (!startsWith(argv, o.match)) continue;
    const rest = argv.slice(o.match.length);
    if (isHelpArg(rest[0])) break; // asking about the old name is not using it
    if (o.when && !o.when(rest)) break;
    const live = entryFor(o.entry)?.state === "live";
    return live ? { argv, notice: { used: o.match.join(" "), now: o.now, entry: o.entry } } : { argv };
  }
  return { argv };
}

/** Whether `home` belongs to a host application (Prism): it was set up embedded, or an embedded serve holds it. */
export function hostManaged(home: string): boolean {
  return existsSync(join(home, "embedded.json")) || embeddedHolder(home) !== undefined;
}

export function noticeLine(n: Notice, removedIn = entryFor(n.entry)?.removed_in ?? "1.0"): string {
  const what = n.now ? `is now '${n.now}'` : "is going away";
  return `parachute: '${n.used}' ${what} (since 0.9, gone in ${removedIn}): parachute changes ${n.used}`;
}

export const USAGE_LOG = join("run", "deprecations.json");

interface UsageLog {
  schema: 1;
  names: Record<string, { count: number; first_seen: string; last_seen: string }>;
}

export function readUsage(home: string): UsageLog {
  try {
    const log = JSON.parse(readFileSync(join(home, USAGE_LOG), "utf8")) as UsageLog;
    if (log && typeof log.names === "object") return log;
  } catch {}
  return { schema: 1, names: {} };
}

/**
 * Say an old name was used, and count it in the home's usage log. Called after the newer-data check passed, so a
 * home that must stay byte-identical is never written. Never on a host-managed home; never creates a home.
 */
export function announce(n: Notice, home: string, now = new Date()): void {
  if (process.env.PARACHUTE_DEPRECATIONS === "0") return;
  if (existsSync(home) && hostManaged(home)) return;
  console.error(noticeLine(n));
  if (!existsSync(home)) return;
  try {
    mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
    const log = readUsage(home);
    const at = now.toISOString();
    const row = log.names[n.used] ?? { count: 0, first_seen: at, last_seen: at };
    log.names[n.used] = { ...row, count: row.count + 1, last_seen: at };
    const path = join(home, USAGE_LOG);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(log, null, 1)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // The log is advice for 1.0's removals; a read-only or full home must not stop the command.
  }
}

/** `parachute help`: the front door, in four groups. `help --all` adds every command today's names still answer. */
export function frontHelp(): string {
  return [
    `parachute ${core.version}: one program for your vault, its keys and the people who use it.`,
    "",
    "Daily",
    "  status                        is it up, where, which vaults",
    "  logs [-f]                     the server's log",
    "  vault list|new|rename|rm|import|export|history|schema|pack|channel",
    "  keys list|new|revoke|approve  who can reach your vaults (tokens is the same command)",
    "",
    "Running it",
    "  setup [expose|mcp|transcription|--embedded]   make something work, once",
    "  serve                         run in the foreground (units, containers, Prism)",
    "  start|stop|restart            the background service",
    "  upgrade                       this program",
    "",
    "Safety",
    "  backup [now|list|schedule]    the vaults' backups",
    "  doctor [--fix]                check, and repair what is safe to repair",
    "",
    "About",
    "  user list|password|2fa|pubkey add   the people who sign in",
    "  changes [--json] [<old name>]       what 0.9 renamed, and what replaced it",
    "  version [--json]",
    "",
    "Old names (auth mint-token, vault create, expose, …) still work and say what replaced them.",
    "Every command: parachute help --all",
  ].join("\n");
}

// ---- parachute changes ----------------------------------------------------------------------------------------

const KINDS = ["command", "mcp-tool", "endpoint", "setting", "credential"] as const;
const HEADINGS: Record<Change["kind"], string> = {
  command: "Commands",
  "mcp-tool": "MCP tools",
  endpoint: "HTTP",
  setting: "Settings",
  credential: "Credentials",
};

function flagValue(args: string[], name: string): string | undefined | null {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  const a = args[i]!;
  return a.includes("=") ? a.slice(name.length + 1) : (args[i + 1] ?? null);
}

/** The change-map entries an old name (`auth mint-token`, `vault create`, `find-path`) refers to. */
export function lookup(words: string[]): Change[] {
  const q = words.join(" ").replace(/^parachute(-vault|-core)?\s+/, "").trim();
  if (!q) return [];
  const old = OLD.find((o) => o.match.join(" ") === q);
  if (old) return [entryFor(old.entry)!];
  return CHANGES.changes.filter((c) => {
    const name = c.old.replace(/^parachute(-vault|-core)?\s+/, "");
    return name === q || name.startsWith(`${q} `) || name.split(/[|,]\s*/).includes(q);
  });
}

/** `parachute changes [--json] [--since 0.8] [--kind k] [--all] [--for-agent] [<old name>]`. Returns the exit code. */
export function changes(args: string[], home: string, out = console.log, err = console.error): number {
  const json = args.includes("--json");
  const forAgent = args.includes("--for-agent");
  const all = args.includes("--all");
  const since = flagValue(args, "--since");
  const kind = flagValue(args, "--kind");
  if (since === null || kind === null) {
    err("parachute changes: --since and --kind take a value");
    return 2;
  }
  if (since !== undefined && since !== CHANGES.from) {
    err(`parachute changes: this map covers ${CHANGES.from} → ${CHANGES.to}; there is no map from ${since} (a 0.7 home moves with \`parachute takeover\`)`);
    return 2;
  }
  if (kind !== undefined && !(KINDS as readonly string[]).includes(kind)) {
    err(`parachute changes: --kind is one of ${KINDS.join(", ")}`);
    return 2;
  }
  const valued = new Set(["--since", "--kind"]);
  const words = args.filter((a, i) => !a.startsWith("-") && !valued.has(args[i - 1] ?? ""));
  let list = CHANGES.changes.filter((c) => !kind || c.kind === kind);
  if (words.length) {
    list = lookup(words).filter((c) => !kind || c.kind === kind);
    if (!list.length) {
      err(`parachute changes: nothing in the map is called '${words.join(" ")}'; parachute changes --all lists every entry`);
      return 1;
    }
  }
  if (json) {
    const { changes: _all, ...head } = CHANGES;
    out(JSON.stringify({ ...head, changes: list }));
    return 0;
  }
  if (forAgent) {
    out(`Parachute ${CHANGES.from} → ${CHANGES.to}. Old names keep working until ${CHANGES.waypoint}; switch now where a replacement is live.`);
    for (const c of list) {
      if (c.action === "keep" || c.state !== "live" || c.new === c.old) continue;
      out(c.new ? `- Replace \`${c.old}\` with \`${c.new}\` (${c.reason}).` : `- Stop using \`${c.old}\`; nothing replaces it (${c.reason}).`);
    }
    return 0;
  }
  // Plain words: what changed and works now; `--all` adds what stays the same and what is still to come.
  const used = existsSync(home) ? readUsage(home).names : {};
  if (!words.length) out(`Parachute ${CHANGES.from} → ${CHANGES.to} (${core.version}). Old names keep working until ${CHANGES.waypoint}.`);
  for (const k of KINDS) {
    const rows = list.filter((c) => c.kind === k && (all || words.length > 0 || (c.action !== "keep" && c.state === "live" && c.new !== c.old)));
    if (!rows.length) continue;
    out("");
    out(HEADINGS[k]);
    for (const c of rows) {
      const to = c.action === "keep" ? "unchanged" : c.new ? `→ ${c.new}` : "→ (goes away)";
      const later = c.state === "planned" ? "  [planned, not in this build]" : "";
      out(`  ${c.old}  ${to}${later}`);
      if (words.length) out(`    ${c.reason}${c.removed_in ? `; the old name goes in ${c.removed_in}` : ""}`);
    }
  }
  const usedNames = Object.entries(used);
  if (!words.length && usedNames.length) {
    out("");
    out("Old names used on this home (run/deprecations.json):");
    for (const [name, u] of usedNames.sort((a, b) => b[1].count - a[1].count)) out(`  ${name}: ${u.count}, last ${u.last_seen}`);
  }
  if (!words.length && !all) {
    out("");
    out("parachute changes --all adds what stays and what is planned; --json for scripts; --for-agent for agents.");
  }
  return 0;
}
