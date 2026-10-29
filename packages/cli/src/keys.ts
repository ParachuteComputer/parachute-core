// `parachute keys` (DESIGN-0.9 §1, §2): every way in is a key with a name, an owner and scopes.
//
//   keys list [--all] [--json]           every live key (the hub's `keys` table, PR #17), --all adds revoked/expired
//   keys list --pending                  apps waiting for approval (auth pending-clients)
//   keys new <name> --vault <v> [--can read|write] [--expires-in <s> | --ephemeral] [--json]
//                                        auth mint-token, labelled with the name, so its key is called <name>
//   keys revoke <name|jti> [--json]      auth revoke-token on the key's token
//   keys approve <client>                auth approve-client
//
// New, list and revoke reuse the hub's own mint, revoke and key code: a key minted here verifies exactly as a token
// from `auth mint-token` does. Type scopes and denies (`--types`, `--deny`) are refused until 0.9.1 enforces them, so
// no key is ever broader than what was asked for.
import { hubDbPath, openHubDb } from "@openparachute/hub/src/hub-db.ts";
import { listKeys, type KeyView } from "@openparachute/hub/src/keys.ts";

export type KeysResult = { exit: number } | { argv: string[] };

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const PASS_NEW = new Set(["--expires-in", "--ephemeral", "--json", "--user", "--service"]);

function usage(): string {
  return [
    "parachute keys list [--all] [--json] | list --pending",
    "parachute keys new <name> --vault <vault> [--can read|write] [--expires-in <seconds> | --ephemeral] [--json]",
    "parachute keys revoke <name|jti> [--json]",
    "parachute keys approve <client>",
  ].join("\n");
}

function withHubDb<T>(fn: (db: ReturnType<typeof openHubDb>) => T): T {
  const db = openHubDb(hubDbPath());
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function value(args: string[], i: number, flag: string): string {
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${flag} takes a value`);
  return v;
}

function keysNew(args: string[]): KeysResult {
  const [name, ...rest] = args;
  if (!name || name.startsWith("-")) {
    console.error("parachute keys new: name the key, e.g. `parachute keys new uni-tasks --vault uni --can write`");
    return { exit: 2 };
  }
  if (!NAME.test(name)) {
    console.error(`parachute keys new: '${name}' is not a key name (letters, digits, '.', '_' and '-', up to 80)`);
    return { exit: 2 };
  }
  let vault: string | undefined;
  let can = "read";
  const pass: string[] = [];
  try {
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === "--vault") vault = value(rest, i++, a);
      else if (a === "--can") can = value(rest, i++, a);
      else if (a === "--types" || a === "--deny") {
        console.error(`parachute keys new: ${a} arrives in 0.9.1, when keys are enforced by type; this build would make a key broader than asked, so it makes none`);
        return { exit: 2 };
      } else if (PASS_NEW.has(a)) {
        pass.push(a);
        if (a !== "--ephemeral" && a !== "--json") pass.push(value(rest, i++, a));
      } else {
        console.error(`parachute keys new: unknown argument '${a}'\nusage: ${usage().split("\n")[1]}`);
        return { exit: 2 };
      }
    }
  } catch (err) {
    console.error(`parachute keys new: ${(err as Error).message}`);
    return { exit: 2 };
  }
  if (!vault) {
    console.error("parachute keys new: --vault <name> is required (which vault the key opens)");
    return { exit: 2 };
  }
  if (can === "admin") {
    console.error("parachute keys new: --can admin is not mintable from the command line (the hub refuses vault admin mints); use read or write");
    return { exit: 2 };
  }
  if (can !== "read" && can !== "write") {
    console.error("parachute keys new: --can is read or write");
    return { exit: 2 };
  }
  const taken = withHubDb((db) => db.prepare("SELECT 1 FROM keys WHERE name = ?").get(name));
  if (taken) {
    console.error(`parachute keys new: a key called '${name}' already exists (parachute keys list --all); pick another name`);
    return { exit: 1 };
  }
  return { argv: ["auth", "mint-token", "--scope", `vault:${vault}:${can}`, "--label", name, ...pass] };
}

function keysRevoke(args: string[]): KeysResult {
  const target = args.find((a) => !a.startsWith("-"));
  const flags = args.filter((a) => a.startsWith("-"));
  if (!target) {
    console.error("parachute keys revoke: name the key (parachute keys list) or give its jti");
    return { exit: 2 };
  }
  const row = withHubDb((db) => db.prepare("SELECT jti FROM keys WHERE name = ?").get(target) as { jti: string } | null);
  return { argv: ["auth", "revoke-token", row?.jti ?? target, ...flags] };
}

function show(keys: KeyView[], users: Map<string, string>): string[] {
  if (!keys.length) return ["No keys. Make one: parachute keys new <name> --vault <vault> --can read|write"];
  const rows = keys.map((k) => [
    k.name,
    `${k.owner_kind}${k.owner ? ` ${users.get(k.owner) ?? k.owner}` : ""}`,
    Object.entries(k.levels).map(([v, l]) => `${v}:${l}`).join(" ") || k.scopes.join(" "),
    k.allow_tags ? `only #${k.allow_tags.join(" #")}` : "",
    k.status === "active" ? (k.expires_at ? `until ${k.expires_at.slice(0, 10)}` : "") : k.status,
  ]);
  const head = ["NAME", "OWNER", "CAN", "LIMITS", "STATUS"];
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  return [head, ...rows].map((r) => r.map((c, i) => c.padEnd(width[i]!)).join("  ").trimEnd());
}

/** Run `parachute keys <args>`: answered here, or the hub command it maps onto. */
export function keysCommand(args: string[]): KeysResult {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "list" || sub === "ls") {
    if (rest.includes("--pending")) return { argv: ["auth", "pending-clients", ...rest.filter((a) => a !== "--pending")] };
    const unknown = rest.find((a) => a !== "--all" && a !== "--json");
    if (unknown) {
      console.error(`parachute keys list: unknown argument '${unknown}'\nusage: ${usage().split("\n")[0]}`);
      return { exit: 2 };
    }
    const { keys, users } = withHubDb((db) => ({
      keys: listKeys(db),
      users: new Map((db.prepare("SELECT id, username FROM users").all() as { id: string; username: string }[]).map((u) => [u.id, u.username])),
    }));
    const shown = rest.includes("--all") ? keys : keys.filter((k) => k.status === "active");
    if (rest.includes("--json")) console.log(JSON.stringify(shown.map((k) => ({ ...k, owner_name: k.owner ? (users.get(k.owner) ?? null) : null }))));
    else for (const line of show(shown, users)) console.log(line);
    return { exit: 0 };
  }
  if (sub === "new") return keysNew(rest);
  if (sub === "revoke" || sub === "rm") return keysRevoke(rest);
  if (sub === "approve") return { argv: ["auth", "approve-client", ...rest] };
  if (sub === "--help" || sub === "-h" || sub === "help") {
    console.log(usage());
    return { exit: 0 };
  }
  console.error(`parachute keys: unknown command '${sub}'\n${usage()}`);
  return { exit: 2 };
}
