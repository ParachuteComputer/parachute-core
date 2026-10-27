// embedded/issuer (PLAN §3 "Issuer", §5 fix 1; Benjamin's E6): the `iss` on every token the CLI mints is the
// hub's real origin, decided the same way every time, and the vault the hub starts verifies those tokens.
//   - PARACHUTE_HUB_ORIGIN set: it is the issuer, exactly, with no hub/run/hub.port file.
//   - not set (embedded): http://127.0.0.1:<hub port>, derived again on every start; earlier issuers stay accepted
//     through embedded.json `accepted_issuers`; ready.json reports `issuer`.
//   - embedded mode never reads expose-state.json or hub/run/hub.port.
//   - box mode too: a vault the hub starts must verify that hub's tokens on a non-default hub port without
//     PARACHUTE_HUB_JWKS_ORIGIN (today it fetches keys from :1939, vault src/hub-jwt.ts:23,63). Found while wiring
//     the candidate adapter, which needs that variable as a workaround (harness/candidate.ts).
// Today the CLI takes the issuer from expose-state, then hub.port, then :1939 (hub src/hub-issuer.ts:18-30) and
// ignores PARACHUTE_HUB_ORIGIN. Lane C turns these green.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { cli, freePort, newHome } from "../candidate-lib.ts";
import { red } from "../lib.ts";
import { NO_EMBEDDED, claims, embeddedHome, embeddedJson, inOwnNetwork, mint, must, readNotes, readyJson, serveEmbedded, tail } from "./_lib.ts";

/** A first hub account, the way a box makes one from a script (stock `auth set-password` takes --password off a TTY). */
const firstUser = (home: string, env?: Record<string, string>) =>
  cli(home, ["auth", "set-password", "--username", "owner", "--password", `pw-${randomBytes(12).toString("hex")}`], { env });

const operatorIss = (home: string) => claims(readFileSync(join(home, "operator.token"), "utf8").trim())?.iss;

describe("embedded/issuer", () => {
  test("setup works today: auth rotate-operator writes a signed operator token in a fresh home", async () => {
    const home = newHome("iss");
    expect((await firstUser(home)).code).toBe(0);
    const r = await cli(home, ["auth", "rotate-operator"]);
    expect(r.code).toBe(0);
    expect(operatorIss(home)).toStartWith("http://");
  });

  red(
    "with PARACHUTE_HUB_ORIGIN set, rotate-operator and mint-token sign with exactly that iss, and no hub.port is read or written",
    { reason: /iss is http:\/\/127\.0\.0\.1:1939, want http:\/\/127\.0\.0\.1:\d+/, lane: "C" },
    async () => {
      const home = newHome("iss");
      const origin = `http://127.0.0.1:${await freePort()}`;
      const env = { PARACHUTE_HUB_ORIGIN: origin };
      const user = await firstUser(home, env);
      must(user.code === 0, `setup: auth set-password exited ${user.code}: ${tail(user.stderr)}`);
      const rot = await cli(home, ["auth", "rotate-operator"], { env });
      must(rot.code === 0, `rotate-operator exited ${rot.code}: ${tail(rot.stderr)}`);
      must(operatorIss(home) === origin, `operator.token iss is ${operatorIss(home)}, want ${origin}`);
      const m = await cli(home, ["auth", "mint-token", "--scope", "vault:default:read", "--ephemeral"], { env });
      must(m.code === 0, `mint-token exited ${m.code}: ${tail(m.stderr)}`);
      const iss = claims(m.stdout.trim().split("\n").pop()!)?.iss;
      must(iss === origin, `mint-token iss is ${iss}, want ${origin}`);
      must(!existsSync(join(home, "hub", "run", "hub.port")), "hub/run/hub.port was written");
    },
  );

  red(
    "embedded, PARACHUTE_HUB_ORIGIN set: ready.json, embedded.json and every minted token carry exactly it, and the vault accepts them",
    { reason: NO_EMBEDDED, lane: "C" },
    async () => {
      const home = newHome("iss");
      const hubPort = await freePort();
      // Any origin the host chooses; not the port it listens on.
      const origin = `http://127.0.0.1:${await freePort([hubPort])}`;
      const env = { PARACHUTE_HUB_ORIGIN: origin };
      const e = await embeddedHome(home, { hubPort, env });
      try {
        must(readyJson(home)?.issuer === origin, `ready.json issuer is ${readyJson(home)?.issuer}, want ${origin}`);
        must(operatorIss(home) === origin, `operator.token iss is ${operatorIss(home)}, want ${origin}`);
        const t = await mint(home, `vault:${e.vaultName}:read`, ["--ephemeral"], env);
        must(claims(t.token)?.iss === origin, `mint-token iss is ${claims(t.token)?.iss}, want ${origin}`);
        const got = await readNotes(e.vault, e.vaultName, t.token);
        must(got.status === 200, `the vault refused the hub's own token: HTTP ${got.status} ${got.text}`);
        must(!existsSync(join(home, "hub", "run", "hub.port")), "hub/run/hub.port was written");
      } finally {
        await e.stop();
      }
    },
  );

  red(
    "embedded, no PARACHUTE_HUB_ORIGIN: the issuer is http://127.0.0.1:<hub port> on every start, and tokens from an earlier port still verify",
    { reason: NO_EMBEDDED, lane: "C" },
    async () => {
      const home = newHome("iss");
      const first = await embeddedHome(home);
      const firstIss = `http://127.0.0.1:${first.hubPort}`;
      let old: string;
      try {
        must(readyJson(home)?.issuer === firstIss, `ready.json issuer is ${readyJson(home)?.issuer}, want ${firstIss}`);
        old = (await mint(home, `vault:${first.vaultName}:read`)).token;
        must(claims(old)?.iss === firstIss, `mint-token iss is ${claims(old)?.iss}, want ${firstIss}`);
      } finally {
        must((await first.stop()) === 0, "the first serve did not stop cleanly");
      }

      const second = await serveEmbedded(home);
      try {
        const nowIss = `http://127.0.0.1:${second.hubPort}`;
        must(readyJson(home)?.issuer === nowIss, `after a restart on another port, ready.json issuer is ${readyJson(home)?.issuer}, want ${nowIss}`);
        const fresh = await mint(home, `vault:${first.vaultName}:read`);
        must(claims(fresh.token)?.iss === nowIss, `after a restart, mint-token iss is ${claims(fresh.token)?.iss}, want ${nowIss}`);
        const accepted = embeddedJson(home)?.accepted_issuers ?? [];
        must(accepted.includes(firstIss), `embedded.json accepted_issuers ${JSON.stringify(accepted)} lacks the earlier ${firstIss}`);
        const oldRead = await readNotes(second.vault, first.vaultName, old);
        must(oldRead.status === 200, `a token from the earlier port was refused: HTTP ${oldRead.status} ${oldRead.text}`);
        const newRead = await readNotes(second.vault, first.vaultName, fresh.token);
        must(newRead.status === 200, `a token from this start was refused: HTTP ${newRead.status} ${newRead.text}`);
      } finally {
        await second.stop();
      }
    },
  );

  red(
    "embedded never reads expose-state.json or hub/run/hub.port, and leaves them as they were",
    { reason: NO_EMBEDDED, lane: "C" },
    async () => {
      const home = newHome("iss");
      // Made-up leftovers from a box install: a public origin and a stale port.
      mkdirSync(join(home, "hub", "run"), { recursive: true, mode: 0o700 });
      const exposeState = JSON.stringify({ hubOrigin: "https://planted.example.test", canonicalFqdn: "planted.example.test" });
      writeFileSync(join(home, "expose-state.json"), exposeState, { mode: 0o600 });
      writeFileSync(join(home, "hub", "run", "hub.port"), "47001\n", { mode: 0o600 });
      const e = await embeddedHome(home);
      try {
        const want = `http://127.0.0.1:${e.hubPort}`;
        must(readyJson(home)?.issuer === want, `ready.json issuer is ${readyJson(home)?.issuer}, want ${want}`);
        must(operatorIss(home) === want, `operator.token iss is ${operatorIss(home)}, want ${want}`);
        const t = await mint(home, `vault:${e.vaultName}:read`);
        must(claims(t.token)?.iss === want, `mint-token iss is ${claims(t.token)?.iss}, want ${want}`);
        must(readFileSync(join(home, "expose-state.json"), "utf8") === exposeState, "expose-state.json changed");
        must(readFileSync(join(home, "hub", "run", "hub.port"), "utf8") === "47001\n", "hub/run/hub.port changed");
      } finally {
        await e.stop();
      }
    },
  );

  red(
    "box: on a non-default hub port with only PARACHUTE_HUB_ORIGIN set (no hub.port, no JWKS env), the CLI's tokens verify at the vault the hub started",
    { reason: /iss is http:\/\/127\.0\.0\.1:1939, want http:\/\/127\.0\.0\.1:\d+/, lane: "C" },
    async () => {
      const r = await inOwnNetwork("box-issuer.run.ts", { hubPortFile: false });
      must(!r.hubPortFile, "hub/run/hub.port was written");
      must(r.iss === r.origin, `mint-token iss is ${r.iss}, want ${r.origin}`);
      must(r.status === 200, `the vault refused a token its own hub signed: HTTP ${r.status} ${r.body}`);
    },
  );

  red(
    "box: a vault the hub starts verifies that hub's tokens on a non-default hub port without PARACHUTE_HUB_JWKS_ORIGIN",
    { reason: /the vault refused a token its own hub signed: HTTP 401/, lane: "C" },
    async () => {
      // hub.port is written so today's CLI signs with the right iss; what's left is where the vault gets the keys.
      const r = await inOwnNetwork("box-issuer.run.ts", { hubPortFile: true });
      must(r.iss === r.origin, `setup: mint-token iss is ${r.iss}, want ${r.origin}`);
      must(r.status === 200, `the vault refused a token its own hub signed: HTTP ${r.status} ${r.body}`);
    },
  );
});
