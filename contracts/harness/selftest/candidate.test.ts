// The candidate adapter's own checks: it refuses bytes that aren't the build, and its sandbox is private and its
// outbound trap counts (harness/candidate.ts, harness/sandbox.ts).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCandidate, MANIFEST, notCandidate, treeHash } from "../candidate.ts";

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

describe("candidate adapter: closed tree and attribution", () => {
  test("a link that points outside the candidate is refused, so outside code can't run unhashed", async () => {
    const d = await fakeCandidate("linked-out");
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(d, "lib"));
    await expect(treeHash(d)).rejects.toThrow(/lib links outside the candidate/);
  });

  test("a link inside the candidate is fine", async () => {
    const d = await fakeCandidate("linked-in");
    symlinkSync("parachute", join(d, "bin", "alias"));
    expect(await treeHash(d)).toHaveLength(64);
  });

  test("a process counts as the candidate only by its executable or the script Bun runs", async () => {
    const d = await fakeCandidate("attribution");
    const dir = realpathSync(d);
    const bun = "/opt/bun/bin/bun";
    const p = (exe: string, cmdline: string[]) => notCandidate({ pid: 1, exe, cmdline, cwd: "/" }, { dir, bun });
    expect(p(bun, ["bun", `${dir}/bin/parachute`, "serve"])).toBeNull();
    expect(p(`${dir}/bin/parachute`, [`${dir}/bin/parachute`, "serve"])).toBeNull();
    // A global install with a candidate path tacked on as an argument is not the candidate.
    expect(p(bun, ["bun", "/home/x/.bun/install/global/node_modules/@openparachute/hub/src/cli.ts", "serve", `${dir}/bin/parachute`])).toMatch(/outside the candidate/);
    expect(p("/usr/bin/python3", ["python3", `${dir}/bin/parachute`])).toMatch(/neither the candidate nor the run's Bun/);
  });
});

describe("sandbox", () => {
  test("is a private network with nothing listening, its trap counts a packet that tries to leave, and host sockets and files are out of reach", async () => {
    // A Unix socket on the host, like a session bus or a tmux server: the sandbox must not reach it.
    const sock = join(root, "host.sock");
    const server = Bun.listen({ unix: sock, socket: { data() {} } });
    const outside = await new Promise<string>((done) => {
      const c = require("node:net").connect(sock);
      c.on("connect", () => (c.destroy(), done("connected")));
      c.on("error", (e: NodeJS.ErrnoException) => done(e.code ?? "error"));
    });
    const p = Bun.spawn(["bun", join(import.meta.dir, "sandbox-probe.ts"), sock], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PCORE_SANDBOX: "" } });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code, err).toBe(0);
    const r = JSON.parse(out.trim().split("\n").pop()!);
    expect(r.links.sort()).toEqual(["lo", "pctrap0"]);
    expect(r.listening).toEqual([]);
    expect(r.after).toBeGreaterThan(r.before);
    expect(r.processes).toBeLessThan(20); // its own PID space: only the sandbox's few processes are visible
    server.stop(true);
    expect(outside).toBe("connected"); // control: the socket answers from the host
    expect(r.hostSocket).toBe("ENOENT");
    expect(r.repoWrite).toBe("EROFS");
    expect(r.userBus).not.toBe(true);
    expect(r.liveHome).toBe(false);
    // Nothing the candidate runs as can take the covers off, make the repo writable, or find the staging aliases.
    expect(r.escapes).toEqual({ umountTmp: false, umountHome: false, umountRun: false, remountRepoRw: false, stagingLeft: false });
  }, 30_000);
});

describe("attribution during a run", () => {
  test("a listener a candidate launch hands off to outside the candidate is flagged, even with a cleaned environment; one inside is not", async () => {
    const p = Bun.spawn(["bun", join(import.meta.dir, "attribution-probe.ts")], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PCORE_SANDBOX: "" } });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code, err).toBe(0);
    const r = JSON.parse(out.trim().split("\n").pop()!);
    expect(r.inside).toEqual([]);
    expect(r.handOff.length).toBe(1);
    expect(r.handOff[0]).toMatch(/outside the candidate/);
    expect(r.cleanHandOff.length).toBe(1);
    expect(r.cleanHandOff[0]).toMatch(/outside the candidate/);
  }, 30_000);
});
