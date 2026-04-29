#!/usr/bin/env bash
# ship-feature/scripts/verify-build.sh
# Run the project's build command and return success/failure as structured JSON.
#
# Auto-detects the build command from package.json (build script or tsc).
# Falls back gracefully when no build command is found.
#
# Returns JSON: { status, result?, error?, next_steps?, metrics? }

set -uo pipefail

# ---------------------------------------------------------------------------
# --help
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage: scripts/verify-build.sh [OPTIONS]

Run the project's build command and return structured JSON.

Options:
  --dir <path>   Project root to run the build in (default: cwd)
  --help, -h     Show this help and exit

Exit codes:
  0  Build succeeded
  1  Build failed
  2  Invalid input
  3  No build command detected

Returns JSON to stdout. Example success:
  {
    "status": "ok",
    "result": { "command": "npm run build", "duration_ms": 3210 },
    "metrics": { "duration_ms": 3210 }
  }

Example failure:
  {
    "status": "error",
    "error": {
      "code": "BUILD_FAILED",
      "message": "Build command exited with code 1",
      "evidence": "...(last 30 lines of output)..."
    },
    "next_steps": [
      "Inspect the build output above",
      "Fix compilation errors before opening a PR"
    ]
  }

Example blocked (no build command):
  { "status": "blocked", "error": { "code": "NO_BUILD_COMMAND", "message": "..." } }
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
# Detect build command
# ---------------------------------------------------------------------------
PKG_JSON="${PROJECT_DIR}/package.json"
BUILD_CMD=""
BUILD_CMD_LABEL=""

if [ -f "${PKG_JSON}" ]; then
  # Check for a "build" script in package.json
  if command -v node >/dev/null 2>&1; then
    HAS_BUILD=$(node -e "try{const p=require('${PKG_JSON}');process.exit(p.scripts&&p.scripts.build?0:1)}catch(e){process.exit(1)}" 2>/dev/null; echo $?)
    if [ "${HAS_BUILD}" = "0" ]; then
      BUILD_CMD="${PKG_MGR} run build"
      BUILD_CMD_LABEL="${PKG_MGR} run build"
    fi
  else
    # Fallback: grep for "build" script key
    if grep -q '"build"' "${PKG_JSON}" 2>/dev/null; then
      BUILD_CMD="${PKG_MGR} run build"
      BUILD_CMD_LABEL="${PKG_MGR} run build"
    fi
  fi
fi

# Fall back to tsc if no build script but tsconfig exists
if [ -z "${BUILD_CMD}" ] && [ -f "${PROJECT_DIR}/tsconfig.json" ]; then
  if command -v tsc >/dev/null 2>&1; then
    BUILD_CMD="tsc"
    BUILD_CMD_LABEL="tsc"
  elif command -v npx >/dev/null 2>&1; then
    BUILD_CMD="npx tsc"
    BUILD_CMD_LABEL="npx tsc"
  fi
fi

if [ -z "${BUILD_CMD}" ]; then
  printf '{"status":"blocked","error":{"code":"NO_BUILD_COMMAND","message":"No build command detected in %s. Add a \"build\" script to package.json or add a tsconfig.json."},"next_steps":["Add a build script to package.json","Or run tsc / your bundler manually"]}\n' "${PROJECT_DIR}"
  exit 3
fi

# ---------------------------------------------------------------------------
# Run the build
# ---------------------------------------------------------------------------
START_MS=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')

BUILD_OUTPUT=$(cd "${PROJECT_DIR}" && eval "${BUILD_CMD}" 2>&1) || BUILD_EXIT=$?
BUILD_EXIT="${BUILD_EXIT:-0}"

END_MS=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')
DURATION_MS=$(( END_MS - START_MS ))

# ---------------------------------------------------------------------------
# Return result
# ---------------------------------------------------------------------------
if [ "${BUILD_EXIT}" = "0" ]; then
  printf '{"status":"ok","result":{"command":%s,"duration_ms":%s},"metrics":{"duration_ms":%s}}\n' \
    "$(_json_escape "${BUILD_CMD_LABEL}")" "${DURATION_MS}" "${DURATION_MS}"
  exit 0
else
  EVIDENCE=$(_json_escape "$(echo "${BUILD_OUTPUT}" | tail -30)")
  printf '{"status":"error","error":{"code":"BUILD_FAILED","message":"Build command exited with code %s","evidence":%s},"result":{"command":%s,"duration_ms":%s},"metrics":{"duration_ms":%s},"next_steps":["Inspect the build output above","Fix compilation or bundling errors before opening a PR"]}\n' \
    "${BUILD_EXIT}" "${EVIDENCE}" "$(_json_escape "${BUILD_CMD_LABEL}")" "${DURATION_MS}" "${DURATION_MS}"
  exit 1
fi
