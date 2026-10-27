// `bun run today`: start a throwaway hub + vault from the pinned commits, run the contracts, stop, clean up.
//
//   bun run today                 the `today` contracts (must pass)
//   bun run today -- --v1         also the `v1` contracts (decided behaviour today's code lacks; marked failing)
//   bun run today -- --keep       keep the temp home for a look afterwards
//   bun run today -- suites/today/notes.test.ts   only that file; other extra args go to `bun test`
//
// To run against services you started yourself, skip this file: write a services JSON (see harness/services.ts,
// `Services`) and run `CONTRACT_SERVICES=<file> bun test suites/today`.
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { startServices, stopAll } from "./services.ts";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const v1 = args.includes("--v1");
const extra = args.filter((a) => a !== "--keep" && a !== "--v1");

const contracts = join(import.meta.dir, "..");
// Installed before anything starts, so an interrupt during startup still stops the services and removes the home.
let child: ReturnType<typeof Bun.spawn> | null = null;
const onSignal = async () => {
  child?.kill();
  await stopAll();
  process.exit(130);
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
const t0 = Date.now();
const running = await startServices({ keep });
const s = running.services;
console.log(`[contracts] hub ${s.hub}, vault "${s.vaultName}" at ${s.vaultDirect} (${Date.now() - t0} ms)`);

const servicesFile = join(s.home, "..", "..", "services-for-contracts.json");
writeFileSync(servicesFile, JSON.stringify(s));

let code = 1;
try {
  // Named suite files replace the default set; anything else is passed to `bun test` as is.
  const named = extra.filter((a) => a.startsWith("suites/"));
  const dirs = named.length ? named : ["suites/today", ...(v1 ? ["suites/v1"] : [])];
  const rest = extra.filter((a) => !a.startsWith("suites/"));
  const p = (child = Bun.spawn(["bun", "test", "--timeout", "60000", ...dirs.map((d) => `./${d}`), ...rest], {
    cwd: contracts,
    env: { ...process.env, CONTRACT_SERVICES: servicesFile },
    stdout: "inherit",
    stderr: "inherit",
  }));
  code = await p.exited;
  if (code !== 0 && process.env.CONTRACT_SHOW_LOGS !== "0") {
    console.log("[contracts] failed; service log tail:\n" + (await running.logs()).slice(-4000));
  }
} finally {
  await running.stop();
}
console.log(`[contracts] services stopped${keep ? `; home kept at ${s.home}` : " and temp home removed"}`);
process.exit(code);
