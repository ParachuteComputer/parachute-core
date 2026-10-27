// Run by candidate.test.ts: enter the sandbox and report what it sees, as JSON on the last line.
import { enterSandbox, listeningPorts, outboundPackets } from "../sandbox.ts";
await enterSandbox();
const links = Bun.spawnSync(["ip", "-o", "link", "show"]).stdout.toString().split("\n").filter(Boolean).map((l) => l.split(":")[1]!.trim());
const before = outboundPackets();
// A connection to a documentation address: it can't go anywhere, but the trap must count it.
await new Promise<void>((done) => {
  const s = require("node:net").connect(443, "198.51.100.1");
  s.on("error", () => done());
  setTimeout(() => (s.destroy(), done()), 1500);
});
console.log(JSON.stringify({ links, listening: listeningPorts(), before, after: outboundPackets(), pid: process.pid }));
