// Run by candidate.test.ts inside the sandbox: two fake candidates, each a bin/parachute that starts a listener.
// One runs a server inside its own folder; the other hands off to a server outside it. The watcher must flag only
// the second. Prints JSON on the last line.
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { enterSandbox } from "../sandbox.ts";
import { watchAttribution, type CandidateInfo } from "../candidate.ts";
await enterSandbox();
const server = (port: number) => `Bun.listen({ hostname: "127.0.0.1", port: ${port}, socket: { data() {} } }); setInterval(() => {}, 1000);\n`;

async function trial(handOff: boolean, port: number): Promise<string[]> {
  const root = mkdtempSync("/tmp/attr-");
  const dir = join(root, "cand");
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "lib"), { recursive: true });
  mkdirSync(join(root, "runtime"));
  symlinkSync(process.execPath, join(root, "runtime", "bun"));
  writeFileSync(join(dir, "lib", "server.ts"), server(port));
  writeFileSync(join(root, "elsewhere.ts"), server(port));
  const target = handOff ? join(root, "elsewhere.ts") : join(dir, "lib", "server.ts");
  writeFileSync(join(dir, "bin", "parachute"), `#!/bin/sh\nexec "${join(root, "runtime", "bun")}" "${target}" "${dir}/lib/server.ts"\n`);
  chmodSync(join(dir, "bin", "parachute"), 0o755);
  const info = { dir, runtimeDir: join(root, "runtime") } as CandidateInfo;
  const watch = watchAttribution(info);
  // Launched the way the suites launch the candidate: its bin/ first on PATH (candidateEnv()).
  const p = Bun.spawn([join(dir, "bin", "parachute")], { stdout: "ignore", stderr: "ignore", env: { PATH: `${dir}/bin:/usr/bin:/bin` } });
  await Bun.sleep(1500);
  const problems = watch.stop();
  p.kill("SIGKILL");
  await p.exited;
  return problems;
}
console.log(JSON.stringify({ inside: await trial(false, 47801), handOff: await trial(true, 47802) }));
