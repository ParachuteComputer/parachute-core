import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExposeState,
  ExposeStateError,
  clearExposeState,
  readExposeState,
  writeExposeState,
} from "../expose-state.ts";

function makeTempPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-state-"));
  return {
    path: join(dir, "expose-state.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const sample: ExposeState = {
  version: 1,
  layer: "tailnet",
  mode: "path",
  canonicalFqdn: "parachute.taildf9ce2.ts.net",
  port: 443,
  funnel: false,
  entries: [
    {
      kind: "proxy",
      mount: "/",
      target: "http://127.0.0.1:1940",
      service: "parachute-vault",
    },
    {
      kind: "file",
      mount: "/.well-known/parachute.json",
      target: "/home/x/.parachute/well-known/parachute.json",
      service: "well-known",
    },
  ],
};

describe("expose-state", () => {
  test("readExposeState returns undefined when missing", () => {
    const { path, cleanup } = makeTempPath();
    try {
      expect(readExposeState(path)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("write + read round-trip", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeExposeState(sample, path);
      expect(readExposeState(path)).toEqual(sample);
    } finally {
      cleanup();
    }
  });

  test("clearExposeState removes the file", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeExposeState(sample, path);
      expect(existsSync(path)).toBe(true);
      clearExposeState(path);
      expect(existsSync(path)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("throws on unsupported version", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(path, JSON.stringify({ ...sample, version: 99 }));
      expect(() => readExposeState(path)).toThrow(/unsupported version/);
    } finally {
      cleanup();
    }
  });

  test("throws on malformed entries", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          ...sample,
          entries: [{ kind: "proxy", mount: "no-slash", target: "http://x", service: "s" }],
        }),
      );
      expect(() => readExposeState(path)).toThrow(ExposeStateError);
    } finally {
      cleanup();
    }
  });
});
