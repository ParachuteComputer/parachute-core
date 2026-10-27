// embedded/offline (PLAN §3 "Offline by default", §7.3 the network trap; Benjamin's E9): embedded mode makes no
// outbound connection: no update check, registry, model download, tunnel probe, Buzz poller or webhook. Proved by
// counting, not sampling: each case runs in a network of its own whose only way out is a dummy interface with an
// nftables counter on every non-loopback packet (the sandbox's trap, harness/sandbox.ts), so nothing else in the
// sandbox can move it. The trap itself is proven both ways: a connection to 198.51.100.1 moves the counter, and
// loopback traffic doesn't. (Benjamin's lsof sampler passes without looking on Linux, PLAN §3.1 R4.)
// Today there is no embedded mode. Lane B turns this green.
import { describe, expect, test } from "bun:test";
import { red } from "../lib.ts";
import { NO_EMBEDDED, inOwnNetwork, must } from "./_lib.ts";

describe("embedded/offline", () => {
  test("the trap counts: a connection attempt to a non-loopback address moves the counter", async () => {
    const r = await inOwnNetwork("offline.run.ts", { mode: "trap" });
    expect(r.after).toBeGreaterThan(r.before);
  });

  test("the trap is quiet for loopback: requests to a local server don't move the counter", async () => {
    const r = await inOwnNetwork("offline.run.ts", { mode: "loopback" });
    expect(r.after).toBe(r.before);
  });

  red("start, bootstrap, a write and a stop send no packet off the machine", { reason: NO_EMBEDDED, lane: "B" }, async () => {
    const r = await inOwnNetwork("offline.run.ts", { mode: "embedded" });
    must(r.after === r.before, `${r.after - r.before} packet(s) tried to leave by a non-loopback interface`);
  });
});
