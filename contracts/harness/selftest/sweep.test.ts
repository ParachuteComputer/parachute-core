// The stale-home sweep removes only homes whose owner is provably gone and that weren't kept on purpose.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sweepStaleSandboxes } from "../services.ts";

const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pcore-sweep-selftest-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function home(name: string, owner: number, kept = false): string {
  const dir = join(base, `pcore-contracts-${name}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "owner.pid"), `${owner}\n`);
  if (kept) writeFileSync(join(dir, "kept"), "");
  return dir;
}

test("only dead, unkept owners' homes are swept", async () => {
  const dead = Bun.spawn(["true"]);
  await dead.exited;
  const gone = home("gone", dead.pid);
  const kept = home("kept", dead.pid, true);
  const mine = home("mine", process.pid);
  const others = home("others", 1); // pid 1 exists but isn't ours: kill(1, 0) gives EPERM, which isn't "dead"
  sweepStaleSandboxes(base);
  expect(existsSync(gone)).toBe(false);
  expect(existsSync(kept)).toBe(true);
  expect(existsSync(mine)).toBe(true);
  expect(existsSync(others)).toBe(true);
});
