// `parachute bootstrap --embedded` (v0.8 PLAN §3 "Bootstrap", §3.1 R3; Benjamin's E4): a host application (Prism)
// sets Parachute up in its home with one non-interactive command, in either order around `serve --embedded`.
//
//   parachute bootstrap --embedded [--home <dir>] [--username <u>] [--password-file <p> | --password-fd <n>]
//                                  [--vault <name>] [--json]
//
//   - home: --home, else PARACHUTE_HOME; neither exits 2 and creates nothing;
//   - the account: --username (default `owner`). The password is optional: Prism's installer passes none, and then
//     the account has no password anyone knows, so there is no web sign-in until `parachute auth set-password`;
//   - the vault: --vault (default `default`), made by this install's own `parachute-vault create --no-mirror`, so no
//     git mirror and no API key;
//   - the operator token: written to `$PARACHUTE_HOME/operator.token` (0600) and returned by path, never printed. Its
//     issuer is PARACHUTE_HUB_ORIGIN (exactly an origin, as for serve), else the issuer embedded.json records, else
//     http://127.0.0.1:<PORT or 1939>; an issuer the home hasn't used yet joins embedded.json's accepted_issuers, so
//     the token keeps verifying after serve picks its port;
//   - idempotent: a second run finds the account, the vault and a usable token, says `created: false`, and writes
//     nothing. An existing account keeps its password (change it with `auth set-password`).
//
// Exit codes: 0 done · 2 flags (or an account by another name already exists) · 5 home unusable · 1 anything else.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";

const VAULT_CLI = fileURLToPath(new URL("./parachute-vault.ts", import.meta.url));
const DEFAULT_USERNAME = "owner";
const DEFAULT_VAULT = "default";
const HUB_DEFAULT_PORT = 1939;

export const EXIT = { ok: 0, failed: 1, usage: 2, homeUnusable: 5 } as const;

class Exit extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export function bootstrapHelp(): string {
  return `parachute bootstrap --embedded: set up a host-managed home in one step (for host applications)

Usage:
  parachute bootstrap --embedded [--home <dir>] [--username <name>]
                      [--password-file <path> | --password-fd <n>] [--vault <name>] [--json]

Flags:
  --embedded              required: the home is managed by a host application
  --home <dir>            the home (default PARACHUTE_HOME; one of them is required)
  --username <name>       the account to create (default ${DEFAULT_USERNAME})
  --password-file <path>  read the account's password from a file
  --password-fd <n>       read the account's password from an open file descriptor
                          With neither, the account has no password: no web sign-in until
                          \`parachute auth set-password\` is run.
  --vault <name>          the vault to create (default ${DEFAULT_VAULT}), with no git mirror
  --json                  print {created, admin, vault, operator_token_file, …} on stdout

Runs before or while \`parachute serve --embedded\` runs. A second run changes nothing and says
created: false. The operator token goes to <home>/operator.token (mode 0600) and is never printed.

Exit codes: 0 done · 2 flags, or an account with another name exists · 5 home unusable · 1 other errors
`;
}

interface Flags {
  embedded: boolean;
  json: boolean;
  help: boolean;
  home?: string;
  username?: string;
  passwordFile?: string;
  passwordFd?: number;
  vault?: string;
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { embedded: false, json: false, help: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--embedded") flags.embedded = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--help" || arg === "-h" || arg === "help") flags.help = true;
    else {
      const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
      const flag = eq > 0 ? arg.slice(0, eq) : arg;
      if (!["--home", "--username", "--password-file", "--password-fd", "--vault"].includes(flag)) {
        throw new Exit(EXIT.usage, `unexpected argument "${arg}"`);
      }
      const value = eq > 0 ? arg.slice(eq + 1) : args[i + 1];
      if (value === undefined || value === "" || (eq < 0 && value.startsWith("--"))) throw new Exit(EXIT.usage, `${flag} needs a value`);
      if (seen.has(flag)) throw new Exit(EXIT.usage, `${flag} given twice`);
      seen.add(flag);
      if (eq < 0) i++;
      if (flag === "--home") flags.home = value;
      else if (flag === "--username") flags.username = value;
      else if (flag === "--password-file") flags.passwordFile = value;
      else if (flag === "--vault") flags.vault = value;
      else {
        if (!/^\d+$/.test(value)) throw new Exit(EXIT.usage, `--password-fd needs a file descriptor number, got "${value}"`);
        flags.passwordFd = Number(value);
      }
    }
  }
  if (flags.passwordFile !== undefined && flags.passwordFd !== undefined) {
    throw new Exit(EXIT.usage, "--password-file and --password-fd can't both be given");
  }
  return flags;
}

/** The password from --password-file or --password-fd: the bytes as given, less one trailing newline. */
function readPassword(flags: Flags): string | undefined {
  let raw: string;
  try {
    if (flags.passwordFile !== undefined) raw = readFileSync(resolve(flags.passwordFile), "utf8");
    else if (flags.passwordFd !== undefined) raw = readFileSync(flags.passwordFd, "utf8");
    else return undefined;
  } catch (err) {
    const from = flags.passwordFile !== undefined ? `--password-file ${flags.passwordFile}` : `--password-fd ${flags.passwordFd}`;
    throw new Exit(EXIT.usage, `can't read the password from ${from}: ${(err as Error).message}`);
  }
  const password = raw.replace(/\r?\n$/, "");
  if (password.length === 0) throw new Exit(EXIT.usage, "the password is empty");
  return password;
}

/** PARACHUTE_HUB_ORIGIN, if set, must be exactly an origin, as `serve --embedded` requires (PLAN §3 "Issuer"). */
function hostIssuer(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  let ok = false;
  try {
    const u = new URL(raw);
    ok = (u.protocol === "http:" || u.protocol === "https:") && u.origin === raw;
  } catch {}
  if (!ok) throw new Exit(EXIT.usage, `PARACHUTE_HUB_ORIGIN must be exactly an origin (scheme://host[:port], no path or trailing slash), got "${raw}"`);
  return raw;
}

function envPort(raw: string | undefined): number | undefined {
  if (!raw || !/^\d{1,5}$/.test(raw.trim())) return undefined;
  const n = Number(raw.trim());
  return n >= 1 && n <= 65535 ? n : undefined;
}

function writeAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * The issuer this home's tokens carry, and embedded.json brought up to date with it: an issuer the home hasn't
 * used joins accepted_issuers (the first one also becomes the issuer), so a token signed now still verifies when
 * `serve --embedded` decides its issuer on its next start. Nothing is written when the home already accepts it.
 */
function settleIssuer(home: string, readEmbedded: (dir: string) => { issuer: string; accepted_issuers: string[] } | undefined): string {
  const fromHost = hostIssuer(process.env.PARACHUTE_HUB_ORIGIN);
  const path = join(home, "embedded.json");
  let raw: Record<string, unknown> | undefined;
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Exit(EXIT.homeUnusable, `${path} can't be read (${(err as Error).message}); it records the issuers earlier tokens carry, so it is left as it is`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Exit(EXIT.homeUnusable, `${path} is not a JSON object; left as it is`);
  }
  const state = raw ? readEmbedded(home) : undefined;
  const issuer = fromHost ?? state?.issuer ?? `http://127.0.0.1:${envPort(process.env.PORT) ?? HUB_DEFAULT_PORT}`;
  if (state?.accepted_issuers.includes(issuer)) return issuer;
  const accepted = [...(state?.accepted_issuers ?? []), issuer];
  const next = { ...(raw ?? {}), issuer: state?.issuer ?? issuer, accepted_issuers: accepted, updated_at: new Date().toISOString() };
  writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  return issuer;
}

/** The vault exists when its vault.yaml does (vault src/config.ts vaultConfigPath). */
function vaultExists(home: string, name: string): boolean {
  return existsSync(join(home, "vault", "data", name, "vault.yaml"));
}

/** `parachute-vault create <name> --no-mirror --json`, this install's own, on the home. No key is minted. */
async function createVault(home: string, name: string): Promise<void> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.PARACHUTE_HOME = home;
  delete env.PORT; // the hub's port, if the host set one, is not the vault's
  const p = Bun.spawn([process.execPath, VAULT_CLI, "create", name, "--no-mirror", "--json"], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) {
    const why = (err || out).trim().split("\n").slice(-3).join(" / ");
    throw new Exit(/must|invalid|reserved|characters|length/i.test(why) ? EXIT.usage : EXIT.failed, `creating vault "${name}" failed: ${why}`);
  }
}

type HubModules = {
  db: typeof import("@openparachute/hub/src/hub-db.ts");
  users: typeof import("@openparachute/hub/src/users.ts");
  op: typeof import("@openparachute/hub/src/operator-token.ts");
  embedded: typeof import("@openparachute/hub/src/embedded-home.ts");
  jwt: typeof import("@openparachute/hub/src/jwt-sign.ts");
  vaultName: typeof import("@openparachute/vault/src/vault-name.ts");
};

/**
 * Is the operator token on disk one we can hand back: signed by this hub's keys, not revoked, this account's, an
 * operator token, from this issuer, and not near expiry? A damaged or revoked one is replaced (Codex round 2).
 */
async function usableOperatorToken(db: Database, home: string, userId: string, issuer: string, m: HubModules): Promise<boolean> {
  const path = join(home, m.op.OPERATOR_TOKEN_FILENAME);
  if (!existsSync(path)) return false;
  try {
    const token = readFileSync(path, "utf8").trim();
    const { payload: claims } = await m.jwt.validateAccessToken(db, token, issuer);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const left = Number(claims.exp) - Date.now() / 1000;
    return claims.sub === userId && aud.includes(m.op.OPERATOR_TOKEN_AUDIENCE) && left > m.op.OPERATOR_TOKEN_AUTO_ROTATE_THRESHOLD_SECONDS;
  } catch {
    return false;
  }
}

/** A filesystem or SQLite error opening the home: unusable (5), as for serve. */
function homeError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && (/^E(ACCES|PERM|ISDIR|NOTDIR|EXIST|ROFS|NOSPC|DQUOT|LOOP|NAMETOOLONG|IO)$/.test(code) || /^SQLITE_(CANTOPEN|READONLY|IOERR|FULL|NOTADB|CORRUPT)/.test(code));
}

/** Run `bootstrap <args>`; returns the exit code. */
export async function bootstrap(args: string[]): Promise<number> {
  const say = (line: string) => console.error(`parachute bootstrap: ${line}`);
  let flags: Flags;
  try {
    flags = parseFlags(args);
  } catch (err) {
    say((err as Error).message);
    return (err as Exit).code ?? EXIT.usage;
  }
  if (flags.help) {
    console.log(bootstrapHelp());
    return EXIT.ok;
  }
  try {
    if (!flags.embedded) throw new Exit(EXIT.usage, "bootstrap is for host-managed homes: pass --embedded (a person's own install uses `parachute init`)");
    const rawHome = flags.home ?? process.env.PARACHUTE_HOME;
    if (!rawHome) throw new Exit(EXIT.usage, "needs a home: set PARACHUTE_HOME or pass --home <dir>");
    const home = resolve(rawHome);
    const password = readPassword(flags);
    const username = flags.username ?? DEFAULT_USERNAME;
    const vault = flags.vault ?? DEFAULT_VAULT;
    // Every hub and vault module reads PARACHUTE_HOME when it loads, so it is set before the first import.
    process.env.PARACHUTE_HOME = home;
    const m: HubModules = {
      db: await import("@openparachute/hub/src/hub-db.ts"),
      users: await import("@openparachute/hub/src/users.ts"),
      op: await import("@openparachute/hub/src/operator-token.ts"),
      embedded: await import("@openparachute/hub/src/embedded-home.ts"),
      jwt: await import("@openparachute/hub/src/jwt-sign.ts"),
      vaultName: await import("@openparachute/vault/src/vault-name.ts"),
    };
    const nameCheck = m.vaultName.validateVaultName(vault);
    if (!nameCheck.ok) throw new Exit(EXIT.usage, `--vault ${vault}: ${nameCheck.error}`);
    if (password !== undefined && !m.users.validatePassword(password).valid) {
      throw new Exit(EXIT.usage, `the password is too short (at least ${m.users.PASSWORD_MIN_LEN} characters)`);
    }
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new Exit(EXIT.homeUnusable, `home ${home} is unusable: ${(err as Error).message}`);
    }

    const db = m.db.openHubDb(join(home, "hub.db"));
    let accountCreated = false;
    let vaultCreated = false;
    let tokenIssued = false;
    let user: ReturnType<typeof m.users.getUserByUsername>;
    let issuer: string;
    try {
      const existing = m.users.listUsers(db);
      user = existing.find((u) => u.username === username) ?? null;
      if (!user && existing.length > 0) {
        // An adopted home already has its account. Without --username, that account is the one bootstrapped;
        // a different name asked for explicitly is refused rather than a second account made.
        if (flags.username !== undefined) {
          throw new Exit(EXIT.usage, `this home already has an account named "${existing[0]!.username}"; bootstrap won't add "${username}"`);
        }
        user = existing[0]!;
      }
      if (!user) {
        try {
          // No password given: a random one nobody ever sees, so the account exists with no web sign-in until
          // `auth set-password`. The column can't be empty, and this keeps hub.db's schema as 0.7 has it.
          user = await m.users.createUser(db, username, password ?? randomBytes(32).toString("base64url"), {
            passwordChanged: password !== undefined,
          });
        } catch (err) {
          if (err instanceof m.users.InvalidUsernameError) throw new Exit(EXIT.usage, err.message);
          throw err;
        }
        accountCreated = true;
      }
      issuer = settleIssuer(home, m.embedded.readEmbeddedState);
      if (!(await usableOperatorToken(db, home, user.id, issuer, m))) {
        await m.op.issueOperatorToken(db, user.id, { dir: home, issuer });
        tokenIssued = true;
      }
    } finally {
      db.close();
    }

    if (!vaultExists(home, vault)) {
      await createVault(home, vault);
      vaultCreated = true;
    }

    const created = accountCreated || vaultCreated;
    const tokenFile = join(home, m.op.OPERATOR_TOKEN_FILENAME);
    const out = {
      created,
      admin: user.username,
      vault,
      operator_token_file: tokenFile,
      issuer,
      account_created: accountCreated,
      vault_created: vaultCreated,
      operator_token: tokenIssued ? "issued" : "kept",
      web_sign_in: accountCreated ? password !== undefined : "unchanged",
    };
    if (flags.json) console.log(JSON.stringify(out));
    else {
      console.log(created ? "Parachute is set up." : "Parachute was already set up; nothing changed.");
      console.log(`  account:        ${user.username}${accountCreated ? " (new)" : ""}`);
      console.log(`  vault:          ${vault}${vaultCreated ? " (new, no git mirror)" : ""}`);
      console.log(`  operator token: ${tokenFile} (${tokenIssued ? "written" : "kept"}, mode 0600)`);
      if (accountCreated && password === undefined) console.log("  web sign-in:    off until `parachute auth set-password`");
    }
    return EXIT.ok;
  } catch (err) {
    const code = err instanceof Exit ? err.code : homeError(err) ? EXIT.homeUnusable : EXIT.failed;
    say((err as Error).message);
    return code;
  }
}
