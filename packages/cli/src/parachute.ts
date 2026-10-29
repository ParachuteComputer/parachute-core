#!/usr/bin/env bun
// `parachute`, the command (primary.ts): the 0.9 front door (front.ts) over the hub's 0.7 commands and what only
// v0.8 has. See dispatch.ts.
import { dispatch } from "./dispatch.ts";
import { frontDoor, frontHelp } from "./front.ts";
import { isHelp, primaryHelp, primaryRole } from "./primary.ts";

const argv = process.argv.slice(2);
if (isHelp(argv) && !argv.includes("--all")) {
  // The front door's help reads nothing from the home, like `version`.
  console.log(frontHelp());
  process.exit(0);
}
if (isHelp(argv)) console.log(primaryHelp());
const door = frontDoor(argv);
process.argv = [process.argv[0]!, process.argv[1]!, ...door.argv];
await dispatch(primaryRole(door.argv), door.notice);
