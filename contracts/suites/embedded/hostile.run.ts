// Run by hostile-local.test.ts in a network of its own (_lib.ts inOwnNetwork), so routes that stop or restart
// modules can be probed without touching the suite's own box. A box install of the candidate on a random port;
// it reports which admin routes a loopback caller reached with each credential. Assertions are in the test.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { candidate, freePort, newHome, safeFetch } from "../candidate-lib.ts";
import { claims, must, report, tail } from "./_lib.ts";
import { binaries, run, serveBox } from "./_stock.ts";
import { effects, forged, notRefused } from "./_hostile.ts";

const VAULT = "hostile";

await report(async () => {
  const info = await binaries();
  const home = newHome("hostile");
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = { PORT: String(port), PARACHUTE_HUB_ORIGIN: origin, EMBEDDINGS_ENABLED: "false" };
  const made = await run(info, home, ["create", VAULT, "--no-mirror", "--json"], env, true);
  must(made.code === 0, `setup: parachute-vault create exited ${made.code}: ${tail(made.stderr)}`);
  if (candidate().profile === "stock-0.7") {
    // The same workarounds the candidate adapter needs for stock 0.7 (fix 1; harness/candidate.ts), so the tokens
    // below are valid and a refusal means "not enough", not "wrong issuer".
    mkdirSync(join(home, "hub", "run"), { recursive: true });
    writeFileSync(join(home, "hub", "run", "hub.port"), `${port}\n`);
    env.PARACHUTE_HUB_JWKS_ORIGIN = origin;
  }
  const box = await serveBox(info, home, VAULT, env);
  try {
    const rot = await run(info, home, ["auth", "rotate-operator"], env);
    must(rot.code === 0, `setup: rotate-operator exited ${rot.code}: ${tail(rot.stderr)}`);
    const operator = readFileSync(join(home, "operator.token"), "utf8").trim();
    const jti = claims(operator)?.jti as string;
    const mint = async (scope: string) => {
      const m = await run(info, home, ["auth", "mint-token", "--scope", scope, "--ephemeral"], env);
      must(m.code === 0, `setup: mint-token ${scope} exited ${m.code}: ${tail(m.stderr)}`);
      return m.stdout.trim().split("\n").pop()!.trim();
    };
    const read = await mint(`vault:${VAULT}:read`);
    const write = await mint(`vault:${VAULT}:write`);
    const vaultAdmin = await mint(`vault:${VAULT}:read vault:${VAULT}:write vault:${VAULT}:admin`);

    // Positive controls: the operator token works on an admin route, and the write token reads notes.
    const opModules = await safeFetch(`${box.hub}/api/modules`, { headers: { authorization: `Bearer ${operator}` } });
    const wRead = await safeFetch(`${box.hub}/vault/${VAULT}/api/notes?limit=1`, { headers: { authorization: `Bearer ${write}` } });

    const result = {
      controls: { operatorOnModules: opModules.status, writeReadsNotes: wRead.status },
      notRefused: {
        none: await notRefused(box.hub, VAULT, jti, undefined),
        read: await notRefused(box.hub, VAULT, jti, read),
        write: await notRefused(box.hub, VAULT, jti, write),
        // A vault admin may set tag schemas on its own vault; everything else here is the host's.
        vaultAdmin: (await notRefused(box.hub, VAULT, jti, vaultAdmin)).filter((l) => !l.includes(`/vault/${VAULT}/api/tags/`)),
        forgedOperator: await notRefused(box.hub, VAULT, jti, forged(operator)),
      },
    };
    return { ...result, effects: await effects(box.hub, box.hub, VAULT, operator, write) };
  } finally {
    await box.stop();
  }
});
