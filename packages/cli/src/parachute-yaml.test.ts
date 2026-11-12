// The parachute.yaml parser, writer and precedence (parachute-yaml.ts, settings.ts). Logic is the point here: a parser
// and a line editor, so these are unit tests; the whole path (serve on the file's port) is contracts/suites/lifecycle.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsError, checkValue, getSetting, parse, setInText, setSetting, settingsOf, unsetInText, unsetSetting } from "./parachute-yaml.ts";

// settings.ts loads the vault's config module, which refuses to run under `bun test` without a PARACHUTE_HOME.
process.env.PARACHUTE_HOME ??= mkdtempSync(join(tmpdir(), "pyaml-vault-home-"));
const { applyParachuteYaml, effective } = await import("./settings.ts");
const { fileWarnings } = await import("./parachute-yaml.ts");

let home = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pyaml-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const write = (text: string) => writeFileSync(join(home, "parachute.yaml"), text);
const read = () => readFileSync(join(home, "parachute.yaml"), "utf8");

const SAMPLE = `# my box
server:
  port: 47000   # the hub
  origin: "https://hub.example.test"
  accepted_issuers:
    - https://old.example.test
    - 'https://older.example.test'
vaults:
  notes:
    description: |
      Line one.
      Line two.
  other:
    description: plain words
`;

describe("parse", () => {
  test("reads maps, lists, quotes, block text and comments", () => {
    const s = settingsOf(parse(SAMPLE));
    expect(s.get("server.port")).toBe("47000");
    expect(s.get("server.origin")).toBe("https://hub.example.test");
    expect(s.get("server.accepted_issuers")).toEqual(["https://old.example.test", "https://older.example.test"]);
    expect(s.get("vaults.notes.description")).toBe("Line one.\nLine two.");
    expect(s.get("vaults.other.description")).toBe("plain words");
  });

  test("a flow list works, and unknown keys are kept, not refused", () => {
    const s = settingsOf(parse("server:\n  accepted_issuers: [https://a.example.test, \"https://b.example.test\"]\nfuture:\n  thing: 1\n"));
    expect(s.get("server.accepted_issuers")).toEqual(["https://a.example.test", "https://b.example.test"]);
    expect(s.has("future.thing")).toBe(false);
  });

  test.each([
    ["server:\n  port: 1\n  bind 127.0.0.1\n", 3, /expected "key: value"/],
    ["server:\n\tport: 1\n", 2, /tabs/],
    ["server:\n  port: 1\n  port: 2\n", 3, /twice/],
    ["server:\n  port: 1\n    deeper: 2\n", 3, /indentation/],
    ["- stray\n", 1, /must sit under a key/],
    ["server:\n  origin: \"https://a\n", 2, /not closed/],
    ["vaults:\n  v:\n    description: >\n      folded\n", 3, /folded/],
  ])("bad text %#: names line %d", (text, line, why) => {
    try {
      parse(text);
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SettingsError);
      expect((err as SettingsError).line).toBe(line);
      expect((err as SettingsError).message).toMatch(new RegExp(`line ${line}`));
      expect((err as SettingsError).message).toMatch(why);
    }
  });

  test("a bad value for a known key names its line", () => {
    expect(() => settingsOf(parse("server:\n  port: banana\n"))).toThrow(/line 2: server.port must be a port/);
    expect(() => settingsOf(parse("server:\n  origin:\n"))).toThrow(/line 2/);
  });
});

describe("checkValue", () => {
  test("checks ports, origins and lists", () => {
    expect(checkValue("server.port", " 0047000 ")).toBe("47000");
    expect(() => checkValue("server.port", "70000")).toThrow(/1 to 65535/);
    expect(checkValue("server.origin", "https://hub.example.test/")).toBe("https://hub.example.test");
    expect(() => checkValue("server.origin", "https://hub.example.test/path")).toThrow(/no path/);
    expect(() => checkValue("server.origin", "hub.example.test")).toThrow(/origin/);
    expect(checkValue("server.accepted_issuers", "https://a.example.test, https://b.example.test")).toEqual(["https://a.example.test", "https://b.example.test"]);
  });
  test("an unknown key names the nearest known one", () => {
    expect(() => checkValue("server.prot", "1")).toThrow(/Did you mean "server.port"/);
    expect(() => checkValue("vaults.notes.descripton", "x")).toThrow(/Did you mean "vaults.notes.description"/);
    expect(() => checkValue("serverport", "1")).toThrow(/Known settings/);
  });
});

describe("set and unset edit the text and keep the rest", () => {
  test("set changes one line and keeps comments, other keys and block text", () => {
    const out = setInText(SAMPLE, "server.port", "47001");
    expect(out).toContain("# my box\n");
    expect(out).toContain("  port: 47001\n");
    expect(out).not.toContain("# the hub"); // the edited line's own trailing comment goes
    expect(out).toContain("      Line one.\n      Line two.\n");
    expect(settingsOf(parse(out)).get("server.accepted_issuers")).toHaveLength(2);
  });

  test("set adds missing keys under the right parent, or at the end", () => {
    let t = setInText("# only a comment\n", "server.bind", "0.0.0.0");
    expect(t).toBe("# only a comment\nserver:\n  bind: 0.0.0.0\n");
    t = setInText(t, "server.port", "47000");
    expect(t).toBe("# only a comment\nserver:\n  bind: 0.0.0.0\n  port: 47000\n");
    t = setInText(t, "vaults.notes.description", "Hello: world # not a comment");
    expect(settingsOf(parse(t)).get("vaults.notes.description")).toBe("Hello: world # not a comment");
    t = setInText(t, "vaults.other.description", "two");
    expect(settingsOf(parse(t)).get("vaults.notes.description")).toBe("Hello: world # not a comment");
    expect(settingsOf(parse(t)).get("vaults.other.description")).toBe("two");
  });

  test("set replaces a whole list, and a block text, with the new value", () => {
    let t = setInText(SAMPLE, "server.accepted_issuers", ["https://new.example.test"]);
    expect(settingsOf(parse(t)).get("server.accepted_issuers")).toEqual(["https://new.example.test"]);
    t = setInText(t, "vaults.notes.description", "One line\nand another");
    expect(settingsOf(parse(t)).get("vaults.notes.description")).toBe("One line\nand another");
    expect(settingsOf(parse(t)).get("vaults.other.description")).toBe("plain words");
  });

  test("unset removes the key and any parent it empties, nothing else", () => {
    const t = unsetInText(unsetInText(SAMPLE, "vaults.notes.description"), "vaults.other.description");
    expect(t).not.toContain("vaults");
    expect(t).toContain("# my box");
    expect(unsetInText(SAMPLE, "server.port")).toContain("server:\n  origin:");
    expect(unsetInText(SAMPLE, "server.bind")).toBe(SAMPLE);
  });

  test("setting under a key that already has a value is refused", () => {
    expect(() => setInText("server: x\n", "server.port", "1")).toThrow(/already has a value/);
  });
});

describe("files: atomic, 0600, and refuse to edit a broken file", () => {
  test("setSetting / unsetSetting round trip", () => {
    setSetting(home, "server.port", "47123");
    expect(statSync(join(home, "parachute.yaml")).mode & 0o777).toBe(0o600);
    expect(getSetting(home, "server.port")).toBe("47123");
    expect(unsetSetting(home, "server.port")).toBe(true);
    expect(unsetSetting(home, "server.port")).toBe(false);
    expect(getSetting(home, "server.port")).toBeUndefined();
  });
  test("a broken file is not edited", () => {
    write("server:\n  port: 1\n  bind 127.0.0.1\n");
    expect(() => setSetting(home, "server.port", "2")).toThrow(/line 3/);
    expect(read()).toBe("server:\n  port: 1\n  bind 127.0.0.1\n");
  });
});

describe("precedence: env, then parachute.yaml, then the default", () => {
  test("apply fills only the env vars that are not set", () => {
    write("server:\n  port: 47000\n  bind: 127.0.0.2\n  origin: https://hub.example.test\n");
    const env: NodeJS.ProcessEnv = { PORT: "47999" };
    applyParachuteYaml(home, { env });
    expect(env.PORT).toBe("47999");
    expect(env.PARACHUTE_BIND_HOST).toBe("127.0.0.2");
    expect(env.PARACHUTE_HUB_ORIGIN).toBe("https://hub.example.test");
  });
  test("the vault's own program takes no server.* settings", () => {
    write("server:\n  port: 47000\n");
    const env: NodeJS.ProcessEnv = {};
    applyParachuteYaml(home, { env, server: false });
    expect(env.PORT).toBeUndefined();
  });
  test("effective says where the value comes from", () => {
    expect(effective(home, "server.port", {})).toMatchObject({ value: "1939", source: "default" });
    write("server:\n  port: 47000\n");
    expect(effective(home, "server.port", {})).toMatchObject({ value: "47000", source: "parachute.yaml" });
    expect(effective(home, "server.port", { PORT: "1" })).toMatchObject({ value: "1", source: "env", overrides: "parachute.yaml 47000" });
  });
});

describe("review round 1", () => {
  test("a dotted key in the file is refused with its line (it would be rewritten wrong)", () => {
    expect(() => parse("server.port: 1\n")).toThrow(/line 1: .*nest/);
  });

  test("U+2028 and U+2029 in a value are written escaped and read back", () => {
    const v = "caf\u00e9\u2028x\u2029y";
    setSetting(home, "vaults.a.description", v);
    expect(read()).not.toMatch(/[\u2028\u2029]/);
    expect(getSetting(home, "vaults.a.description")).toBe(v);
  });

  test("unknown keys under server and vaults.<n> are warned about with the nearest name", () => {
    const w = fileWarnings("server:\n  prot: 47000\nvaults:\n  notes:\n    descripton: x\nfuture:\n  thing: 1\n");
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/line 2: unknown setting "server.prot".*Did you mean "server.port"/);
    expect(w[1]).toMatch(/line 5.*vaults.notes.description/);
  });

  test("set writes under a parent at the parent's own child indent", () => {
    const t = setInText("server:\n    bind: 0.0.0.0\n", "server.port", "47000");
    expect(t).toBe("server:\n    bind: 0.0.0.0\n    port: 47000\n");
  });
});
