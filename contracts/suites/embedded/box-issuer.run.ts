// Run by issuer.test.ts in a network of its own (_lib.ts inOwnNetwork): a stock box on a non-default hub port, the
// way a person or Prism's stock mode starts one, with no PARACHUTE_HUB_JWKS_ORIGIN. It reports what a CLI-minted
// token says and whether the vault the hub started accepts it. The assertions are in issuer.test.ts.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { freePort, newHome, safeFetch } from "../candidate-lib.ts";
import { claims, must, report, tail } from "./_lib.ts";
import { binaries, run, serveBox } from "./_stock.ts";

await report(async (input: { hubPortFile: boolean }) => {
  const info = await binaries();
  const home = newHome("boxiss");
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PARACHUTE_HUB_ORIGIN: origin, EMBEDDINGS_ENABLED: "false" };
  const made = await run(info, home, ["create", "boxv", "--no-mirror", "--json"], env, true);
  must(made.code === 0, `setup: parachute-vault create exited ${made.code}: ${tail(made.stderr)}`);
  if (input.hubPortFile) {
    // Today's CLI takes its issuer from this file (hub src/hub-issuer.ts); writing it isolates the vault's side.
    mkdirSync(join(home, "hub", "run"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "hub", "run", "hub.port"), `${port}\n`, { mode: 0o600 });
  }
  const box = await serveBox(info, home, "boxv", env);
  try {
    const rot = await run(info, home, ["auth", "rotate-operator"], env);
    must(rot.code === 0, `setup: auth rotate-operator exited ${rot.code}: ${tail(rot.stderr)}`);
    const mint = await run(info, home, ["auth", "mint-token", "--scope", "vault:boxv:read", "--ephemeral"], env);
    must(mint.code === 0, `setup: auth mint-token exited ${mint.code}: ${tail(mint.stderr)}`);
    const token = mint.stdout.trim().split("\n").pop()!.trim();
    const r = await safeFetch(`${box.hub}/vault/boxv/api/notes?limit=1`, { headers: { authorization: `Bearer ${token}` } });
    return {
      origin,
      iss: claims(token)?.iss,
      status: r.status,
      body: (await r.text()).slice(0, 300),
      hubPortFile: existsSync(join(home, "hub", "run", "hub.port")),
    };
  } finally {
    await box.stop();
  }
});
