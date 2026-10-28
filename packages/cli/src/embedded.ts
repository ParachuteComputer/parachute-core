// `parachute serve --embedded` (v0.8 PLAN §3; Benjamin's E1, E6): the one process a host application (Prism)
// starts, on ports the host chooses, loopback only, in a home the host owns.
//
//   parachute serve --embedded [--home <dir>] [--listen 127.0.0.1:<port>] [--vault-listen 127.0.0.1:<port>]
//                              [--offline] [--parent-pid <pid>]
//
//   - home: --home, else PARACHUTE_HOME; neither exits 2 and creates nothing;
//   - hub port: --listen, then PORT, then 1939; vault port: --vault-listen, then `port` in
//     $PARACHUTE_HOME/vault/config.yaml, then 1940; a non-loopback address exits 2, a port in use exits 4;
//   - issuer: PARACHUTE_HUB_ORIGIN exactly, else http://127.0.0.1:<hub port>, decided again on every start; every
//     earlier issuer stays in embedded.json `accepted_issuers`, so old tokens keep verifying;
//   - the hub's /health is 200 only once the vault answers; /api/ready is 200 only once the box is usable, and
//     run/ready.json (both ports, the issuer, the pid) exists by then;
//   - while it runs, the home is held (run/serve.lock, managed.ts): other serves, installs and module commands are
//     refused with managed_by_host, and so are the matching HTTP routes (hub-server.ts);
//   - it stops cleanly on SIGTERM or SIGINT, when the --parent-pid process dies, or (without --parent-pid) when the
//     process that started it dies: ready.json goes, the vault stops, then the hub; exit 0.
//
// Exit codes (PLAN §3): 0 clean · 2 flags or managed_by_host · 4 port in use · 5 home unusable · 75 a part failed.
// 6 (newer data) is lane B's.
//
// Process model: lane A1's child path. The vault runs as this program's own `parachute-vault serve`, started from
// this install (never from PATH) with its port, bind, issuers and key source passed in. Lane A2's in-process vault
// replaces startVaultChild() and keeps everything else here.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import core from "../../../package.json" with { type: "json" };
import { acquireHold } from "./managed.ts";

const HUB_DEFAULT_PORT = 1939;
const VAULT_DEFAULT_PORT = 1940;
const VAULT_CLI = fileURLToPath(new URL("./parachute-vault.ts", import.meta.url));
const VAULT_START_MS = 60_000;
const VAULT_STOP_MS = 7_000;

export const EXIT = { ok: 0, usage: 2, portInUse: 4, homeUnusable: 5, partFailed: 75 } as const;

class Exit extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

interface Flags {
  home?: string;
  listen?: string;
  vaultListen?: string;
  offline: boolean;
  parentPid?: number;
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { offline: false };
  const seen = new Set<string>(); // each value flag once: dispatch's checks and serve must agree on the home
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--embedded") continue;
    if (arg === "--offline") {
      flags.offline = true; // offline is the default (PLAN §3); lane B makes it hold
      continue;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const value = eq > 0 ? arg.slice(eq + 1) : args[i + 1];
    if (!["--home", "--listen", "--vault-listen", "--parent-pid"].includes(flag)) {
      throw new Exit(EXIT.usage, `unexpected argument "${arg}"`);
    }
    if (value === undefined || value === "" || (eq < 0 && value.startsWith("--"))) throw new Exit(EXIT.usage, `${flag} needs a value`);
    if (seen.has(flag)) throw new Exit(EXIT.usage, `${flag} given twice`);
    seen.add(flag);
    if (eq < 0) i++;
    if (flag === "--home") flags.home = value;
    else if (flag === "--listen") flags.listen = value;
    else if (flag === "--vault-listen") flags.vaultListen = value;
    else {
      if (!/^\d+$/.test(value) || Number(value) <= 0) throw new Exit(EXIT.usage, `--parent-pid needs a process id, got "${value}"`);
      flags.parentPid = Number(value);
    }
  }
  return flags;
}

type ServeModule = typeof import("@openparachute/hub/src/commands/serve.ts");

/**
 * An address from a flag, the environment or the config: 127.0.0.1 only. Anything that isn't loopback exits 2
 * (PLAN §3), and so does another loopback address: the hub reaches its vault on 127.0.0.1, so a vault listening on
 * 127.0.0.2 or ::1 would answer its own /health while every request through the hub failed.
 */
function address(serveMod: ServeModule, what: string, value: string | undefined, fallbackPort: number, bindEnv: string | undefined) {
  const only = (host: string, shown: string) => {
    if (host === "127.0.0.1" || host === "localhost") return;
    const why = serveMod.isLoopbackHost(host) ? "embedded mode listens on 127.0.0.1 only" : "not a loopback address; embedded mode listens on 127.0.0.1 only";
    throw new Exit(EXIT.usage, `${shown}: ${why}`);
  };
  if (bindEnv) only(bindEnv, `${what === "--listen" ? "PARACHUTE_BIND_HOST" : "VAULT_BIND"}=${bindEnv}`);
  if (value === undefined) return { host: "127.0.0.1", port: fallbackPort };
  const a = serveMod.parseListen(value);
  if (!a) throw new Exit(EXIT.usage, `${what} needs 127.0.0.1:<port>, got "${value}"`);
  if (a.host !== undefined) only(a.host, `${what} ${value}`);
  return { host: "127.0.0.1", port: a.port };
}

const listenText = (a: { port: number }) => `127.0.0.1:${a.port}`;

/** PARACHUTE_HUB_ORIGIN, if set, must be exactly an origin: it is the issuer as given, never rewritten (PLAN §3). */
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

/** A filesystem error: the home is unusable (exit 5), not a part that failed. */
function homeError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && (/^E(ACCES|PERM|ISDIR|NOTDIR|EXIST|ROFS|NOSPC|DQUOT|LOOP|NAMETOOLONG|NOENT|IO)$/.test(code) || /^ERR_FS_/.test(code) || /^SQLITE_(CANTOPEN|READONLY|IOERR|FULL|NOTADB|CORRUPT)/.test(code));
}

function envPort(raw: string | undefined): number | undefined {
  if (!raw || !/^\d{1,5}$/.test(raw.trim())) return undefined;
  const n = Number(raw.trim());
  return n >= 1 && n <= 65535 ? n : undefined;
}

/** `port` in $PARACHUTE_HOME/vault/config.yaml, read the way the vault reads it (vault src/config.ts). */
function configuredVaultPort(home: string): number | undefined {
  const p = join(home, "vault", "config.yaml");
  if (!existsSync(p)) return undefined;
  try {
    return envPort(/^port:\s*(\d+)/m.exec(readFileSync(p, "utf8"))?.[1]);
  } catch {
    return undefined;
  }
}

/** Can we bind it now? A port another process holds exits 4 before anything starts (PLAN §3). */
function portFree(host: string, port: number): boolean {
  try {
    const s = Bun.listen({ hostname: host, port, socket: { data() {} } });
    s.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** Write `data` to `path` atomically, 0600, in a 0700 folder. */
function writeAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Record this start's issuer in embedded.json, keeping every earlier one accepted (PLAN §3 "Issuer"). */
function recordIssuer(home: string, issuer: string): string[] {
  const p = join(home, "embedded.json");
  let prev: { issuer?: unknown; accepted_issuers?: unknown } = {};
  if (existsSync(p)) {
    // A file that can't be read or parsed is never reset: that would drop every earlier issuer, and with them
    // every token minted on an earlier port. The home is unusable until someone looks.
    try {
      prev = JSON.parse(readFileSync(p, "utf8"));
    } catch (err) {
      throw new Exit(EXIT.homeUnusable, `${p} can't be read (${(err as Error).message}); it records the issuers earlier tokens carry, so it is left as it is`);
    }
    if (!prev || typeof prev !== "object") throw new Exit(EXIT.homeUnusable, `${p} is not a JSON object; left as it is`);
  }
  const earlier = [...(Array.isArray(prev.accepted_issuers) ? prev.accepted_issuers : []), prev.issuer].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  const accepted = [...new Set([...earlier, issuer])];
  writeAtomic(p, `${JSON.stringify({ issuer, accepted_issuers: accepted, updated_at: new Date().toISOString() }, null, 2)}\n`);
  return accepted;
}

interface VaultPart {
  exited: Promise<number>;
  /** Did it say why it couldn't start? "port" for an address in use. */
  failure(): "port" | undefined;
  stop(): Promise<void>;
}

/** The vault as this install's own `parachute-vault serve` (the child path), with everything passed in. */
function startVaultChild(o: { home: string; host: string; port: number; issuer: string; accepted: string[]; hubLoopback: string }): VaultPart {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // No first-boot auto-create: it logs a full API key (PLAN §2.2 item 3); the host bootstraps the vault.
  delete env.PARACHUTE_VAULT_NAME;
  Object.assign(env, {
    PARACHUTE_HOME: o.home,
    PORT: String(o.port),
    VAULT_BIND: o.host,
    // The issuer exactly, every earlier one, and keys and revocations from this hub on loopback (fix 1).
    PARACHUTE_HUB_ORIGIN: o.issuer,
    PARACHUTE_HUB_ORIGINS: o.accepted.join(","),
    PARACHUTE_HUB_JWKS_ORIGIN: o.hubLoopback,
    // managed.ts lets exactly this child's `parachute-vault serve` through while the home is held.
    PARACHUTE_EMBEDDED_PARENT: String(process.pid),
    // No first-boot vault and no services.json write (vault src/server.ts): the host bootstraps, and the stock hub
    // needs services.json as it was to roll back (PLAN §2.2 item 3, §3).
    PARACHUTE_VAULT_HOST_MANAGED: "1",
  });
  const proc = Bun.spawn([process.execPath, VAULT_CLI, "serve"], { env, stdin: "ignore", stdout: "inherit", stderr: "pipe" });
  let tail = "";
  void (async () => {
    const reader = proc.stderr.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      process.stderr.write(value);
      tail = (tail + new TextDecoder().decode(value)).slice(-4000);
    }
  })().catch(() => {});
  return {
    exited: proc.exited,
    failure: () => (/EADDRINUSE|address already in use|port \d+ in use/i.test(tail) ? "port" : undefined),
    async stop() {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill("SIGTERM");
      const done = await Promise.race([proc.exited.then(() => true), Bun.sleep(VAULT_STOP_MS).then(() => false)]);
      if (!done) {
        proc.kill("SIGKILL");
        await proc.exited;
      }
    },
  };
}

async function answers(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
    await r.arrayBuffer();
    return r.ok;
  } catch {
    return false;
  }
}

/** Run `serve --embedded <args>`; resolves with the exit code once it has stopped. */
export async function serveEmbedded(args: string[]): Promise<number> {
  const say = (line: string) => console.error(`parachute serve --embedded: ${line}`);
  const startedBy = process.ppid;

  // What there is to undo; stop() undoes whatever exists, once, whenever it is asked (a signal, the parent's
  // death, the vault's exit, a failure during start-up).
  let home = "";
  let readyFile = "";
  let release: (() => void) | undefined;
  let pendingHub: Promise<unknown> | undefined;
  let hubStop: (() => Promise<void>) | undefined;
  let vaultPart: VaultPart | undefined;
  let ready = false;
  let vaultUp = false;
  const watches: (() => void)[] = [];
  const unpublish = () => {
    if (readyFile) rmSync(readyFile, { force: true });
  };
  let stopping: Promise<number> | undefined;
  const stopAsked = Promise.withResolvers<void>();
  // Each step runs even if an earlier one fails, and the hold goes last, so the home is never free while a
  // part of this serve still runs. A hub start still in flight is waited for, then stopped.
  const step = async (what: string, fn: () => unknown) => {
    try {
      await fn();
    } catch (err) {
      say(`${what}: ${(err as Error).message}`);
    }
  };
  const stop = (code: number, why: string): Promise<number> =>
    (stopping ??= (async () => {
      stopAsked.resolve();
      if (why) say(`stopping (${why})`);
      ready = false;
      vaultUp = false; // /health stops saying healthy as soon as the stop begins
      for (const cancel of watches) cancel();
      await step("removing ready.json", unpublish);
      await step("stopping the vault", () => vaultPart?.stop());
      await step("waiting for the hub to start", () => pendingHub);
      await step("stopping the hub", () => hubStop?.());
      await step("removing ready.json", unpublish); // again, once start-up can no longer publish
      await step("releasing the home", () => release?.());
      return code;
    })());
  process.on("SIGTERM", () => void stop(EXIT.ok, "SIGTERM"));
  process.on("SIGINT", () => void stop(EXIT.ok, "SIGINT"));

  try {
    const flags = parseFlags(args);
    const rawHome = flags.home ?? process.env.PARACHUTE_HOME;
    if (!rawHome) throw new Exit(EXIT.usage, "needs a home: set PARACHUTE_HOME or pass --home <dir>");
    home = resolve(rawHome);
    // Every hub and vault module reads PARACHUTE_HOME when it loads, so it is set before the first import.
    process.env.PARACHUTE_HOME = home;
    const serveMod: ServeModule = await import("@openparachute/hub/src/commands/serve.ts");

    // Parent death (PLAN §3), watched from the start: the --parent-pid process, else the process that started this
    // one. A parent already gone means there is nothing to serve.
    if (flags.parentPid !== undefined) {
      if (!serveMod.pidAlive(flags.parentPid)) throw new Exit(EXIT.ok, `parent ${flags.parentPid} is already gone`);
      watches.push(serveMod.watchParentPid(flags.parentPid, () => void stop(EXIT.ok, `parent ${flags.parentPid} exited`)));
    } else if (startedBy > 1) {
      const parent = startedBy;
      if (process.ppid !== parent) throw new Exit(EXIT.ok, `parent ${parent} is already gone`);
      const timer = setInterval(() => {
        if (process.ppid !== parent) void stop(EXIT.ok, `parent ${parent} exited`);
      }, 500);
      watches.push(() => clearInterval(timer));
    }

    const hub = address(serveMod, "--listen", flags.listen, envPort(process.env.PORT) ?? HUB_DEFAULT_PORT, process.env.PARACHUTE_BIND_HOST);
    const issuer = hostIssuer(process.env.PARACHUTE_HUB_ORIGIN) ?? `http://${listenText(hub)}`;
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new Exit(EXIT.homeUnusable, `home ${home} is unusable: ${(err as Error).message}`);
    }
    const vault = address(serveMod, "--vault-listen", flags.vaultListen, configuredVaultPort(home) ?? VAULT_DEFAULT_PORT, process.env.VAULT_BIND);
    if (hub.port === vault.port) throw new Exit(EXIT.usage, `the hub and the vault can't share port ${hub.port}`);

    // The hold: exclusive, so of several serves started at once on this home exactly one goes on.
    if (stopping) return await stopping;
    const taken = acquireHold(home);
    if ("holder" in taken) throw new Exit(EXIT.usage, `managed_by_host: another serve --embedded (pid ${taken.holder}) holds ${home}`);
    release = taken.release;
    if (stopping) return await stopping;

    for (const [what, a] of [["hub", hub], ["vault", vault]] as const) {
      if (!portFree(a.host, a.port)) throw new Exit(EXIT.portInUse, `${what} port ${a.port} is in use (${listenText(a)})`);
    }
    readyFile = join(home, "run", "ready.json");
    unpublish(); // a ready.json left by a killed run must never read as this one's
    const accepted = recordIssuer(home, issuer);

    try {
      const starting = serveMod.serve({
        port: hub.port,
        hostname: hub.host,
        embedded: { issuer, vaultPort: vault.port, vaultAnswers: () => vaultUp, ready: () => ready, acceptedIssuers: accepted },
      });
      // A stop that comes while the hub starts waits for this, so the hub it then stops is the one that started.
      pendingHub = starting.then((served) => (hubStop = served.stop), () => undefined);
      await starting;
    } catch (err) {
      const inUse = (err as NodeJS.ErrnoException).code === "EADDRINUSE";
      throw new Exit(inUse ? EXIT.portInUse : EXIT.partFailed, `the hub failed to start: ${(err as Error).message}`);
    }
    if (stopping) return await stopping;

    vaultPart = startVaultChild({ home, host: vault.host, port: vault.port, issuer, accepted, hubLoopback: `http://${listenText(hub)}` });
    let vaultExit: number | undefined;
    void vaultPart.exited.then((c) => {
      vaultExit = c;
      // Before the box is ready, start-up below decides what the exit means.
      if (ready) void stop(EXIT.partFailed, `the vault exited (${c})`);
    });
    const vaultHealth = `http://${listenText(vault)}/health`;
    const deadline = Date.now() + VAULT_START_MS;
    while (!stopping && vaultExit === undefined && Date.now() < deadline) {
      const ok = await answers(vaultHealth);
      if (stopping || vaultExit !== undefined) break; // decided while we waited
      if (ok) {
        vaultUp = true;
        break;
      }
      await Bun.sleep(100);
    }
    if (stopping) return await stopping;
    if (!vaultUp || vaultExit !== undefined) {
      await Bun.sleep(100); // let its last stderr arrive
      const code = vaultPart.failure() === "port" ? EXIT.portInUse : EXIT.partFailed;
      if (vaultExit === undefined) say(`the vault did not answer on ${listenText(vault)} within ${VAULT_START_MS / 1000} s`);
      return await stop(code, code === EXIT.portInUse ? `vault port ${vault.port} is in use` : `the vault failed to start (exit ${vaultExit ?? "none"})`);
    }

    writeAtomic(
      readyFile,
      `${JSON.stringify(
        {
          ready: true,
          pid: process.pid,
          listen: listenText(hub),
          vault_listen: listenText(vault),
          issuer,
          version: core.version,
          started_at: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    if (stopping) return await stopping;
    if (vaultExit !== undefined) return await stop(EXIT.partFailed, `the vault exited (${vaultExit})`);
    ready = true;
    say(`ready: hub ${listenText(hub)}, vault ${listenText(vault)}, issuer ${issuer}`);
    await stopAsked.promise;
    return await stopping!;
  } catch (err) {
    const code = err instanceof Exit ? err.code : homeError(err) ? EXIT.homeUnusable : EXIT.partFailed;
    say(code === EXIT.homeUnusable && !(err instanceof Exit) ? `home ${home} is unusable: ${(err as Error).message}` : (err as Error).message);
    return await stop(code, "");
  }
}
