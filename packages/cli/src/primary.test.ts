// Which role `parachute <argv>` runs as (primary.ts). The hub's 0.7 commands must stay the hub's, exactly: Prism and
// Benjamin's suite call them through `parachute`. Only what 0.7 had no meaning for goes to core.
import { describe, expect, test } from "bun:test";
import { namesModule, primaryRole } from "./primary.ts";

describe("parachute: which role a command runs as", () => {
  test("install without a module name is core's own install", () => {
    for (const argv of [["install"], ["install", "--prefix", "/x/vault"], ["install", "--prefix=/x"]]) {
      expect({ argv, role: primaryRole(argv) }).toEqual({ argv, role: "core" });
    }
  });

  test("install with a module name, or install --help, is the hub's module installer, as in 0.7", () => {
    for (const argv of [["install", "vault"], ["install", "all"], ["install", "--help"], ["install", "-h"], ["install", "--tag", "rc", "vault"], ["install", "--channel", "rc", "scribe", "--no-start"]]) {
      expect({ argv, role: primaryRole(argv) }).toEqual({ argv, role: "hub" });
    }
  });

  test("every other command is the hub's: serve, bootstrap, auth, vault, version, help", () => {
    for (const argv of [[], ["help"], ["--help"], ["serve", "--embedded"], ["bootstrap", "--embedded", "--json"], ["auth", "mint-token", "--json"], ["vault", "create", "x"], ["vault", "remove", "x"], ["version", "--json"], ["--version"]]) {
      expect({ argv, role: primaryRole(argv) }).toEqual({ argv, role: "hub" });
    }
  });

  test("takeover is core's", () => {
    expect(primaryRole(["takeover", "--dry-run"])).toBe("core");
  });

  test("a value flag's value is not a module name", () => {
    expect(namesModule(["--prefix", "vault"])).toBe(false);
    expect(namesModule(["--tag", "rc"])).toBe(false);
    expect(namesModule(["--no-start", "vault"])).toBe(true);
  });
});
