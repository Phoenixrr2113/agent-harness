#!/usr/bin/env bash
# Full Terminal-Bench 2.0 run: all 92 tasks.
#
# Only run this after scripts/smoke.sh completes cleanly — a failing
# adapter on task 1 will burn credits on 91 follow-up tasks.
#
# Expected cost on Qwen3-Coder via OpenRouter: ~$8-15
# Expected wall time:                         ~3-6 hours at -n 4 concurrency

set -euo pipefail

cd "$(dirname "$0")/.."

: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY must be set}"
MODEL="${HARNESS_MODEL:-qwen/qwen3-coder}"
CONCURRENCY="${HARBOR_CONCURRENCY:-4}"

echo "==> full run: 92 tasks on $MODEL (concurrency=$CONCURRENCY)"

uv run harbor run \
    -d terminal-bench/terminal-bench-2 \
    --agent-import-path agent_harness_adapter:AgentHarness \
    -m "$MODEL" \
    -n "$CONCURRENCY" \
    "$@"
