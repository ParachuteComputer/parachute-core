// No `pvk_` key on first boot (0.9.1, T-446; changes-0.9.json "pvk_ YAML API keys": dropped, refused at 1.0).
//
// Until 0.9.1 a first boot that named its vault (PARACHUTE_VAULT_NAME: the setup wizard's vault step, a container, a
// Render Blueprint) wrote a write-level `pvk_` key into both vault.yaml and the server-wide config.yaml, and
// `parachute-vault serve` printed it in full to its log. Nobody needs it: the box's owner signs in with the account
// (or the owner key, #49) and connects apps by OAuth or named keys; a standalone vault takes VAULT_AUTH_TOKEN or a
// hub-signed token. So a fresh home holds no `pvk_` key, the log prints none, and the way in still works.
//
// The first boot here is the vault program's own (`parachute-vault serve`): the box's `parachute serve` runs the same
// first-boot code when the wizard starts its vault (packages/cli/src/serve.ts → firstBootCreate). `parachute-vault
// create` (what `parachute init --vault-name` and bootstrap run) made no key before either; it is pinned too.
//
// Candidate only (safety/). Each test uses its own fresh home. A key is stored hashed, so "no key" is read as "no
// api_keys entry with a key_hash" in any YAML file of the home.
import { afterAll, describe, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { allowOrigins, cli, freePort, newHome, safeFetch, start, until, type Served } from "../candidate-lib.ts";
import { must } from "../lib.ts";

const VAULT = "fernhill";
const started: Served[] = [];
afterAll(async () => {
  await Promise.all(started.map((p) => p.stop()));
});

/** Every YAML file under the home that holds a stored key (a `key_hash:` line), with how many. */
function keyFiles(home: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ya?ml$/.test(name)) {
        const n = (readFileSync(p, "utf8").match(/^\s*-?\s*key_hash:/gm) ?? []).length;
        if (n > 0) found.push(`${p.slice(home.length + 1)} (${n})`);
      }
    }
  };
  if (existsSync(home)) walk(home);
  return found;
}

/** `parachute-vault serve` in a fresh home that names its first vault; returns once the vault exists and answers. */
async function firstBoot(env: Record<string, string> = {}): Promise<{ home: string; port: number; log: () => string }> {
  const home = newHome("first-boot");
  const port = await freePort();
  const p = start(home, ["serve"], { vault: true, env: { PORT: String(port), EMBEDDINGS_ENABLED: "false", PARACHUTE_VAULT_NAME: VAULT, ...env } });
  started.push(p);
  const made = await until(() => existsSync(join(home, "vault", "data", VAULT, "vault.yaml")), 45_000);
  must(made, `setup: first boot never made the vault ${VAULT}: ${p.log().slice(-1500)}`);
  allowOrigins(`http://127.0.0.1:${port}`);
  const up = await until(async () => (await safeFetch(`http://127.0.0.1:${port}/health`)).ok, 45_000);
  must(up, `setup: serve never answered /health on ${port}: ${p.log().slice(-1500)}`);
  return { home, port, log: p.log };
}

describe("first boot mints no pvk_ key", () => {
  test("first boot naming its vault: no key in vault.yaml or config.yaml, none printed", async () => {
    const b = await firstBoot();
    const keys = keyFiles(b.home);
    must(keys.length === 0, `first boot left a pvk_ key in: ${keys.join(", ")}`);
    must(!/API key:|pvk_/.test(b.log()), `first boot logged a key: ${b.log().match(/.*(API key:|pvk_).*/)?.[0]}`);
  });

  test("the way in still works: VAULT_AUTH_TOKEN reads the new vault, and no bearer is refused", async () => {
    const token = `contracts-operator-${crypto.randomUUID()}`;
    const b = await firstBoot({ VAULT_AUTH_TOKEN: token });
    const url = `http://127.0.0.1:${b.port}/vault/${VAULT}/api/notes?limit=1`;
    const none = await safeFetch(url);
    must(none.status === 401, `no bearer: ${none.status}, want 401`);
    const ok = await safeFetch(url, { headers: { authorization: `Bearer ${token}` } });
    must(ok.status === 200, `VAULT_AUTH_TOKEN: ${ok.status}, want 200: ${(await ok.text()).slice(0, 200)}`);
  });

  test("`parachute-vault create` (init's and bootstrap's way) makes no key either", async () => {
    const home = newHome("first-create");
    const r = await cli(home, ["create", VAULT, "--no-mirror"], { vault: true, env: { EMBEDDINGS_ENABLED: "false" } });
    must(r.code === 0, `setup: parachute-vault create gave ${r.code}: ${(r.stderr ?? "").slice(-400)}`);
    const keys = keyFiles(home);
    must(keys.length === 0, `create left a pvk_ key in: ${keys.join(", ")}`);
  });
});
