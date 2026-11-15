# MCP description eval: old vs new

| model | arm | success | runs | calls / task (median) | input tokens / task | output tokens / task | cost (list $) |
|---|---|---:|---:|---:|---:|---:|---:|
| haiku | old | **60/60** (100%) | 60 | 1.8 (1.5) | 78.7k | 573 | 0.11 |
| haiku | new | **60/60** (100%) | 60 | 1.9 (2) | 27.3k | 542 | 0.07 |
| sonnet | old | **60/60** (100%) | 60 | 1.6 (1) | 75.2k | 360 | 1.65 |
| sonnet | new | **59/60** (98%) | 60 | 1.6 (1) | 23.5k | 339 | 1.05 |

Tasks where the arms differ (first failure reason shown):

| model | task | old | new | a failure |
|---|---|---:|---:|---|
| sonnet | t23 | 2/2 | 1/2 | no receipt attachment (0 attachments) |

240 runs counted. Success is checked by the harness (vault end state, logged calls, or the ANSWER line).
