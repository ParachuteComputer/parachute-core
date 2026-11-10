# MCP description eval: old vs new

| model | arm | success | runs | calls / task (median) | input tokens / task | output tokens / task | cost (list $) |
|---|---|---:|---:|---:|---:|---:|---:|
| haiku | old | **89/90** (99%) | 90 | 1.8 (1.5) | 81.7k | 578 | 0.17 |
| haiku | new | **90/90** (100%) | 90 | 2.1 (2) | 26.6k | 558 | 0.11 |
| opus | old | **90/90** (100%) | 90 | 2.2 (2) | 87.6k | 509 | 5.88 |
| opus | new | **90/90** (100%) | 90 | 2.2 (2) | 27.7k | 509 | 4.14 |
| sonnet | old | **90/90** (100%) | 90 | 1.7 (1) | 77.0k | 380 | 2.28 |
| sonnet | new | **90/90** (100%) | 90 | 1.6 (1) | 22.6k | 349 | 1.52 |
| codex | old | **88/90** (98%) | 90 | 20.1 (2) | 100.5k | 252 | 0.00 |
| codex | new | **89/90** (99%) | 90 | 1.7 (1) | 79.0k | 198 | 0.00 |

Tasks where the arms differ (first failure reason shown):

| model | task | old | new | a failure |
|---|---|---:|---:|---|
| haiku | t23 | 2/3 | 3/3 | no receipt attachment (0 attachments) |
| codex | t01 | 2/3 | 3/3 | answer null, want 01M63X7HZF1E3DFT40JQN5J3Z9 |

720 runs counted. Success is checked by the harness (vault end state, logged calls, or the ANSWER line).
