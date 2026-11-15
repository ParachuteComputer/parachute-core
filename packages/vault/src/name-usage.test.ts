// The usage log for 1.0's removals (T-407): names and counts land in the home's run/deprecations.json, merged with
// what the CLI wrote there; never on a home a host application (Prism) manages, and not with the CLI's opt-out.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countName, flushNameUsage, restRouteName } from "./name-usage.ts";

const saved = { home: process.env.PARACHUTE_HOME, parent: process.env.PARACHUTE_EMBEDDED_PARENT, opt: process.env.PARACHUTE_DEPRECATIONS };
let home = "";
const log = () => join(home, "run", "deprecations.json");
beforeEach(() => {
  // Other tests in this process count names too: drop what they left pending, writing nothing.
  process.env.PARACHUTE_DEPRECATIONS = "0";
  flushNameUsage();
  home = mkdtempSync(join(tmpdir(), "name-usage-"));
  process.env.PARACHUTE_HOME = home;
  delete process.env.PARACHUTE_EMBEDDED_PARENT;
  delete process.env.PARACHUTE_DEPRECATIONS;
});
afterEach(() => {
  flushNameUsage();
  process.env.PARACHUTE_HOME = saved.home;
  for (const [k, v] of [["PARACHUTE_EMBEDDED_PARENT", saved.parent], ["PARACHUTE_DEPRECATIONS", saved.opt]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("name usage", () => {
  test("counts merge into the CLI's log: old names under names, new names under adopted", () => {
    mkdirSync(join(home, "run"));
    writeFileSync(log(), JSON.stringify({ schema: 1, names: { "auth mint-token": { count: 2, first_seen: "a", last_seen: "b" } } }));
    countName("mcp query-notes", "old");
    countName("mcp query-notes", "old");
    countName("mcp query-records", "new");
    flushNameUsage();
    const l = JSON.parse(readFileSync(log(), "utf8"));
    expect(l.names["auth mint-token"].count).toBe(2);
    expect(l.names["mcp query-notes"].count).toBe(2);
    expect(l.adopted["mcp query-records"].count).toBe(1);
    countName("mcp query-notes", "old");
    flushNameUsage();
    expect(JSON.parse(readFileSync(log(), "utf8")).names["mcp query-notes"].count).toBe(3);
  });

  test("nothing is written on an embedded home (embedded.json)", () => {
    writeFileSync(join(home, "embedded.json"), "{}");
    countName("mcp query-notes", "old");
    flushNameUsage();
    expect(existsSync(log())).toBe(false);
  });

  test("nothing is written under Prism's embedded serve (the vault child it starts)", () => {
    process.env.PARACHUTE_EMBEDDED_PARENT = "12345";
    countName("mcp query-notes", "old");
    flushNameUsage();
    expect(existsSync(log())).toBe(false);
  });

  test("nothing is written while this process holds the home as its embedded serve", () => {
    mkdirSync(join(home, "run"));
    writeFileSync(join(home, "run", "serve.hold"), "");
    writeFileSync(join(home, "run", "serve.lock"), JSON.stringify({ pid: process.pid }));
    countName("mcp query-notes", "old");
    flushNameUsage();
    expect(existsSync(log())).toBe(false);
  });

  test("PARACHUTE_DEPRECATIONS=0 turns it off, as it does for the CLI", () => {
    process.env.PARACHUTE_DEPRECATIONS = "0";
    countName("mcp query-notes", "old");
    flushNameUsage();
    expect(existsSync(log())).toBe(false);
  });

  test("a REST route is named by its shape, never by an id or path", () => {
    expect(restRouteName("GET", "")).toBeNull();
    expect(restRouteName("GET", "/tags")).toBeNull();
    expect(restRouteName("GET", "/notes")).toBe("rest GET /api/notes");
    expect(restRouteName("patch", "/notes/Projects%2FAlder")).toBe("rest PATCH /api/notes/:id");
    expect(restRouteName("GET", "/notes/x/versions/3")).toBe("rest GET /api/notes/:id/versions/:x");
    expect(restRouteName("GET", "/notes/x/secret-word")).toBe("rest GET /api/notes/:id/?");
  });
});
