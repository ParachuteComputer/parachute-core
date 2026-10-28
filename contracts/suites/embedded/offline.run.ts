// Run by offline.test.ts in a network of its own with its own trap (_lib.ts report({trap: true})): only what this
// script starts can move the counter. It reports the counter before and after; the assertions are in the test.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { allowOrigins, freePort, newHome, outboundPackets, safeFetch } from "../candidate-lib.ts";
import { embeddedHome, json, mint, must, report, tail } from "./_lib.ts";
import { binaries, run, serveBox } from "./_stock.ts";

/** A documentation address (RFC 5737): nothing answers, so a connection to it can only leave by the trap. */
const OFF_MACHINE = "http://198.51.100.1:9";

await report(
  async (input: { mode: "trap" | "loopback" | "embedded" | "box"; offline?: boolean }) => {
    const before = outboundPackets();
    if (input.mode === "trap") {
      // Positive control: a connection to a documentation address has to leave by the trap.
      allowOrigins(OFF_MACHINE);
      await safeFetch(`${OFF_MACHINE}/`, { signal: AbortSignal.timeout(1500) }).catch(() => undefined);
    } else if (input.mode === "loopback") {
      // Negative control: loopback traffic doesn't count.
      const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
      allowOrigins(`http://127.0.0.1:${s.port}`);
      for (let i = 0; i < 5; i++) await (await safeFetch(`http://127.0.0.1:${s.port}/`)).text();
      s.stop(true);
    } else if (input.mode === "box") {
      // A box whose vault has a webhook trigger off the machine, with or without `serve --offline`. A write that
      // matches the trigger calls the webhook online (the trap counts it) and doesn't offline.
      const info = await binaries();
      const home = newHome("offline");
      const port = await freePort();
      // The vault the hub starts fetches keys from :1939 whatever the hub's port (fix 1, lane C), so say where.
      const origin = `http://127.0.0.1:${port}`;
      const env = { PORT: String(port), PARACHUTE_HUB_ORIGIN: origin, PARACHUTE_HUB_JWKS_ORIGIN: origin, EMBEDDINGS_ENABLED: "false" };
      const made = await run(info, home, ["create", "boxo", "--no-mirror", "--json"], env, true);
      must(made.code === 0, `setup: parachute-vault create exited ${made.code}: ${tail(made.stderr)}`);
      appendFileSync(
        join(home, "vault", "config.yaml"),
        `triggers:\n  - name: offline-probe\n    when:\n      tags: [probe]\n    action:\n      webhook: ${OFF_MACHINE}/hook\n      timeout: 1500\n`,
      );
      // Counted from before serve starts to after it stops, so a call at start or at stop counts too.
      const box = await serveBox(info, home, "boxo", env, input.offline ? ["--offline"] : []);
      let offlineLogged = false;
      try {
        const rot = await run(info, home, ["auth", "rotate-operator"], env);
        must(rot.code === 0, `setup: auth rotate-operator exited ${rot.code}: ${tail(rot.stderr)}`);
        const m = await run(info, home, ["auth", "mint-token", "--scope", "vault:boxo:write", "--ephemeral", "--json"], env);
        const token = json(m.stdout)?.token;
        must(m.code === 0 && typeof token === "string", `setup: auth mint-token --json exited ${m.code}: ${tail(m.stderr)}`);
        const w = await safeFetch(`${box.hub}/vault/boxo/api/notes`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ content: "made-up note for the probe", path: "offline/probe", tags: ["probe"] }),
        });
        must(w.status === 201, `a write failed: HTTP ${w.status} ${tail(await w.text(), 200)}`);
        await Bun.sleep(3000); // the trigger fires after the write returns
        offlineLogged = /offline: not calling/.test(box.log());
      } finally {
        await box.stop();
      }
      return { before, after: outboundPackets(), offlineLogged };
    } else {
      // Start, bootstrap, a mint, a write and a stop, with no --offline flag: embedded is offline by default.
      const home = newHome("offline");
      const e = await embeddedHome(home);
      try {
        const t = await mint(home, `vault:${e.vaultName}:write`);
        const w = await safeFetch(`${e.vault}/vault/${e.vaultName}/api/notes`, {
          method: "POST",
          headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json" },
          body: JSON.stringify({ content: "made-up note [[elsewhere]] https://example.test/x", path: "offline/one", tags: ["offline"] }),
        });
        must(w.status === 201, `a write failed: HTTP ${w.status} ${tail(await w.text(), 200)}`);
        await Bun.sleep(3000); // give anything a write triggers (webhooks, mirrors, embeddings) time to try
      } finally {
        must((await e.stop()) === 0, `serve --embedded did not stop cleanly: ${tail(e.log())}`);
      }
    }
    return { before, after: outboundPackets() };
  },
  { trap: true },
);
