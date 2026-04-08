# Terminal-Bench 2.0 adapter for agent-harness

> ⚠️ **PARKED** — Do not run. This adapter is structurally correct but will score
> ~0% until the harness has Wrapped Agent Mode (the ability to wrap an external
> coding CLI like qwen-code as a managed subprocess). Bare `harness run` has no
> built-in shell/file tools, so TB2 tasks can't succeed. Unpark after Wrapped
> Agent Mode ships; change `agent.py` to install both qwen-code and agent-harness
> in the container and invoke `harness run --wrap qwen-code "<task>"`.

A Harbor agent that runs `harness run` against the 92-task Terminal-Bench 2.0
suite maintained by Laude Institute. Mirrors the exact leaderboard-ranked
runner used by Forge, Claude Code, and friends.

```
bench/terminal-bench/
├── agent_harness_adapter/
│   ├── __init__.py
│   └── agent.py              # AgentHarness(BaseInstalledAgent)
├── scripts/
│   ├── smoke.sh              # 5 tasks, ~$1, verify wiring
│   └── full.sh               # 92 tasks, ~$10, headline number
├── pyproject.toml            # adapter is a real python package so Harbor can import it
├── .env.example
└── README.md
```

## Prerequisites

- **Docker Desktop running** — Harbor spins up a fresh container per task.
- **`uv`** — `curl -LsSf https://astral.sh/uv/install.sh | sh`
- **OpenRouter API key** — https://openrouter.ai/keys
- **agent-harness reachable by npm** — the adapter runs `npm install -g` inside
  each container. Options:
  - Push this repo to GitHub (default, simplest)
  - `npm publish` it
  - Point `HARNESS_INSTALL_SOURCE` at a tarball URL

## Setup (once)

```bash
cd bench/terminal-bench
cp .env.example .env && $EDITOR .env   # fill in OPENROUTER_API_KEY
uv venv && source .venv/bin/activate
uv pip install -e .                    # installs harbor + registers the adapter package
set -a && source .env && set +a        # export env vars for the harbor subprocess
```

Verify Harbor sees the adapter:

```bash
uv run python -c "from agent_harness_adapter import AgentHarness; print(AgentHarness.name())"
# agent-harness
```

## Smoke run — always do this first

```bash
./scripts/smoke.sh
```

Runs 5 tasks, 2 concurrent, on `qwen/qwen3-coder`. Cost ~$1, wall time 15-30
min. Success looks like:

```
dataset:   terminal-bench/terminal-bench-2   (92 tasks, 5 sampled)
agent:     agent-harness (import: agent_harness_adapter:AgentHarness)
model:     qwen/qwen3-coder
─────────────────────────────────────────
 ✓ adaptive-rejection-sampler           42s
 ✓ bn-fit-modify                        1m31s
 ✗ break-filter-js-from-html            2m04s  (test exit 1)
 ✓ build-cython-ext                     3m12s
 ✓ build-pmars                          2m47s
─────────────────────────────────────────
resolved 4/5  (80.0%)
```

**If the smoke run fails before any task completes**, it's almost certainly an
adapter bug, not a harness bug. Common first-run failures:

| Symptom | Cause | Fix |
| --- | --- | --- |
| `NVM failed to load` | Base image is missing curl/bash | Check `apt-get install` line in `agent.py` |
| `npm install -g ... ENOENT` | `HARNESS_INSTALL_SOURCE` unreachable from container | Push the repo public, or change the install source |
| `harness: command not found` | npm install succeeded but global bin isn't in PATH | Check nvm default node version in `install()` |
| `OPENROUTER_API_KEY not set` in harness output | env var not forwarded | Check `_resolved_env_vars` in `run()` |
| Hangs on "Running command: ..." | Harbor task has no internet | Expected for a few tasks; they should time out cleanly |

Inspect a specific task's logs:

```bash
ls ~/.harbor/runs/latest/trials/<task-name>/logs/agent/
# agent-harness.txt  ← everything the harness printed
```

## Full run

Only after a clean smoke:

```bash
./scripts/full.sh
```

All 92 tasks, 4 concurrent, ~3-6 hours, ~$8-15. The script forwards any extra
args to `harbor run` — use `-n 8` to bump concurrency, `--task-name 'build-*'`
to scope to a subset, etc.

## Comparing to Forge / Claude Code / etc.

Forge self-reports **81.8%** on TB2. Public leaderboard:
https://tbench.ai/leaderboard

Numbers to record for your headline claim:
- Overall pass rate
- Model id (Qwen3-Coder vs Claude Sonnet — not comparable apples-to-apples)
- Mean time-to-resolve
- Total cost

Harbor writes all of these to `~/.harbor/runs/<run-id>/summary.json`.

## What this adapter intentionally skips

- **Trajectory export**: `populate_context_post_run()` is a no-op. The Harbor
  dashboard will show token counts as 0 and won't render step-by-step traces.
  Revisit when `harness run` gains a structured trace output (`--trace json`).
- **MCP server forwarding**: Forge's qwen-code adapter copies MCP config into
  the container. We don't — the harness loads MCP from its own config which
  it reads from inside the container after install. If you want to bench with
  custom MCP servers, pre-bake them into a custom `HARNESS_INSTALL_SOURCE`.
- **Skills directory copying**: same rationale. Skills travel with the install.

## Swapping models

The `-m` flag on `harbor run` is passed through to `harness run --model` as-is.
Anything OpenRouter recognizes works:

```bash
./scripts/smoke.sh -m anthropic/claude-sonnet-4
./scripts/smoke.sh -m openai/gpt-4o
./scripts/smoke.sh -m qwen/qwen-2.5-coder-32b-instruct
```

For a head-to-head matrix, run `full.sh` 3× with different `-m` values and diff
the summary.json outputs.

## Submitting to the leaderboard

See https://github.com/laude-institute/terminal-bench/blob/main/docs/LEADERBOARD.md
— you upload the `summary.json` + a trajectory zip via PR. Note that the
trajectory export gap above means we can't submit a leaderboard-valid run
until `populate_context_post_run` is implemented.
