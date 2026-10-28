// Reading a systemd unit's home (takeover.ts unitHome): the takeover pauses only units that serve the home it takes
// over, so reading another home's unit as this one's stops the wrong Parachute. The rule is to read only what is
// unambiguous and call the rest "unknown" (never paused; serve refuses).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { systemdWords, unitHome as readHome } from "./takeover.ts";

// The user manager's environment sets no PARACHUTE_HOME here, unless a test says so.
const unitHome = (text: string, manager: () => string | undefined | null = () => undefined) => readHome(text, manager);
const svc = (lines: string) => `[Service]\n${lines}`;
const DEFAULT = join(process.env.HOME || homedir(), ".parachute");

const dir = mkdtempSync(join(tmpdir(), "takeover-unit-"));
const file = (name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};

describe("systemdWords", () => {
  test("quotes keep spaces; any backslash (systemd's escapes) or unclosed quoting is not read", () => {
    expect(systemdWords(`"PARACHUTE_HOME=/srv/home other" PORT=1`)).toEqual(["PARACHUTE_HOME=/srv/home other", "PORT=1"]);
    expect(systemdWords(`PARACHUTE_HOME='/a b'`)).toEqual(["PARACHUTE_HOME=/a b"]);
    expect(systemdWords(`PARACHUTE_HOME=/a\\ b`)).toBeUndefined();
    expect(systemdWords(`"PARACHUTE_HOME=/srv/home\\x20other"`)).toBeUndefined();
    expect(systemdWords(`"PARACHUTE_HOME=/a`)).toBeUndefined();
  });
});

describe("unitHome", () => {
  test("a quoted home with a space is read whole, in the unit and in an environment file", () => {
    expect(unitHome(svc(`Environment="PARACHUTE_HOME=/srv/home other"\n`))).toBe("/srv/home other");
    const f = file("a.env", `PARACHUTE_HOME="/srv/home other"\n`);
    expect(unitHome(svc(`EnvironmentFile=${f}\n`))).toBe("/srv/home other");
  });
  test("EnvironmentFile= wins over Environment=, whatever the order", () => {
    const f = file("b.env", `PARACHUTE_HOME=/from/file\n`);
    expect(unitHome(`${svc(`EnvironmentFile=${f}\n`)}${svc(`Environment=PARACHUTE_HOME=/from/env\n`)}`)).toBe("/from/file");
  });
  test("an empty Environment= resets, and the last assignment wins", () => {
    expect(unitHome(svc(`Environment=PARACHUTE_HOME=/one\nEnvironment=\nEnvironment=PARACHUTE_HOME=/two\nEnvironment=PARACHUTE_HOME=/three\n`))).toBe("/three");
    expect(unitHome(svc(`Environment=PARACHUTE_HOME=/one\nEnvironment=\n`))).toBe(DEFAULT);
  });
  test("an explicit empty PARACHUTE_HOME is the default home, not the manager's", () => {
    expect(unitHome(svc(`Environment=PARACHUTE_HOME=\n`), () => "/srv/this")).toBe(DEFAULT);
  });
  test("an environment file keeps inner spaces and # in a bare value; export, $, a backslash or odd quoting is unknown", () => {
    expect(unitHome(svc(`EnvironmentFile=${file("c.env", "# a comment\nPARACHUTE_HOME=/srv/home #other  \n")}\n`))).toBe("/srv/home #other");
    expect(unitHome(svc(`EnvironmentFile=${file("d.env", "PARACHUTE_HOME=/srv/home\\ other\n")}\n`))).toBe("unknown");
    expect(unitHome(svc(`EnvironmentFile=${file("e.env", "PARACHUTE_HOME=\"/a\" b\n")}\n`))).toBe("unknown");
    expect(unitHome(svc(`Environment=PARACHUTE_HOME=/srv/other\nEnvironmentFile=${file("x.env", "export PARACHUTE_HOME=/srv/this\n")}\n`))).toBe("unknown");
    expect(unitHome(svc(`EnvironmentFile=${file("y.env", "PARACHUTE_HOME=$HOME/p\n")}\n`))).toBe("unknown");
    expect(unitHome(svc(`Environment="PARACHUTE_HOME=/srv/home\\x20other"\n`))).toBe("unknown");
  });
  test("an unrelated variable's value going on over lines makes the file unknown, not a second assignment", () => {
    const f = file("f.env", `DESCRIPTION="first\nPARACHUTE_HOME=/srv/this\nlast"\n`);
    expect(unitHome(svc(`Environment=PARACHUTE_HOME=/srv/other\nEnvironmentFile=${f}\n`))).toBe("unknown");
  });
  test("a continuation line anywhere makes the unit unknown", () => {
    expect(unitHome(svc(`Environment=PARACHUTE_HOME=/srv/other\nExecStartPre=/bin/echo \\\nEnvironment=PARACHUTE_HOME=/srv/this\n`))).toBe("unknown");
  });
  test("Environment= outside [Service] doesn't count", () => {
    expect(unitHome(`${svc("Environment=PARACHUTE_HOME=/srv/other\n")}[Unit]\nEnvironment=PARACHUTE_HOME=/srv/this\n`)).toBe("/srv/other");
  });
  test("a command that sets PARACHUTE_HOME itself, UnsetEnvironment= or PassEnvironment= naming it: unknown", () => {
    expect(unitHome(svc(`Environment=PARACHUTE_HOME=/srv/this\nExecStart=/usr/bin/env PARACHUTE_HOME=/srv/other parachute serve\n`))).toBe("unknown");
    expect(unitHome(svc(`Environment=PARACHUTE_HOME=/srv/this\nUnsetEnvironment=PARACHUTE_HOME\n`))).toBe("unknown");
    expect(unitHome(svc(`PassEnvironment=PARACHUTE_HOME\n`))).toBe("unknown");
  });
  test("specifiers: %% is a percent, %h the user's home, any other one unknown", () => {
    expect(unitHome(svc(`Environment=PARACHUTE_HOME=/srv/%%h\n`))).toBe("/srv/%h");
    expect(unitHome(svc(`Environment=PARACHUTE_HOME=%h/p\n`))).toMatch(/\/p$/);
    expect(unitHome(svc(`Environment=PARACHUTE_HOME=/srv/%u\n`))).toBe("unknown");
  });
  test("with no PARACHUTE_HOME in the unit, the user manager's environment decides; one systemd won't report is unknown", () => {
    expect(unitHome(svc(""), () => "/srv/managed")).toBe("/srv/managed");
    expect(unitHome(svc(""), () => null)).toBe("unknown");
    expect(unitHome(svc(`Environment=PARACHUTE_HOME=/srv/unit\n`), () => "/srv/managed")).toBe("/srv/unit");
  });
  test("a missing optional file is skipped; a missing required one is unknown", () => {
    expect(unitHome(svc(`Environment=PARACHUTE_HOME=/env\nEnvironmentFile=-${join(dir, "none.env")}\n`))).toBe("/env");
    expect(unitHome(svc(`EnvironmentFile=${join(dir, "none.env")}\n`))).toBe("unknown");
  });
});
