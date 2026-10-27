// embedded/rollback (PLAN §3 "Adopting an existing stock home in place", §7.4 `embedded/*`): a stock home opened
// with `serve --embedded` can go back to stock 0.7.19, keeping every write made since, and both Prism's old
// token and a token minted while embedded still verify. The scenario is in rollback.run.ts (it runs in a network
// of its own, because stock puts its vault on :1940, which the suite's own box holds in the sandbox).
// Red today at the embedded step: `serve` takes no --embedded. Lane E turns it green.
import { describe, expect, test } from "bun:test";
import { red } from "../lib.ts";
import { NO_EMBEDDED, inOwnNetwork } from "./_lib.ts";

describe("embedded/rollback", () => {
  test("setup works today: stock 0.7 makes a home, restarts on it, and its token still reads the note", async () => {
    expect(await inOwnNetwork("rollback.run.ts", { stockOnly: true })).toEqual({ ok: true });
  });

  red(
    "stock home → serve --embedded (write, mint) → stock again: stock reads and updates what embedded wrote, and both tokens verify",
    { reason: NO_EMBEDDED, lane: "E" },
    async () => {
      await inOwnNetwork("rollback.run.ts", {});
    },
  );
});
