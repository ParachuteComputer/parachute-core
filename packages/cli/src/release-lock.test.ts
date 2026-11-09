// The release lock (release.ts withReleaseLock) between two processes. lifecycle/upgrade holds it end to end ("two
// 0.9 commands opening a 0.8 home at once take one backup between them"), but there the deadlock below only shows
// when the two commands' lock attempts interleave just so, about once in a few CI runs (both killed at 60 s).
// Here the interleaving is set up on purpose.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELEASE_LOCK } from "./release.ts";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("a command waiting for the release lock holds nothing while it waits, so the one ahead of it can finish", async () => {
  const home = mkdtempSync(join(tmpdir(), "pcore-release-lock-"));
  made.push(home);
  mkdirSync(join(home, "run"));
  // The command ahead: it has begun taking the lock (RESERVED), as BEGIN EXCLUSIVE does before it waits out readers.
  const ahead = new Database(join(home, RELEASE_LOCK), { create: true });
  ahead.exec("CREATE TABLE IF NOT EXISTS hold (pid INTEGER)");
  ahead.exec("PRAGMA busy_timeout = 3000");
  ahead.exec("BEGIN IMMEDIATE");
  ahead.exec("INSERT INTO hold VALUES (1)");

  // The second command asks for the lock now and waits.
  const releaseTs = join(import.meta.dir, "release.ts");
  const second = Bun.spawn(
    ["bun", "-e", `const { withReleaseLock } = await import(${JSON.stringify(releaseTs)}); console.log(withReleaseLock(${JSON.stringify(home)}, () => "held", 10_000));`],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    await Bun.sleep(1_000); // the second command is inside its wait

    // The command ahead finishes taking the lock (EXCLUSIVE: no reader may remain). A waiter that kept its read lock
    // while waiting blocks this, and each then waits for the other until both time out.
    expect(() => ahead.exec("COMMIT")).not.toThrow();
    ahead.close();

    expect(await second.exited).toBe(0);
    expect((await new Response(second.stdout).text()).trim()).toBe("held");
  } finally {
    second.kill();
    ahead.close();
  }
}, 30_000);
