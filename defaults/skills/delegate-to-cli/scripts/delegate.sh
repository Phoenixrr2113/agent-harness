#!/usr/bin/env bash
# delegate.sh — Delegate a bounded subtask to a local CLI agent and return structured JSON.
#
# Usage: scripts/delegate.sh [--timeout-ms N] <cli> <mode> <prompt>
#
# Returns JSON to stdout:
#   on success: { "status": "ok", "result": { "output": "...", "exit_code": 0, "duration_ms": N }, "metrics": { "duration_ms": N } }
#   on error:   { "status": "error", "error": { "code": "...", "message": "...", "evidence": "..." }, "next_steps": [...] }

set -uo pipefail

# ---------------------------------------------------------------------------
# --help
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage: scripts/delegate.sh [--timeout-ms N] <cli> <mode> <prompt>

Run a bounded subtask via a local CLI agent and return structured JSON.

Arguments:
  <cli>     One of: claude, codex, gemini
  <mode>    One of: read (analysis/summary), edit (file modification)
  <prompt>  Non-empty prompt string to send to the subagent

Options:
  --timeout-ms N   Wall-clock timeout in milliseconds (default: 300000 = 5 min)
  --help, -h       Show this help and exit

Exit codes:
  0  Success (status: ok in JSON)
  1  Subprocess or runtime error (status: error in JSON)
  2  Invalid input (bad cli/mode args)
  3  Environment missing (CLI not on PATH or version too old)

Returns JSON to stdout. stderr is suppressed from the subprocess; use
error.evidence in the JSON for raw diagnostic output.

Examples:
  scripts/delegate.sh claude read "Summarize the README"
  scripts/delegate.sh claude edit "Refactor src/utils.ts to remove duplication"
  scripts/delegate.sh codex read "Review this PR for security issues"
  scripts/delegate.sh --timeout-ms 600000 claude read "Analyze all 50 files"

Minimum CLI versions:
  claude  >= 2.1  (earlier builds have a broken -p / --print mode)
  codex   >= 1.0
  gemini  >= 1.0

For the flag table (read vs edit per CLI), see references/permission-flags.md.
For error-code recovery hints, see references/failure-modes.md.
EOF
  exit 0
fi

# ---------------------------------------------------------------------------
# Parse --timeout-ms option
# ---------------------------------------------------------------------------
TIMEOUT_MS=300000
while [[ "${1:-}" == --* ]]; do
  case "${1:-}" in
    --timeout-ms)
      TIMEOUT_MS="${2:-300000}"
      shift 2
      ;;
    *)
      _json_error "INVALID_INPUT" "Unknown option: ${1}" "" ""
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
_json_ok() {
  local output="${1}"
  local exit_code="${2}"
  local duration_ms="${3}"
  # Escape the output for JSON embedding
  local escaped
  escaped=$(printf '%s' "${output}" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null \
    || printf '%s' "${output}" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/' | tr -d '\n' | sed 's/\\n$//')
  printf '{"status":"ok","result":{"output":%s,"exit_code":%s,"duration_ms":%s},"metrics":{"duration_ms":%s}}\n' \
    "${escaped}" "${exit_code}" "${duration_ms}" "${duration_ms}"
}

_json_error() {
  local code="${1}"
  local message="${2}"
  local evidence="${3}"
  local next_steps_json="${4}"
  local msg_escaped evidence_escaped
  msg_escaped=$(printf '%s' "${message}" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null \
    || printf '"%s"' "${message}")
  evidence_escaped=$(printf '%s' "${evidence}" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null \
    || printf '"%s"' "${evidence}")
  if [ -n "${next_steps_json}" ]; then
    printf '{"status":"error","error":{"code":"%s","message":%s,"evidence":%s},"next_steps":%s}\n' \
      "${code}" "${msg_escaped}" "${evidence_escaped}" "${next_steps_json}"
  else
    printf '{"status":"error","error":{"code":"%s","message":%s,"evidence":%s}}\n' \
      "${code}" "${msg_escaped}" "${evidence_escaped}"
  fi
}

# ---------------------------------------------------------------------------
# Validate arguments
# ---------------------------------------------------------------------------
CLI="${1:-}"
MODE="${2:-}"
PROMPT="${3:-}"

if [ -z "${CLI}" ] || [ -z "${MODE}" ] || [ -z "${PROMPT}" ]; then
  _json_error "INVALID_INPUT" \
    "Usage: scripts/delegate.sh [--timeout-ms N] <cli> <mode> <prompt> — all three arguments are required" \
    "" \
    '["Run scripts/delegate.sh --help for usage"]'
  exit 2
fi

case "${CLI}" in
  claude|codex|gemini) ;;
  *)
    _json_error "INVALID_INPUT" \
      "Invalid cli '${CLI}': must be one of claude, codex, gemini" \
      "" \
      '["Re-invoke with a valid cli argument: claude, codex, or gemini"]'
    exit 2
    ;;
esac

case "${MODE}" in
  read|edit) ;;
  *)
    _json_error "INVALID_INPUT" \
      "Invalid mode '${MODE}': must be 'read' (analysis-only) or 'edit' (file modification)" \
      "" \
      '["Re-invoke with mode=read or mode=edit","See references/permission-flags.md for what each mode maps to per CLI"]'
    exit 2
    ;;
esac

# ---------------------------------------------------------------------------
# Check CLI is on PATH
# ---------------------------------------------------------------------------
if ! command -v "${CLI}" >/dev/null 2>&1; then
  case "${CLI}" in
    claude)
      INSTALL_HINT="npm install -g @anthropic-ai/claude-code"
      ;;
    codex)
      INSTALL_HINT="npm install -g @openai/codex"
      ;;
    gemini)
      INSTALL_HINT="npm install -g @google/gemini-cli"
      ;;
  esac
  _json_error "CLI_NOT_FOUND" \
    "'${CLI}' is not on PATH. Install it and ensure it is accessible." \
    "" \
    "[\"Install: ${INSTALL_HINT}\",\"Or delegate to a different CLI: scripts/delegate.sh codex ${MODE} ...\"]"
  exit 3
fi

# ---------------------------------------------------------------------------
# Check minimum version
# ---------------------------------------------------------------------------
MIN_VERSIONS=( ["claude"]="2.1" ["codex"]="1.0" ["gemini"]="1.0" )
MIN_VER="${MIN_VERSIONS[${CLI}]:-1.0}"

RAW_VERSION=$("${CLI}" --version 2>&1 | head -1 || true)
DETECTED_VERSION=$(printf '%s' "${RAW_VERSION}" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1 || true)

if [ -n "${DETECTED_VERSION}" ] && [ -n "${MIN_VER}" ]; then
  # Compare major.minor parts
  DET_MAJOR=$(printf '%s' "${DETECTED_VERSION}" | cut -d. -f1)
  DET_MINOR=$(printf '%s' "${DETECTED_VERSION}" | cut -d. -f2)
  MIN_MAJOR=$(printf '%s' "${MIN_VER}" | cut -d. -f1)
  MIN_MINOR=$(printf '%s' "${MIN_VER}" | cut -d. -f2)

  VERSION_OK=1
  if [ "${DET_MAJOR}" -lt "${MIN_MAJOR}" ] 2>/dev/null; then
    VERSION_OK=0
  elif [ "${DET_MAJOR}" -eq "${MIN_MAJOR}" ] 2>/dev/null && [ "${DET_MINOR}" -lt "${MIN_MINOR}" ] 2>/dev/null; then
    VERSION_OK=0
  fi

  if [ "${VERSION_OK}" -eq 0 ]; then
    _json_error "CLI_VERSION_TOO_OLD" \
      "'${CLI}' version ${DETECTED_VERSION} is below the minimum required ${MIN_VER}. Upgrade and retry." \
      "${RAW_VERSION}" \
      "[\"Upgrade: npm install -g ${CLI}\",\"See references/failure-modes.md for minimum version table\"]"
    exit 3
  fi
fi

# ---------------------------------------------------------------------------
# Map mode → permission flag
# ---------------------------------------------------------------------------
# See references/permission-flags.md for the full flag table with version notes.
case "${CLI}" in
  claude)
    if [ "${MODE}" = "edit" ]; then
      PERMISSION_FLAG="--permission-mode bypassPermissions"
    else
      PERMISSION_FLAG=""
    fi
    ;;
  codex)
    if [ "${MODE}" = "edit" ]; then
      PERMISSION_FLAG="--dangerously-bypass-approvals-and-sandbox"
    else
      PERMISSION_FLAG="-s read-only"
    fi
    ;;
  gemini)
    # gemini's non-interactive mode is read-leaning; edit requires verification
    PERMISSION_FLAG=""
    ;;
esac

# ---------------------------------------------------------------------------
# Build command
# ---------------------------------------------------------------------------
# All three CLIs support a non-interactive print/pipe mode:
#   claude: claude -p "<prompt>"
#   codex:  codex -q "<prompt>"   (--quiet disables spinner/TUI)
#   gemini: gemini -p "<prompt>"
case "${CLI}" in
  claude)
    if [ -n "${PERMISSION_FLAG}" ]; then
      # shellcheck disable=SC2206
      CMD=( claude ${PERMISSION_FLAG} -p "${PROMPT}" )
    else
      CMD=( claude -p "${PROMPT}" )
    fi
    ;;
  codex)
    if [ -n "${PERMISSION_FLAG}" ]; then
      # shellcheck disable=SC2206
      CMD=( codex -q ${PERMISSION_FLAG} "${PROMPT}" )
    else
      CMD=( codex -q "${PROMPT}" )
    fi
    ;;
  gemini)
    CMD=( gemini -p "${PROMPT}" )
    ;;
esac

# ---------------------------------------------------------------------------
# Run with timeout
# ---------------------------------------------------------------------------
TIMEOUT_SEC=$(( TIMEOUT_MS / 1000 ))
START_MS=$(date +%s%3N 2>/dev/null || echo 0)

TMPOUT=$(mktemp)
TMPERR=$(mktemp)
trap 'rm -f "${TMPOUT}" "${TMPERR}"' EXIT

EXIT_CODE=0

if command -v timeout >/dev/null 2>&1; then
  # GNU coreutils timeout available
  timeout "${TIMEOUT_SEC}" "${CMD[@]}" >"${TMPOUT}" 2>"${TMPERR}" || EXIT_CODE=$?
  if [ "${EXIT_CODE}" -eq 124 ]; then
    _json_error "SUBPROCESS_TIMEOUT" \
      "The ${CLI} subprocess exceeded the ${TIMEOUT_SEC}s wall-clock limit." \
      "" \
      "[\"Increase --timeout-ms (e.g. --timeout-ms 600000 for 10 min)\",\"Split the task into smaller bounded subtasks\"]"
    exit 1
  fi
else
  # Portable fallback: background + poll
  "${CMD[@]}" >"${TMPOUT}" 2>"${TMPERR}" &
  CHILD_PID=$!
  ELAPSED=0
  POLL_INTERVAL=2
  TIMED_OUT=0
  while kill -0 "${CHILD_PID}" 2>/dev/null; do
    sleep "${POLL_INTERVAL}"
    ELAPSED=$(( ELAPSED + POLL_INTERVAL ))
    if [ "${ELAPSED}" -ge "${TIMEOUT_SEC}" ]; then
      kill "${CHILD_PID}" 2>/dev/null || true
      TIMED_OUT=1
      break
    fi
  done
  if [ "${TIMED_OUT}" -eq 1 ]; then
    _json_error "SUBPROCESS_TIMEOUT" \
      "The ${CLI} subprocess exceeded the ${TIMEOUT_SEC}s wall-clock limit." \
      "" \
      "[\"Increase --timeout-ms (e.g. --timeout-ms 600000 for 10 min)\",\"Split the task into smaller bounded subtasks\"]"
    exit 1
  fi
  wait "${CHILD_PID}" || EXIT_CODE=$?
fi

END_MS=$(date +%s%3N 2>/dev/null || echo 0)
DURATION_MS=$(( END_MS - START_MS ))

OUTPUT=$(cat "${TMPOUT}")
STDERR_OUT=$(cat "${TMPERR}")

# ---------------------------------------------------------------------------
# Classify non-zero exits
# ---------------------------------------------------------------------------
if [ "${EXIT_CODE}" -ne 0 ]; then
  COMBINED="${OUTPUT}${STDERR_OUT}"

  # 429 / rate limit pattern
  if printf '%s' "${COMBINED}" | grep -qiE '429|rate.?limit|too many requests'; then
    _json_error "RATE_LIMITED" \
      "${CLI} returned a rate-limit error (429). Back off and retry." \
      "${COMBINED}" \
      "[\"Wait 60s before retrying\",\"Serialize parallel delegations to reduce request rate\"]"
    exit 1
  fi

  # Permission / approval hang detection: zero output, non-zero exit, short elapsed
  if [ -z "${OUTPUT}" ] && [ "${DURATION_MS}" -lt 5000 ]; then
    _json_error "PERMISSION_FLAG_MISSING" \
      "${CLI} produced no output and exited quickly. This usually means the subprocess needed approval that could not be satisfied. Retry with mode=edit to pass the correct permission flag." \
      "${STDERR_OUT}" \
      "[\"Re-invoke with mode=edit instead of mode=read\",\"See references/permission-flags.md for the exact flag\"]"
    exit 1
  fi

  _json_error "SUBPROCESS_FAILED" \
    "${CLI} exited with code ${EXIT_CODE}." \
    "${COMBINED}" \
    "[\"Check error.evidence for raw subprocess output\",\"Run scripts/verify-cli.sh ${CLI} to confirm version and PATH\"]"
  exit 1
fi

# ---------------------------------------------------------------------------
# Success
# ---------------------------------------------------------------------------
_json_ok "${OUTPUT}" "${EXIT_CODE}" "${DURATION_MS}"
