// The front door's routing table (front.ts): new verbs map onto commands that exist, and each old name is tied to
// a change-map entry, so a notice can never point at nothing. The behaviour end to end is lifecycle/front-door.
import { describe, expect, test } from "bun:test";
import { CHANGES, entryFor, frontDoor, lookup, noticeLine } from "./front.ts";

describe("parachute: the 0.9 front door", () => {
  test("new verbs run today's commands", () => {
    const cases: [string[], string[]][] = [
      [["user", "list"], ["auth", "list-users"]],
      [["user", "pubkey", "add", "npub1x"], ["auth", "link-pubkey", "npub1x"]],
      [["vault", "new", "work"], ["vault", "create", "work"]],
      [["vault", "pack", "rm", "x"], ["vault", "packs", "remove", "x"]],
      [["vault", "channel", "attach", "c", "v"], ["vault", "attach-channel", "c", "v"]],
      [["setup", "expose", "tailnet"], ["expose", "tailnet"]],
      [["setup", "mcp", "claude"], ["vault", "mcp-install"]],
      [["setup", "--embedded", "--json"], ["bootstrap", "--embedded", "--json"]],
      [["backup", "schedule"], ["vault", "backup", "--schedule"]],
      [["tokens", "list"], ["keys", "list"]],
    ];
    for (const [argv, want] of cases) expect({ argv, run: frontDoor(argv).argv, notice: frontDoor(argv).notice }).toEqual({ argv, run: want, notice: undefined });
  });

  test("old names run unchanged, with a notice only where the replacement is live", () => {
    const d = frontDoor(["auth", "mint-token", "--scope", "vault:v:read"]);
    expect(d.argv).toEqual(["auth", "mint-token", "--scope", "vault:v:read"]);
    expect(noticeLine(d.notice!)).toBe("parachute: 'auth mint-token' is now 'keys new <name>' (since 0.9, gone in 1.0): parachute changes auth mint-token");
    expect(frontDoor(["auth", "list-grants"]).notice).toBeUndefined(); // keys list doesn't cover grants yet
    expect(frontDoor(["auth", "mint-token", "--help"]).notice).toBeUndefined();
    expect(frontDoor(["install"]).notice).toBeUndefined(); // core's own install is not the module installer
    expect(frontDoor(["install", "--prefix", "/x"]).notice?.used).toBeUndefined();
    expect(frontDoor(["install", "vault"]).notice?.used).toBe("install");
    // Prism's v1 shapes that never warn, whatever the home.
    for (const argv of [["serve", "--embedded"], ["bootstrap", "--embedded", "--json"], ["version", "--json"]]) {
      expect(frontDoor(argv)).toEqual({ argv });
    }
  });

  test("every old name points at a change-map entry, and `changes <old name>` finds it", () => {
    const olds = ["auth mint-token", "auth revoke-token", "vault create", "expose", "migrate", "vault tokens", "vault backup"];
    for (const used of olds) {
      const d = frontDoor([...used.split(" "), "x"]);
      expect({ used, entry: d.notice && entryFor(d.notice.entry)?.state }).toEqual({ used, entry: "live" });
      expect(lookup(used.split(" ")).length).toBeGreaterThan(0);
    }
    expect(lookup(["find-path"])[0]?.new).toBe("query-notes {path_between}");
  });

  test("the map is well formed", () => {
    expect(CHANGES.schema).toBe(1);
    for (const c of CHANGES.changes) {
      expect(["command", "mcp-tool", "endpoint", "setting", "credential"]).toContain(c.kind);
      expect(["live", "planned"]).toContain(c.state);
      expect(typeof c.reason).toBe("string");
    }
  });
});
