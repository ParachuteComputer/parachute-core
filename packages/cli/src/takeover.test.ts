// Reading a systemd unit's home (takeover.ts unitHome), the way systemd.exec(5) does: the takeover pauses only units
// that serve the home it takes over, so a misread home stops another home's Parachute.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemdWords, unitHome } from "./takeover.ts";

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
  test("a missing optional file is skipped; a missing required one, or broken quoting, is unknown", () => {
    expect(unitHome(`Environment=PARACHUTE_HOME=/env\nEnvironmentFile=-${join(dir, "none.env")}\n`)).toBe("/env");
    expect(unitHome(`EnvironmentFile=${join(dir, "none.env")}\n`)).toBe("unknown");
    expect(unitHome(`Environment="PARACHUTE_HOME=/a\n`)).toBe("unknown");
  });
});
