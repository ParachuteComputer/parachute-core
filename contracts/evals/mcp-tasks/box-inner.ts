// Runs INSIDE a private network namespace (`unshare -rn`, started by box.ts). It makes a throwaway box from this
// checkout's own `parachute` (create a vault, `serve`, mint an admin pass), seeds the synthetic vault, and opens a
// unix-socket bridge so the runner outside can reach the hub. Inside the namespace only loopback exists, so the
// box's vault port (1940 by default) is the namespace's own and can never meet a live install.
//
//   bun box-inner.ts <dir> <port> <socket>
// Prints one line `READY {json}` on stdout, then serves until stdin closes or SIGTERM.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NOTES, TYPES, TRIP_PLAN_EDIT, VOICE_MEMO } from "./fixture.ts";

const [dir, portArg, sock] = process.argv.slice(2);
if (!dir || !portArg || !sock) throw new Error("usage: bun box-inner.ts <dir> <port> <socket>");
const port = Number(portArg);
const origin = `http://127.0.0.1:${port}`;
const vault = "eval";
const bin = resolve(import.meta.dir, "../../../packages/cli/bin");

const user = join(dir, "u");
const home = join(user, ".parachute");
mkdirSync(join(user, "tmp"), { recursive: true });
const env = {
  PATH: `${bin}:${process.env.PATH}`,
  HOME: user,
  PARACHUTE_HOME: home,
  TMPDIR: join(user, "tmp"),
  LANG: "C.UTF-8",
  PORT: String(port),
  PARACHUTE_HUB_ORIGIN: origin,
  EMBEDDINGS_ENABLED: "false",
};

async function run(args: string[]): Promise<string> {
  const p = Bun.spawn([join(bin, "parachute"), ...args], { env, cwd: user, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`parachute ${args.join(" ")} failed (${code}): ${err.slice(-800)}`);
  return out;
}

const lo = Bun.spawnSync(["ip", "link", "set", "lo", "up"], { stderr: "pipe" });
if (lo.exitCode !== 0) {
  console.error(`BOX-ERROR ip link set lo up failed (${lo.exitCode}): ${lo.stderr.toString()}`);
  process.exit(1);
}

{
  const p = Bun.spawnSync([join(bin, "parachute-vault"), "create", vault, "--no-mirror", "--json"], { env, cwd: user, stderr: "pipe" });
  if (p.exitCode !== 0) {
    console.error(`BOX-ERROR parachute-vault create failed (${p.exitCode}): ${p.stderr.toString().slice(-600).replace(/\n/g, " | ")}`);
    process.exit(1);
  }
}
const serveLog = Bun.file(join(dir, "serve.log"));
const serve = Bun.spawn([join(bin, "parachute"), "serve"], {
  env: { ...env, PARACHUTE_BIND_HOST: "127.0.0.1", PARACHUTE_INITIAL_ADMIN_USERNAME: "owner", PARACHUTE_INITIAL_ADMIN_PASSWORD: `pw-${crypto.randomUUID()}` },
  cwd: user,
  stdout: serveLog,
  stderr: serveLog,
});
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  serve.kill("SIGTERM");
  await Promise.race([serve.exited, Bun.sleep(5000)]);
  serve.kill("SIGKILL");
  process.exit(code);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

async function waitUp() {
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`${origin}/vault/${vault}/mcp`, { method: "POST" });
      if (r.status === 401) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("the box did not come up");
}

try {
  await waitUp();
  await run(["auth", "rotate-operator"]);
  const scope = ["read", "write", "admin"].map((l) => `vault:${vault}:${l}`).join(" ");
  const token = (await run(["auth", "mint-token", "--scope", scope, "--label", "eval-operator"])).trim().split("\n").pop()!.trim();

  // Seed through MCP, the way any client would.
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "mcp-tasks-seed", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/vault/${vault}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    const text = (r.content ?? []).map((c: any) => c.text ?? "").join("");
    if (r.isError) throw new Error(`seed ${name}: ${text.slice(0, 500)}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  for (const t of TYPES) await call("update-tag", t);
  await call("create-note", { notes: NOTES });
  const trip = NOTES.find((n) => n.path === TRIP_PLAN_EDIT.path)!;
  await call("update-note", { id: trip.path, content: trip.content.replace(TRIP_PLAN_EDIT.find, TRIP_PLAN_EDIT.replace), force: true });
  const ticket = await call("request-attachment-upload", { note: VOICE_MEMO.note, filename: VOICE_MEMO.filename, size_bytes: VOICE_MEMO.bytes.length });
  const up = await fetch(ticket.url, { method: "PUT", headers: { "content-type": "audio/mp4" }, body: VOICE_MEMO.bytes });
  if (!up.ok) throw new Error(`seed upload: ${up.status} ${await up.text()}`);
  await client.close();

  // The bridge: unix socket → the hub on loopback, inside the namespace.
  Bun.serve({
    unix: sock,
    async fetch(req) {
      const u = new URL(req.url);
      // The runner's one way to reach the box's CLI: mint a pass at a level (for scope-specific snapshots).
      if (u.pathname === "/__eval/mint") {
        const level = u.searchParams.get("level");
        if (level !== "read" && level !== "write" && level !== "admin") return new Response("bad level", { status: 400 });
        const scopes = ["read", "write", "admin"].slice(0, ["read", "write", "admin"].indexOf(level) + 1);
        const t = (await run(["auth", "mint-token", "--scope", scopes.map((l) => `vault:${vault}:${l}`).join(" "), "--label", `eval-${level}`])).trim().split("\n").pop()!;
        return new Response(t);
      }
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
      return fetch(`${origin}${u.pathname}${u.search}`, { method: req.method, headers: req.headers, body, redirect: "manual" });
    },
  });
  writeFileSync(join(dir, "token"), token, { mode: 0o600 });
  console.log(`READY ${JSON.stringify({ origin, vault })}`);
  // Stay up until the runner closes our stdin.
  for await (const _ of Bun.stdin.stream()) {
  }
  await stop();
} catch (err) {
  console.error(`BOX-ERROR ${String((err as Error)?.message ?? err).replace(/\n/g, " | ")}`);
  await stop(1);
}
