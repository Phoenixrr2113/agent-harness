---
name: daily-reflection
description: >-
  Scheduled end-of-day synthesis. Runs at 18:00 daily — reads the day's
  sessions, writes a structured journal entry to memory/journal/, and proposes
  rule candidates from patterns across recent journals. Use when the harness
  schedule fires or when the user asks to summarize today's activity.
license: MIT
metadata:
  harness-tags: 'workflow,scheduled,reflection'
  harness-status: active
  harness-author: human
  harness-related: 'research,respect-the-user'
  harness-schedule: '0 18 * * *'
---

# Workflow: Daily Reflection

## When to use

This skill is triggered automatically at 18:00 by the harness scheduler
(`metadata.harness-schedule: 0 18 * * *`). Invoke it manually when:

- The user asks to synthesize or summarize today's work.
- The user asks what was accomplished, learned, or left open.
- You want to extract rule candidates from recent journals after a significant
  session.

## Available scripts

- `scripts/synthesize.sh [--date YYYY-MM-DD] [--harness-dir <path>]` — Run
  the daily journal synthesis for the given date (default: today). Returns
  structured JSON with `journal_path`, `sessions_processed`, and
  `patterns_detected`.
- `scripts/propose-rules.sh [--harness-dir <path>]` — Analyze recent journals
  and propose instinct/rule candidates. Returns JSON with a list of candidates
  and their source reasoning.

## Workflow

1. **Synthesize:** Run `scripts/synthesize.sh` (optionally with `--date`).
   On `status: ok`, the journal file is at `result.journal_path`.
2. **Propose rules:** Run `scripts/propose-rules.sh` to extract rule
   candidates from the new (and recent) journal entries.
3. **Review:** Present the journal summary and rule candidates to the user
   for review before any rule is promoted to an instinct.

## Gotchas

- Both scripts require a working `harness` binary on `PATH` (or `--harness-dir`
  pointing to a valid harness directory).
- `synthesize.sh` is idempotent by default — re-running on the same date
  overwrites the existing journal entry. Pass `--no-force` if you want to
  preserve an existing entry.
- `propose-rules.sh` reads the last 7 days of journal entries. On a fresh
  harness with fewer than 7 days of history the output will be sparse — this
  is expected.

## Failure modes

- `NO_SESSIONS` — No session files found for the requested date. Nothing to
  synthesize. Inform the user and exit.
- `JOURNAL_COMMAND_FAILED` — The underlying `harness journal` command returned
  a non-zero exit code. The error details are in `error.message`. Check that
  Ollama is running and the configured model is available.
- `LEARN_COMMAND_FAILED` — The `harness learn` command failed. See
  `error.message`. Same checks as above.
- `INVALID_DATE` — The `--date` argument does not match `YYYY-MM-DD`. Fix the
  format and retry.
