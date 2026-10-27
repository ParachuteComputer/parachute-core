// Run by candidate.test.ts: enter the sandbox and report what it sees, as JSON on the last line.
// argv[2]: a Unix socket the test made on the host; the sandbox must not reach it.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { enterSandbox, listeningPorts, outboundPackets } from "../sandbox.ts";
await enterSandbox();
const links = Bun.spawnSync(["ip", "-o", "link", "show"]).stdout.toString().split("\n").filter(Boolean).map((l) => l.split(":")[1]!.trim());
const before = outboundPackets();
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
console.log(
  JSON.stringify({
    links,
    listening: listeningPorts(),
    before,
    after: outboundPackets(),
    pid: process.pid,
    hostSocket,
    repoWrite,
    userBus: uid ? existsSync(`/run/user/${uid}/bus`) : null,
    liveHome: existsSync(join(process.env.HOME ?? "/nonexistent", ".parachute")),
  }),
);
