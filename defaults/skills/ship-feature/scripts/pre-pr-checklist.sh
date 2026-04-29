#!/usr/bin/env bash
# ship-feature/scripts/pre-pr-checklist.sh
# Run typecheck + lint + tests + build all-or-nothing before opening a PR.
# Stops at the first failure and returns the failure as the structured error.
#
# Calls verify-tests.sh and verify-build.sh from the same scripts/ directory.
#
# Returns JSON: { status, result?, error?, next_steps?, metrics? }

set -uo pipefail

# ---------------------------------------------------------------------------
# --help
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage: scripts/pre-pr-checklist.sh [OPTIONS]

Run the full pre-PR checklist: typecheck, lint, tests, build.
Stops at the first failure. All checks must pass for status: ok.

Options:
  --dir <path>   Project root (default: cwd)
  --help, -h     Show this help and exit

Exit codes:
  0  All checks passed
  1  One or more checks failed (see error.code)
  2  Invalid input
  3  Environment missing

Returns JSON to stdout. Example success:
  {
    "status": "ok",
    "result": {
      "typecheck": "ok",
      "lint": "ok",
      "tests": { "passed": 42, "failed": 0, "skipped": 0 },
      "build": "ok"
    },
    "metrics": { "total_duration_ms": 8400 }
  }

Example failure:
  {
    "status": "error",
    "error": {
      "code": "TESTS_FAILED",
      "message": "3 test(s) failed",
      "evidence": "..."
    },
    "result": {
      "typecheck": "ok",
      "lint": "ok",
      "tests": "failed",
      "build": "skipped"
    },
    "next_steps": ["Fix failing tests before opening a PR"]
  }

error.code values:
  TYPECHECK_FAILED   — tsc --noEmit returned non-zero
  LINT_FAILED        — lint script returned non-zero
  TESTS_FAILED       — test suite has failures
  BUILD_FAILED       — build command returned non-zero
  NO_TEST_COMMAND    — no test script found (blocked, not error)
  NO_BUILD_COMMAND   — no build command found (blocked, not error)
  INVALID_INPUT      — bad argument
EOF
  exit 0
fi

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------
PROJECT_DIR="${PWD}"

while [ $# -gt 0 ]; do
  case "${1}" in
    --dir)
      shift
      PROJECT_DIR="${1}"
      shift
      ;;
    --dir=*)
      PROJECT_DIR="${1#--dir=}"
      shift
      ;;
    *)
      printf '{"status":"error","error":{"code":"INVALID_INPUT","message":"Unknown argument: %s"},"next_steps":["Run --help for usage"]}\n' "${1}"
      exit 2
      ;;
  esac
done

if [ ! -d "${PROJECT_DIR}" ]; then
  printf '{"status":"error","error":{"code":"INVALID_INPUT","message":"Project directory not found: %s"},"next_steps":["Provide a valid --dir path"]}\n' "${PROJECT_DIR}"
  exit 2
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
_json_escape() {
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "${1}" | python3 -c 'import sys,json; sys.stdout.write(json.dumps(sys.stdin.read()))'
  else
    local escaped
    escaped=$(printf '%s' "${1}" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/g' | tr -d '\n' | sed 's/\\n$//')
    printf '"%s"' "${escaped}"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TOTAL_START_MS=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')

# ---------------------------------------------------------------------------
# Detect package manager from lockfiles
# ---------------------------------------------------------------------------
if [ -f "${PROJECT_DIR}/bun.lockb" ] || [ -f "${PROJECT_DIR}/bun.lock" ]; then
  PKG_MGR="bun"
elif [ -f "${PROJECT_DIR}/pnpm-lock.yaml" ]; then
  PKG_MGR="pnpm"
elif [ -f "${PROJECT_DIR}/yarn.lock" ]; then
  PKG_MGR="yarn"
else
  PKG_MGR="npm"
fi

if ! command -v "${PKG_MGR}" >/dev/null 2>&1; then
  PKG_MGR="npm"
fi

# ---------------------------------------------------------------------------
# Step 1: Typecheck
# ---------------------------------------------------------------------------
TYPECHECK_STATUS="skipped"

PKG_JSON="${PROJECT_DIR}/package.json"
HAS_TSCONFIG=0
[ -f "${PROJECT_DIR}/tsconfig.json" ] && HAS_TSCONFIG=1

# Check for a lint script that includes typecheck (tsc --noEmit)
HAS_LINT_SCRIPT=0
if [ -f "${PKG_JSON}" ] && command -v node >/dev/null 2>&1; then
  CHECK=$(node -e "try{const p=require('${PKG_JSON}');process.exit(p.scripts&&p.scripts.lint?0:1)}catch(e){process.exit(1)}" 2>/dev/null; echo $?)
  [ "${CHECK}" = "0" ] && HAS_LINT_SCRIPT=1
elif [ -f "${PKG_JSON}" ] && grep -q '"lint"' "${PKG_JSON}" 2>/dev/null; then
  HAS_LINT_SCRIPT=1
fi

if [ "${HAS_TSCONFIG}" = "1" ]; then
  # Prefer `tsc --noEmit` directly for an explicit typecheck
  TSC_BIN=""
  if command -v tsc >/dev/null 2>&1; then
    TSC_BIN="tsc"
  elif [ -f "${PROJECT_DIR}/node_modules/.bin/tsc" ]; then
    TSC_BIN="${PROJECT_DIR}/node_modules/.bin/tsc"
  elif command -v npx >/dev/null 2>&1; then
    TSC_BIN="npx tsc"
  fi

  if [ -n "${TSC_BIN}" ]; then
    TYPECHECK_OUTPUT=$(cd "${PROJECT_DIR}" && eval "${TSC_BIN} --noEmit" 2>&1) || TYPECHECK_EXIT=$?
    TYPECHECK_EXIT="${TYPECHECK_EXIT:-0}"
    if [ "${TYPECHECK_EXIT}" != "0" ]; then
      TOTAL_END_MS=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')
      TOTAL_DURATION_MS=$(( TOTAL_END_MS - TOTAL_START_MS ))
      EVIDENCE=$(_json_escape "$(echo "${TYPECHECK_OUTPUT}" | tail -30)")
      printf '{"status":"error","error":{"code":"TYPECHECK_FAILED","message":"TypeScript type errors detected","evidence":%s},"result":{"typecheck":"failed","lint":"skipped","tests":"skipped","build":"skipped"},"metrics":{"total_duration_ms":%s},"next_steps":["Fix TypeScript errors before continuing","Run: tsc --noEmit"]}\n' \
        "${EVIDENCE}" "${TOTAL_DURATION_MS}"
      exit 1
    fi
    TYPECHECK_STATUS="ok"
  fi
fi

# ---------------------------------------------------------------------------
# Step 2: Lint
# ---------------------------------------------------------------------------
LINT_STATUS="skipped"

if [ "${HAS_LINT_SCRIPT}" = "1" ]; then
  LINT_OUTPUT=$(cd "${PROJECT_DIR}" && "${PKG_MGR}" run lint 2>&1) || LINT_EXIT=$?
  LINT_EXIT="${LINT_EXIT:-0}"
  if [ "${LINT_EXIT}" != "0" ]; then
    TOTAL_END_MS=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')
    TOTAL_DURATION_MS=$(( TOTAL_END_MS - TOTAL_START_MS ))
    EVIDENCE=$(_json_escape "$(echo "${LINT_OUTPUT}" | tail -30)")
    printf '{"status":"error","error":{"code":"LINT_FAILED","message":"Lint check failed","evidence":%s},"result":{"typecheck":%s,"lint":"failed","tests":"skipped","build":"skipped"},"metrics":{"total_duration_ms":%s},"next_steps":["Fix lint violations before continuing","Run: %s run lint"]}\n' \
      "${EVIDENCE}" "$(_json_escape "${TYPECHECK_STATUS}")" "${TOTAL_DURATION_MS}" "${PKG_MGR}"
    exit 1
  fi
  LINT_STATUS="ok"
fi

# ---------------------------------------------------------------------------
# Step 3: Tests (via verify-tests.sh)
# ---------------------------------------------------------------------------
TESTS_STATUS="skipped"
TESTS_RESULT_JSON='null'

TESTS_OUTPUT=$("${SCRIPT_DIR}/verify-tests.sh" --dir "${PROJECT_DIR}" 2>&1) || TESTS_EXIT=$?
TESTS_EXIT="${TESTS_EXIT:-0}"

# Parse the JSON result from verify-tests.sh
if command -v python3 >/dev/null 2>&1; then
  TESTS_RESULT_JSON=$(echo "${TESTS_OUTPUT}" | python3 -c '
import sys, json
try:
    data = json.loads(sys.stdin.read().strip())
    if data.get("status") == "ok":
        r = data.get("result", {})
        print(json.dumps({"passed": r.get("passed", 0), "failed": r.get("failed", 0), "skipped": r.get("skipped", 0)}))
    elif data.get("status") == "blocked":
        print(json.dumps({"blocked": True, "code": data.get("error", {}).get("code", "NO_TEST_COMMAND")}))
    else:
        r = data.get("result", {})
        print(json.dumps({"passed": r.get("passed", 0), "failed": r.get("failed", 0), "skipped": r.get("skipped", 0)}))
except Exception:
    print("null")
' 2>/dev/null || echo 'null')
else
  TESTS_RESULT_JSON='null'
fi

if [ "${TESTS_EXIT}" = "3" ]; then
  # No test command — blocked but not a hard failure; skip gracefully
  TESTS_STATUS="blocked"
elif [ "${TESTS_EXIT}" != "0" ]; then
  TOTAL_END_MS=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')
  TOTAL_DURATION_MS=$(( TOTAL_END_MS - TOTAL_START_MS ))
  # Extract error fields from verify-tests.sh output
  ERROR_CODE="TESTS_FAILED"
  ERROR_MSG="Test suite failed"
  if command -v python3 >/dev/null 2>&1; then
    PARSED=$(echo "${TESTS_OUTPUT}" | python3 -c '
import sys, json
try:
    data = json.loads(sys.stdin.read().strip())
    err = data.get("error", {})
    print(err.get("code", "TESTS_FAILED"))
    print(err.get("message", "Test suite failed"))
except Exception:
    print("TESTS_FAILED")
    print("Test suite failed")
' 2>/dev/null || printf 'TESTS_FAILED\nTest suite failed')
    ERROR_CODE=$(echo "${PARSED}" | head -1)
    ERROR_MSG=$(echo "${PARSED}" | tail -1)
  fi
  EVIDENCE=$(_json_escape "$(echo "${TESTS_OUTPUT}" | tail -30)")
  printf '{"status":"error","error":{"code":%s,"message":%s,"evidence":%s},"result":{"typecheck":%s,"lint":%s,"tests":%s,"build":"skipped"},"metrics":{"total_duration_ms":%s},"next_steps":["Fix failing tests before opening a PR","Run: scripts/verify-tests.sh --dir %s"]}\n' \
    "$(_json_escape "${ERROR_CODE}")" "$(_json_escape "${ERROR_MSG}")" "${EVIDENCE}" \
    "$(_json_escape "${TYPECHECK_STATUS}")" "$(_json_escape "${LINT_STATUS}")" \
    "${TESTS_RESULT_JSON:-null}" "${TOTAL_DURATION_MS}" "${PROJECT_DIR}"
  exit 1
else
  TESTS_STATUS="ok"
fi

# ---------------------------------------------------------------------------
# Step 4: Build (via verify-build.sh)
# ---------------------------------------------------------------------------
BUILD_STATUS="skipped"
BUILD_RESULT_JSON='null'

BUILD_OUTPUT=$("${SCRIPT_DIR}/verify-build.sh" --dir "${PROJECT_DIR}" 2>&1) || BUILD_EXIT=$?
BUILD_EXIT="${BUILD_EXIT:-0}"

if [ "${BUILD_EXIT}" = "3" ]; then
  BUILD_STATUS="blocked"
elif [ "${BUILD_EXIT}" != "0" ]; then
  TOTAL_END_MS=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')
  TOTAL_DURATION_MS=$(( TOTAL_END_MS - TOTAL_START_MS ))
  ERROR_CODE="BUILD_FAILED"
  ERROR_MSG="Build command failed"
  if command -v python3 >/dev/null 2>&1; then
    PARSED=$(echo "${BUILD_OUTPUT}" | python3 -c '
import sys, json
try:
    data = json.loads(sys.stdin.read().strip())
    err = data.get("error", {})
    print(err.get("code", "BUILD_FAILED"))
    print(err.get("message", "Build command failed"))
except Exception:
    print("BUILD_FAILED")
    print("Build command failed")
' 2>/dev/null || printf 'BUILD_FAILED\nBuild command failed')
    ERROR_CODE=$(echo "${PARSED}" | head -1)
    ERROR_MSG=$(echo "${PARSED}" | tail -1)
  fi
  EVIDENCE=$(_json_escape "$(echo "${BUILD_OUTPUT}" | tail -30)")
  printf '{"status":"error","error":{"code":%s,"message":%s,"evidence":%s},"result":{"typecheck":%s,"lint":%s,"tests":%s,"build":"failed"},"metrics":{"total_duration_ms":%s},"next_steps":["Fix build errors before opening a PR","Run: scripts/verify-build.sh --dir %s"]}\n' \
    "$(_json_escape "${ERROR_CODE}")" "$(_json_escape "${ERROR_MSG}")" "${EVIDENCE}" \
    "$(_json_escape "${TYPECHECK_STATUS}")" "$(_json_escape "${LINT_STATUS}")" \
    "${TESTS_RESULT_JSON:-null}" "${TOTAL_DURATION_MS}" "${PROJECT_DIR}"
  exit 1
else
  BUILD_STATUS="ok"
  if command -v python3 >/dev/null 2>&1; then
    BUILD_RESULT_JSON=$(echo "${BUILD_OUTPUT}" | python3 -c '
import sys, json
try:
    data = json.loads(sys.stdin.read().strip())
    print(json.dumps(data.get("result", {})))
except Exception:
    print("null")
' 2>/dev/null || echo 'null')
  fi
fi

# ---------------------------------------------------------------------------
# All checks passed
# ---------------------------------------------------------------------------
TOTAL_END_MS=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')
TOTAL_DURATION_MS=$(( TOTAL_END_MS - TOTAL_START_MS ))

printf '{"status":"ok","result":{"typecheck":%s,"lint":%s,"tests":%s,"build":%s},"metrics":{"total_duration_ms":%s}}\n' \
  "$(_json_escape "${TYPECHECK_STATUS}")" \
  "$(_json_escape "${LINT_STATUS}")" \
  "${TESTS_RESULT_JSON:-null}" \
  "$(_json_escape "${BUILD_STATUS}")" \
  "${TOTAL_DURATION_MS}"
exit 0
