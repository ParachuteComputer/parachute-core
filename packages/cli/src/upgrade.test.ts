// What `parachute upgrade` accepts (upgrade.ts parseUpgrade). It is read before anything touches the home, so what
// it lets through is what reaches the step (the backup, the record): the hub's own forms must still pass, rebuilt
// so the hub's parser can't refuse them afterwards, and nothing else. The refusals themselves are the contract's
// (lifecycle/upgrade: exit 2, the home byte for byte).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUpgrade } from "./upgrade.ts";

// As the hub knows its modules (service-spec.ts getSpec): a short name, and the name of its row in services.json.
const rowOf = (short: string) => ({ vault: "parachute-vault", scribe: "parachute-scribe" })[short];
const home = mkdtempSync(join(tmpdir(), "upgrade-parse-"));
const rows = (services: unknown) => writeFileSync(join(home, "services.json"), typeof services === "string" ? services : JSON.stringify({ services }));
const ask = (args: string[]) => parseUpgrade(args, home, rowOf);
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("parachute upgrade: what it was asked", () => {
  test("the forms it has", () => {
    rows([]);
    expect(ask(["--check"])).toEqual({ kind: "check", json: false });
    expect(ask(["--json", "--check"])).toEqual({ kind: "check", json: true });
    expect(ask(["--rollback", "--restore", "--yes", "--json"]).kind).toBe("rollback");
    expect(ask(["--rollback", "-y"]).kind).toBe("rollback");
    expect(ask(["--help"]).kind).toBe("help");
    expect(ask(["--check", "-h"]).kind).toBe("help");
  });

  test("the hub's own upgrade gets the arguments as understood: the sweep, one service it will find, its three flags", () => {
    rows([{ name: "parachute-vault" }, { name: "made-up-module", installDir: "/opt/made-up" }]);
    expect(ask([])).toEqual({ kind: "hub", argv: [] });
    expect(ask(["hub"])).toEqual({ kind: "hub", argv: ["hub"] });
    expect(ask(["--channel=latest", "vault"])).toEqual({ kind: "hub", argv: ["vault", "--channel", "latest"] });
    expect(ask(["--tag", "0.7.9", "vault", "--allow-downgrade"])).toEqual({ kind: "hub", argv: ["vault", "--tag", "0.7.9", "--allow-downgrade"] });
    expect(ask(["made-up-module", "--channel", "rc"])).toEqual({ kind: "hub", argv: ["made-up-module", "--channel", "rc"] });
  });

  test("a service is accepted only where the hub will find it", () => {
    rows([{ name: "parachute-vault" }, { name: "row-without-folder" }]);
    expect(ask(["scribe"]).kind).toBe("usage"); // a module the hub knows, not installed here
    expect(ask(["row-without-folder"]).kind).toBe("usage"); // the hub resolves a row only by its install folder
    expect(ask(["parachute-vault"]).kind).toBe("usage"); // a row's name is not a module's short name
    expect(ask(["nosuch"]).kind).toBe("usage");
    rows("not json");
    expect(ask(["vault"]).kind).toBe("usage"); // the hub would stop on the file, after the step
    expect(ask([]).kind).toBe("usage");
    expect(ask(["--check"]).kind).toBe("check"); // the check reads no services.json
  });

  test("anything else is a usage error", () => {
    rows([{ name: "parachute-vault" }]);
    for (const args of [["--chekc"], ["--dry-run"], ["--json"], [""], ["vault", "hub"], ["--check", "vault"], ["--check", ""], ["--check", "--rollback"], ["--check", "--yes"], ["--rollback", "vault"], ["--rollback", ""], ["--channel"], ["--channel", "beta"], ["--tag"], ["--tag", ""], ["--tag="], ["vault", "--tag", ""], ["--channel", "--tag"], ["--tag", "-x"], ["-x"]]) {
      expect({ args, kind: ask(args).kind }).toEqual({ args, kind: "usage" });
    }
  });
});
