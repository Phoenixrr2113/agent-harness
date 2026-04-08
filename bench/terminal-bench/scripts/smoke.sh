#!/usr/bin/env bash
# Smoke run: 5 tasks, 2 concurrent. Verifies the adapter end-to-end
# (container install, one-shot invocation, log capture) before committing
# to a full 92-task run.
#
# Expected cost on Qwen3-Coder via OpenRouter: ~$0.50-1.00
# Expected wall time:                         ~15-30 min (depends on task mix)

set -euo pipefail

cd "$(dirname "$0")/.."

: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY must be set}"
MODEL="${HARNESS_MODEL:-qwen/qwen3-coder}"

echo "==> smoke run: 5 tasks on $MODEL"

uv run harbor run \
    -d terminal-bench/terminal-bench-2 \
    --agent-import-path agent_harness_adapter:AgentHarness \
    -m "$MODEL" \
    -l 5 \
    -n 2 \
    "$@"
