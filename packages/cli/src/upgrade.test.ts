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

  test("the hub's own upgrade gets the arguments as understood: the sweep, one service, its three flags", () => {
    expect(parseUpgrade([])).toEqual({ kind: "hub", service: undefined, argv: [] });
    expect(parseUpgrade(["hub"])).toEqual({ kind: "hub", service: "hub", argv: ["hub"] });
    expect(parseUpgrade(["--channel=latest", "vault"])).toEqual({ kind: "hub", service: "vault", argv: ["vault", "--channel", "latest"] });
    expect(parseUpgrade(["--tag", "0.7.9", "vault", "--allow-downgrade"])).toEqual({ kind: "hub", service: "vault", argv: ["vault", "--tag", "0.7.9", "--allow-downgrade"] });
  });

  test("anything else is a usage error", () => {
    for (const args of [["--chekc"], ["--dry-run"], ["--json"], [""], ["vault", "hub"], ["--check", "vault"], ["--check", ""], ["--check", "--rollback"], ["--check", "--yes"], ["--rollback", "vault"], ["--rollback", ""], ["--channel"], ["--channel", "beta"], ["--tag"], ["--tag", ""], ["--tag="], ["vault", "--tag", ""], ["--channel", "--tag"], ["--tag", "-x"], ["-x"]]) {
      expect({ args, kind: parseUpgrade(args).kind }).toEqual({ args, kind: "usage" });
    }
  });
});
