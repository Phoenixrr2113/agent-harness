# Fix Plan — Agent Harness

## Completed (This Loop)

- [x] **Progressive disclosure budget algorithm** — Fixed context-loader to use global demand estimation instead of hardcoded thresholds. Now correctly falls back L2 -> L1 -> L0 based on total token demand vs available budget. Updated test to match corrected behavior.
- [x] **Conversation messages API** — Rewrote Conversation class to use AI SDK's `messages` parameter instead of concatenating history into a flat prompt string. Proper message structure gives LLMs better understanding of conversation turns.
- [x] **Chat model override** — Connected `--model` flag in `harness chat` to the Conversation via `setModelOverride()`.
- [x] **Streaming token capture** — `harness.stream()` now captures usage tokens from the `streamText` result's `usage` promise instead of recording 0.
- [x] **Validate command** — New `harness validate` checks: required files, config, state, primitive directories, context budget, API key, memory directories. Exit code 1 on errors.
- [x] **Provider reset** — Added `resetProvider()` to clear cached OpenRouter provider.
- [x] **New provider APIs** — Added `generateWithMessages()` and `streamWithMessages()` for proper message-based interactions.

## Completed (Loop 2)

- [x] **Conversation windowing** — Rewrote from message-count (maxHistory: 20) to token-budget-based. Uses 50% of (max_tokens - system_prompt_tokens) for conversation history. Messages track individual token counts, trimmed oldest-first.
- [x] **Session cleanup** — Added `cleanupOldFiles()` enforcing `session_retention_days` and `journal_retention_days`. New `harness cleanup` command with `--dry-run` flag. Added `listExpiredFiles()` and `listSessions()` utilities.
- [x] **Scheduler auto-start** — Integrated Scheduler into `harness dev` command. Starts automatically, graceful shutdown on SIGINT/SIGTERM. Added `--no-schedule` flag to disable.
- [x] **Config validation** — Added `HarnessConfigSchema` Zod schema in types.ts. `loadConfig()` now validates via `safeParse()` with descriptive error messages. Uses `.passthrough()` to preserve unknown keys.
- [x] **Intake directory creation** — Added `intake/` to scaffold DIRECTORIES array.
- [x] **Scratch command** — New `harness scratch <note>` appends timestamped notes to `memory/scratch.md`.

## Completed (Loop 3)

- [x] **Agent delegation** — New `src/runtime/delegate.ts` with full delegation engine: `delegateTo()` runs stateless sub-agents with their own context (agent body + CORE.md + rules at L1), `findAgent()` resolves by id/prefix/filename, `buildAgentPrompt()` assembles 10%-budget system prompts. Sessions tagged with `[delegated to agent-id]`. New CLI commands: `harness agents` (list), `harness delegate <id> <prompt>` (invoke). Default summarizer agent in scaffold. 16 new tests.

## Completed (Loop 4)

- [x] **Journal date range** — Added `--from`, `--to`, `--all`, `--force`, `--pending` flags to `harness journal`. New `synthesizeJournalRange()` processes multiple dates, skips already-journaled dates unless `--force`. New `listUnjournaled()` finds gaps. `--pending` shows dates needing journals.
- [x] **Better error messages** — Rewrote `formatError()` with typed error handling: API errors, network errors, rate limiting, file system errors, validation errors. Added `requireHarness()` helper used by 9 commands. Eliminated all `err: any` patterns in CLI.
- [x] **Session metadata** — `SessionRecord` now includes optional `model_id` and `delegated_to` fields. Sessions record which model was used and whether they were delegation calls. Written to session markdown with **Model:** and **Delegated to:** lines. Delegation sessions get auto-tagged with agent id.

## Completed (Loop 5)

- [x] **Conversation session recording** — `send()` and `sendStream()` in Conversation class now record sessions after each chat turn. Optional via `recordSessions` constructor option (defaults to true). Includes model_id, prompt (truncated to 500 chars), and summary (truncated to 200 chars). 16 new tests in conversation.test.ts.
- [x] **Context.md format (JSON-lines)** — Switched from fragile `### User`/`### Assistant` markdown to JSON-lines format (`context.jsonl`). Each line is one `{"role","content"}` object. Backward-compatible: auto-migrates legacy `context.md` on first load. Both parsers exported and tested. `.gitignore` updated.
- [x] **Defaults/templates** — Populated `defaults/` with canonical primitives (rules, instincts, skills, playbooks, agents) using `{{DATE}}`/`{{AGENT_NAME}}` template variables. Created 4 model config templates: `base` (claude-sonnet), `claude-opus`, `gpt4`, `local` (llama-3.3-70b). Refactored scaffold.ts to read from `defaults/` and `templates/` at runtime instead of hardcoding strings (~50% code reduction). Added `--template` flag to `harness init`. Added `listTemplates()` export.

## Next Priority

### P2 — Polish

- [ ] **Index file improvements** — Index tables truncate L0 at 80 chars. Should be configurable.

### P3 — Future

- [ ] **Multi-provider support** — Currently hardcoded to OpenRouter. Abstract provider to support direct Anthropic/OpenAI/local models.
- [ ] **Plugin system** — Allow custom commands and primitives via a plugin directory.
- [ ] **Programmatic API tests** — Test `createHarness()` with mocked LLM calls.
- [ ] **CI/CD pipeline** — GitHub Actions for build + test on push.

## Architecture Notes

### What Works Well
- File-first design is clean and intuitive
- Progressive disclosure (L0/L1/L2) is effective for budget management
- Session recording + journal synthesis loop is functional end-to-end
- CLI is well-organized with consistent option patterns
- Scaffold creates a fully functional agent in one command

### Known Limitations
- Provider singleton means you can't mix providers in the same process
- Token estimation is 1:4 char ratio — good enough but not precise
- No streaming for journal/learn commands (they use batch generation)
- File locking: concurrent processes could corrupt state.md or context.md
