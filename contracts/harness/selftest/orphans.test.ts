// If the harness itself is killed outright (SIGKILL: no handler runs), the services it started must still die,
// and the next run must remove the temp home it left.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startServices } from "../services.ts";

async function answers(url: string): Promise<boolean> {
  try {
    await globalThis.fetch(url); // a raw probe on purpose: we expect nothing to be listening
    return true;
  } catch {
    return false;
  }
}

test(
  "services die when the harness is SIGKILLed, and the next run sweeps its temp home",
  async () => {
    const script = `const { startServices } = await import(${JSON.stringify(join(import.meta.dir, "../services.ts"))});
      const r = await startServices();
      console.log(JSON.stringify(r.services));
      await new Promise(() => {});`;
    const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "inherit", env: process.env });
    const reader = child.stdout.getReader();
    let line = "";
    while (!line.includes("\n")) line += new TextDecoder().decode((await reader.read()).value);
    const s = JSON.parse(line.trim());
    const vault = s.vaultDirect.replace(/\/vault\/.*$/, "");
    const sandbox = join(s.home, "..", "..");
    expect(await answers(`${s.hub}/health`)).toBe(true);

    child.kill("SIGKILL");
    await child.exited;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && ((await answers(`${s.hub}/health`)) || (await answers(`${vault}/health`))))
      await Bun.sleep(200);
    expect(await answers(`${s.hub}/health`)).toBe(false);
    expect(await answers(`${vault}/health`)).toBe(false);

    expect(existsSync(sandbox)).toBe(true); // nothing could clean it up yet...
    const next = await startServices(); // ...until the next run starts
    expect(existsSync(sandbox)).toBe(false);
    await next.stop();
  },
  90_000,
);
