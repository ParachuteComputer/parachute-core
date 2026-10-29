// One throwaway, seeded box per eval run, reachable from outside on 127.0.0.1:<port>.
// The box runs in its own network namespace (box-inner.ts); this side listens on the same port number and forwards
// every request over a unix socket, so URLs the box hands out (upload and download tickets) work from here too.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Box {
  origin: string;
  vault: string;
  mcpUrl: string;
  token: string;
  dir: string;
  /** Mint a pass for this vault at one level, with the box's own CLI (run inside its namespace). */
  mint(level: "read" | "write" | "admin"): Promise<string>;
  stop(): Promise<void>;
}

const LIVE_PORTS = new Set([1939, 1940, 1941, 1942, 1943, 1944, 1945, 1946]);

function freePort(): number {
  for (let i = 0; i < 200; i++) {
    const p = 47000 + Math.floor(Math.random() * 2500);
    if (LIVE_PORTS.has(p)) continue;
    try {
      const s = Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {} } });
      s.stop(true);
      return p;
    } catch {}
  }
  throw new Error("no free port");
}

export async function startBox(opts: { keep?: boolean } = {}): Promise<Box> {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mcp-tasks-"));
  const sock = join(dir, "bridge.sock");
  const inner = join(import.meta.dir, "box-inner.ts");
  for (let attempt = 0; ; attempt++) {
    const port = freePort();
    const proc = Bun.spawn(["unshare", "-rn", process.execPath, inner, dir, String(port), sock], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: dir,
    });
    const reader = proc.stdout.getReader();
    let buf = "";
    const deadline = Date.now() + 60_000;
    let ready: { origin: string; vault: string } | null = null;
    let pending = reader.read();
    while (!ready && Date.now() < deadline) {
      const r = await Promise.race([pending, Bun.sleep(1000).then(() => null)]);
      if (r === null) continue;
      if (r.done) break;
      pending = reader.read();
      buf += new TextDecoder().decode(r.value);
      const m = buf.match(/^READY (.*)$/m);
      if (m) ready = JSON.parse(m[1]!);
    }
    if (!ready) {
      const err = await new Response(proc.stderr).text().catch(() => "");
      proc.kill("SIGKILL");
      if (attempt < 2) continue;
      throw new Error(`the box did not start: ${err.slice(-1500)}`);
    }
    let server: ReturnType<typeof Bun.serve>;
    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        idleTimeout: 0,
        async fetch(req) {
          const u = new URL(req.url);
          const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
          return fetch(`http://box${u.pathname}${u.search}`, { unix: sock, method: req.method, headers: req.headers, body, redirect: "manual" } as any);
        },
      });
    } catch {
      proc.kill("SIGTERM");
      if (attempt < 2) continue;
      throw new Error("the outside port was taken");
    }
    const token = readFileSync(join(dir, "token"), "utf8");
    return {
      origin: ready.origin,
      vault: ready.vault,
      mcpUrl: `${ready.origin}/vault/${ready.vault}/mcp`,
      token,
      dir,
      async mint(level) {
        const r = await fetch(`${ready!.origin}/__eval/mint?level=${level}`);
        if (!r.ok) throw new Error(`mint ${level}: ${r.status} ${await r.text()}`);
        return (await r.text()).trim();
      },
      async stop() {
        server.stop(true);
        try {
          proc.stdin.end();
        } catch {}
        await Promise.race([proc.exited, Bun.sleep(8000)]);
        if (proc.exitCode === null) proc.kill("SIGKILL");
        if (!opts.keep) rmSync(dir, { recursive: true, force: true });
      },
    };
  }
}
