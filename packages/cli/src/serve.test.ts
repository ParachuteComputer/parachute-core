// The in-process vault's environment (serve.ts VaultPart): in one process the environment is the hub's too. What a
// vault child got must hold here, and nothing may stay behind after the vault stops. The vault itself is faked
// (startVault); everything checked is VaultPart's own logic.
import { afterEach, describe, expect, test } from "bun:test";
import { VaultPart } from "./serve.ts";
import type { RunningVault, StartVaultOptions } from "@openparachute/vault/src/start-vault.ts";
import type { HubValues } from "@openparachute/vault/src/hub-jwt.ts";

const KEYS = ["PARACHUTE_OFFLINE", "LIFECYCLE_TEST_TOKEN", "LIFECYCLE_TEST_ONLY_IN_FILE", "PARACHUTE_HUB_ORIGIN"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = saved[k];
  }
});

function part(file: Record<string, string>, opts: { fail?: boolean } = {}) {
  const seen: Record<string, string | undefined>[] = [];
  const values: HubValues[] = [];
  const running: RunningVault = { port: 1, hostname: "127.0.0.1", startedAt: "", stop: async () => {} };
  const p = new VaultPart({
    startVault: async (_: StartVaultOptions) => {
      seen.push(Object.fromEntries(KEYS.map((k) => [k, process.env[k]])));
      if (opts.fail) throw new Error("made-up start failure");
      return running;
    },
    readEnvFile: () => file,
    setHubValues: (v) => void values.push(v),
    isOffline: () => process.env.PARACHUTE_OFFLINE === "1",
    port: () => 1,
    onStopFile: () => {},
  });
  return { p, seen, values };
}

describe("VaultPart: the vault's .env in the hub's process", () => {
  test("the file wins over the environment, as it did for a child, and everything goes back on stop", async () => {
    process.env.LIFECYCLE_TEST_TOKEN = "from-the-hub";
    Reflect.deleteProperty(process.env, "LIFECYCLE_TEST_ONLY_IN_FILE");
    const { p, seen } = part({ LIFECYCLE_TEST_TOKEN: "from-the-file", LIFECYCLE_TEST_ONLY_IN_FILE: "x" });
    await p.start();
    expect(seen[0]!.LIFECYCLE_TEST_TOKEN).toBe("from-the-file");
    expect(seen[0]!.LIFECYCLE_TEST_ONLY_IN_FILE).toBe("x");
    await p.stop(1_000);
    expect(process.env.LIFECYCLE_TEST_TOKEN).toBe("from-the-hub");
    expect("LIFECYCLE_TEST_ONLY_IN_FILE" in process.env).toBe(false);
  });

  test("a failed start puts the environment back too", async () => {
    process.env.LIFECYCLE_TEST_TOKEN = "from-the-hub";
    const { p } = part({ LIFECYCLE_TEST_TOKEN: "from-the-file" }, { fail: true });
    await expect(p.start()).rejects.toThrow("made-up start failure");
    expect(process.env.LIFECYCLE_TEST_TOKEN).toBe("from-the-hub");
  });

  test("offline serve stays offline: the vault's .env can't turn PARACHUTE_OFFLINE off", async () => {
    process.env.PARACHUTE_OFFLINE = "1";
    const { p, seen } = part({ PARACHUTE_OFFLINE: "0" });
    await p.start();
    expect(seen[0]!.PARACHUTE_OFFLINE).toBe("1");
    expect(process.env.PARACHUTE_OFFLINE).toBe("1");
    await p.stop(1_000);
    expect(process.env.PARACHUTE_OFFLINE).toBe("1");
  });

  test("the hub's own keys never take the file's value; the vault gets them as values", async () => {
    process.env.PARACHUTE_HUB_ORIGIN = "http://127.0.0.1:47001";
    const { p, values } = part({ PARACHUTE_HUB_ORIGIN: "https://old.example" });
    await p.start();
    expect(process.env.PARACHUTE_HUB_ORIGIN).toBe("http://127.0.0.1:47001");
    expect(values.at(-1)!.hubOrigin).toBe("https://old.example"); // a child saw its .env over the hub's environment
    p.setHub({ origin: "https://hub.example" });
    expect(values.at(-1)!.hubOrigin).toBe("https://hub.example"); // the hub's issuer over both
    expect(process.env.PARACHUTE_HUB_ORIGIN).toBe("http://127.0.0.1:47001");
  });
});
