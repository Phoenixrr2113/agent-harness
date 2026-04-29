# Session 2026-04-28T16:30

## User goal
Add a new `harness skill list` subcommand.

## What happened
- Implemented the new subcommand by writing a fresh `listSkills()` helper in `src/cli/skill.ts`.
- **User correction #1:** "There's already a `loadAllSkills()` in `src/runtime/skills/loader.ts` — use that instead of creating a duplicate." I replaced my new helper with the existing loader.
- Wired the subcommand to print one line per skill.
- **User correction #2:** "You're using `console.log` directly — the rest of the CLI uses the `logger` from `src/cli/logger.ts`. Switch to that for consistency." I refactored to use the project logger.
- Re-ran tests; all pass.

## Outcome
Subcommand merged. Two corrections in one session, both about reuse and consistency with existing code.

## Pattern noted
Search for existing helpers and conventions before writing new ones. Both corrections were about ignoring existing project patterns.
