import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  clearPid,
  defaultAlive,
  ensureLogPath,
  formatUptime,
  logPath,
  pidPath,
  processState,
  readPid,
  writePid,
} from "../process-state.ts";

function makeTempConfig(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-proc-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("process-state paths", () => {
  test("pidPath / logPath land under <configDir>/<svc>/{run,logs}", () => {
    expect(pidPath("vault", "/cfg")).toBe("/cfg/vault/run/vault.pid");
    expect(logPath("notes", "/cfg")).toBe("/cfg/notes/logs/notes.log");
  });
});

describe("writePid / readPid / clearPid", () => {
  test("round-trips through the filesystem", () => {
    const { dir, cleanup } = makeTempConfig();
    try {
      expect(readPid("vault", dir)).toBeUndefined();
      writePid("vault", 12345, dir);
      expect(readPid("vault", dir)).toBe(12345);
      clearPid("vault", dir);
      expect(readPid("vault", dir)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("readPid ignores garbage pid files", () => {
    const { dir, cleanup } = makeTempConfig();
    try {
      const p = pidPath("vault", dir);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "not-a-number\n");
      expect(readPid("vault", dir)).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

describe("processState", () => {
  test("no pid file → unknown (externally-managed is possible)", () => {
    const { dir, cleanup } = makeTempConfig();
    try {
      expect(processState("vault", dir).status).toBe("unknown");
    } finally {
      cleanup();
    }
  });

  test("pid file + alive pid → running with pid + startedAt", () => {
    const { dir, cleanup } = makeTempConfig();
    try {
      writePid("vault", 4242, dir);
      const state = processState("vault", dir, () => true);
      expect(state.status).toBe("running");
      expect(state.pid).toBe(4242);
      expect(state.startedAt).toBeInstanceOf(Date);
    } finally {
      cleanup();
    }
  });

  test("pid file + dead pid → stopped (known-dead, not unknown)", () => {
    const { dir, cleanup } = makeTempConfig();
    try {
      writePid("vault", 4242, dir);
      const state = processState("vault", dir, () => false);
      expect(state.status).toBe("stopped");
      expect(state.pid).toBe(4242);
    } finally {
      cleanup();
    }
  });
});

describe("defaultAlive", () => {
  test("current process is alive", () => {
    expect(defaultAlive(process.pid)).toBe(true);
  });

  test("absurd pid is not alive", () => {
    // PIDs above 2^22 don't exist on mainstream OSes.
    expect(defaultAlive(99_999_999)).toBe(false);
  });
});

describe("formatUptime", () => {
  test("sub-minute → seconds", () => {
    const now = new Date("2026-04-19T12:00:45Z");
    const start = new Date("2026-04-19T12:00:00Z");
    expect(formatUptime(start, now)).toBe("45s");
  });

  test("sub-hour → minutes", () => {
    const now = new Date("2026-04-19T12:13:00Z");
    const start = new Date("2026-04-19T12:00:00Z");
    expect(formatUptime(start, now)).toBe("13m");
  });

  test("sub-day → h+m", () => {
    const now = new Date("2026-04-19T14:13:00Z");
    const start = new Date("2026-04-19T12:00:00Z");
    expect(formatUptime(start, now)).toBe("2h 13m");
  });

  test("multi-day → d+h", () => {
    const now = new Date("2026-04-23T18:00:00Z");
    const start = new Date("2026-04-19T12:00:00Z");
    expect(formatUptime(start, now)).toBe("4d 6h");
  });
});

describe("ensureLogPath", () => {
  test("creates logs dir and returns the log-file path", () => {
    const { dir, cleanup } = makeTempConfig();
    try {
      const p = ensureLogPath("vault", dir);
      expect(p).toBe(logPath("vault", dir));
      expect(existsSync(join(dir, "vault", "logs"))).toBe(true);
    } finally {
      cleanup();
    }
  });
});
