// Reading a systemd unit's home (takeover.ts unitHome), the way systemd.exec(5) does: the takeover pauses only units
// that serve the home it takes over, so a misread home stops another home's Parachute.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemdWords, unitHome as readHome } from "./takeover.ts";

// The user manager's environment sets no PARACHUTE_HOME here, unless a test says so.
const unitHome = (text: string, manager: () => string | undefined | null = () => undefined) => readHome(text, manager);

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
  test("a quoted home with a space is read whole", () => {
    expect(unitHome(`[Service]\nEnvironment="PARACHUTE_HOME=/srv/home other"\n`)).toBe("/srv/home other");
  });
  test("an environment file's quoted home with a space is read whole", () => {
    const f = file("a.env", `PARACHUTE_HOME="/srv/home other"\n`);
    expect(unitHome(`[Service]\nEnvironmentFile=${f}\n`)).toBe("/srv/home other");
  });
  test("EnvironmentFile= wins over Environment=, whatever the order", () => {
    const f = file("b.env", `PARACHUTE_HOME=/from/file\n`);
    expect(unitHome(`[Service]\nEnvironmentFile=${f}\n[Service]\nEnvironment=PARACHUTE_HOME=/from/env\n`)).toBe("/from/file");
  });
  test("an empty Environment= resets, and the last assignment wins", () => {
    expect(unitHome(`Environment=PARACHUTE_HOME=/one\nEnvironment=\nEnvironment=PARACHUTE_HOME=/two\nEnvironment=PARACHUTE_HOME=/three\n`)).toBe("/three");
    expect(unitHome(`Environment=PARACHUTE_HOME=/one\nEnvironment=\n`)).toMatch(/\/\.parachute$/);
  });
  test("an environment file keeps inner spaces and # in a bare value; a backslash or odd quoting is unknown", () => {
    expect(unitHome(`EnvironmentFile=${file("c.env", "# a comment\nPARACHUTE_HOME=/srv/home #other  \n")}\n`)).toBe("/srv/home #other");
    expect(unitHome(`EnvironmentFile=${file("d.env", "PARACHUTE_HOME=/srv/home\\ other\n")}\n`)).toBe("unknown");
    expect(unitHome(`EnvironmentFile=${file("e.env", "PARACHUTE_HOME=\"/a\" b\n")}\n`)).toBe("unknown");
    expect(unitHome(`[Service]\nEnvironment="PARACHUTE_HOME=/srv/home\\x20other"\n`)).toBe("unknown");
  });
  test("an unrelated variable's value going on over lines makes the file unknown, not a second assignment", () => {
    const f = file("f.env", `DESCRIPTION="first\nPARACHUTE_HOME=/srv/this\nlast"\n`);
    expect(unitHome(`Environment=PARACHUTE_HOME=/srv/other\nEnvironmentFile=${f}\n`)).toBe("unknown");
  });
  test("UnsetEnvironment= or PassEnvironment= naming PARACHUTE_HOME makes it unknown", () => {
    expect(unitHome(`Environment=PARACHUTE_HOME=/srv/this\nUnsetEnvironment=PARACHUTE_HOME\n`)).toBe("unknown");
    expect(unitHome(`PassEnvironment=PARACHUTE_HOME\n`)).toBe("unknown");
  });
  test("specifiers: %% is a percent, %h the user's home, any other one unknown", () => {
    expect(unitHome(`Environment=PARACHUTE_HOME=/srv/%%h\n`)).toBe("/srv/%h");
    expect(unitHome(`Environment=PARACHUTE_HOME=%h/p\n`)).toMatch(/\/p$/);
    expect(unitHome(`Environment=PARACHUTE_HOME=/srv/%u\n`)).toBe("unknown");
  });
  test("with no PARACHUTE_HOME in the unit, the user manager's environment decides; one systemd won't report is unknown", () => {
    expect(unitHome(`[Service]\n`, () => "/srv/managed")).toBe("/srv/managed");
    expect(unitHome(`[Service]\n`, () => null)).toBe("unknown");
    expect(unitHome(`Environment=PARACHUTE_HOME=/srv/unit\n`, () => "/srv/managed")).toBe("/srv/unit");
  });
  test("a missing optional file is skipped; a missing required one, or broken quoting, is unknown", () => {
    expect(unitHome(`Environment=PARACHUTE_HOME=/env\nEnvironmentFile=-${join(dir, "none.env")}\n`)).toBe("/env");
    expect(unitHome(`EnvironmentFile=${join(dir, "none.env")}\n`)).toBe("unknown");
    expect(unitHome(`Environment="PARACHUTE_HOME=/a\n`)).toBe("unknown");
  });
});
