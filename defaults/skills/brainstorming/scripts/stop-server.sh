#!/usr/bin/env bash
# Stop the brainstorm server and clean up
# Usage: stop-server.sh <session_dir>
#
# Kills the server process. Only deletes session directory if it's
# under /tmp (ephemeral). Persistent directories (.superpowers/) are
# kept so mockups can be reviewed later.

# --- --help block (per docs/skill-authoring.md script feedback contract) ---
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'HELP'
Usage: stop-server.sh <session_dir>

Stops a running brainstorming visual companion server (started via
start-server.sh). Reads the server PID from <session_dir>/state/server.pid
and sends SIGTERM (escalating to SIGKILL after ~2 seconds if the process
doesn't shut down gracefully).

Arguments:
  <session_dir>  Path to the session directory created by start-server.sh.
                 The PID file is at <session_dir>/state/server.pid.
  --help, -h     Show this message and exit 0.

Cleanup:
  - Always removes <session_dir>/state/server.pid and server.log on success.
  - Removes the entire session directory ONLY if it is under /tmp/ (ephemeral).
  - Persistent session directories (e.g. <project>/.superpowers/brainstorm/...)
    are preserved so the user can review mockups after the server stops.

Output (stdout):
  {"status": "stopped"}      — server was running and is now stopped
  {"status": "not_running"}  — no PID file found; nothing to stop
  {"status": "failed", ...}  — kill attempted but process still alive

Exit codes:
  0  Server stopped (or was not running)
  1  Argument error or kill failed
HELP
  exit 0
fi

SESSION_DIR="$1"

if [[ -z "$SESSION_DIR" ]]; then
  echo '{"error": "Usage: stop-server.sh <session_dir>"}'
  exit 1
fi

STATE_DIR="${SESSION_DIR}/state"
PID_FILE="${STATE_DIR}/server.pid"

if [[ -f "$PID_FILE" ]]; then
  pid=$(cat "$PID_FILE")

  # Try to stop gracefully, fallback to force if still alive
  kill "$pid" 2>/dev/null || true

  # Wait for graceful shutdown (up to ~2s)
  for i in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done

  # If still running, escalate to SIGKILL
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true

    # Give SIGKILL a moment to take effect
    sleep 0.1
  fi

  if kill -0 "$pid" 2>/dev/null; then
    echo '{"status": "failed", "error": "process still running"}'
    exit 1
  fi

  rm -f "$PID_FILE" "${STATE_DIR}/server.log"

  # Only delete ephemeral /tmp directories
  if [[ "$SESSION_DIR" == /tmp/* ]]; then
    rm -rf "$SESSION_DIR"
  fi

  echo '{"status": "stopped"}'
else
  echo '{"status": "not_running"}'
fi
