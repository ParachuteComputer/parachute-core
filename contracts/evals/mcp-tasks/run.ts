// The MCP description eval (T-318 design §4, "ship gate"): each task, on a fresh synthetic box, with the OLD tool
// descriptions and with the NEW ones, driven by real models. Writes one JSON line per run and a summary.
//
//   bun run.ts [--models opus,sonnet,haiku,codex] [--arms old,new] [--tasks t01,t02] [--repeats 3]
//              [--concurrency 4] [--out results/<name>]
//
// Claude models run through `claude -p` (this machine's Claude Code login): no built-in tools, no settings, our own
// short system prompt, and only two MCP servers: `vault` (proxy.ts, the arm under test) and `files` (one
// http_request tool, the same in both arms). `codex` runs OpenAI's default Codex model through `codex exec` with the
// same two servers.
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startBox, type Box } from "./box.ts";
import { connect } from "./mcp.ts";
import { RECEIPT } from "./fixture.ts";
import { TASKS, type Call, type Ctx, type Note } from "./tasks.ts";
import { summarize } from "./report.ts";

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : dflt;
};
const models = arg("models", "haiku").split(",");
const arms = arg("arms", "old,new").split(",") as ("old" | "new")[];
const taskIds = arg("tasks", "all");
const repeats = Number(arg("repeats", "1"));
const concurrency = Number(arg("concurrency", "4"));
const out = resolve(arg("out", join(import.meta.dir, "results", `run-${new Date().toISOString().replace(/[:.]/g, "-")}`)));
const timeoutMs = Number(arg("timeout", "420")) * 1000;
mkdirSync(out, { recursive: true });
const rowsFile = join(out, "runs.jsonl");

export const SYSTEM = `You are an agent working in a Parachute vault (a notes store) through the MCP tools of the server named "vault". Today is 2026-10-28.
Do the user's task with those tools. Don't ask questions; make reasonable choices.
End your final message with one line: ANSWER: <json>. Give notes as a JSON array of their paths, a count as a number, counts per group as a JSON object, one note's id or a link as a JSON string. If the task only changes the vault, end with ANSWER: "done".`;

const tasks = TASKS.filter((t) => !t.skip && (taskIds === "all" || taskIds.split(",").includes(t.id)));
const proxy = join(import.meta.dir, "proxy.ts");
const redact = (s: string) => s.replace(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g, "<jwt>");

interface Job {
  model: string;
  arm: "old" | "new";
  task: (typeof tasks)[number];
  rep: number;
}

function parseAnswer(text: string): unknown {
  const lines = text.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(/^\W*ANSWER:\s*(.*)$/);
    if (!m) continue;
    let raw = m[1]!.trim().replace(/^`+|`+$/g, "");
    // An ANSWER may run over several lines (a pretty-printed array or object).
    if (/^[[{]/.test(raw) && i < lines.length - 1) raw = [raw, ...lines.slice(i + 1)].join("\n").replace(/`+\s*$/, "");
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

async function drive(job: Job, box: Box, mcpConfig: string): Promise<{ text: string; usage: any; cost: number; turns: number; error?: string }> {
  const prompt = job.task.prompt({ receiptPath: join(box.dir, RECEIPT.filename) });
  if (job.model === "codex") return driveCodex(prompt, box, job.arm);
  const p = Bun.spawn(
    [
      "claude", "-p", prompt,
      "--model", job.model,
      "--tools", "",
      "--strict-mcp-config", "--mcp-config", mcpConfig,
      "--allowedTools", "mcp__vault,mcp__files",
      "--system-prompt", SYSTEM,
      "--setting-sources", "",
      "--output-format", "stream-json", "--verbose",
      "--max-turns", "30",
      "--permission-mode", "bypassPermissions",
    ],
    { cwd: box.dir, env: { ...process.env, ENABLE_TOOL_SEARCH: "false", MCP_TIMEOUT: "30000" }, stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  writeFileSync(join(box.dir, "transcript.jsonl"), stdout);
  const lines = stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = lines.find((l: any) => l.type === "system" && l.subtype === "init");
  const vaultTools = (init?.tools ?? []).filter((t: string) => t.startsWith("mcp__vault__"));
  const result = lines.find((l: any) => l.type === "result");
  if (!result) return { text: "", usage: {}, cost: 0, turns: 0, error: `no result (exit ${p.exitCode}): ${stderr.slice(-400)}` };
  if (!vaultTools.length || !(init?.tools ?? []).includes("mcp__files__http_request")) return { text: result.result ?? "", usage: result.usage, cost: result.total_cost_usd, turns: result.num_turns, error: "the vault or files tools were not loaded" };
  return { text: result.result ?? "", usage: result.usage ?? {}, cost: result.total_cost_usd ?? 0, turns: result.num_turns ?? 0, error: result.is_error ? `is_error: ${result.subtype}` : undefined };
}

async function driveCodex(prompt: string, box: Box, arm: string): Promise<{ text: string; usage: any; cost: number; turns: number; error?: string }> {
  const cfg = (name: string, args: string[]) => [
    "-c", `mcp_servers.${name}.command="${process.execPath}"`,
    "-c", `mcp_servers.${name}.args=${JSON.stringify(args)}`,
  ];
  const last = join(box.dir, "codex-last.txt");
  const p = Bun.spawn(
    [
      "codex", "exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config",
      "--sandbox", "read-only",
      "-c", 'approval_policy="never"', "-c", 'web_search="disabled"',
      "-c", 'mcp_servers.vault.default_tools_approval_mode="approve"',
      "-c", 'mcp_servers.files.default_tools_approval_mode="approve"',
      ...cfg("vault", [proxy, "vault", arm, box.mcpUrl, join(box.dir, "token"), join(box.dir, "calls.jsonl")]),
      ...cfg("files", [proxy, "files", join(box.dir, "calls.jsonl"), box.origin, join(box.dir, RECEIPT.filename)]),
      "-o", last,
      `${SYSTEM}\n\nDo not use a shell; use only the vault and files MCP tools.\n\nTask: ${prompt}`,
    ],
    { cwd: box.dir, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CODEX_HOME: codexHome(box) } },
  );
  const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  writeFileSync(join(box.dir, "transcript.jsonl"), stdout);
  const events = stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  let turns = 0;
  for (const e of events as any[]) {
    if (e.type === "turn.completed" && e.usage) {
      turns++;
      usage.input_tokens += e.usage.input_tokens ?? 0;
      usage.cached_input_tokens += e.usage.cached_input_tokens ?? 0;
      usage.output_tokens += e.usage.output_tokens ?? 0;
    }
  }
  const text = existsSync(last) ? readFileSync(last, "utf8") : "";
  // The run must use the MCP tools only: a shell command could reach the vault around the descriptions under test.
  const shell = (events as any[]).filter((e) => e.type === "item.completed" && e.item?.type === "command_execution").length;
  if (shell) return { text, usage, cost: 0, turns, error: `used the shell ${shell} times` };
  return { text, usage, cost: 0, turns, error: text ? undefined : `no final message (exit ${p.exitCode}): ${stderr.slice(-400)}` };
}

/** A clean CODEX_HOME per run: no user AGENTS.md, memories, skills or config; only a link to the login. */
function codexHome(box: Box): string {
  const home = join(box.dir, "codex-home");
  mkdirSync(home, { recursive: true });
  const auth = join(process.env.CODEX_HOME ?? join(process.env.HOME!, ".codex"), "auth.json");
  if (!existsSync(join(home, "auth.json"))) symlinkSync(auth, join(home, "auth.json"));
  return home;
}

async function runJob(job: Job): Promise<Record<string, unknown>> {
  const started = Date.now();
  const box = await startBox({ keep: !!process.env.EVAL_KEEP });
  try {
    writeFileSync(join(box.dir, RECEIPT.filename), RECEIPT.bytes);
    const calls = join(box.dir, "calls.jsonl");
    writeFileSync(calls, "");
    const mcpConfig = join(box.dir, "mcp.json");
    writeFileSync(
      mcpConfig,
      JSON.stringify({
        mcpServers: {
          vault: { command: process.execPath, args: [proxy, "vault", job.arm, box.mcpUrl, join(box.dir, "token"), calls] },
          files: { command: process.execPath, args: [proxy, "files", calls, box.origin, join(box.dir, RECEIPT.filename)] },
        },
      }),
    );
    const r = await drive(job, box, mcpConfig);
    const logged: Call[] = readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const vaultCalls = logged.filter((c) => c.server === "vault");
    const answer = parseAnswer(r.text);
    const op = await connect(box.mcpUrl, box.token);
    let cache: Note[] | null = null;
    const ctx: Ctx = {
      answer,
      text: r.text,
      calls: vaultCalls,
      receiptPath: join(box.dir, RECEIPT.filename),
      vault: op,
      async notes() {
        if (!cache) {
          const res: any = await op.call("query-notes", { limit: 1000, include_content: true, include_metadata: true });
          cache = Array.isArray(res) ? res : res.notes;
        }
        return cache!;
      },
      async fetchBytes(url) {
        const u = new URL(url);
        if (u.port !== new URL(box.origin).port) return null;
        const res = await fetch(u, { redirect: "manual" });
        return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
      },
      async tokenWorks(token) {
        try {
          const c = await connect(box.mcpUrl, token);
          await c.call("query-notes", { limit: 1 });
          await c.close();
          return true;
        } catch {
          return false;
        }
      },
    };
    let verdict: string | true;
    try {
      verdict = r.error && (!r.text || /used the shell/.test(r.error)) ? r.error : await job.task.check(ctx);
    } catch (err) {
      verdict = `oracle error: ${String((err as Error)?.message ?? err).slice(0, 300)}`;
    }
    await op.close();
    const u = r.usage ?? {};
    return {
      model: job.model,
      arm: job.arm,
      task: job.task.id,
      family: job.task.family,
      rep: job.rep,
      ok: verdict === true,
      why: verdict === true ? undefined : redact(String(verdict)).slice(0, 400),
      error: r.error,
      calls: vaultCalls.length,
      call_errors: vaultCalls.filter((c) => c.isError).length,
      tools_used: [...new Set(vaultCalls.map((c) => c.name))],
      error_texts: vaultCalls.filter((c) => c.isError).map((c) => redact(`${c.name}: ${c.result ?? ""}`).slice(0, 300)),
      input_tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      cached_tokens: u.cache_read_input_tokens ?? u.cached_input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cost_usd: r.cost,
      turns: r.turns,
      answer: redact(JSON.stringify(answer ?? null)).slice(0, 600),
      ms: Date.now() - started,
    };
  } finally {
    await box.stop();
  }
}

const jobs: Job[] = [];
for (let rep = 1; rep <= repeats; rep++) for (const task of tasks) for (const model of models) for (const arm of arms) jobs.push({ model, arm, task, rep });
console.log(`[mcp-tasks] ${jobs.length} runs: ${models.join(",")} × ${arms.join(",")} × ${tasks.length} tasks × ${repeats} → ${out}`);
let next = 0;
let done = 0;
async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++]!;
    let row: Record<string, unknown> = {};
    // A box that fails to start is the harness's problem, not the model's: try again, then record it apart.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        row = await runJob(job);
        break;
      } catch (err) {
        row = { model: job.model, arm: job.arm, task: job.task.id, family: job.task.family, rep: job.rep, ok: false, why: `harness: ${String((err as Error)?.message ?? err).slice(-400)}`, harness_error: true };
      }
    }
    appendFileSync(rowsFile, JSON.stringify(row) + "\n");
    done++;
    console.log(`[${done}/${jobs.length}] ${job.model} ${job.arm} ${job.task.id}#${job.rep} ${row.ok ? "ok" : `FAIL ${row.why}`} (${row.calls ?? "-"} calls, ${row.input_tokens ?? "-"} in)`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
writeFileSync(join(out, "SUMMARY.md"), summarize(readFileSync(rowsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))));
console.log(readFileSync(join(out, "SUMMARY.md"), "utf8"));
