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
Most commands accept `--log-level <level>` (debug, info, warn, error).

### Core

```bash
harness init <name>                  # Scaffold a new agent (-t template)
harness run "prompt" [--stream]      # Run a single prompt (--model alias)
harness chat [--model claude]        # Interactive chat (--fresh to reset)
harness info                         # Show harness info and context budget
harness prompt                       # Display assembled system prompt
harness status                       # Full status dashboard (health, costs, MCP, etc.)
harness dashboard                    # Live telemetry dashboard (--watch, --json)
```

### Development

```bash
harness dev                          # Watch mode — auto-rebuild indexes
harness index                        # Rebuild all _index.md files
harness validate                     # Validate structure, config, primitives, MCP
harness doctor                       # Validate + auto-fix issues
harness fix <file>                   # Fix a single primitive file
```

### Memory & Learning

```bash
harness journal [--date YYYY-MM-DD]  # Synthesize daily journal from sessions (--auto-harvest)
harness compress [--date YYYY-MM-DD] # Compress journal into weekly summary
harness learn [--install]            # Propose/install instincts from patterns
harness harvest [--install]          # Extract reusable skills from sessions
harness cleanup [--dry-run]          # Clean old sessions and journals
harness scratch [show|edit|clear]    # Manage scratch buffer
harness history [--limit N]          # Show conversation history
```

### Capabilities

```bash
harness install <file.md>            # Install a capability file
harness intake                       # Process all files in intake/
harness tools list                   # List all available tools
harness tools show <id>              # Show tool definition details
harness agents                       # List configured delegate agents
harness delegate <agent-id> "prompt" # Delegate task to a sub-agent
```

### Workflow Engine

```bash
harness workflow list                # List defined workflows
harness workflow run <id>            # Execute a workflow (--dry-run)
harness metrics show [--workflow id] # Show workflow run metrics
harness metrics clear [--workflow id]# Clear metrics data
```

### Configuration & Cost

```bash
harness config show                  # Show full resolved config
harness config get <key>             # Get a config value (dot notation)
harness config set <key> <value>     # Set a config value
harness costs show                   # Show spending breakdown
harness costs budget                 # Show/set budget limits
harness costs clear                  # Clear cost history
```

### Analysis & Export

```bash
harness search [query]               # Full-text search across primitives
harness graph [--format dot|json]    # Dependency graph of primitives
harness analytics                    # Session analytics and patterns
harness export [output]              # Export harness as portable bundle
harness import <bundle>              # Import a harness bundle
```

### Infrastructure

```bash
harness health                       # Health check status
harness ratelimit status             # Rate limiter status
harness ratelimit clear              # Reset rate limiter state
harness auth                         # Verify API key configuration
```

### MCP (Model Context Protocol)

```bash
harness mcp list                     # List configured MCP servers
harness mcp test [--server name]     # Test MCP server connections
```

## MCP Integration

Agent Harness supports MCP servers for extending the tool set available to agents.
Servers are configured in `config.yaml` under `mcp.servers`:

```yaml
mcp:
  servers:
    # stdio transport — launches a local process
    filesystem:
      transport: stdio
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
      env:
        SOME_VAR: value
      enabled: true

    # HTTP transport — connects to a remote server
    api-server:
      transport: http
      url: https://example.com/mcp
      headers:
        Authorization: "Bearer ${API_KEY}"

    # SSE transport — server-sent events
    sse-server:
      transport: sse
      url: https://example.com/sse
```

MCP server configuration fields:
- **transport** (required): `stdio`, `http`, or `sse`
- **command** (stdio only): Executable to launch
- **args** (stdio only): Command-line arguments
- **env** (stdio only): Environment variables for the process
- **cwd** (stdio only): Working directory for the process
- **url** (http/sse only): Server URL
- **headers** (http/sse only): HTTP headers (supports `${ENV_VAR}` expansion)
- **enabled**: Set to `false` to disable without removing config

At boot, harness connects to all enabled MCP servers, discovers their tools,
and merges them into the unified tool set alongside markdown and programmatic tools.
MCP server status is shown in `harness status`, `harness info`, `harness dashboard`,
and validated by `harness validate` and `harness doctor`.

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
- **OPENROUTER_API_KEY** — set in `.env` or environment (also supports ANTHROPIC_API_KEY, OPENAI_API_KEY)
- TypeScript strict mode, ESM only

## Architecture

```
src/
  cli/           # CLI entry point (commander)
  core/          # Types, config, harness factory
  llm/           # OpenRouter provider (Vercel AI SDK)
  primitives/    # Document parser (frontmatter + L0/L1/L2)
  runtime/       # Context loader, sessions, conversation, journal, scheduler,
                 # MCP client, tools, health, cost tracking, rate limiting, etc.
```

Key patterns:
- Factory function (`createHarness()`) returns `HarnessAgent` interface
- Token-budgeted context assembly with 3-level progressive disclosure
- File-first: all agent config is markdown with YAML frontmatter
- Sessions auto-recorded to `memory/sessions/`
- Conversation history persisted to `memory/context.md`
- MCP servers discovered at boot, tools merged into unified ToolSet
- Config-driven guardrails: rate limiting, budget enforcement, health monitoring
- Unified telemetry with `collectSnapshot()` aggregating health, costs, sessions, workflows, MCP

## Testing

```bash
npm test            # Run all tests
npm run test:watch  # Watch mode
npx vitest run tests/config.test.ts  # Single file
```

548 tests across 30 files covering primitives, config, state, context-loader,
scaffold, sessions, conversation, journal, tools, MCP, harness lifecycle,
cost tracking, health, rate limiting, metrics, analytics, watcher, and more.
