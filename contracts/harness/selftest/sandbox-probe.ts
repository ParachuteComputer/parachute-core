// Run by candidate.test.ts: enter the sandbox and report what it sees, as JSON on the last line.
// argv[2]: a Unix socket the test made on the host; the sandbox must not reach it.
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { enterSandbox, listeningPorts, sandboxOutboundPackets } from "../sandbox.ts";
await enterSandbox();
const links = Bun.spawnSync(["ip", "-o", "link", "show"]).stdout.toString().split("\n").filter(Boolean).map((l) => l.split(":")[1]!.trim());
const before = await sandboxOutboundPackets();
// A connection to a documentation address: it can't go anywhere, but the trap must count it.
await new Promise<void>((done) => {
  const s = connect(443, "198.51.100.1");
  s.on("error", () => done());
  setTimeout(() => (s.destroy(), done()), 1500);
});
const hostSocket = await new Promise<string>((done) => {
  const s = connect(process.argv[2]!);
  s.on("connect", () => (s.destroy(), done("connected")));
  s.on("error", (e: NodeJS.ErrnoException) => done(e.code ?? "error"));
});
let repoWrite = "written";
try {
  writeFileSync(join(import.meta.dir, "..", "..", ".sandbox-write-probe"), "x");
} catch (e) {
  repoWrite = (e as NodeJS.ErrnoException).code ?? "error";
}
const uid = process.env.PCORE_HOST_UID;
// Try to undo the covers the way a hostile candidate would: every attempt must fail.
const tryRun = (cmd: string[]) => Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
const repo = join(import.meta.dir, "..", "..");
const escapes = {
  umountTmp: tryRun(["umount", "/tmp"]) || tryRun(["umount", "-l", "/tmp"]),
  umountHome: tryRun(["umount", "-l", process.env.HOME ?? "/nonexistent"]),
  umountRun: tryRun(["umount", "-l", "/run"]),
  remountRepoRw: tryRun(["mount", "-o", "remount,bind,rw", repo]),
  stagingLeft: existsSync("/run/pcore-stage"),
};
console.log(
  JSON.stringify({
    links,
    listening: listeningPorts(),
    before,
    after: await sandboxOutboundPackets(),
    processes: readdirSync("/proc").filter((d) => /^\d+$/.test(d)).length,
    hostSocket,
    repoWrite,
    userBus: uid ? existsSync(`/run/user/${uid}/bus`) : null,
    liveHome: existsSync(join(process.env.HOME ?? "/nonexistent", ".parachute")),
    escapes,
  }),
);
