#!/usr/bin/env bash
# ship-feature/scripts/verify-tests.sh
# Run the project test suite and return pass/fail counts as structured JSON.
#
# Auto-detects npm / yarn / pnpm / bun from lockfiles and from the
# test script declared in package.json. Falls back to `npm test`.
#
# Returns JSON: { status, result?, error?, next_steps?, metrics? }

set -uo pipefail

# ---------------------------------------------------------------------------
# --help
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage: scripts/verify-tests.sh [OPTIONS]

Run the project's test suite and return structured JSON with pass/fail counts.

Options:
  --dir <path>   Project root to run tests in (default: cwd)
  --help, -h     Show this help and exit

Exit codes:
  0  All tests passed
  1  One or more tests failed
  2  Invalid input
  3  Environment missing (no package.json or no test script)

Returns JSON to stdout. Example success:
  {
    "status": "ok",
    "result": { "passed": 42, "failed": 0, "skipped": 1, "duration_ms": 1234 },
    "metrics": { "duration_ms": 1234 }
  }

Example failure:
  {
    "status": "error",
    "error": {
      "code": "TESTS_FAILED",
      "message": "3 tests failed",
      "evidence": "..."
    },
    "next_steps": [
      "Inspect test output above",
      "Re-run with --verbose to see failure details"
    ]
  }

Example blocked (no test command):
  { "status": "blocked", "error": { "code": "NO_TEST_COMMAND", "message": "..." } }

Exit codes:
  0  All tests passed
  1  Tests failed
  2  Invalid input
  3  No test command detected (project has no package.json or no test script)
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
  # Escape a string for safe embedding in a JSON value.
  # Use python3 if available (most reliable); fall back to basic sed.
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "${1}" | python3 -c 'import sys,json; sys.stdout.write(json.dumps(sys.stdin.read()))'
  else
    local escaped
    escaped=$(printf '%s' "${1}" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/g' | tr -d '\n' | sed 's/\\n$//')
    printf '"%s"' "${escaped}"
  fi
}

# ---------------------------------------------------------------------------
# Detect package manager and test command
# ---------------------------------------------------------------------------
PKG_JSON="${PROJECT_DIR}/package.json"

if [ ! -f "${PKG_JSON}" ]; then
  printf '{"status":"blocked","error":{"code":"NO_TEST_COMMAND","message":"No package.json found in %s — cannot detect test command."}}\n' "${PROJECT_DIR}"
  exit 3
fi

# Detect package manager from lockfiles
if [ -f "${PROJECT_DIR}/bun.lockb" ] || [ -f "${PROJECT_DIR}/bun.lock" ]; then
  PKG_MGR="bun"
elif [ -f "${PROJECT_DIR}/pnpm-lock.yaml" ]; then
  PKG_MGR="pnpm"
elif [ -f "${PROJECT_DIR}/yarn.lock" ]; then
  PKG_MGR="yarn"
else
  PKG_MGR="npm"
fi

# Verify the package manager is available; fall back to npm
if ! command -v "${PKG_MGR}" >/dev/null 2>&1; then
  PKG_MGR="npm"
fi

# Check that a test script is declared
if ! command -v python3 >/dev/null 2>&1 && ! command -v node >/dev/null 2>&1; then
  # Best-effort: assume test script exists
  HAS_TEST_SCRIPT=1
else
  if command -v node >/dev/null 2>&1; then
    HAS_TEST_SCRIPT=$(node -e "try{const p=require('${PKG_JSON}');process.exit(p.scripts&&p.scripts.test?0:1)}catch(e){process.exit(1)}" 2>/dev/null; echo $?)
    # node exits 0 = has test, 1 = no test
    if [ "${HAS_TEST_SCRIPT}" = "0" ]; then
      HAS_TEST_SCRIPT=1
    else
      HAS_TEST_SCRIPT=0
    fi
  else
    HAS_TEST_SCRIPT=1
  fi
fi

if [ "${HAS_TEST_SCRIPT}" = "0" ]; then
  printf '{"status":"blocked","error":{"code":"NO_TEST_COMMAND","message":"package.json in %s has no \"test\" script. Add one to run tests."},"next_steps":["Add a test script to package.json","Or run your test runner directly and verify manually"]}\n' "${PROJECT_DIR}"
  exit 3
fi

# ---------------------------------------------------------------------------
# Run the test suite
# ---------------------------------------------------------------------------
START_MS=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')

# Capture output; allow non-zero exit (we handle it ourselves)
TEST_OUTPUT=$("${PKG_MGR}" test 2>&1) || TEST_EXIT=$?
TEST_EXIT="${TEST_EXIT:-0}"

END_MS=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')
DURATION_MS=$(( END_MS - START_MS ))

# ---------------------------------------------------------------------------
# Parse pass/fail counts from common test runner outputs
# ---------------------------------------------------------------------------
# Patterns covered:
#   vitest:   "X passed | Y failed | Z skipped"  /  "X passed (Z skipped)"
#   jest:     "Tests: X passed, Y failed, Z skipped"
#   mocha:    "X passing" / "Y failing"
#   tap:      "# pass X" / "# fail Y"
#   generic:  "X tests passed" / "Y tests failed"

PASSED=0
FAILED=0
SKIPPED=0

# vitest: "✓ 42 tests passed | 0 failed | 1 skipped" or "42 passed (1 skipped)"
if echo "${TEST_OUTPUT}" | grep -qiE '[0-9]+ (tests )?passed'; then
  PASSED=$(echo "${TEST_OUTPUT}" | grep -oiE '([0-9]+) (tests )?passed' | grep -oE '[0-9]+' | tail -1 || echo 0)
fi
if echo "${TEST_OUTPUT}" | grep -qiE '[0-9]+ failed'; then
  FAILED=$(echo "${TEST_OUTPUT}" | grep -oiE '([0-9]+) failed' | grep -oE '[0-9]+' | tail -1 || echo 0)
fi
if echo "${TEST_OUTPUT}" | grep -qiE '[0-9]+ skipped'; then
  SKIPPED=$(echo "${TEST_OUTPUT}" | grep -oiE '([0-9]+) skipped' | grep -oE '[0-9]+' | tail -1 || echo 0)
fi

# mocha-style: "X passing" / "Y failing"
if [ "${PASSED}" = "0" ] && echo "${TEST_OUTPUT}" | grep -qiE '[0-9]+ passing'; then
  PASSED=$(echo "${TEST_OUTPUT}" | grep -oiE '([0-9]+) passing' | grep -oE '[0-9]+' | tail -1 || echo 0)
fi
if [ "${FAILED}" = "0" ] && echo "${TEST_OUTPUT}" | grep -qiE '[0-9]+ failing'; then
  FAILED=$(echo "${TEST_OUTPUT}" | grep -oiE '([0-9]+) failing' | grep -oE '[0-9]+' | tail -1 || echo 0)
fi

# tap: "# pass X" / "# fail Y"
if [ "${PASSED}" = "0" ] && echo "${TEST_OUTPUT}" | grep -qiE '^# pass [0-9]+'; then
  PASSED=$(echo "${TEST_OUTPUT}" | grep -oiE '^# pass ([0-9]+)' | grep -oE '[0-9]+' | tail -1 || echo 0)
fi
if [ "${FAILED}" = "0" ] && echo "${TEST_OUTPUT}" | grep -qiE '^# fail [0-9]+'; then
  FAILED=$(echo "${TEST_OUTPUT}" | grep -oiE '^# fail ([0-9]+)' | grep -oE '[0-9]+' | tail -1 || echo 0)
fi

# If exit code is non-zero but we couldn't parse failure count, mark at least 1 failed
if [ "${TEST_EXIT}" != "0" ] && [ "${FAILED}" = "0" ]; then
  FAILED=1
fi

# ---------------------------------------------------------------------------
# Return result
# ---------------------------------------------------------------------------
if [ "${TEST_EXIT}" = "0" ] && [ "${FAILED}" = "0" ]; then
  printf '{"status":"ok","result":{"passed":%s,"failed":%s,"skipped":%s,"duration_ms":%s},"metrics":{"duration_ms":%s}}\n' \
    "${PASSED}" "${FAILED}" "${SKIPPED}" "${DURATION_MS}" "${DURATION_MS}"
  exit 0
else
  EVIDENCE=$(_json_escape "$(echo "${TEST_OUTPUT}" | tail -30)")
  printf '{"status":"error","error":{"code":"TESTS_FAILED","message":"%s test(s) failed","evidence":%s},"result":{"passed":%s,"failed":%s,"skipped":%s,"duration_ms":%s},"metrics":{"duration_ms":%s},"next_steps":["Inspect the test output above","Re-run with verbose flag for more details","Fix failing tests before opening a PR"]}\n' \
    "${FAILED}" "${EVIDENCE}" "${PASSED}" "${FAILED}" "${SKIPPED}" "${DURATION_MS}" "${DURATION_MS}"
  exit 1
fi
