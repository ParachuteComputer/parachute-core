// `bun run doors:keep <label>`: keep the last run's fingerprint of one door as the golden one
// (suites/door/golden/<label>.jsonl). Run it when a door's behaviour changed on purpose, and commit the file: its
// diff is the change every other door is now held to.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const contracts = resolve(import.meta.dir, "..", "..");
const label = process.argv[2];
const from = join(resolve(process.env.DOOR_RESULTS ?? join(contracts, ".cache", "doors")), label ?? "", "golden.jsonl");
if (!label || !existsSync(from)) {
  console.error(`usage: bun run doors:keep <label>   (no run found at ${from}; set DOOR_RESULTS to the run's folder)`);
  process.exit(2);
}
const to = join(contracts, "suites", "door", "golden", `${label}.jsonl`);
mkdirSync(join(contracts, "suites", "door", "golden"), { recursive: true });
copyFileSync(from, to);
console.log(`kept ${to}`);
