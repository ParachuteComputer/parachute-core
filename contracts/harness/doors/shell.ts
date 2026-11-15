// `bun harness/doors/shell.ts <command...>`: run one command inside the sandbox (harness/sandbox.ts). For trying a
// door by hand; the runner (run.ts) is what a real run uses.
import { enterSandbox } from "../sandbox.ts";

await enterSandbox();
const p = Bun.spawn(process.argv.slice(2), { stdio: ["inherit", "inherit", "inherit"] });
process.exit(await p.exited);
