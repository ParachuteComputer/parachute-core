// `parachute probe` (also `parachute-core probe`): check that one vault on a box really opens and answers, below the
// router (audit L6-03). A hub `/health` says the process is up; it never opens a vault. The probe goes the way a
// client goes, through the hub, with a read-only pass for one vault (a canary vault, docs/probe/README.md):
//
//   health          GET  <url>/health                                the hub answers
//   vault-health    GET  <url>/vault/<name>/api/health               the hub routes to this vault, the pass is taken
//   read            GET  <url>/vault/<name>/api/notes?limit=1        a REST read: the vault's database opens
//                   (or ?id=<note> with --note: that note exists)
//   mcp-initialize  POST <url>/vault/<name>/mcp  initialize           the vault's MCP door answers
//   mcp-tools-list  POST <url>/vault/<name>/mcp  tools/list           and lists at least one tool
//
// It prints one line and exits 0 when every step passes, 1 at the first step that fails (named, with its HTTP status
// or a reason), and 2 when it is set up wrong. The line never holds note content or the pass, and nothing the server
// sent is echoed: only step names, statuses, counts and timings. It never follows a redirect (a bounced request
// would carry the pass elsewhere), and it touches no Parachute home.
//
// The pass comes from PARACHUTE_PROBE_TOKEN or --token-file <path>, never from an argument: arguments show in `ps`.
// It runs from anywhere (a systemd timer, cron, another machine on the tailnet); docs/probe/ has user units.
import { readFileSync } from "node:fs";
import core from "../../../package.json" with { type: "json" };

export const PROBE_USAGE = `usage: parachute probe --url <hub url> --vault <name> [--token-file <path>] [--note <id or path>] [--timeout <ms>]

  --url          the hub's origin, e.g. http://127.0.0.1:1939 (or PARACHUTE_PROBE_URL)
  --vault        the vault to open, e.g. canary (or PARACHUTE_PROBE_VAULT)
  --token-file   a file holding a read-only pass for that vault; else PARACHUTE_PROBE_TOKEN
  --note         also require this note (id or path) to be readable (or PARACHUTE_PROBE_NOTE)
  --timeout      milliseconds per request (default 10000)

Steps: health, vault-health, read, mcp-initialize, mcp-tools-list. One line out; exit 0 ok, 1 a step failed, 2 a
setup error. Mint the pass with \`parachute auth mint-token --scope vault:<name>:read --label probe\`.`;

interface Config {
  url: string;
  vault: string;
  token: string;
  note?: string;
  timeoutMs: number;
}

/** A step that failed: its name and an HTTP status, or a reason of our own words (never the server's). */
class StepFailed extends Error {
  constructor(
    readonly step: string,
    readonly detail: string,
  ) {
    super(`${step} ${detail}`);
  }
}

/** Read the configuration from arguments and the environment, or return why it can't run (exit 2). */
export function probeConfig(args: string[], env: Record<string, string | undefined>): Config | { error: string } {
  const flags: Record<string, string> = {};
  const known = new Set(["--url", "--vault", "--token-file", "--note", "--timeout"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const [name, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    if (name === "--token" || name === "--bearer") {
      return { error: `${name} is refused: an argument shows in \`ps\`. Put the pass in PARACHUTE_PROBE_TOKEN or a file named by --token-file` };
    }
    if (!known.has(name)) return { error: `unknown argument ${JSON.stringify(name.slice(0, 40))}` };
    const value = inline ?? args[++i];
    if (value === undefined || value === "") return { error: `${name} needs a value` };
    flags[name] = value;
  }
  const url = (flags["--url"] ?? env.PARACHUTE_PROBE_URL ?? "").replace(/\/+$/, "");
  const vault = flags["--vault"] ?? env.PARACHUTE_PROBE_VAULT ?? "";
  const note = flags["--note"] ?? (env.PARACHUTE_PROBE_NOTE || undefined);
  if (!url) return { error: "no hub url: pass --url or set PARACHUTE_PROBE_URL" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "--url is not a URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { error: "--url must be http:// or https://" };
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return { error: "--url must be an origin (and path), with no credentials, query or fragment" };
  if (!vault) return { error: "no vault: pass --vault or set PARACHUTE_PROBE_VAULT" };
  // A vault's own name rule (packages/vault/src/vault-name.ts), so the name is safe in a URL and in the line.
  if (!/^[a-z0-9_-]+$/.test(vault)) return { error: "--vault must be lowercase letters, digits, - and _" };
  const timeoutMs = flags["--timeout"] === undefined ? 10_000 : Number(flags["--timeout"]);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) return { error: "--timeout must be whole milliseconds, 1 to 300000" };
  let token: string;
  if (flags["--token-file"] !== undefined) {
    try {
      token = readFileSync(flags["--token-file"], "utf8").trim();
    } catch (e) {
      return { error: `can't read --token-file (${(e as NodeJS.ErrnoException).code ?? "error"})` };
    }
    if (!token) return { error: "--token-file is empty" };
  } else {
    token = (env.PARACHUTE_PROBE_TOKEN ?? "").trim();
    if (!token) return { error: "no pass: set PARACHUTE_PROBE_TOKEN or pass --token-file <path>" };
  }
  if (/\s/.test(token)) return { error: "the pass holds whitespace: put only the token in it" };
  return { url, vault, token, note, timeoutMs };
}

/** One request, bounded in time, never redirected. Network failures become a step failure with our own reason. */
async function call(step: string, cfg: Config, path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`${cfg.url}${path}`, { ...init, redirect: "manual", signal: AbortSignal.timeout(cfg.timeoutMs) });
  } catch (e) {
    const name = (e as Error).name;
    throw new StepFailed(step, name === "TimeoutError" || name === "AbortError" ? `timeout after ${cfg.timeoutMs}ms` : "unreachable");
  }
}

/** The body of a 2xx reply as text; any other status, or a body cut off, is the step's failure. */
async function body(step: string, r: Response): Promise<string> {
  if (r.status < 200 || r.status > 299) {
    await r.body?.cancel().catch(() => {});
    throw new StepFailed(step, `status ${r.status}`);
  }
  try {
    return await r.text();
  } catch {
    throw new StepFailed(step, `status ${r.status}, reply cut off`);
  }
}

async function json(step: string, r: Response): Promise<any> {
  const text = await body(step, r);
  try {
    return JSON.parse(text);
  } catch {
    throw new StepFailed(step, `status ${r.status} with a body that is not JSON`);
  }
}

/** A JSON-RPC reply from the MCP door: a JSON body, or the message with this id in an event stream. */
async function rpc(step: string, r: Response, id: number): Promise<any> {
  const type = r.headers.get("content-type") ?? "";
  const text = await body(step, r);
  let msg: any;
  try {
    if (type.includes("text/event-stream")) {
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const m = JSON.parse(line.slice(5));
        if (m?.id === id) msg = m;
      }
    } else msg = JSON.parse(text);
  } catch {
    throw new StepFailed(step, `status ${r.status} with a reply that is not JSON-RPC`);
  }
  if (!msg || msg.id !== id) throw new StepFailed(step, `status ${r.status} with no reply to request ${id}`);
  if (msg.error) throw new StepFailed(step, `status ${r.status} json-rpc error ${Number(msg.error.code) || "?"}`);
  return msg.result;
}

/** Run the steps; resolves to the line to print and the exit code. */
export async function runProbe(cfg: Config): Promise<{ line: string; code: 0 | 1 }> {
  const times: string[] = [];
  const t0 = performance.now();
  let current = "health";
  const timed = async <T>(step: string, fn: () => Promise<T>): Promise<T> => {
    current = step;
    const s = performance.now();
    try {
      return await fn();
    } finally {
      times.push(`${step}=${Math.round(performance.now() - s)}ms`);
    }
  };
  const auth = { authorization: `Bearer ${cfg.token}` };
  const vaultPath = `/vault/${encodeURIComponent(cfg.vault)}`;
  const mcpHeaders = { ...auth, "content-type": "application/json", accept: "application/json, text/event-stream" };
  let tools = 0;
  try {
    await timed("health", async () => {
      const body = await json("health", await call("health", cfg, "/health"));
      if (body?.status !== "ok") throw new StepFailed("health", "answered, but not status ok");
    });
    await timed("vault-health", async () => {
      const body = await json("vault-health", await call("vault-health", cfg, `${vaultPath}/api/health`, { headers: auth }));
      if (body?.vault !== cfg.vault) throw new StepFailed("vault-health", "answered for another vault");
    });
    await timed("read", async () => {
      const q = cfg.note === undefined ? "limit=1&include_content=false" : `id=${encodeURIComponent(cfg.note)}&include_content=false`;
      const body = await json("read", await call("read", cfg, `${vaultPath}/api/notes?${q}`, { headers: auth }));
      const ok = cfg.note === undefined ? Array.isArray(body) || Array.isArray(body?.notes) : typeof body?.id === "string";
      if (!ok) throw new StepFailed("read", "answered with an unexpected shape");
    });
    let session: string | null = null;
    let protocol = "2025-06-18";
    await timed("mcp-initialize", async () => {
      const r = await call("mcp-initialize", cfg, `${vaultPath}/mcp`, {
        method: "POST",
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: protocol, capabilities: {}, clientInfo: { name: "parachute-probe", version: core.version } },
        }),
      });
      session = r.headers.get("mcp-session-id");
      const result = await rpc("mcp-initialize", r, 1);
      if (typeof result?.protocolVersion !== "string") throw new StepFailed("mcp-initialize", "answered with no protocol version");
      protocol = result.protocolVersion;
    });
    await timed("mcp-tools-list", async () => {
      const headers: Record<string, string> = { ...mcpHeaders, "mcp-protocol-version": protocol };
      if (session) headers["mcp-session-id"] = session;
      const note = await call("mcp-tools-list", cfg, `${vaultPath}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      await note.body?.cancel().catch(() => {});
      if (note.status >= 300) throw new StepFailed("mcp-tools-list", `status ${note.status} on notifications/initialized`);
      const r = await call("mcp-tools-list", cfg, `${vaultPath}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      const result = await rpc("mcp-tools-list", r, 2);
      tools = Array.isArray(result?.tools) ? result.tools.length : 0;
      if (tools === 0) throw new StepFailed("mcp-tools-list", "listed no tools");
    });
  } catch (e) {
    // Anything we didn't foresee still ends as one line naming the step, with the error's kind but not its text.
    const failed = e instanceof StepFailed ? e : new StepFailed(current, `unexpected ${(e as Error)?.name ?? "error"}`);
    const total = Math.round(performance.now() - t0);
    return { line: `probe FAIL vault=${cfg.vault} step=${failed.step}: ${failed.detail} (${times.join(" ")} total=${total}ms)`, code: 1 };
  }
  const total = Math.round(performance.now() - t0);
  return { line: `probe ok vault=${cfg.vault} ${times.join(" ")} tools=${tools} total=${total}ms`, code: 0 };
}

/** `parachute probe <args>`: returns the exit code. */
export async function probe(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(PROBE_USAGE);
    return 0;
  }
  const cfg = probeConfig(args, process.env);
  if ("error" in cfg) {
    console.error(`parachute probe: ${cfg.error} (see parachute probe --help)`);
    return 2;
  }
  const { line, code } = await runProbe(cfg);
  (code === 0 ? console.log : console.error)(line);
  return code;
}
