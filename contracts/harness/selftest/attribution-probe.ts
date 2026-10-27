// Run by candidate.test.ts inside the sandbox: fake candidates whose bin/parachute starts a listener. One runs a
// server inside its own folder; one hands off to a server outside it; one hands off with a cleaned environment
// (`env -i`), launched with no candidate PATH. The watcher must flag the hand-offs only. JSON on the last line.
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { enterSandbox } from "../sandbox.ts";
import { makeLaunchers, watchAttribution, type CandidateInfo } from "../candidate.ts";
await enterSandbox();
const server = (port: number) => `Bun.listen({ hostname: "127.0.0.1", port: ${port}, socket: { data() {} } }); setInterval(() => {}, 1000);\n`;

async function trial(kind: "inside" | "handOff" | "cleanHandOff", port: number): Promise<string[]> {
  const root = mkdtempSync("/tmp/attr-");
  const dir = join(root, "cand");
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "lib"), { recursive: true });
  mkdirSync(join(root, "runtime"));
  const bun = join(root, "runtime", "bun");
  symlinkSync(process.execPath, bun);
  writeFileSync(join(dir, "lib", "server.ts"), server(port));
  writeFileSync(join(root, "elsewhere.ts"), server(port));
  const body =
    kind === "inside" ? `exec "${bun}" "${dir}/lib/server.ts"` :
    kind === "handOff" ? `exec "${bun}" "${join(root, "elsewhere.ts")}" "${dir}/lib/server.ts"` :
    `exec env -i "${bun}" "${join(root, "elsewhere.ts")}"`;
  writeFileSync(join(dir, "bin", "parachute"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, "bin", "parachute"), 0o755);
  const launch = makeLaunchers(dir, root);
  const info = { dir, runtimeDir: join(root, "runtime"), ...launch } as CandidateInfo;
  const watch = watchAttribution(info);
  const env = kind === "cleanHandOff" ? { PATH: "/usr/bin:/bin" } : { PATH: `${dir}/bin:/usr/bin:/bin` };
  const p = Bun.spawn([info.bin], { stdout: "ignore", stderr: "ignore", env });
  await Bun.sleep(1500);
  const problems = watch.stop();
  p.kill("SIGKILL");
  await p.exited;
  return problems;
}
console.log(JSON.stringify({ inside: await trial("inside", 47801), handOff: await trial("handOff", 47802), cleanHandOff: await trial("cleanHandOff", 47803) }));
