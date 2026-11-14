// T-460: the history policy across releases. vault.yaml's burst window round-trips, and a history-import manifest
// planned by an older release (fewer policy keys, other compaction defaults) still matches the vault it was planned for.
import { test, expect } from "bun:test";
import { writeVaultConfig, readVaultConfig } from "./config.ts";
import { sameRetention } from "./history-import.ts";
import { resolveHistoryPolicy } from "../core/src/history.ts";

test("burst_window_seconds round-trips through vault.yaml, and a negative or fractional value is kept for the clamp", () => {
  for (const [given, resolved] of [[0, 0], [120, 120], [-5, 0], [90.7, 90]] as const) {
    const name = `burst-${String(given).replace(/\W/g, "_")}`;
    writeVaultConfig({ name, api_keys: [], created_at: new Date().toISOString(), history: { burst_window_seconds: given } });
    const read = readVaultConfig(name)!.history!;
    expect(read.burst_window_seconds).toBe(given);
    expect(resolveHistoryPolicy(read).burst_window_seconds).toBe(resolved);
  }
  expect(resolveHistoryPolicy({ burst_window_seconds: null as unknown as number }).burst_window_seconds).toBe(0);
  expect(resolveHistoryPolicy({ burst_window_seconds: "0" as unknown as number }).burst_window_seconds).toBe(0);
});

test("a manifest's policy matches on retention keys only, and only those it carries", () => {
  const now = resolveHistoryPolicy({});
  // What a release before T-460 resolved: no burst key, the old compaction defaults.
  const { burst_window_seconds: _b, ...older } = { ...now, compact_ratio: 3, compact_min_versions: 10 };
  expect(sameRetention(now, older as typeof now)).toBe(true);
  expect(sameRetention(now, { ...now, max_versions: 50 })).toBe(false);
  expect(sameRetention(now, { ...now, max_bytes_per_note: null })).toBe(false);
  expect(sameRetention(now, { ...now, enabled: false })).toBe(false);
});
