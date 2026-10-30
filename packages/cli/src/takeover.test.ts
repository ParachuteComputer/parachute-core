// Reading a systemd unit's home (takeover.ts unitHome): the takeover pauses only units that serve the home it takes
// over, so reading another home's unit as this one's stops the wrong Parachute. The rule is to read only what is
// unambiguous and call the rest "unknown" (never paused; serve refuses).
import { describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { backup, entries, managerValue, restore, systemdWords, unitHome as readHome } from "./takeover.ts";

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

// The backup and its restore (a rehearsal, lane H): a real home has a library's version links in transcription/bin
// (`libggml.so -> libggml.so.0 -> libggml.so.0.15.1`). They stay inside the home, so they are copied as links and put
// back as links; only a link that leads out of the home (or a socket) can't be copied as it is.
describe("backup and restore", () => {
  const made = () => {
    const root = mkdtempSync(join(tmpdir(), "takeover-backup-"));
    const home = join(root, "home");
    mkdirSync(join(home, "transcription", "bin"), { recursive: true });
    mkdirSync(join(home, "vault", "data", "v"), { recursive: true });
    writeFileSync(join(home, "transcription", "bin", "libx.so.0.15.1"), "made-up library bytes");
    symlinkSync("libx.so.0.15.1", join(home, "transcription", "bin", "libx.so.0"));
    symlinkSync("libx.so.0", join(home, "transcription", "bin", "libx.so"));
    symlinkSync("../transcription/bin/libx.so", join(home, "vault", "lib"));
    writeFileSync(join(home, "vault", "data", "v", "vault.db"), "made-up database bytes");
    return { root, home };
  };
  const linkAt = (p: string) => (lstatSync(p).isSymbolicLink() ? readlinkSync(p) : "not a link");

  test("links that stay inside the home are copied as links, with their targets as written, and restored as links", () => {
    const { root, home } = made();
    expect(entries(home).other).toEqual([]);
    const dest = join(root, "backup");
    expect(backup(home, dest).files).toBe(2);
    expect(linkAt(join(dest, "home", "transcription", "bin", "libx.so"))).toBe("libx.so.0");
    expect(linkAt(join(dest, "home", "vault", "lib"))).toBe("../transcription/bin/libx.so");
    writeFileSync(join(home, "vault", "data", "v", "vault.db"), "changed after the backup");
    const aside = restore(home, dest);
    expect(linkAt(join(home, "transcription", "bin", "libx.so"))).toBe("libx.so.0");
    expect(linkAt(join(home, "transcription", "bin", "libx.so.0"))).toBe("libx.so.0.15.1");
    expect(linkAt(join(home, "vault", "lib"))).toBe("../transcription/bin/libx.so");
    expect(readFileSync(join(home, "vault", "lib"), "utf8")).toBe("made-up library bytes");
    expect(readFileSync(join(home, "vault", "data", "v", "vault.db"), "utf8")).toBe("made-up database bytes");
    expect(readFileSync(join(aside, "vault", "data", "v", "vault.db"), "utf8")).toBe("changed after the backup");
  });

  test("a link that leads out of the home, by an absolute path or by .., can't be copied as it is", () => {
    const { root, home } = made();
    symlinkSync(join(root, "elsewhere"), join(home, "out-absolute"));
    symlinkSync("../../elsewhere", join(home, "vault", "out-relative"));
    symlinkSync("..", join(home, "transcription", "up"));
    expect(entries(home).other.sort()).toEqual(["out-absolute", join("transcription", "up"), join("vault", "out-relative")].sort());
  });
});

describe("managerValue: a value as systemctl show-environment prints it", () => {
  test("plain values are taken as they are", () => {
    expect(managerValue("/home/u/.bun/bin:/usr/bin")).toBe("/home/u/.bun/bin:/usr/bin");
    expect(managerValue("")).toBe("");
  });
  test("systemd's $'…' form is decoded: a space, quotes, backslashes, C escapes, octal and hex bytes (UTF-8)", () => {
    expect(managerValue("$'/home/u/My Tools/bin:/usr/bin'")).toBe("/home/u/My Tools/bin:/usr/bin");
    expect(managerValue("$'it\\'s a \\\\ and \\\"q\\\"'")).toBe(`it's a \\ and "q"`);
    expect(managerValue("$'a\\tb\\nc'")).toBe("a\tb\nc");
    expect(managerValue("$'caf\\303\\251 \\x41'")).toBe("café A");
    expect(managerValue("$'café'")).toBe("café");
  });
  test("anything it can't read exactly is null", () => {
    expect(managerValue("$'unterminated")).toBeNull();
    expect(managerValue("$'a'b'")).toBeNull();
    expect(managerValue("$'\\q'")).toBeNull();
    expect(managerValue("$'\\'")).toBeNull();
    expect(managerValue("$'\\777'")).toBeNull();
  });
});
