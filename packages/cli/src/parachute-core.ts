#!/usr/bin/env bun
// `parachute-core`: the same program as `parachute`, under its other name (front.ts, dispatch.ts).
import { dispatch } from "./dispatch.ts";
import { frontDoor } from "./front.ts";

const door = frontDoor(process.argv.slice(2));
process.argv = [process.argv[0]!, process.argv[1]!, ...door.argv];
await dispatch("core", door.notice);
