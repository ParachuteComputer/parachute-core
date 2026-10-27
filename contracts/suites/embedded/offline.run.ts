// Run by offline.test.ts in a network of its own with its own trap (_lib.ts report({trap: true})): only what this
// script starts can move the counter. It reports the counter before and after; the assertions are in the test.
import { allowOrigins, newHome, outboundPackets, safeFetch } from "../candidate-lib.ts";
import { embeddedHome, mint, must, report, tail } from "./_lib.ts";

await report(
  async (input: { mode: "trap" | "loopback" | "embedded" }) => {
    const before = outboundPackets();
    if (input.mode === "trap") {
      // Positive control: a connection to a documentation address (RFC 5737) has to leave by the trap.
      allowOrigins("http://198.51.100.1:9");
      await safeFetch("http://198.51.100.1:9/", { signal: AbortSignal.timeout(1500) }).catch(() => undefined);
    } else if (input.mode === "loopback") {
      // Negative control: loopback traffic doesn't count.
      const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
      allowOrigins(`http://127.0.0.1:${s.port}`);
      for (let i = 0; i < 5; i++) await (await safeFetch(`http://127.0.0.1:${s.port}/`)).text();
      s.stop(true);
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
