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

const vault = await startVault({ onStopFile: () => void shutdown("STOP_SIGNAL") });
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
