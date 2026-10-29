// Turn runs.jsonl rows into the summary table: per model and arm, success, calls per task and tokens; then each task
// where the arms differ. `bun report.ts <runs.jsonl>...` prints it for one or more result files.
import { readFileSync } from "node:fs";

type Row = Record<string, any>;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

export function summarize(rows: Row[]): string {
  rows = rows.filter((r) => !r.harness_error);
  const models = [...new Set(rows.map((r) => r.model))];
  const lines: string[] = [];
  lines.push("| model | arm | success | runs | calls / task | input tokens / task | output tokens / task | cost (list $) |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|");
  for (const m of models) {
    for (const arm of ["old", "new"]) {
      const rs = rows.filter((r) => r.model === m && r.arm === arm);
      if (!rs.length) continue;
      const ok = rs.filter((r) => r.ok).length;
      lines.push(
        `| ${m} | ${arm} | **${ok}/${rs.length}** (${Math.round((100 * ok) / rs.length)}%) | ${rs.length} | ${mean(rs.map((r) => r.calls ?? 0)).toFixed(1)} | ${k(mean(rs.map((r) => r.input_tokens ?? 0)))} | ${k(mean(rs.map((r) => r.output_tokens ?? 0)))} | ${rs.reduce((a, r) => a + (r.cost_usd ?? 0), 0).toFixed(2)} |`,
      );
    }
  }
  const tasks = [...new Set(rows.map((r) => r.task))].sort();
  const diff: string[] = [];
  for (const m of models) {
    for (const t of tasks) {
      const o = rows.filter((r) => r.model === m && r.task === t && r.arm === "old");
      const n = rows.filter((r) => r.model === m && r.task === t && r.arm === "new");
      const so = o.filter((r) => r.ok).length;
      const sn = n.filter((r) => r.ok).length;
      if (o.length && n.length && so / o.length !== sn / n.length) {
        const why = n.filter((r) => !r.ok).map((r) => r.why)[0] ?? o.filter((r) => !r.ok).map((r) => r.why)[0] ?? "";
        diff.push(`| ${m} | ${t} | ${so}/${o.length} | ${sn}/${n.length} | ${String(why).replace(/\|/g, "\\|").slice(0, 160)} |`);
      }
    }
  }
  const harness = rows.length;
  return [
    "# MCP description eval: old vs new",
    "",
    ...lines,
    "",
    "Tasks where the arms differ (first failure reason shown):",
    "",
    "| model | task | old | new | a failure |",
    "|---|---|---:|---:|---|",
    ...(diff.length ? diff : ["| – | none | | | |"]),
    "",
    `${harness} runs counted. Success is checked by the harness (vault end state, logged calls, or the ANSWER line).`,
    "",
  ].join("\n");
}

if (import.meta.main) {
  const rows = process.argv.slice(2).flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  console.log(summarize(rows));
}
