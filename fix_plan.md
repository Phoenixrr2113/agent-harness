# Fix Plan — Agent Harness

## Completed (This Loop)

- [x] **Progressive disclosure budget algorithm** — Fixed context-loader to use global demand estimation instead of hardcoded thresholds. Now correctly falls back L2 -> L1 -> L0 based on total token demand vs available budget. Updated test to match corrected behavior.
- [x] **Conversation messages API** — Rewrote Conversation class to use AI SDK's `messages` parameter instead of concatenating history into a flat prompt string. Proper message structure gives LLMs better understanding of conversation turns.
- [x] **Chat model override** — Connected `--model` flag in `harness chat` to the Conversation via `setModelOverride()`.
- [x] **Streaming token capture** — `harness.stream()` now captures usage tokens from the `streamText` result's `usage` promise instead of recording 0.
- [x] **Validate command** — New `harness validate` checks: required files, config, state, primitive directories, context budget, API key, memory directories. Exit code 1 on errors.
- [x] **Provider reset** — Added `resetProvider()` to clear cached OpenRouter provider.
- [x] **New provider APIs** — Added `generateWithMessages()` and `streamWithMessages()` for proper message-based interactions.

## Next Priority

### P0 — Core Functionality

- [ ] **Conversation windowing** — Current 20-message window is message-count-based. Should be token-count-based to prevent context overflow with long messages. Track token usage per message and trim smartly.
- [ ] **Session cleanup** — Implement `memory.session_retention_days` — currently configured but never enforced. Add a `harness cleanup` command or run during boot.
- [ ] **Scheduler auto-start** — The Scheduler class exists and works but is never started from the CLI. Either `harness dev` or a new `harness schedule` command should spin it up.
- [ ] **Agent delegation** — The `agents/` directory exists for sub-agent definitions but there's no delegation mechanism. Design: parse agent docs, create child harness instances, route prompts.

### P1 — DX & Reliability

- [ ] **Defaults/templates** — The `defaults/` and `templates/` directories are empty. Should contain default primitives for `harness init` (e.g., default rules, instinct seeds, config presets for different models).
- [ ] **Better error messages** — Some errors bubble raw stack traces. Improve CLI error formatting across all commands.
- [ ] **Config validation** — Use Zod to validate config.yaml at load time. Currently config merging is permissive and silently accepts invalid keys.
- [ ] **Intake directory creation** — `harness init` doesn't create `intake/` by default. Should be included in scaffold.
- [ ] **Journal date range** — `harness journal` only does single-day synthesis. Add `--range` or `--all` for bulk journal generation.

### P2 — Polish

- [ ] **Context.md format** — Conversation persistence format (`### User` / `### Assistant`) is fragile. Consider JSON or structured frontmatter.
- [ ] **Index file improvements** — Index tables truncate L0 at 80 chars. Should be configurable.
- [ ] **Session metadata** — Sessions only track prompt/summary/tokens. Could include model ID, disclosure level used, error state.
- [ ] **Scratch.md integration** — `memory/scratch.md` is loaded into context but no command writes to it. Add `harness scratch <note>` for quick working memory.
- [ ] **Conversation session recording** — Chat sessions don't create session records. Each chat turn should optionally write a session.

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
