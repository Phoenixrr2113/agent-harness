#!/usr/bin/env bash
# daily-reflection/scripts/propose-rules.sh
# Analyze recent journal entries and propose instinct/rule candidates.
# Wraps `harness learn`. Returns structured JSON to stdout.
#
# Returns JSON: { status, result?, error?, next_steps?, metrics? }

set -uo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage: scripts/propose-rules.sh [OPTIONS]

Analyze recent journal entries and surface rule candidates using
`harness learn`. The candidates are returned as structured JSON for
the agent to review and optionally promote to instincts.

Options:
  --harness-dir <path>  Harness directory (default: HARNESS_DIR env or cwd)
  --help, -h            Show this help and exit

Exit codes:
  0  Success — candidates list returned (may be empty)
  1  Error — harness learn command failed
  2  Invalid input — harness directory not found or invalid
  3  Environment missing — harness binary not found

Returns JSON to stdout. Example success (candidates found):
  {
    "status": "ok",
    "result": {
      "candidates": [
        {
          "id": "always-verify-before-commit",
          "summary": "Always run the test suite before creating a commit",
          "source_journals": ["memory/journal/2026-04-28.md"],
          "confidence": "medium"
        }
      ],
      "total": 1
    },
    "metrics": { "duration_ms": 3100 }
  }

Example success (no candidates):
  {
    "status": "ok",
    "result": { "candidates": [], "total": 0 },
    "metrics": { "duration_ms": 1200 }
  }

Note: The harness learn command performs the actual analysis. The JSON
shape above is the contract; the content is determined by the LLM and
the journal entries present on disk.
EOF
  exit 0
fi

# ── Defaults ────────────────────────────────────────────────────────────────

HARNESS_DIR="${HARNESS_DIR:-}"

# ── Argument parsing ─────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --harness-dir)
      shift
      HARNESS_DIR="${1:-}"
      shift
      ;;
    *)
      printf '{"status":"error","error":{"code":"INVALID_ARGS","message":"Unknown argument: %s"},"next_steps":["Run scripts/propose-rules.sh --help for usage"]}\n' \
        "$1"
      exit 2
      ;;
  esac
done

# ── Resolve harness dir ───────────────────────────────────────────────────────

if [ -z "$HARNESS_DIR" ]; then
  HARNESS_DIR="$(pwd)"
fi

if [ ! -d "$HARNESS_DIR" ]; then
  printf '{"status":"error","error":{"code":"HARNESS_DIR_NOT_FOUND","message":"Harness directory does not exist: %s"},"next_steps":["Pass --harness-dir <path> or set HARNESS_DIR env var"]}\n' \
    "$HARNESS_DIR"
  exit 2
fi

# ── Locate harness binary ─────────────────────────────────────────────────────

HARNESS_BIN="$(command -v harness 2>/dev/null || true)"
if [ -z "$HARNESS_BIN" ]; then
  LOCAL_BIN="$HARNESS_DIR/node_modules/.bin/harness"
  if [ -x "$LOCAL_BIN" ]; then
    HARNESS_BIN="$LOCAL_BIN"
  fi
fi

if [ -z "$HARNESS_BIN" ]; then
  printf '{"status":"error","error":{"code":"HARNESS_NOT_FOUND","message":"harness binary not found on PATH and not in node_modules/.bin"},"next_steps":["Install agent-harness globally (npm i -g @agentskills/agent-harness) or add it to PATH"]}\n'
  exit 3
fi

# ── Run harness learn ─────────────────────────────────────────────────────────

START_MS=$(($(date +%s) * 1000))

LEARN_OUTPUT="$("$HARNESS_BIN" learn -d "$HARNESS_DIR" 2>&1)"
EXIT_CODE=$?

END_MS=$(($(date +%s) * 1000))
DURATION_MS=$((END_MS - START_MS))

if [ $EXIT_CODE -ne 0 ]; then
  ESCAPED_MSG="$(printf '%s' "$LEARN_OUTPUT" | tr -d '\n' | sed 's/"/\\"/g')"
  printf '{"status":"error","error":{"code":"LEARN_COMMAND_FAILED","message":"%s"},"next_steps":["Check that Ollama is running","Verify the configured model is available (harness hardware)","Ensure at least one journal entry exists in memory/journal/","Re-run with HARNESS_VERBOSE=1 for more detail"]}\n' \
    "$ESCAPED_MSG"
  exit 1
fi

# ── Emit success JSON ─────────────────────────────────────────────────────────
#
# harness learn does not currently emit machine-parseable JSON output — it
# writes instinct candidate files to disk and prints human-readable progress.
# We return a thin wrapper that confirms the command succeeded and delegates
# the actual candidate list to the agent, which can read the disk output.
#
# Future enhancement: patch `harness learn --json` to emit a structured
# candidate list and parse it here.

printf '{"status":"ok","result":{"candidates":[],"total":0,"note":"harness learn completed; candidates written to disk by the harness. Review memory/instincts/ or re-run `harness harvest` to promote them."},"metrics":{"duration_ms":%d}}\n' \
  "$DURATION_MS"
