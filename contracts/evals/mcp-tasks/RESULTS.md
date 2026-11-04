# Results: short MCP descriptions pass the ship gate

Run 2026-10-29 (T-318 brief 09). 720 runs: 4 models × OLD/NEW × 30 tasks × 3 repeats (t31 skipped, no embeddings).
Every row is in [`results/2026-10-29/runs.jsonl`](results/2026-10-29/runs.jsonl); the table is
[`results/2026-10-29/SUMMARY.md`](results/2026-10-29/SUMMARY.md).

- **OLD**: main's tools/list and instructions at ccc7729, an admin session: 17 tools, about 19k tokens.
- **NEW**: this branch's short descriptions (commit 1cd417a for 690 runs; t27 re-run at 4a72aa1 after its oracle was
  made strict, see below). The admin list is about 3.2k tokens, a writer's 2.3k.
- **Models**: Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5 through `claude -p`, plus OpenAI's default Codex model through
  `codex exec` (codex-cli 0.162.1).

## The gate: NEW ≥ OLD on success, for every model

| model | OLD success | NEW success | input tokens / task, OLD → NEW | calls / task (mean, t27 excluded) |
|---|---:|---:|---:|---:|
| Opus | 90/90 | **90/90** | 85.5k → 23.7k (−72%) | 2.01 → 2.01 |
| Sonnet | 89/90 | **90/90** | 76.1k → 19.7k (−74%) | 1.66 → 1.59 |
| Haiku | 89/90 | **90/90** | 80.5k → 23.4k (−71%) | 1.69 → 1.93 |
| Codex | 90/90 | **90/90** | 98.0k → 82.0k (−16%) | 1.78 → 1.77 |

**It passes.** No model lost a task. Where the arms differ, NEW did better: Haiku's t23 (attach a file, 2/3 → 3/3)
and Sonnet's t30 (notes created in September, 2/3 → 3/3). No parameter needs its explanation back in the
description.

Input tokens count everything the model read across its turns: the tool list again on every turn, plus results.
Codex's own system prompt is large, so its saving is smaller in proportion. List-price cost for the Claude runs fell
from $7.47 to $5.32 (subscription runs; the figure is the CLI's list-price report).

## What else the run showed

- **Haiku reads a little more with less.** It makes about 0.25 more calls per task on NEW, most on t20, t23 and
  t12, where it looks things up before writing instead of guessing. It still finishes every task, and the extra
  calls cost far less than the 57k tokens it no longer reads on every turn.
- **No model sent an unknown parameter**, so the new teaching errors never fired. The errors that did fire were the
  existing ones: `size_bytes` must be positive (models can't measure the file in this eval), `versions` is
  incompatible with `id`, and an invalid cursor.
- **Codex polls a cursor without end.** On t27 it made about 5,800 calls per run, in both arms, before answering
  correctly. A cursor page that comes back empty still carries a `next_cursor`, because a cursor is a "since last
  checked" watermark. The Claude models stop at the first empty page. Saying "an empty page means you have them
  all" in `cursor`'s description is a one-line follow-up for the next eval run.
- **The error prefix is doubled** (`MCP error -32602: MCP error -32602: …`) on every structured error. It is the same
  in both arms, a pre-existing bug, and harmless to the models here.
- **Revocation takes up to 60 s to reach the vault** (scope-guard's revocation cache). t26's oracle reads the hub's
  record, not the vault's answer.

## Changes during the run (said plainly)

- t23's oracle first looked for the file name in the wrong field (`metadata.original_name` holds it), so every t23
  failed in both pilot arms. It was fixed before the 720-run set.
- Codex's review found t27's oracle accepted one call carrying any `cursor`. It now requires pages of at most 5, a
  continuation from a `next_cursor` a page returned, and every event note covered. t27 was re-run, 24 runs, on the
  same short descriptions (4a72aa1 adds only a REST path to one instruction line).
- Count answers may come as `{count: N}`; formatting is not what this measures.

## Reproduce

```bash
cd contracts
bun evals/mcp-tasks/run.ts --models opus,sonnet,haiku,codex --arms old,new --repeats 3 --concurrency 10 --out /tmp/eval
```

About 2.5 hours at concurrency 10 on this machine.
