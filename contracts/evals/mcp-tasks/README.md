# evals/mcp-tasks: do agents do as well with short MCP descriptions?

The 0.9 design (T-318, §4 "ship gate") cuts what an agent reads before its first call from about 15k tokens (a writer
session) to under 4k. That ships only if agents do as well with less. This eval checks it: 31 tasks drawn from real
use, each run by real models against a fresh synthetic vault, once with the OLD tool descriptions and once with the
NEW ones.

It is an eval, not a contract: it calls paid models, its numbers move a little from run to run, and CI doesn't run it.
The budget itself is a contract (`suites/mcp/budget.test.ts`).

## Run

Needs Bun, `unshare` (unprivileged user namespaces), and a logged-in `claude` CLI; `codex` for the non-Claude model.

```bash
cd contracts
bun evals/mcp-tasks/run.ts --models opus,sonnet,haiku,codex --repeats 3 --concurrency 6 --out evals/mcp-tasks/results/<name>
bun evals/mcp-tasks/run.ts --models haiku --tasks t10,t27        # a few tasks, one model
bun evals/mcp-tasks/report.ts evals/mcp-tasks/results/*/runs.jsonl
bun evals/mcp-tasks/snapshot.ts /tmp/tools.json --scope write    # what an agent sees from this checkout
```

## How a run works

- **A fresh box per run** (`box.ts`, `box-inner.ts`): this checkout's own `parachute-vault create` and `parachute
  serve`, in a temp home, inside a private network namespace (`unshare -rn`). Only loopback exists in there, so the
  box's vault port (1940 by default) is its own and never meets a live install. The runner reaches the hub through a
  unix-socket bridge, on the same port number outside, so the upload and download URLs the box hands out work.
- **The synthetic vault** (`fixture.ts`): 60 made-up notes (tasks, people, events and meetings, reading notes,
  linked project notes), four types, a note with a previous version and an attachment. People are at example.org.
  Nothing comes from a real vault.
- **The model** talks to two MCP servers (`proxy.ts`): `vault`, which shows the arm's descriptions and forwards every
  call unchanged to the box, and `files`, one `http_request` tool for spending upload URLs (the same in both arms).
  - OLD: `old/tools.json`, the instructions and `tools/list` an admin session got from main at `ccc7729`
    (17 tools, about 19k tokens).
  - NEW: whatever this checkout serves.
  So both arms run against the same server; only what the model reads differs.
- **Claude models** run through `claude -p`: no built-in tools, no settings or memory, tool search off, and the short
  system prompt in `run.ts` (the same in both arms). **Codex** runs `codex exec` with a clean `CODEX_HOME` (only a link
  to the login), approvals for the two servers, and a run that touches the shell counts as failed.
- **Success** is decided by the harness (`tasks.ts`), never by the model: the vault's end state, the calls the proxy
  logged, or the final `ANSWER:` line compared with the fixture. Calls and tokens come from the proxy's log and the
  CLI's usage report.

## Tasks

`tasks.ts` holds the 31 tasks of the design's draft (`tasks.json` in the T-318 design folder), with small changes so
each has one right answer on a synthetic vault (listed at the top of the file). t31 (`semantic`) is skipped: the box
has no embeddings, as the 0.8 bundle has none.

## Results

`results/<name>/SUMMARY.md` per run set; `runs.jsonl` has one row per run (no tokens or keys: JWTs are redacted).
The current numbers are in [`RESULTS.md`](RESULTS.md).
