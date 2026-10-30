#!/usr/bin/env bun
// `parachute`, the command (primary.ts): the 0.9 front door (front.ts) over the hub's 0.7 commands and what only
// v0.8 has. See dispatch.ts.
import { dispatch } from "./dispatch.ts";
import { frontDoor } from "./front.ts";
import { isHelp, primaryHelp, primaryRole } from "./primary.ts";

const argv = process.argv.slice(2);
// `parachute help` is the front door's (dispatch answers it after the home's checks, as help always was);
// `help --all` adds every command today's names answer, as 0.8's help did.
if (isHelp(argv) && argv.includes("--all")) console.log(primaryHelp());
const door = frontDoor(argv);
process.argv = [process.argv[0]!, process.argv[1]!, ...door.argv];
await dispatch(primaryRole(door.argv), door.notice);
