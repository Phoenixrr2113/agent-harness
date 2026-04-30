# Manual Regression Findings — 2026-04-30 — v0.16.0 + dev-template fix

**Tier executed:** Required
**Provider used:** Ollama qwen3:1.7b (where model invocation needed)
**Built dist:** commit `8188396` (`feat/manual-regression-spec` branch, two ahead of v0.16.0 main)
**Total items:** 48 (R-01..R-45 + P-01..P-03)
**Counts:** _ PASS / _ FAIL / _ SURPRISE / _ KNOWN — *(tally filled at end of run)*

**Test command for v0.16.0+ dist:** `node /Users/randywilson/Desktop/agent-harness/dist/cli/index.js <args>` (the global `harness` on this machine is v0.8.0). All commands below substitute `harness` → the dist path; the canonical checklist's commands assume a fresh global install of the version under test.

## Findings

<!-- Each finding cites the item id (R-NN or P-NN.M), Expected, Actual, Triage, Resolution. Numbered F-NN monotonically. -->
