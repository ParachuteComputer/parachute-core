// `parachute-core serve` (and `parachute serve`) with the vault inside this process (PLAN v0.8 §2.1–2.2, lane A2).
//
// One process: the vault (`startVault()`, packages/vault/src/start-vault.ts) on its own port as before (1940 on a
// box), then the hub (`serve()`, packages/hub/src/commands/serve.ts) proxying /vault/* to it over loopback. The hub's
// supervisor skips the vault row of services.json in memory and still supervises every other module.
//
// One shutdown coordinator for every way serve is told to stop: SIGTERM, SIGINT, the vault's stop file
// (`parachute-vault stop`), and a part that fails to start. Its steps, in order:
//   1. let the part being started finish starting (a signal during start-up waits for it, then stops it);
//   2. stop the hub: its children, then its listener, letting the requests it is reading finish (they reach the
//      vault, which is still up); it removes hub-instance.json and closes hub.db (hub commands/serve.ts);
//   3. stop the vault: its listener (requests in flight finish), its mirror managers, hooks and workers, then every
//      vault database, which checkpoints each WAL;
//   4. remove run/ready.json;
//   5. exit: 0 for a stop, 75 for a part that failed to start. All within one deadline.
// Lane C adds `--parent-pid` (parent death is one more way into the same stop) and `--embedded`.
//
// The child path (`PARACHUTE_PROCESS_MODEL=child`: the hub starts `parachute-vault serve` as before) stays until the
// Nov 3 decision (PLAN §2.1); then the losing path is deleted.
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ModuleState, SpawnRequest } from "@openparachute/hub/src/supervisor.ts";
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
/** What a vault the hub would start reads from the environment that the hub's own start reads too. */
const HUB_KEYS = ["PORT", "PARACHUTE_BIND_HOST", "PARACHUTE_HUB_ORIGIN", "PARACHUTE_HUB_ORIGINS", "PARACHUTE_HUB_JWKS_ORIGIN"] as const;

interface Part {
  name: string;
  stop: (deadline: number) => Promise<void>;
}

class Coordinator {
  private parts: Part[] = [];
  private step: Promise<unknown> = Promise.resolve();
  private stopping: Promise<never> | null = null;
  /** Set once a stop is asked for: start-up checks it after each part and goes no further. */
  stopAsked = false;

  constructor(private readonly home: string) {}

  /**
   * Start one part. A stop asked for meanwhile waits for it to finish starting; the part is registered in the same
   * step, so that stop stops it too.
   */
  start<T>(name: string, starting: Promise<T>, stopOf: (part: T) => Part["stop"]): Promise<T> {
    this.step = starting.then(
      (part) => void this.parts.push({ name, stop: stopOf(part) }),
      () => {},
    );
    return starting;
  }

  /** Stop everything started so far, in reverse, and exit with `code`. Safe to call more than once. */
  stop(reason: string, code = 0): Promise<never> {
    if (this.stopping) return this.stopping;
    this.stopAsked = true;
    const t0 = Date.now();
    console.log(`parachute serve: stopping (${reason})`);
    // The deadline holds even if a step hangs.
    setTimeout(() => {
      console.error(`parachute serve: not stopped within ${STOP_DEADLINE_MS / 1000} s; exiting anyway`);
      process.exit(code === 0 ? 1 : code);
    }, STOP_DEADLINE_MS + 1_000);
    this.stopping = (async (): Promise<never> => {
      await Promise.race([this.step, Bun.sleep(STOP_DEADLINE_MS / 2)]);
      for (const part of [...this.parts].reverse()) {
        const left = Math.max(500, STOP_DEADLINE_MS - (Date.now() - t0));
        try {
          await Promise.race([part.stop(left), Bun.sleep(left)]);
        } catch (err) {
          console.error(`parachute serve: stopping the ${part.name} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      this.removeRunFiles();
      console.log(`parachute serve: stopped in ${Date.now() - t0} ms`);
      process.exit(code);
    })();
    return this.stopping;
  }

  /** run/ready.json. (hub-instance.json is the hub's: its stop removes it.) */
  removeRunFiles(): void {
    rmSync(join(this.home, "run", "ready.json"), { force: true });
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

  // 1. The vault, on the port the hub proxies to: its services.json row's (snapped back to 1940 if it drifted, as the
  //    hub does for a child), else config.yaml's, else 1940.
  const { readManifestLenient } = await import("@openparachute/hub/src/services-manifest.ts");
  const { reconcilePortToCanonical } = await import("@openparachute/hub/src/commands/serve-boot.ts");
  const { readGlobalConfig, DEFAULT_PORT } = await import("@openparachute/vault/src/config.ts");
  const { startVault } = await import("@openparachute/vault/src/start-vault.ts");
  const row = readManifestLenient(SERVICES_MANIFEST_PATH).services.find((s) => s.name === "parachute-vault");
  const port = row ? reconcilePortToCanonical(row, SERVICES_MANIFEST_PATH, console.log).port : readGlobalConfig().port || DEFAULT_PORT;
  // The vault's .env fills unset environment keys when it starts. In one process that environment is the hub's too,
  // so the keys the hub reads for itself go back to what they were; the vault gets what a hub gives its child (below).
  const before = Object.fromEntries(HUB_KEYS.map((k) => [k, process.env[k]]));
  let vault: Awaited<ReturnType<typeof startVault>>;
  try {
    vault = await coordinator.start(
      "vault",
      startVault({
        port,
        selfRegister: "after-first-boot",
        logFirstBootKey: false,
        onStopFile: () => void coordinator.stop("the stop file"),
      }),
      (v) => (deadline) => v.stop({ reason: "serve stopping", deadline }),
    );
  } catch (err) {
    return fail("vault", err);
  }
  const fromVaultEnv: Partial<Record<(typeof HUB_KEYS)[number], string>> = {};
  for (const k of HUB_KEYS) {
    if (process.env[k] !== before[k]) {
      fromVaultEnv[k] = process.env[k];
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
  if (coordinator.stopAsked) return coordinator.stop("stopped during start-up");

  // 2. The hub. Its supervisor holds the vault as a part of this process instead of a child.
  const { Supervisor } = await import("@openparachute/hub/src/supervisor.ts");
  const { closeAllStores } = await import("@openparachute/vault/src/vault-store.ts");
  const { selfRegister } = await import("@openparachute/vault/src/self-register.ts");
  let hubStopping = false;
  const vaultState = (): ModuleState => ({ short: "vault", status: "running", pid: process.pid, startedAt: vault.startedAt, restartsInWindow: 0 });
  class InProcessSupervisor extends Supervisor {
    override async start(req: SpawnRequest): Promise<ModuleState> {
      if (req.short !== "vault") return super.start(req);
      // The setup wizard's first vault (it passes the name it asked for).
      const name = req.env?.PARACHUTE_VAULT_NAME;
      if (name !== undefined) {
        const { firstBootCreate } = await import("@openparachute/vault/src/start-vault.ts");
        if (await firstBootCreate(name, false)) selfRegister({ version: vaultPkg.version });
      }
      return vaultState();
    }
    // A vault rename or delete through the hub stops and restarts the vault to release its databases and rebuild its
    // services.json row. Here that is what they do; the vault keeps serving. When serve itself stops, the
    // coordinator stops the vault after the hub, so the hub's own stop leaves it alone.
    override async stop(short: string): Promise<ModuleState | undefined> {
      if (short !== "vault") return super.stop(short);
      if (!hubStopping) closeAllStores(true);
      return vaultState();
    }
    override async restart(short: string, nextReq?: SpawnRequest): Promise<ModuleState | undefined> {
      if (short !== "vault") return super.restart(short, nextReq);
      closeAllStores(true);
      selfRegister({ version: vaultPkg.version });
      return vaultState();
    }
    override list(): ModuleState[] {
      return [...super.list().filter((m) => m.short !== "vault"), vaultState()];
    }
    override get(short: string): ModuleState | undefined {
      return short === "vault" ? vaultState() : super.get(short);
    }
  }

  const { serve } = await import("@openparachute/hub/src/commands/serve.ts");
  let hub: Awaited<ReturnType<typeof serve>>;
  try {
    hub = await coordinator.start("hub", serve({ supervisor: new InProcessSupervisor() }), (h) => async () => {
      hubStopping = true;
      await h.stop();
    });
  } catch (err) {
    return fail("hub", err);
  }

  // 3. What the hub gives a vault child: its issuer and the origins it answers on (hub serve-boot.ts
  //    buildModuleSpawnRequest). The vault reads these when it checks a pass, so they apply from here on. Lane C passes
  //    them in as values instead.
  const { buildHubOriginsEnvValue } = await import("@openparachute/hub/src/vault-hub-origin-env.ts");
  const issuer = hub.result.issuer;
  const origin = issuer ?? fromVaultEnv.PARACHUTE_HUB_ORIGIN;
  if (origin) process.env.PARACHUTE_HUB_ORIGIN = origin;
  const origins = issuer ? buildHubOriginsEnvValue(CONFIG_DIR, issuer) : fromVaultEnv.PARACHUTE_HUB_ORIGINS;
  if (origins) process.env.PARACHUTE_HUB_ORIGINS = origins;
  if (fromVaultEnv.PARACHUTE_HUB_JWKS_ORIGIN) process.env.PARACHUTE_HUB_JWKS_ORIGIN = fromVaultEnv.PARACHUTE_HUB_JWKS_ORIGIN;
  if (coordinator.stopAsked) return coordinator.stop("stopped during start-up");

  // Both listeners keep the process alive until the coordinator exits it.
  return new Promise<never>(() => {});
}
