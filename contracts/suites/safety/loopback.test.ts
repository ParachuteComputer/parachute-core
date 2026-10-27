// Fix 2: `parachute serve` listens on loopback only, unless told otherwise; so does the vault.
//
// Today the hub binds `PARACHUTE_BIND_HOST || "0.0.0.0"` (hub src/commands/serve.ts:629-632), so a plain
// `parachute serve` on a laptop answers on every interface. The vault already defaults to 127.0.0.1 unless
// VAULT_BIND says otherwise (vault src/bind.ts resolveBindHostname). The hub's container files set
// PARACHUTE_BIND_HOST=0.0.0.0 explicitly (PLAN §2.3), so the escape hatch must keep working. PLAN §2.3, §5 fix 2,
// §7.5 mutant "binds: 0.0.0.0". Lane C.
//
// Each test starts its own process in a fresh home (candidate-lib start()), with PORT set and no bind setting,
// and reads the listening sockets from /proc inside the sandbox (no connection tricks).
import { afterAll, describe, expect, test } from "bun:test";
import { freePort, listeners, newHome, start, until, type Served } from "../candidate-lib.ts";
import { must, red } from "../lib.ts";

const started: Served[] = [];
afterAll(async () => {
  await Promise.all(started.map((p) => p.stop()));
});

/** Start `parachute serve` (or `parachute-vault serve`) on a fresh port; return the addresses it listens on. */
async function serve(opts: { vault?: boolean; env?: Record<string, string> } = {}): Promise<{ port: number; addrs: string[]; log: () => string }> {
  const home = newHome(opts.vault ? "vault-bind" : "hub-bind");
  const port = await freePort();
  const p = start(home, ["serve"], { vault: opts.vault, env: { PORT: String(port), EMBEDDINGS_ENABLED: "false", ...opts.env } });
  started.push(p);
  const on = () => listeners().filter((l) => l.endsWith(`:${port}`));
  const up = await until(() => on().length > 0, 45_000);
  if (!up) throw new Error(`setup: ${opts.vault ? "parachute-vault" : "parachute"} serve never listened on ${port}\n${p.log().slice(-1500)}`);
  await Bun.sleep(300); // a second socket (IPv6) would be bound by now
  return { port, addrs: on(), log: p.log };
}

const loopback = (addr: string) => addr.startsWith("127.0.0.1:") || addr.startsWith("[::1]:");

describe("loopback by default (fix 2)", () => {
  test("setup works today: `parachute serve` in a fresh home starts and listens on PORT", async () => {
    const { addrs } = await serve();
    expect(addrs.length).toBeGreaterThan(0);
  });

  red("`parachute serve` with no PARACHUTE_BIND_HOST and no --listen binds 127.0.0.1 only", { reason: /parachute serve listens beyond loopback: (0\.0\.0\.0|\[::\])/, lane: "C" }, async () => {
    const { addrs } = await serve();
    must(addrs.every(loopback), `parachute serve listens beyond loopback: ${addrs.join(" ")}`);
  });

  test("PARACHUTE_BIND_HOST=0.0.0.0 still binds every interface (the containers' escape hatch)", async () => {
    const { port, addrs } = await serve({ env: { PARACHUTE_BIND_HOST: "0.0.0.0" } });
    expect(addrs).toContain(`0.0.0.0:${port}`);
  });

  test("`parachute-vault serve` with no VAULT_BIND binds 127.0.0.1 only", async () => {
    const { addrs } = await serve({ vault: true });
    expect(addrs.filter((a) => !loopback(a))).toEqual([]);
  });
});
