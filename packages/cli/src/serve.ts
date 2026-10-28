// `parachute-core serve` (and `parachute serve`) with the vault inside this process (PLAN v0.8 §2.1–2.2, lane A2).
//
// One process: the vault (`startVault()`, packages/vault/src/start-vault.ts) on its own port as before (1940 on a
// box), then the hub (`serve()`, packages/hub/src/commands/serve.ts) proxying /vault/* to it over loopback. The vault
// starts when the home has it (its services.json row, as the hub started its child), or when the hub is told to start
// it (the setup wizard). The hub's supervisor holds it as a part of this process instead of a child: start, stop and
// restart (a vault rename or delete, `parachute restart vault`) stop and start it here, as they did the child, and
// every other module is supervised as before.
//
// One shutdown coordinator for every way serve is told to stop: SIGTERM, SIGINT, the vault's stop file
// (`parachute-vault stop`), and a part that fails to start. Its steps, in order, within one deadline:
//   1. let the part being started finish starting (a signal during start-up waits for it, then stops it);
//   2. stop the hub: its children, then its listener, letting the requests it is reading finish (they reach the
//      vault, which is still up); it removes hub-instance.json and closes hub.db (hub commands/serve.ts);
//   3. stop the vault: its listener (requests in flight finish), its mirror managers, hooks and workers, then every
//      vault database, which checkpoints each WAL;
//   4. close every vault database still open, whatever happened above (a stop that ran out of time, a start cut
//      short), and remove run/ready.json;
//   5. exit: 0 for a stop, 75 for a part that failed to start.
// Lane C adds `--parent-pid` (parent death is one more way into the same stop) and `--embedded`.
//
// The child path (`PARACHUTE_PROCESS_MODEL=child`: the hub starts `parachute-vault serve` as before) stays until the
// Nov 3 decision (PLAN §2.1); then the losing path is deleted.
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ModuleState, SpawnRequest } from "@openparachute/hub/src/supervisor.ts";
import type { RunningVault, StartVaultOptions } from "@openparachute/vault/src/start-vault.ts";
import type { HubValues } from "@openparachute/vault/src/hub-jwt.ts";
import vaultPkg from "@openparachute/vault/package.json" with { type: "json" };

export type ProcessModel = "in-process" | "child";

/** What this build runs. The candidate build (contracts/harness/build-core-candidate.ts) can change it. */
export const BUILT_PROCESS_MODEL: ProcessModel = "in-process";

export function processModel(env: NodeJS.ProcessEnv = process.env): ProcessModel {
  const v = env.PARACHUTE_PROCESS_MODEL;
  return v === "child" || v === "in-process" ? v : BUILT_PROCESS_MODEL;
}

/** A part failed to start (PLAN §3: exit 75). */
export const EXIT_PART_FAILED = 75;
/** Every stop step together, from the moment the stop is asked for. */
const STOP_DEADLINE_MS = 8_000;
/** What the parts after the hub keep for themselves out of the deadline. */
const AFTER_HUB_MS = 3_500;
/** Keys the hub reads for itself that the vault's .env could set (see VaultPart.start). */
const HUB_KEYS = ["PORT", "PARACHUTE_BIND_HOST", "PARACHUTE_HUB_ORIGIN", "PARACHUTE_HUB_ORIGINS", "PARACHUTE_HUB_JWKS_ORIGIN"] as const;

interface Part {
  name: string;
  stop: (deadline: number) => Promise<void>;
  /** Last, synchronous: release what must not stay open (run even when `stop` ran out of time). */
  close?: () => void;
}

class Coordinator {
  private parts: Part[] = [];
  private step: Promise<unknown> = Promise.resolve();
  private stopping: Promise<never> | null = null;
  /** Set once a stop is asked for: start-up checks it after each part and goes no further. */
  stopAsked = false;

  constructor(private readonly home: string) {}

  add(part: Part): void {
    this.parts.push(part);
  }

  /** A start-up step: a stop asked for meanwhile waits for it (bounded) before stopping the parts. */
  track<T>(starting: Promise<T>): Promise<T> {
    this.step = starting.catch(() => {});
    return starting;
  }

  /** Stop every part, the hub first, and exit with `code`. Safe to call more than once. */
  stop(reason: string, code = 0): Promise<never> {
    if (this.stopping) return this.stopping;
    this.stopAsked = true;
    const t0 = Date.now();
    const left = () => STOP_DEADLINE_MS - (Date.now() - t0);
    console.log(`parachute serve: stopping (${reason})`);
    // The deadline holds even if a step hangs.
    setTimeout(() => {
      console.error(`parachute serve: not stopped within ${STOP_DEADLINE_MS / 1000} s; exiting anyway`);
      this.closeAll();
      process.exit(code === 0 ? 1 : code);
    }, STOP_DEADLINE_MS + 1_000);
    this.stopping = (async (): Promise<never> => {
      await Promise.race([this.step, Bun.sleep(left() - AFTER_HUB_MS)]);
      // The hub first: requests it is reading still reach the vault. Then the rest, last added first.
      const order = [...this.parts].reverse().sort((a, b) => Number(b.name === "hub") - Number(a.name === "hub"));
      for (const part of order) {
        const budget = Math.max(500, part.name === "hub" ? left() - AFTER_HUB_MS : left());
        try {
          await Promise.race([part.stop(budget), Bun.sleep(budget)]);
        } catch (err) {
          console.error(`parachute serve: stopping the ${part.name} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      this.closeAll();
      console.log(`parachute serve: stopped in ${Date.now() - t0} ms`);
      process.exit(code);
    })();
    return this.stopping;
  }

  private closeAll(): void {
    for (const part of this.parts) {
      try {
        part.close?.();
      } catch {}
    }
    this.removeRunFiles();
  }

  /** run/ready.json. (hub-instance.json is the hub's: its stop removes it.) */
  removeRunFiles(): void {
    rmSync(join(this.home, "run", "ready.json"), { force: true });
  }
}

/**
 * The vault as a part of this process. Its start, stop and restart run one at a time, so a supervisor call and a
 * stop never overlap, and a second start while one runs is a no-op.
 */
class VaultPart {
  running: RunningVault | null = null;
  /** True once stopped on request (the hub's `stop vault`): reported as stopped, as a child would be. */
  stoppedOnRequest = false;
  /** The hub's issuer and accepted origins for the vault, once the hub has them. */
  private hub: HubValues = {};
  /** Hub-read keys as the vault's .env file has them (a child read them over the hub's environment). */
  private fromEnvFile: Partial<Record<(typeof HUB_KEYS)[number], string>> = {};
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: {
      startVault: (opts: StartVaultOptions) => Promise<RunningVault>;
      readEnvFile: () => Record<string, string>;
      setHubValues: (v: HubValues) => void;
      port: (requested?: number) => number;
      onStopFile: () => void;
    },
  ) {}

  private op<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  start(opts: { port?: number; firstBootVaultName?: string } = {}): Promise<void> {
    return this.op(async () => {
      if (this.running) return;
      // The vault's .env fills unset environment keys when it starts. In one process that environment is the hub's
      // too, so the keys the hub reads for itself go back to what they were; the vault gets them as values instead.
      const before = Object.fromEntries(HUB_KEYS.map((k) => [k, process.env[k]]));
      const file = this.deps.readEnvFile();
      this.fromEnvFile = Object.fromEntries(HUB_KEYS.filter((k) => file[k] !== undefined).map((k) => [k, file[k]]));
      try {
        this.running = await this.deps.startVault({
          port: this.deps.port(opts.port),
          selfRegister: "after-first-boot",
          logFirstBootKey: false,
          ...(opts.firstBootVaultName !== undefined ? { firstBootVaultName: opts.firstBootVaultName } : {}),
          onStopFile: this.deps.onStopFile,
        });
        this.stoppedOnRequest = false;
      } finally {
        for (const k of HUB_KEYS) {
          if (process.env[k] === before[k]) continue;
          if (before[k] === undefined) delete process.env[k];
          else process.env[k] = before[k];
        }
        this.giveHubValues();
      }
    });
  }

  stop(deadline: number, opts: { onRequest?: boolean } = {}): Promise<void> {
    return this.op(async () => {
      const v = this.running;
      if (!v) return;
      this.running = null;
      if (opts.onRequest) this.stoppedOnRequest = true;
      await v.stop({ reason: opts.onRequest ? "stop requested by the hub" : "serve stopping", deadline });
    });
  }

  /**
   * The hub's issuer and the origins it answers on, as a hub gave its vault child (hub serve-boot.ts
   * buildModuleSpawnRequest, api-modules-ops.ts), or as a start or restart request from the hub carries them.
   */
  setHub(values: { origin?: string; origins?: string }): void {
    this.hub = {
      ...(values.origin ? { hubOrigin: values.origin } : {}),
      ...(values.origins ? { hubOrigins: values.origins } : {}),
    };
    this.giveHubValues();
  }

  /**
   * What a vault child saw (supervisor.ts spawn env, then the child's own .env load): the hub's environment, the
   * vault's .env file over it, the hub's issuer and origins over both. Given as values (vault hub-jwt.ts), never
   * written into this process's environment, which is the hub's too.
   */
  private giveHubValues(): void {
    const env = (k: (typeof HUB_KEYS)[number]) => this.fromEnvFile[k] ?? process.env[k];
    const values: HubValues = {};
    const origin = this.hub.hubOrigin ?? env("PARACHUTE_HUB_ORIGIN");
    if (origin) values.hubOrigin = origin;
    const origins = this.hub.hubOrigins ?? env("PARACHUTE_HUB_ORIGINS");
    if (origins) values.hubOrigins = origins;
    const jwks = env("PARACHUTE_HUB_JWKS_ORIGIN");
    if (jwks) values.jwksOrigin = jwks;
    this.deps.setHubValues(values);
  }
}

function serveUsage(): void {
  console.error("usage: parachute serve");
}

/** `serve` with the vault in this process. Runs until stopped; never returns. */
export async function serveInProcess(args: string[]): Promise<never> {
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    const { serveHelp } = await import("@openparachute/hub/src/help.ts");
    console.log(serveHelp());
    process.exit(0);
  }
  if (args.length > 0) {
    console.error(`parachute serve: unexpected argument "${args[0]}"`);
    serveUsage();
    process.exit(1);
  }

  // The hub and the vault each find the home from PARACHUTE_HOME when their config modules load.
  const { CONFIG_DIR, SERVICES_MANIFEST_PATH } = await import("@openparachute/hub/src/config.ts");
  const coordinator = new Coordinator(CONFIG_DIR);
  // Handlers first: a signal at any moment from here on is a stop, never a kill.
  process.on("SIGTERM", () => void coordinator.stop("SIGTERM"));
  process.on("SIGINT", () => void coordinator.stop("SIGINT"));
  // A ready.json from a run that was killed says nothing about this one (PLAN §3).
  coordinator.removeRunFiles();

  const fail = (part: string, err: unknown): Promise<never> => {
    console.error(`parachute serve: the ${part} failed to start: ${err instanceof Error ? err.message : String(err)}`);
    return coordinator.stop(`the ${part} failed to start`, EXIT_PART_FAILED);
  };

  const { readManifestLenient } = await import("@openparachute/hub/src/services-manifest.ts");
  const { reconcilePortToCanonical } = await import("@openparachute/hub/src/commands/serve-boot.ts");
  const { readGlobalConfig, readEnvFile, DEFAULT_PORT } = await import("@openparachute/vault/src/config.ts");
  const { startVault, firstBootCreate } = await import("@openparachute/vault/src/start-vault.ts");
  const { closeAllStores } = await import("@openparachute/vault/src/vault-store.ts");
  const { selfRegister } = await import("@openparachute/vault/src/self-register.ts");
  const { setHubValues } = await import("@openparachute/vault/src/hub-jwt.ts");
  const { buildHubOriginsEnvValue } = await import("@openparachute/hub/src/vault-hub-origin-env.ts");
  const vaultRow = () => readManifestLenient(SERVICES_MANIFEST_PATH).services.find((s) => s.name === "parachute-vault");

  const vault = new VaultPart({
    startVault,
    readEnvFile,
    setHubValues,
    // The port the hub proxies to: what it asked for, else the services.json row's (snapped back to 1940 if it
    // drifted, as the hub does for a child), else config.yaml's, else 1940.
    port: (requested) => {
      if (requested) return requested;
      const row = vaultRow();
      return row ? reconcilePortToCanonical(row, SERVICES_MANIFEST_PATH, console.log).port : readGlobalConfig().port || DEFAULT_PORT;
    },
    onStopFile: () => void coordinator.stop("the stop file"),
  });
  coordinator.add({ name: "vault", stop: (deadline) => vault.stop(deadline), close: () => closeAllStores(true) });

  // 1. The vault, if this home has one, before the hub: a vault that can't start stops serve before the hub ever
  //    binds, and the hub never proxies to a vault not yet up.
  if (vaultRow()) {
    try {
      await coordinator.track(vault.start());
    } catch (err) {
      return fail("vault", err);
    }
    if (coordinator.stopAsked) return coordinator.stop("stopped during start-up");
  }

  // 2. The hub. Its supervisor holds the vault as a part of this process instead of a child.
  const { Supervisor } = await import("@openparachute/hub/src/supervisor.ts");
  let hubStopping = false;
  const vaultState = (): ModuleState | undefined => {
    if (vault.running) return { short: "vault", status: "running", pid: process.pid, startedAt: vault.running.startedAt, restartsInWindow: 0 };
    if (vault.stoppedOnRequest) return { short: "vault", status: "stopped", restartsInWindow: 0 };
    return undefined;
  };
  const crashed = (err: unknown): ModuleState => {
    console.error(`[supervisor] vault failed to start: ${err instanceof Error ? err.message : String(err)}`);
    return { short: "vault", status: "crashed", restartsInWindow: 0, lastCrashAt: new Date().toISOString(), lastExitCode: EXIT_PART_FAILED };
  };
  const requestedPort = (req?: SpawnRequest): number | undefined => {
    const n = Number(req?.env?.PORT);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const issuerOf = (req?: SpawnRequest) => ({ origin: req?.env?.PARACHUTE_HUB_ORIGIN, origins: req?.env?.PARACHUTE_HUB_ORIGINS });
  class InProcessSupervisor extends Supervisor {
    override async start(req: SpawnRequest): Promise<ModuleState> {
      if (req.short !== "vault") return super.start(req);
      // The setup wizard's first vault passes the name it asked for.
      const name = req.env?.PARACHUTE_VAULT_NAME;
      if (vault.running) {
        if (name !== undefined && (await firstBootCreate(name, false))) selfRegister({ version: vaultPkg.version });
        return vaultState()!;
      }
      // A vault installed while serve runs, or started again after a stop: it starts now, in this process. A failure
      // is this module's, as a child's crash was; serve keeps running.
      try {
        if (req.env?.PARACHUTE_HUB_ORIGIN) vault.setHub(issuerOf(req));
        await vault.start({ port: requestedPort(req), firstBootVaultName: name });
      } catch (err) {
        return crashed(err);
      }
      return vaultState()!;
    }
    // When serve itself stops, the coordinator stops the vault after the hub, so the hub's own stop leaves it alone.
    override async stop(short: string): Promise<ModuleState | undefined> {
      if (short !== "vault" || !vaultState()) return super.stop(short);
      if (!hubStopping) await vault.stop(4_000, { onRequest: true });
      return vaultState();
    }
    override async restart(short: string, nextReq?: SpawnRequest): Promise<ModuleState | undefined> {
      if (short !== "vault" || !vaultState()) return super.restart(short, nextReq);
      const port = requestedPort(nextReq) ?? vault.running?.port;
      await vault.stop(4_000, { onRequest: true });
      try {
        if (nextReq?.env?.PARACHUTE_HUB_ORIGIN) vault.setHub(issuerOf(nextReq));
        await vault.start({ port });
        // As the child's boot did: the services.json row follows the vaults there are now (a rename or a delete).
        selfRegister({ version: vaultPkg.version });
      } catch (err) {
        return crashed(err);
      }
      return vaultState();
    }
    override list(): ModuleState[] {
      const v = vaultState();
      return v ? [...super.list().filter((m) => m.short !== "vault"), v] : super.list();
    }
    override get(short: string): ModuleState | undefined {
      return short === "vault" ? (vaultState() ?? super.get(short)) : super.get(short);
    }
  }

  const { serve } = await import("@openparachute/hub/src/commands/serve.ts");
  try {
    const hub = await coordinator.track(serve({ supervisor: new InProcessSupervisor() }));
    coordinator.add({
      name: "hub",
      stop: async () => {
        hubStopping = true;
        await hub.stop();
      },
    });
    // 3. What the hub gives a vault child: its issuer and the origins it answers on. The vault reads them when it
    //    checks a pass, so they apply from here on.
    const issuer = hub.result.issuer;
    if (issuer) vault.setHub({ origin: issuer, origins: buildHubOriginsEnvValue(CONFIG_DIR, issuer) });
  } catch (err) {
    return fail("hub", err);
  }
  if (coordinator.stopAsked) return coordinator.stop("stopped during start-up");

  // The listeners keep the process alive until the coordinator exits it.
  return new Promise<never>(() => {});
}
