# Agent Harness — Development Guide

## Build & Run

```bash
# Install dependencies
npm install

# Build (tsup, outputs to dist/)
npm run build

# Run tests (vitest)
npm test

# Watch mode for development
npm run dev

# Type check without emitting
npm run lint
```

## CLI Commands

All commands accept `-d, --dir <path>` to specify the harness directory (defaults to `.`).

```bash
# Scaffold a new agent
harness init <name>

# Run a single prompt
harness run "your prompt" [--stream] [--model gemma]

# Interactive chat with conversation history
harness chat [--model claude] [--fresh]

# Show harness info and context budget
harness info

# Display the assembled system prompt
harness prompt

# Validate harness structure and config
harness validate

# Watch mode — auto-rebuild indexes on file changes
harness dev

# Rebuild all _index.md files
harness index

# Synthesize daily journal from sessions
harness journal [--date YYYY-MM-DD]

# Propose/install instincts from session patterns
harness learn [--install]

# Install a capability file
harness install <file.md>

# Process all files in intake/ directory
harness intake
```

## Model Aliases

Short names for `--model`:
- `gemma` → google/gemma-4-26b-a4b-it
- `gemma-31b` → google/gemma-4-31b-it
- `qwen` → qwen/qwen3.5-35b-a3b
- `glm` → z-ai/glm-4.7-flash
- `claude` → anthropic/claude-sonnet-4
- `gpt4o` → openai/gpt-4o
- `gpt4o-mini` → openai/gpt-4o-mini

## Environment

- **Node.js 20+** required
- **OPENROUTER_API_KEY** — set in `.env` or environment
- TypeScript strict mode, ESM only

## Architecture

```
src/
  cli/           # CLI entry point (commander)
  core/          # Types, config, harness factory
  llm/           # OpenRouter provider (Vercel AI SDK)
  primitives/    # Document parser (frontmatter + L0/L1/L2)
  runtime/       # Context loader, sessions, conversation, journal, scheduler, etc.
```

Key patterns:
- Factory function (`createHarness()`) returns `HarnessAgent` interface
- Token-budgeted context assembly with 3-level progressive disclosure
- File-first: all agent config is markdown with YAML frontmatter
- Sessions auto-recorded to `memory/sessions/`
- Conversation history persisted to `memory/context.md`

## Testing

```bash
npm test            # Run all tests
npm run test:watch  # Watch mode
npx vitest run tests/config.test.ts  # Single file
```

71 tests across 5 files: primitives, config, state, context-loader, scaffold.
