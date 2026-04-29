# Session 2026-04-28T09:14

## User goal
Add a `--dry-run` flag to the `harness migrate` command so users can preview pending migrations.

## What happened
- Searched `src/cli/migrate.ts` and `src/runtime/migrations.ts` for existing flag handling.
- Followed the existing `commander` pattern (`--verbose`, `--force`) and added `--dry-run` alongside.
- Wired the flag through `runMigrations(opts)` so the planner returns a plan instead of executing.
- Added one unit test covering the no-execute path.

## Outcome
Tests pass. PR opened.

## Pattern noted
Reuse the existing flag plumbing rather than threading a new options object — followed the codebase convention.
