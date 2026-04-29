#!/usr/bin/env bash
# daily-reflection/scripts/synthesize.sh
# Synthesize today's (or --date YYYY-MM-DD) sessions into a journal entry.
# Wraps `harness journal`. Returns structured JSON to stdout.
#
# Returns JSON: { status, result?, error?, next_steps?, metrics?, artifacts? }

set -uo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage: scripts/synthesize.sh [OPTIONS]

Synthesize a day's sessions into a journal entry using `harness journal`.
Writes the journal file to <harness-dir>/memory/journal/<date>.md and
returns a structured JSON result.

Options:
  --date YYYY-MM-DD    Date to synthesize (default: today's date)
  --harness-dir <path> Harness directory (default: HARNESS_DIR env or cwd)
  --no-force           Skip synthesis if a journal entry already exists
  --help, -h           Show this help and exit

Exit codes:
  0  Success — journal written
  1  Error — harness journal command failed, no sessions, or invalid args
  2  Invalid input — bad date format or missing harness directory
  3  Environment missing — harness binary not found
  4  Skipped — journal entry already exists (only with --no-force)

Returns JSON to stdout. Example success:
  {
    "status": "ok",
    "result": {
      "journal_path": "memory/journal/2026-04-30.md",
      "sessions_processed": null,
      "patterns_detected": null,
      "rule_candidates": null
    },
    "metrics": { "duration_ms": 4200 },
    "artifacts": [{ "path": "memory/journal/2026-04-30.md", "description": "Today's synthesized journal entry" }]
  }

Note: sessions_processed / patterns_detected / rule_candidates are populated
by the harness journal command when available; otherwise they are null.
EOF
  exit 0
fi

# ── Defaults ────────────────────────────────────────────────────────────────

DATE=""
HARNESS_DIR="${HARNESS_DIR:-}"
FORCE="--force"

# ── Argument parsing ─────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --date)
      shift
      DATE="${1:-}"
      shift
      ;;
    --harness-dir)
      shift
      HARNESS_DIR="${1:-}"
      shift
      ;;
    --no-force)
      FORCE=""
      shift
      ;;
    *)
      STDERR_MSG="Unknown argument: $1"
      printf '{"status":"error","error":{"code":"INVALID_ARGS","message":"%s"},"next_steps":["Run scripts/synthesize.sh --help for usage"]}\n' \
        "$STDERR_MSG" >&2
      printf '{"status":"error","error":{"code":"INVALID_ARGS","message":"%s"},"next_steps":["Run scripts/synthesize.sh --help for usage"]}\n' \
        "$STDERR_MSG"
      exit 2
      ;;
  esac
done

# ── Resolve date ─────────────────────────────────────────────────────────────

if [ -z "$DATE" ]; then
  DATE="$(date +%Y-%m-%d)"
fi

# Validate YYYY-MM-DD format
if ! echo "$DATE" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
  printf '{"status":"error","error":{"code":"INVALID_DATE","message":"--date must be YYYY-MM-DD, got: %s"},"next_steps":["Correct the date format and retry"]}\n' \
    "$DATE"
  exit 2
fi

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
  # Fallback: look for a local node_modules/.bin/harness relative to harness dir
  LOCAL_BIN="$HARNESS_DIR/node_modules/.bin/harness"
  if [ -x "$LOCAL_BIN" ]; then
    HARNESS_BIN="$LOCAL_BIN"
  fi
fi

if [ -z "$HARNESS_BIN" ]; then
  printf '{"status":"error","error":{"code":"HARNESS_NOT_FOUND","message":"harness binary not found on PATH and not in node_modules/.bin"},"next_steps":["Install agent-harness globally (npm i -g @agentskills/agent-harness) or add it to PATH"]}\n'
  exit 3
fi

# ── Check for existing journal entry (--no-force mode) ───────────────────────

JOURNAL_PATH="$HARNESS_DIR/memory/journal/${DATE}.md"
if [ "$FORCE" = "" ] && [ -f "$JOURNAL_PATH" ]; then
  # Relative path for portability in the JSON output
  REL_JOURNAL="memory/journal/${DATE}.md"
  printf '{"status":"ok","result":{"journal_path":"%s","sessions_processed":null,"patterns_detected":null,"rule_candidates":null,"skipped":true},"metrics":{"duration_ms":0},"artifacts":[{"path":"%s","description":"Existing journal entry (skipped synthesis — use default without --no-force to overwrite)"}]}\n' \
    "$REL_JOURNAL" "$REL_JOURNAL"
  exit 4
fi

# ── Run harness journal ───────────────────────────────────────────────────────

START_MS=$(($(date +%s) * 1000))

CMD_ARGS=("-d" "$HARNESS_DIR" "--date" "$DATE")
if [ -n "$FORCE" ]; then
  CMD_ARGS+=("$FORCE")
fi

JOURNAL_OUTPUT="$("$HARNESS_BIN" journal "${CMD_ARGS[@]}" 2>&1)"
EXIT_CODE=$?

END_MS=$(($(date +%s) * 1000))
DURATION_MS=$((END_MS - START_MS))

if [ $EXIT_CODE -ne 0 ]; then
  # Escape the output for safe JSON embedding (basic escaping)
  ESCAPED_MSG="$(printf '%s' "$JOURNAL_OUTPUT" | tr -d '\n' | sed 's/"/\\"/g')"
  printf '{"status":"error","error":{"code":"JOURNAL_COMMAND_FAILED","message":"%s"},"next_steps":["Check that Ollama is running","Verify the configured model is available (harness hardware)","Re-run with HARNESS_VERBOSE=1 for more detail"]}\n' \
    "$ESCAPED_MSG"
  exit 1
fi

# ── Emit success JSON ─────────────────────────────────────────────────────────

REL_JOURNAL="memory/journal/${DATE}.md"

printf '{"status":"ok","result":{"journal_path":"%s","sessions_processed":null,"patterns_detected":null,"rule_candidates":null},"metrics":{"duration_ms":%d},"artifacts":[{"path":"%s","description":"Synthesized journal entry for %s"}]}\n' \
  "$REL_JOURNAL" \
  "$DURATION_MS" \
  "$REL_JOURNAL" \
  "$DATE"
