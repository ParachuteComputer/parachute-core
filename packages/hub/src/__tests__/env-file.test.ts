import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseEnvFile,
  parseEnvFileText,
  readEnvFileValues,
  upsertEnvLine,
  writeEnvFile,
} from "../env-file.ts";

function makeHarness(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-envfile-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("parseEnvFileText", () => {
  test("parses bare KEY=value lines", () => {
    const parsed = parseEnvFileText("FOO=bar\nBAZ=qux\n");
    expect(parsed.values).toEqual({ FOO: "bar", BAZ: "qux" });
    expect(parsed.lines).toEqual(["FOO=bar", "BAZ=qux"]);
  });

  test("strips one level of double quotes", () => {
    const parsed = parseEnvFileText('TOKEN="abc123"\n');
    expect(parsed.values.TOKEN).toBe("abc123");
  });

  test("strips one level of single quotes", () => {
    const parsed = parseEnvFileText("TOKEN='abc123'\n");
    expect(parsed.values.TOKEN).toBe("abc123");
  });

  test("preserves embedded equals signs in value", () => {
    const parsed = parseEnvFileText("URL=http://x.example.com/?q=1\n");
    expect(parsed.values.URL).toBe("http://x.example.com/?q=1");
  });

  test("ignores lines without a key (leading equals or no equals)", () => {
    const parsed = parseEnvFileText("=novalue\nbarewordnoequals\nGOOD=x\n");
    expect(parsed.values).toEqual({ GOOD: "x" });
  });

  test("empty content yields empty parse", () => {
    const parsed = parseEnvFileText("");
    expect(parsed.lines).toEqual([]);
    expect(parsed.values).toEqual({});
  });

  test("handles missing trailing newline", () => {
    const parsed = parseEnvFileText("FOO=bar");
    expect(parsed.values.FOO).toBe("bar");
    expect(parsed.lines).toEqual(["FOO=bar"]);
  });
});

describe("parseEnvFile / readEnvFileValues", () => {
  test("missing file returns empty parse", () => {
    const h = makeHarness();
    try {
      const parsed = parseEnvFile(join(h.dir, "missing.env"));
      expect(parsed.lines).toEqual([]);
      expect(parsed.values).toEqual({});
      expect(readEnvFileValues(join(h.dir, "missing.env"))).toEqual({});
    } finally {
      h.cleanup();
    }
  });

  test("reads existing file values", () => {
    const h = makeHarness();
    try {
      const path = join(h.dir, ".env");
      writeFileSync(path, "A=1\nB=2\n");
      expect(readEnvFileValues(path)).toEqual({ A: "1", B: "2" });
    } finally {
      h.cleanup();
    }
  });
});

describe("upsertEnvLine", () => {
  test("appends when key not present", () => {
    const next = upsertEnvLine(["FOO=1"], "BAR", "2");
    expect(next).toEqual(["FOO=1", "BAR=2"]);
  });

  test("replaces in place when key present", () => {
    const next = upsertEnvLine(["FOO=1", "BAR=old", "BAZ=3"], "BAR", "new");
    expect(next).toEqual(["FOO=1", "BAR=new", "BAZ=3"]);
  });

  test("does not mutate the input array", () => {
    const input = ["FOO=1"];
    upsertEnvLine(input, "BAR", "2");
    expect(input).toEqual(["FOO=1"]);
  });
});

describe("writeEnvFile", () => {
  test("creates parent directories and writes content with trailing newline", () => {
    const h = makeHarness();
    try {
      const path = join(h.dir, "nested", "subdir", ".env");
      writeEnvFile(path, ["FOO=1", "BAR=2"]);
      expect(readFileSync(path, "utf8")).toBe("FOO=1\nBAR=2\n");
    } finally {
      h.cleanup();
    }
  });

  test("round-trips with parseEnvFile", () => {
    const h = makeHarness();
    try {
      const path = join(h.dir, ".env");
      const start = parseEnvFileText("KEEP=ok\nUPDATE=old\n");
      const lines = upsertEnvLine(start.lines, "UPDATE", "new");
      writeEnvFile(path, lines);
      expect(parseEnvFile(path).values).toEqual({ KEEP: "ok", UPDATE: "new" });
    } finally {
      h.cleanup();
    }
  });
});
