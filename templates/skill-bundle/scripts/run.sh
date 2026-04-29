#!/usr/bin/env bash
# {{NAME}} — TODO: describe what this script does
# Returns JSON: { status, result?, error?, next_steps?, metrics? }

set -uo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage: scripts/run.sh [OPTIONS] <ARGS>

TODO: One-paragraph description of what this script does.

Options:
  --help, -h   Show this help and exit

Examples:
  scripts/run.sh ...

Exit codes:
  0  Success
  1  Error
  2  Invalid input
  3  Environment missing
  4  Blocked (decision needed)

Returns JSON to stdout. See SKILL.md for the result schema.
EOF
  exit 0
fi

# TODO: Implement the operation. Return structured JSON to stdout.
echo '{"status":"error","error":{"code":"NOT_IMPLEMENTED","message":"Edit scripts/run.sh to implement this skill."},"next_steps":["Implement the script logic","Replace this stub with real behavior","Test via: scripts/run.sh --help"]}'
exit 1
