#!/usr/bin/env bash
# verify-cli.sh — Verify a delegation CLI is installed and meets the minimum version.
#
# Usage: scripts/verify-cli.sh <cli>
#
# Returns JSON to stdout:
#   on success: { "status": "ok", "result": { "cli": "claude", "version": "2.5.1", "min_required": "2.1" } }
#   on error:   { "status": "error", "error": { "code": "...", "message": "...", "evidence": "..." }, "next_steps": [...] }

set -uo pipefail

# ---------------------------------------------------------------------------
# --help
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage: scripts/verify-cli.sh <cli>

Verify a delegation CLI is on PATH and meets the minimum version.

Arguments:
  <cli>   One of: claude, codex, gemini

Exit codes:
  0  CLI present and version OK
  1  Error (see JSON error.code)
  2  Invalid input
  3  Environment missing (CLI not on PATH or version too old)

Returns JSON to stdout. error.code values:
  CLI_NOT_FOUND       — binary missing from PATH
  CLI_VERSION_TOO_OLD — installed version is below the minimum
  INVALID_INPUT       — unrecognised <cli> argument

Minimum versions:
  claude  2.1  (earlier builds have a broken -p / --print mode)
  codex   1.0
  gemini  1.0

Examples:
  scripts/verify-cli.sh claude
  scripts/verify-cli.sh codex
EOF
  exit 0
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
_json_ok() {
  local cli="${1}"
  local version="${2}"
  local min_required="${3}"
  printf '{"status":"ok","result":{"cli":"%s","version":"%s","min_required":"%s"}}\n' \
    "${cli}" "${version}" "${min_required}"
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
# Validate argument
# ---------------------------------------------------------------------------
CLI="${1:-}"

if [ -z "${CLI}" ]; then
  _json_error "INVALID_INPUT" \
    "Usage: scripts/verify-cli.sh <cli> — argument required" \
    "" \
    '["Run scripts/verify-cli.sh --help for usage"]'
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

# ---------------------------------------------------------------------------
# Minimum version table
# ---------------------------------------------------------------------------
declare -A MIN_VERSIONS
MIN_VERSIONS=( [claude]="2.1" [codex]="1.0" [gemini]="1.0" )
MIN_VER="${MIN_VERSIONS[${CLI}]}"

# ---------------------------------------------------------------------------
# Check binary is on PATH
# ---------------------------------------------------------------------------
if ! command -v "${CLI}" >/dev/null 2>&1; then
  case "${CLI}" in
    claude)  INSTALL_HINT="npm install -g @anthropic-ai/claude-code" ;;
    codex)   INSTALL_HINT="npm install -g @openai/codex" ;;
    gemini)  INSTALL_HINT="npm install -g @google/gemini-cli" ;;
  esac
  _json_error "CLI_NOT_FOUND" \
    "'${CLI}' is not on PATH. Install it and ensure it is accessible from the shell." \
    "" \
    "[\"Install: ${INSTALL_HINT}\",\"Confirm PATH includes the npm global bin directory\"]"
  exit 3
fi

# ---------------------------------------------------------------------------
# Detect version
# ---------------------------------------------------------------------------
RAW_VERSION=$("${CLI}" --version 2>&1 | head -1 || true)
DETECTED_VERSION=$(printf '%s' "${RAW_VERSION}" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1 || true)

if [ -z "${DETECTED_VERSION}" ]; then
  # Cannot parse version — still on PATH, report what we got
  _json_ok "${CLI}" "unknown" "${MIN_VER}"
  exit 0
fi

# ---------------------------------------------------------------------------
# Compare version against minimum (major.minor)
# ---------------------------------------------------------------------------
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
    "'${CLI}' version ${DETECTED_VERSION} is below the minimum required ${MIN_VER}." \
    "${RAW_VERSION}" \
    "[\"Upgrade: npm install -g ${CLI}\",\"See references/failure-modes.md for minimum version details\"]"
  exit 3
fi

# ---------------------------------------------------------------------------
# All clear
# ---------------------------------------------------------------------------
_json_ok "${CLI}" "${DETECTED_VERSION}" "${MIN_VER}"
