# MCP description eval: old vs new

| model | arm | success | runs | calls / task (median) | input tokens / task | output tokens / task | cost (list $) |
|---|---|---:|---:|---:|---:|---:|---:|
| sonnet | old | **6/6** (100%) | 6 | 2.3 (2) | 159.9k | 1.1k | 0.26 |
| sonnet | new | **5/6** (83%) | 6 | 2.7 (3) | 53.9k | 971 | 0.24 |

Tasks where the arms differ (first failure reason shown):

| model | task | old | new | a failure |
|---|---|---:|---:|---|
| sonnet | t23 | 6/6 | 5/6 | no receipt attachment (0 attachments) |

12 runs counted. Success is checked by the harness (vault end state, logged calls, or the ANSWER line).
