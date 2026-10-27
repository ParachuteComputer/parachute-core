// Cleanup must be complete whenever stopAll() returns, because the signal handler calls process.exit right after.
// Uses the real pinned services (about a second to start).
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startServices, stopAll } from "../services.ts";

async function answers(url: string): Promise<boolean> {
  try {
    await globalThis.fetch(url); // a raw probe on purpose: we expect nothing to be listening
    return true;
  } catch {
    return false;
  }
}

test(
  "a signal during normal cleanup waits for that cleanup to finish",
  async () => {
    const running = await startServices();
    const s = running.services;
    const sandbox = join(s.home, "..", "..");
    expect(existsSync(sandbox)).toBe(true);

    const normal = running.stop(); // the main path has started stopping...
    await stopAll(); // ...and a signal arrives: the handler awaits stopAll(), then exits.

    expect(await answers(`${s.hub}/health`)).toBe(false);
    expect(await answers(`${s.vaultDirect.replace(/\/vault\/.*$/, "")}/health`)).toBe(false);
    expect(existsSync(sandbox)).toBe(false);
    await normal;
  },
  60_000,
);
