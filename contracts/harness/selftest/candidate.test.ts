// The candidate adapter's own checks: it refuses bytes that aren't the build, and its sandbox is private and its
// outbound trap counts (harness/candidate.ts, harness/sandbox.ts).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCandidate, MANIFEST, treeHash } from "../candidate.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pcore-candidate-selftest-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function fakeCandidate(name: string): Promise<string> {
  const d = join(root, name);
  mkdirSync(join(d, "bin"), { recursive: true });
  writeFileSync(join(d, "bin", "parachute"), "#!/bin/sh\necho hub\n");
  writeFileSync(join(d, "bin", "parachute-vault"), "#!/bin/sh\necho vault\n");
  writeFileSync(join(d, MANIFEST), JSON.stringify({ profile: "stock-0.7", process_model: "child", sha256: await treeHash(d) }));
  return d;
}

describe("candidate adapter", () => {
  test("a candidate whose files match its manifest loads", async () => {
    const d = await fakeCandidate("ok");
    expect((await loadCandidate(d)).sha256).toHaveLength(64);
  });

  test("one changed byte is refused", async () => {
    const d = await fakeCandidate("tampered");
    writeFileSync(join(d, "bin", "parachute"), "#!/bin/sh\necho Hub\n");
    await expect(loadCandidate(d)).rejects.toThrow(/files hash to .* but CANDIDATE.json says/);
  });

  test("a candidate that isn't the one CI built is refused", async () => {
    const d = await fakeCandidate("other");
    process.env.CANDIDATE_SHA256 = "0".repeat(64);
    try {
      await expect(loadCandidate(d)).rejects.toThrow(/but this CI build produced/);
    } finally {
      delete process.env.CANDIDATE_SHA256;
    }
  });
});

describe("sandbox", () => {
  test("is a private network with nothing listening, and its trap counts a packet that tries to leave", async () => {
    const p = Bun.spawn(["bun", join(import.meta.dir, "sandbox-probe.ts")], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PCORE_SANDBOX: "" } });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code, err).toBe(0);
    const r = JSON.parse(out.trim().split("\n").pop()!);
    expect(r.links.sort()).toEqual(["lo", "pctrap0"]);
    expect(r.listening).toEqual([]);
    expect(r.after).toBeGreaterThan(r.before);
    expect(r.pid).toBeLessThan(10); // its own PID space
  }, 30_000);
});
