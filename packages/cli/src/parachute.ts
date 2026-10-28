#!/usr/bin/env bun
// `parachute`, the command (primary.ts): the hub's 0.7 commands, plus what only v0.8 has. See dispatch.ts.
import { dispatch } from "./dispatch.ts";
import { isHelp, primaryHelp, primaryRole } from "./primary.ts";

const argv = process.argv.slice(2);
if (isHelp(argv)) console.log(primaryHelp());
await dispatch(primaryRole(argv));
