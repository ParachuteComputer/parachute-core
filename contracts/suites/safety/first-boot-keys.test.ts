// No `pvk_` key on first boot (0.9.1, T-446; changes-0.9.json "pvk_ YAML API keys": stop minting in 0.9).
//
// Until 0.9.1 a first boot that named its vault (PARACHUTE_VAULT_NAME, as the setup wizard, a container or a Render
// Blueprint sets it) wrote a write-level `pvk_` key into both vault.yaml and the server-wide config.yaml, and
// `parachute-vault serve` printed it in full to its log. Nobody needs it: the box's owner signs in with the account
// (or the owner key, #49) and connects apps by OAuth or named keys; a standalone vault takes VAULT_AUTH_TOKEN or a
// hub-signed token. So a fresh home holds no `pvk_` key, the log prints none, and the way in still works.
//
// Candidate only (safety/). Each test starts its own process in a fresh home and reads the home's files after the
// first-boot vault exists. A key is stored hashed, so "no key" is read as "no api_keys entry with a key_hash".
import { afterAll, describe, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { freePort, newHome, safeFetch, start, until, allowOrigins, type Served } from "../candidate-lib.ts";
import { must } from "../lib.ts";

const VAULT = "fernhill";
const started: Served[] = [];
afterAll(async () => {
  await Promise.all(started.map((p) => p.stop()));
});

/** Every YAML file under the home that holds a stored key (a `key_hash:` line), with the line's count. */
function keyFiles(home: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.ya?ml$/.test(name)) {
        const n = (readFileSync(p, "utf8").match(/^\s*-?\s*key_hash:/gm) ?? []).length;
        if (n > 0) found.push(`${p.slice(home.length + 1)} (${n})`);
      }
    }
  };
  walk(home);
  return found;
}

async function firstBoot(opts: { vault: boolean; env?: Record<string, string> }): Promise<{ home: string; port: number; log: () => string }> {
  const home = newHome(opts.vault ? "first-boot-vault" : "first-boot-box");
  const port = await freePort();
  const p = start(home, ["serve"], { vault: opts.vault, env: { PORT: String(port), EMBEDDINGS_ENABLED: "false", PARACHUTE_VAULT_NAME: VAULT, ...opts.env } });
  started.push(p);
  const made = await until(() => existsSync(join(home, "vault", "data", VAULT, "vault.yaml")), 45_000);
  must(made, `setup: first boot never made the vault ${VAULT}: ${p.log().slice(-1500)}`);
  allowOrigins(`http://127.0.0.1:${port}`);
  const up = await until(async () => (await safeFetch(`http://127.0.0.1:${port}/health`)).ok, 45_000);
  must(up, `setup: serve never answered /health on ${port}: ${p.log().slice(-1500)}`);
  return { home, port, log: p.log };
}

describe("first boot mints no pvk_ key", () => {
  test("`parachute serve` naming its first vault: no key in vault.yaml or config.yaml, none in the log", async () => {
    const b = await firstBoot({ vault: false, env: { PARACHUTE_INITIAL_ADMIN_USERNAME: "owner", PARACHUTE_INITIAL_ADMIN_PASSWORD: "fernhill-owner-passphrase" } });
    const keys = keyFiles(b.home);
    must(keys.length === 0, `first boot left a pvk_ key in: ${keys.join(", ")}`);
    must(!/API key:|pvk_/.test(b.log()), `first boot logged a key: ${b.log().match(/.*(API key:|pvk_).*/)?.[0]}`);
  });

  test("`parachute-vault serve` (a standalone vault, as a container runs it): no key stored, none printed", async () => {
    const b = await firstBoot({ vault: true });
    const keys = keyFiles(b.home);
    must(keys.length === 0, `first boot left a pvk_ key in: ${keys.join(", ")}`);
    must(!/API key:|pvk_/.test(b.log()), `first boot logged a key: ${b.log().match(/.*(API key:|pvk_).*/)?.[0]}`);
  });

  test("the standalone vault's way in still works: VAULT_AUTH_TOKEN reads the new vault, and no bearer is refused", async () => {
    const token = `contracts-operator-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    const b = await firstBoot({ vault: true, env: { VAULT_AUTH_TOKEN: token } });
    const url = `http://127.0.0.1:${b.port}/vault/${VAULT}/api/notes?limit=1`;
    const none = await safeFetch(url);
    must(none.status === 401, `no bearer: ${none.status}, want 401`);
    const ok = await safeFetch(url, { headers: { authorization: `Bearer ${token}` } });
    must(ok.status === 200, `VAULT_AUTH_TOKEN: ${ok.status}, want 200: ${(await ok.text()).slice(0, 200)}`);
  });
});
