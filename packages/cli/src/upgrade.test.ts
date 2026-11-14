// What `parachute upgrade` accepts (upgrade.ts parseUpgrade). It is read before anything touches the home, so what
// it lets through is what reaches the step (the backup, the record): the hub's own forms must still pass, and
// nothing else. The refusals themselves are the contract's (lifecycle/upgrade: exit 2, the home byte for byte).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUpgrade } from "./upgrade.ts";

const KNOWN = ["vault", "scribe"];
const kind = (args: string[], home = "/nonexistent") => parseUpgrade(args, home, KNOWN).kind;

describe("parachute upgrade: what it was asked", () => {
  test("the forms it has", () => {
    expect(kind(["--check"])).toBe("check");
    expect(parseUpgrade(["--json", "--check"], "/nonexistent", KNOWN)).toEqual({ kind: "check", json: true });
    expect(kind(["--rollback", "--restore", "--yes", "--json"])).toBe("rollback");
    expect(kind(["--rollback", "-y"])).toBe("rollback");
    expect(kind(["--help"])).toBe("help");
    expect(kind(["--check", "-h"])).toBe("help");
  });

  test("the hub's own upgrade passes as it was: the sweep, one known service, its three flags", () => {
    for (const args of [[], ["hub"], ["vault"], ["scribe", "--channel", "rc"], ["--channel=latest", "vault"], ["--tag", "0.7.9", "vault"], ["vault", "--allow-downgrade"]]) {
      expect({ args, kind: kind(args) }).toEqual({ args, kind: "hub" });
    }
  });

  test("a service is known by services.json too, and by nothing else", () => {
    const home = mkdtempSync(join(tmpdir(), "upgrade-parse-"));
    try {
      writeFileSync(join(home, "services.json"), JSON.stringify({ services: [{ name: "made-up-module" }] }));
      expect(kind(["made-up-module"], home)).toBe("hub");
      expect(kind(["another-module"], home)).toBe("usage");
      writeFileSync(join(home, "services.json"), "not json");
      expect(kind(["made-up-module"], home)).toBe("usage");
      expect(kind(["vault"], home)).toBe("hub");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("anything else is a usage error", () => {
    for (const args of [["--chekc"], ["--dry-run"], ["nosuch"], ["vault", "scribe"], ["--check", "vault"], ["--check", "--rollback"], ["--check", "--yes"], ["--rollback", "vault"], ["--channel"], ["--channel", "beta"], ["--tag"], ["--tag="], ["--channel", "--tag"], ["-x"]]) {
      expect({ args, kind: kind(args) }).toEqual({ args, kind: "usage" });
    }
  });
});
