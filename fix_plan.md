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

## Completed (Loop 6)

- [x] **Multi-provider support** — Refactored `provider.ts` to support 3 providers: `openrouter` (default), `anthropic` (direct Anthropic API), `openai` (direct OpenAI API). Each uses its native AI SDK package (`@openrouter/ai-sdk-provider`, `@ai-sdk/anthropic`, `@ai-sdk/openai`). Provider selected via `config.model.provider`. Cached per provider+key. Added `--provider` flag to CLI `run` command. 12 new provider tests.
- [x] **createHarness model/provider override** — Fixed `options.model` which was accepted but never applied. Now properly overrides `config.model.id`. Added `options.provider` to override provider. Both applied before model creation.
- [x] **Programmatic API tests** — 13 new tests for `createHarness()` lifecycle: boot, run, stream, shutdown, session recording, state transitions, model/provider overrides. Uses vitest `vi.mock('ai')` to mock `generateText`/`streamText` without real API calls.
- [x] **Index L0 truncation** — Changed from hardcoded 80-char to configurable via `IndexOptions.summaryMaxLength` (default 120). Adds ellipsis when truncated. Exported `IndexOptions` type.

## Completed (Loop 7)

- [x] **Retry/timeout config** — Added `max_retries` (default 2) and `timeout_ms` (optional) to model config schema. All `generate()`, `generateWithMessages()`, `streamGenerate()`, and `streamWithMessages()` calls now pass retry/timeout/abortSignal through to AI SDK. New `CallOptions` interface exported. `DeepPartial<T>` utility type added for flexible config overrides. `loadConfig()` now accepts `DeepPartial<HarnessConfig>` instead of `Partial<HarnessConfig>`.
- [x] **Streaming delegation** — New `delegateStream()` function in delegate.ts returns `{ agentId, sessionId, textStream }`. Stream wraps session recording (writes session after stream consumed). CLI `harness delegate --stream` flag now works (was previously a no-op stub). Fixed delegate config override that was hardcoding `provider: 'openrouter'` — now preserves the user's config provider. 2 new delegation stream tests.
- [x] **Structured logger** — New `src/core/logger.ts` module with `Logger` interface supporting `debug|info|warn|error` levels and `silent` mode. Global level control via `setGlobalLogLevel()`. Child loggers with colon-delimited prefixes (`[parent:child]`). Harness core uses `log` singleton. CLI gains `--quiet`, `--verbose`, and `--log-level <level>` global flags via commander `preAction` hook. 16 new logger tests.
- [x] **CI/CD pipeline** — GitHub Actions workflow (`.github/workflows/ci.yml`) runs on push/PR to main. Matrix strategy: Node 20 + 22. Steps: install, build, test, verify CLI entry point.

## Completed (Loop 8)

- [x] **Test migration to ai/test** — Replaced `vi.mock('ai')` (hand-rolled generateText/streamText mocks) with `ai/test` `MockLanguageModelV3`. Mock model implements the real LanguageModelV3 interface (`doGenerate`, `doStream`). Tests now exercise the actual AI SDK `generateText`/`streamText` against the mock model — better integration coverage. Mocking moved to provider layer (`getModel` returns mock) instead of SDK layer.
- [x] **Extension directories (plugin system)** — Added `extensions.directories` config field to register custom primitive directories. Extension dirs are automatically: loaded by `loadAllPrimitives()`, included in context assembly (`buildSystemPrompt()`), indexed by `rebuildAllIndexes()`, watched by `createWatcher()`, and validated by `harness validate`. Centralized `CORE_PRIMITIVE_DIRS` constant and `getPrimitiveDirs()` helper exported from types.ts. 4 new tests. Zero code duplication for directory lists.
- [x] **Template config refresh** — Updated all 4 template configs (base, claude-opus, gpt4, local) and `writeDefaultConfig()` with `max_retries`, `timeout_ms`, and `extensions.directories` fields.

## Completed (Loop 9)

- [x] **Quiet hours enforcement** — Scheduler now checks `config.runtime.quiet_hours` before executing workflows. New `isQuietHours()` function uses `Intl.DateTimeFormat` for timezone-aware hour calculation, supports midnight-wrapping ranges (e.g. 23–6), falls back to local time for invalid timezones. `onSkipQuietHours` callback added to `SchedulerOptions`. 8 new tests.
- [x] **Primitive parse error collection** — New `loadDirectoryWithErrors()` and `loadAllPrimitivesWithErrors()` functions collect parse errors instead of silently swallowing them. `ParseError`, `LoadResult`, `LoadAllResult` types exported. `buildSystemPrompt()` now uses the error-collecting loader and logs warnings for broken files.
- [x] **Context budget warnings** — `buildSystemPrompt()` now returns `parseErrors` and `warnings` arrays in `LoadedContext`. Warns when system prompt exceeds 12% of total context budget, and when primitives are loaded at reduced disclosure levels (L0/L1) due to budget constraints. `harness.boot()` logs warnings via structured logger. Fixed duplicate `state.md` push bug in context-loader.
- [x] **Journal synthesis structured output** — New `JournalSynthesis` type with `summary`, `insights`, `instinct_candidates`, `knowledge_updates` fields. New `parseJournalSynthesis()` parser extracts structured sections from LLM output (resilient to missing sections, supports legacy "Patterns" section). Updated synthesis prompt with explicit section format. `JournalEntry` now includes `structured` field. 7 new journal parser tests.

## Completed (Loop 10)

- [x] **Comprehensive validator module** — Extracted validate logic from CLI into standalone `src/runtime/validator.ts` with `validateHarness()` function. Adds cross-reference integrity checking (validates `related:` fields against known primitive IDs and file paths), missing L0/L1 counts across all primitives, multi-provider API key detection (OPENROUTER, ANTHROPIC, OPENAI), and memory directory structure checks. `ValidationResult` type with `ok`, `warnings`, `errors`, `parseErrors`, `primitiveCounts`, `totalPrimitives`. CLI validate command reduced from ~130 lines to ~30 lines. 10 new validator tests.
- [x] **Evaluator auto-fix** — New `fixCapability()` function in intake.ts automatically repairs common issues in capability markdown files: generates missing `id` from filename, adds missing `status: active`, infers and adds missing type tags from content headings, generates L0 summary from first heading (truncated to 120 chars), generates L1 summary from first paragraph (truncated to 300 chars). Writes fixed file back with `gray-matter.stringify()`. 12 new intake fix tests. New `harness fix <file>` CLI command.
- [x] **Intake test suite** — 23 new tests covering `fixCapability()`, `evaluateCapability()`, `installCapability()`, and `processIntake()`.

## Completed (Loop 11)

- [x] **Session archival** — New `archiveOldFiles()` function moves expired sessions to `memory/sessions/archive/YYYY-MM/` and journals to `memory/journal/archive/YYYY-MM/` instead of deleting. Files are preserved for audit/query. `cleanupOldFiles()` retained but deprecated. CLI `harness cleanup` now defaults to archive mode, `--delete` flag for permanent removal. `ArchiveResult` type exported. 12 new session tests.
- [x] **Status command** — New `harness status` shows rich harness overview: agent name/version, model, mode, primitive counts per directory, recent sessions, journal count, goals, active workflows, unfinished business, health summary from validator.
- [x] **Evaluator dependency resolution** — `evaluateCapability()` now accepts optional `harnessDir` parameter. When provided, checks `related:` references against all known primitive IDs and file paths, validates `with:` agent references against `agents/` directory, warns on invalid cron expressions in `schedule:` field. `installCapability()` automatically passes harnessDir for full validation. 5 new dependency resolution tests.

## Completed (Loop 12)

- [x] **Doctor command** — New `harness doctor` runs validation + batch auto-fix in one pass. `doctorHarness()` function creates missing directories (memory/, memory/sessions, memory/journal, intake), auto-fixes all primitives (missing id/status/L0/L1/tags via `fixCapability()`), recalculates L0/L1 warnings after fixes. `DoctorResult` extends `ValidationResult` with `fixes` and `directoriesCreated` arrays. 5 new doctor tests.
- [x] **Scheduled archival** — Scheduler now includes built-in daily auto-archival (cron `0 23 * * *` by default). New `autoArchival` and `archivalCron` options on `SchedulerOptions`. New `onArchival` callback. `runArchival()` public method reads retention config and calls `archiveOldFiles()`. Auto-archival enabled by default in `harness dev`. 5 new scheduler tests (start/stop, list workflows, archival, invalid cron).
- [x] **Workflow CLI** — New `harness workflow list` shows all workflows with schedules, status, agent references, and L0 summaries. New `harness workflow run <id>` executes a single workflow on demand (bypasses quiet hours). Uses existing `Scheduler.runOnce()`.

## Completed (Loop 13)

- [x] **Search/query command** — New `src/runtime/search.ts` with `searchPrimitives()` function that searches across all primitive directories by text query (matches id, tags, L0, L1, body content) and/or filters (tag, type, status, author). Type-aware directory filtering accepts both singular ("rule") and plural ("rules"). New `harness search [query]` CLI command with `--tag`, `--type`, `--status`, `--author` options. `SearchOptions` and `SearchResult` types exported. 20 new search tests.
- [x] **Config CLI** — New `harness config show` displays full resolved configuration (merged defaults + file) as YAML. New `harness config get <key>` retrieves specific values by dot-notation path (e.g. `model.id`). New `harness config set <key> <value>` writes to config.yaml using YAML document API (preserves comments/formatting), with automatic type coercion (boolean, int, float) and post-write validation. Uses Commander.js nested subcommand pattern.

## All Plan Items Complete

All items from the original fix plan have been implemented across 13 loops.

## Architecture Notes

### What Works Well
- File-first design is clean and intuitive
- Progressive disclosure (L0/L1/L2) is effective for budget management
- Session recording + journal synthesis loop is functional end-to-end
- CLI is well-organized with consistent option patterns
- Scaffold creates a fully functional agent in one command
- Multi-provider: OpenRouter, Anthropic, OpenAI all work via standard config
- Programmatic API tested with official `ai/test` MockLanguageModelV3
- Structured logging with configurable verbosity
- CI/CD: automated build + test on push/PR
- Extension directories for custom primitive types
- Quiet hours enforcement prevents unnecessary API calls
- Parse error collection surfaces broken primitives instead of hiding them
- Budget warnings give visibility into context truncation
- Comprehensive validator with cross-reference integrity checking
- Auto-fix for common capability file issues (missing id, status, L0/L1, type tags)
- Session archival preserves audit trail instead of deleting
- Rich status command for at-a-glance harness overview
- Evaluator dependency resolution catches broken references before install
- Doctor command for one-pass validation + auto-remediation
- Scheduled auto-archival prevents memory directory bloat
- Workflow CLI for listing and manual execution

### Known Limitations
- Token estimation is 1:4 char ratio — good enough but not precise
- No streaming for journal/learn commands (they use batch generation)
- File locking: concurrent processes could corrupt state.md or context.jsonl
