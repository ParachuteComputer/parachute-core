# MCP description eval: old vs new

| model | arm | success | runs | calls / task (median) | input tokens / task | output tokens / task | cost (list $) |
|---|---|---:|---:|---:|---:|---:|---:|
| haiku | old | **89/90** (99%) | 90 | 1.8 (1) | 80.5k | 537 | 0.16 |
| haiku | new | **90/90** (100%) | 90 | 2.1 (2) | 23.4k | 564 | 0.10 |
| sonnet | old | **89/90** (99%) | 90 | 1.7 (1) | 76.1k | 372 | 2.11 |
| sonnet | new | **90/90** (100%) | 90 | 1.7 (1) | 19.7k | 360 | 1.45 |
| opus | old | **90/90** (100%) | 90 | 2.1 (2) | 85.5k | 505 | 5.20 |
| opus | new | **90/90** (100%) | 90 | 2.1 (2) | 23.7k | 485 | 3.77 |
| codex | old | **90/90** (100%) | 90 | 194.8 (2) | 98.0k | 247 | 0.00 |
| codex | new | **90/90** (100%) | 90 | 184.9 (1.5) | 82.0k | 211 | 0.00 |

Tasks where the arms differ (first failure reason shown):

| model | task | old | new | a failure |
|---|---|---:|---:|---|
| haiku | t23 | 2/3 | 3/3 | no receipt attachment (0 attachments) |
| sonnet | t30 | 2/3 | 3/3 | no list in ANSWER |

720 runs counted. Success is checked by the harness (vault end state, logged calls, or the ANSWER line).

