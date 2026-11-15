// What `parachute upgrade` accepts (upgrade.ts parseUpgrade). It is read before anything touches the home, so what
// it lets through is what reaches the step (the backup, the record): the hub's own forms must still pass, rebuilt
// so the hub's parser can't refuse them afterwards, and nothing else. The refusals themselves, and whether the hub
// finds the service named, are the contract's (lifecycle/upgrade: exit 2, the home byte for byte).
import { describe, expect, test } from "bun:test";
import { parseUpgrade } from "./upgrade.ts";

describe("parachute upgrade: what it was asked", () => {
  test("the forms it has", () => {
    expect(parseUpgrade(["--check"])).toEqual({ kind: "check", json: false });
    expect(parseUpgrade(["--json", "--check"])).toEqual({ kind: "check", json: true });
    expect(parseUpgrade(["--rollback", "--restore", "--yes", "--json"]).kind).toBe("rollback");
    expect(parseUpgrade(["--rollback", "-y"]).kind).toBe("rollback");
    expect(parseUpgrade(["--help"]).kind).toBe("help");
    expect(parseUpgrade(["--check", "-h"]).kind).toBe("help");
  });

  test("a service named is the hub's own upgrade, with the arguments as understood", () => {
    expect(parseUpgrade(["hub"])).toEqual({ kind: "hub", service: "hub", argv: ["hub"] });
    expect(parseUpgrade(["--channel=latest", "vault"])).toEqual({ kind: "hub", service: "vault", argv: ["vault", "--channel", "latest"] });
    expect(parseUpgrade(["--tag", "0.7.9", "vault", "--allow-downgrade"])).toEqual({ kind: "hub", service: "vault", argv: ["vault", "--tag", "0.7.9", "--allow-downgrade"] });
  });

  test("no service named is this program's own upgrade, on one of its channels", () => {
    expect(parseUpgrade([])).toEqual({ kind: "core", json: false });
    expect(parseUpgrade(["--json", "--channel", "beta"])).toEqual({ kind: "core", channel: "beta", json: true });
    expect(parseUpgrade(["--channel=next"])).toEqual({ kind: "core", channel: "next", json: false });
  });

  test("anything else is a usage error", () => {
    for (const args of [["--chekc"], ["--dry-run"], [""], ["vault", "hub"], ["vault", "--json"], ["vault", "--channel", "beta"], ["--channel", "rc"], ["--allow-downgrade"], ["--tag", "0.9.0"], ["--check", "vault"], ["--check", ""], ["--check", "--rollback"], ["--check", "--yes"], ["--rollback", "vault"], ["--rollback", ""], ["--channel"], ["--channel", "nightly"], ["--tag"], ["--tag", ""], ["--tag="], ["vault", "--tag", ""], ["--channel", "--tag"], ["--tag", "-x"], ["-x"]]) {
      expect({ args, kind: parseUpgrade(args).kind }).toEqual({ args, kind: "usage" });
    }
  });
});
