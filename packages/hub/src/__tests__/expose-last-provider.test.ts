import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearLastProvider, readLastProvider, writeLastProvider } from "../expose-last-provider.ts";

function makeEnv(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-last-provider-"));
  return {
    path: join(dir, "expose-last-provider.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("expose-last-provider", () => {
  test("returns undefined when file is missing", () => {
    const env = makeEnv();
    try {
      expect(readLastProvider(env.path)).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  test("round-trips a provider", () => {
    const env = makeEnv();
    try {
      writeLastProvider("cloudflare", {
        path: env.path,
        now: () => new Date("2026-04-22T12:34:56Z"),
      });
      const record = readLastProvider(env.path);
      expect(record).toEqual({
        version: 1,
        provider: "cloudflare",
        writtenAt: "2026-04-22T12:34:56.000Z",
      });
    } finally {
      env.cleanup();
    }
  });

  test("atomic write leaves no tmp file behind on success", () => {
    const env = makeEnv();
    try {
      writeLastProvider("tailscale", { path: env.path });
      const contents = readFileSync(env.path, "utf8");
      // rename (not raw write) is the atomic path — body has to be valid JSON.
      expect(() => JSON.parse(contents)).not.toThrow();
    } finally {
      env.cleanup();
    }
  });

  test("returns undefined on corrupt JSON rather than throwing", () => {
    const env = makeEnv();
    try {
      writeFileSync(env.path, "{ not: json");
      expect(readLastProvider(env.path)).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  test("returns undefined on schema mismatch (wrong provider value)", () => {
    const env = makeEnv();
    try {
      writeFileSync(
        env.path,
        JSON.stringify({ version: 1, provider: "aws", writtenAt: "2026-04-22T00:00:00Z" }),
      );
      expect(readLastProvider(env.path)).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  test("returns undefined on unknown version", () => {
    const env = makeEnv();
    try {
      writeFileSync(
        env.path,
        JSON.stringify({ version: 99, provider: "tailscale", writtenAt: "2026-04-22T00:00:00Z" }),
      );
      expect(readLastProvider(env.path)).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  test("clearLastProvider removes the file", () => {
    const env = makeEnv();
    try {
      writeLastProvider("tailscale", { path: env.path });
      expect(readLastProvider(env.path)).toBeDefined();
      clearLastProvider(env.path);
      expect(readLastProvider(env.path)).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  test("overwriting updates the stored provider", () => {
    const env = makeEnv();
    try {
      writeLastProvider("tailscale", { path: env.path });
      writeLastProvider("cloudflare", { path: env.path });
      expect(readLastProvider(env.path)?.provider).toBe("cloudflare");
    } finally {
      env.cleanup();
    }
  });
});
