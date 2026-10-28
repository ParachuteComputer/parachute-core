#!/usr/bin/env bun
/**
 * `parachute-vault serve` (and `bun src/server.ts`, what the launchd and systemd units run): the vault in a process
 * of its own. Everything it serves is `startVault()` (./start-vault.ts); this file adds only what a process of its own
 * needs: SIGINT, SIGTERM and the stop file (`parachute-vault stop`) stop the vault, then the process exits 0.
 * `parachute-core serve` runs the same `startVault()` inside its own process instead.
 */
import { startVault } from "./start-vault.ts";

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  // Within the hub supervisor's 5 s before it escalates to SIGKILL (hub src/supervisor.ts).
  await vault.stop({ reason: signal, deadline: 4_000 });
  process.exit(0);
}

// Under `serve --embedded` (v0.8 PLAN §2.2 item 3, §3) the host manages the home, and the embedded serve passes
// PARACHUTE_VAULT_HOST_MANAGED=1 to its vault child: no first-boot vault (it would log a full API key; the host
// bootstraps), and no services.json write, ever (the stock hub needs it as it was to roll back), whatever the
// vault's .env says.
const hostManaged = process.env.PARACHUTE_VAULT_HOST_MANAGED === "1";
const vault = await startVault({
  onStopFile: () => void shutdown("STOP_SIGNAL"),
  ...(hostManaged ? { selfRegister: false as const, firstBoot: false, logFirstBootKey: false } : {}),
});
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
