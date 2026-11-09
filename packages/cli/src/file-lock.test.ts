// The file lock (file-lock.ts) between two processes, through both its callers: the release lock (release.ts) and
// the keys lock (keys.ts). The contracts hold them end to end (lifecycle/upgrade "two 0.9 commands opening a 0.8
// home at once", lifecycle/front-door "two at once with one new name"), but there the deadlock below shows only when
// the two commands' lock attempts interleave just so: then both wait out their timeouts and fail. Here the
// interleaving is set up on purpose.
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

const src = (f: string) => JSON.stringify(join(import.meta.dir, f));
const takers = {
  "the release lock": (home: string, file: string) =>
    `const { withReleaseLock } = await import(${src("release.ts")}); console.log(withReleaseLock(${JSON.stringify(home)}, () => "held", 10_000));`,
  "the keys lock (keys.ts takes it this way)": (_home: string, file: string) =>
    `const { takeFileLock } = await import(${src("file-lock.ts")}); takeFileLock(${JSON.stringify(file)}, 10_000); console.log("held");`,
};

for (const [what, script] of Object.entries(takers)) {
  test(`${what}: a command waiting for it holds nothing while it waits, so the one ahead of it can finish`, async () => {
    const home = mkdtempSync(join(tmpdir(), "pcore-file-lock-"));
    made.push(home);
    mkdirSync(join(home, "run"));
    const file = join(home, RELEASE_LOCK);
    // The command ahead: it has begun taking the lock (RESERVED), as BEGIN EXCLUSIVE does before it waits out readers.
    const ahead = new Database(file, { create: true });
    ahead.exec("CREATE TABLE IF NOT EXISTS hold (pid INTEGER)");
    ahead.exec("PRAGMA busy_timeout = 3000");
    ahead.exec("BEGIN IMMEDIATE");
    ahead.exec("INSERT INTO hold VALUES (1)");

    // The second command asks for the lock now and waits.
    const second = Bun.spawn(["bun", "-e", script(home, file)], { stdout: "pipe", stderr: "pipe" });
    try {
      await Bun.sleep(1_000); // the second command is inside its wait

      // The command ahead finishes taking the lock (EXCLUSIVE: no reader may remain). A waiter that kept its read
      // lock while waiting blocks this, and each then waits for the other until both time out.
      expect(() => ahead.exec("COMMIT")).not.toThrow();
      ahead.close();

      expect(await second.exited).toBe(0);
      expect((await new Response(second.stdout).text()).trim()).toBe("held");
    } finally {
      second.kill();
      ahead.close();
    }
  }, 30_000);
}
