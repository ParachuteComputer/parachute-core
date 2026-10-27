import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { configDir } from "../config.ts";

describe("configDir", () => {
  test("honors PARACHUTE_HOME when set", () => {
    expect(configDir({ PARACHUTE_HOME: "/tmp/custom-parachute" })).toBe("/tmp/custom-parachute");
  });

  test("ignores empty PARACHUTE_HOME", () => {
    expect(configDir({ PARACHUTE_HOME: "" })).toBe(join(homedir(), ".parachute"));
  });

  test("falls back to ~/.parachute when unset", () => {
    expect(configDir({})).toBe(join(homedir(), ".parachute"));
  });
});
