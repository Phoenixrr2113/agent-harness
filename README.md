# Agent Harness

A file-first agent operating system. Build AI agents by editing markdown files, not writing code.

## The Idea

Every AI agent framework today requires you to write code. LangChain, CrewAI, Anthropic Agent SDK, Vercel AI SDK — all code-first. If you can't program, you can't build agents.

Agent Harness takes a different approach: **the agent is the filesystem, not the code.**

You `npm install` the harness, scaffold a directory, and get a working autonomous agent. Customize it by editing markdown files — identity, rules, instincts, skills, playbooks. The code layer exists but is optional. It's the escape hatch, not the entry point.

## Quick Start

```bash
# Install globally
npm install -g agent-harness

# Create a new agent
harness init my-agent
cd my-agent

# Set your API key
export OPENROUTER_API_KEY=sk-or-...

# Talk to your agent
harness run "Who are you?"

# Or start an interactive chat
harness chat

# See what's loaded
harness info

# Watch for file changes
harness dev
```

## How It Works

When you run `harness init my-agent`, you get this directory:

```
my-agent/
├── CORE.md              # Agent identity (frozen — who am I?)
├── SYSTEM.md            # Boot instructions (how do I operate?)
├── config.yaml          # Model, runtime, memory settings
├── state.md             # Live state (mode, goals, last interaction)
├── rules/               # Human-authored operational boundaries
│   └── operations.md
├── instincts/           # Agent-learned reflexive behaviors
│   ├── lead-with-answer.md
│   ├── read-before-edit.md
│   └── search-before-create.md
├── skills/              # Capabilities with embedded expertise
│   └── research.md
├── playbooks/           # Adaptive guidance for outcomes
│   └── ship-feature.md
├── workflows/           # Cron-driven automations
├── tools/               # External service integrations
├── agents/              # Sub-agent roster
└── memory/
    ├── sessions/        # Auto-captured interaction records
    ├── journal/         # Daily synthesized reflections
    └── scratch.md       # Ephemeral working memory
```

Every file is markdown with YAML frontmatter. Every file has three disclosure levels:

- **L0** (~5 tokens): One-line summary in an HTML comment
- **L1** (~50-100 tokens): Paragraph summary in an HTML comment
- **L2** (full body): Complete content

The harness loads files intelligently based on token budget — L0 to decide relevance, L1 to work with, L2 only when actively needed.

## The 7 Primitives

| Primitive | Owner | Purpose | Example |
|-----------|-------|---------|---------|
| **Rules** | Human | Operational boundaries that don't change | "Never deploy on Fridays" |
| **Instincts** | Agent | Learned behaviors that evolve over time | "Lead with the answer, not reasoning" |
| **Skills** | Mixed | Capabilities with embedded judgment | "How to do research" |
| **Playbooks** | Mixed | Adaptive guidance for achieving outcomes | "How to ship a feature" |
| **Workflows** | Infra | Cron-driven deterministic automations | "Hourly health check" |
| **Tools** | External | Service integration knowledge | "GitHub API patterns" |
| **Agents** | External | Sub-agent roster and capabilities | "Code reviewer agent" |

### Ownership matters

Every file has exactly one owner — human, agent, or infrastructure:

- **Human** writes rules and CORE.md. The agent respects these.
- **Agent** writes instincts and sessions. It learns from experience.
- **Infrastructure** writes indexes and journals. Bookkeeping is automated.

## Customizing Your Agent

### Change identity
Edit `CORE.md` — this is who your agent is, its values, and its ethics.

### Add a rule
Create a file in `rules/`:

```markdown
---
id: no-friday-deploys
tags: [rule, safety, deployment]
created: 2026-04-06
author: human
status: active
---

<!-- L0: Never deploy to production on Fridays. -->
<!-- L1: No production deployments on Fridays. Three incidents were traced to Friday
     deploys with reduced weekend monitoring. Staging is fine. -->

# Rule: No Friday Deploys

Never deploy to production on Fridays. Staging deployments are acceptable.
If an emergency hotfix is needed, require explicit human approval.
```

### Add an instinct
Create a file in `instincts/`. Instincts are behaviors the agent learns — they have provenance (where the learning came from).

### Add a skill
Create a file in `skills/`. Skills include not just what the agent can do, but how it thinks about doing it — judgment, red flags, when NOT to use the skill.

### Add a playbook
Create a file in `playbooks/`. Playbooks are step-by-step guidance that the agent interprets and adapts, not rigid scripts.

## Installing Content

Install skills, rules, agents, and more from the community:

```bash
# Install from any source — file, URL, or name
harness install https://raw.githubusercontent.com/.../skill.md

# Search community sources
harness discover search "code review"

# Browse available sources
harness sources list
```

The installer auto-detects format (Claude Code skills, raw markdown, bash hooks, MCP configs) and normalizes to harness convention with proper frontmatter.

Share your own primitives as bundles:

```bash
harness bundle my-skills.tar --types skills,rules
harness bundle-install my-skills.tar
```

## CLI Commands

### Core

| Command | Description |
|---------|-------------|
| `harness init [name]` | Create a new agent (interactive if no name given) |
| `harness run <prompt>` | Run a single prompt |
| `harness run <prompt> --stream` | Stream the response |
| `harness run <prompt> -m claude` | Use a model alias |
| `harness chat` | Interactive REPL with conversation memory |
| `harness chat --fresh` | Start a fresh conversation (clear history) |
| `harness info` | Show loaded context and token budget |
| `harness prompt` | Display the full assembled system prompt |
| `harness status` | Show primitives, sessions, config, state |
| `harness validate` | Validate harness structure and configuration |
| `harness doctor` | Validate and auto-fix all fixable issues |

### Development

| Command | Description |
|---------|-------------|
| `harness dev` | Watch mode + auto-index + scheduler + web dashboard |
| `harness dev --port 8080` | Custom dashboard port (default 3000) |
| `harness index` | Rebuild all index files |
| `harness process` | Auto-fill missing frontmatter and L0/L1 summaries |
| `harness search <query>` | Search primitives by text and tags |
| `harness graph` | Analyze primitive dependency graph |
| `harness serve` | Start HTTP API server for webhooks and integrations |

### Learning

| Command | Description |
|---------|-------------|
| `harness journal` | Synthesize today's sessions into a journal entry |
| `harness learn` | Analyze sessions and propose new instincts |
| `harness learn --install` | Auto-install proposed instincts |
| `harness harvest --install` | Extract and install instinct candidates from journals |
| `harness auto-promote` | Promote instinct patterns appearing 3+ times |

### Intelligence

| Command | Description |
|---------|-------------|
| `harness suggest` | Suggest skills/playbooks for frequent uncovered topics |
| `harness contradictions` | Detect conflicts between rules and instincts |
| `harness dead-primitives` | Find orphaned primitives not used in 30+ days |
| `harness enrich` | Add topics, token counts, and references to sessions |
| `harness gate run` | Run verification gates (pre-boot, pre-run, post-session, pre-deploy) |
| `harness check-rules <action>` | Check an action against loaded rules |

### MCP (Model Context Protocol)

| Command | Description |
|---------|-------------|
| `harness mcp list` | List configured MCP servers and status |
| `harness mcp test` | Test server connections and list tools |
| `harness mcp discover` | Scan for servers from Claude Desktop, Cursor, VS Code, etc. |
| `harness mcp search <query>` | Search the MCP registry |
| `harness mcp install <query>` | Install an MCP server from the registry |

### Installing and Sharing

| Command | Description |
|---------|-------------|
| `harness install <source>` | Install from file, URL, or source name (auto-detects format) |
| `harness discover search <query>` | Search all community sources for content |
| `harness discover env` | Scan .env files for API keys, suggest MCP servers |
| `harness discover project` | Detect tech stack, suggest rules/skills |
| `harness bundle <output>` | Pack primitives into a shareable bundle |
| `harness bundle-install <source>` | Install from a bundle |
| `harness export [output]` | Export harness to a portable JSON bundle |
| `harness import <bundle>` | Import a harness bundle |
| `harness sources list` | List configured community content sources |

### Monitoring

| Command | Description |
|---------|-------------|
| `harness dashboard` | Unified view of health, costs, sessions, workflows |
| `harness health` | System health status and metrics |
| `harness costs` | View API spending |
| `harness analytics` | Session analytics and usage patterns |
| `harness metrics` | Workflow execution metrics |

### Model Aliases

Use `-m` with a shorthand instead of full OpenRouter model IDs:

| Alias | Model |
|-------|-------|
| `gemma` | google/gemma-4-26b-a4b-it |
| `gemma-31b` | google/gemma-4-31b-it |
| `qwen` | qwen/qwen3.5-35b-a3b |
| `glm` | z-ai/glm-4.7-flash |
| `claude` | anthropic/claude-sonnet-4 |
| `gpt4o` | openai/gpt-4o |

## MCP Integration

Agent Harness connects to [MCP servers](https://modelcontextprotocol.io/) to give your agent tools — file access, APIs, databases, and more.

```yaml
# config.yaml
mcp:
  servers:
    filesystem:
      transport: stdio
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    my-api:
      transport: http
      url: https://example.com/mcp
```

Auto-discover servers already on your machine:

```bash
harness mcp discover       # Scans Claude Desktop, Cursor, VS Code, Cline, etc.
harness mcp search github  # Search the MCP registry
harness mcp install github # Install from registry into config.yaml
```

During `harness init`, MCP servers are auto-discovered and added to your config.

## Dev Mode and Dashboard

`harness dev` starts everything at once:

- **File watcher** — auto-rebuilds indexes when you edit primitives
- **Auto-processor** — fills missing frontmatter and L0/L1 summaries on save
- **Scheduler** — runs cron-based workflows
- **Web dashboard** — browse primitives, chat, view sessions at `localhost:3000`

```bash
harness dev                    # Start everything
harness dev --port 8080        # Custom port
harness dev --no-web           # Skip dashboard
harness dev --no-auto-process  # Skip auto-processing
```

The dashboard includes: agent status, health checks, spending, sessions, workflows, primitives browser, file editor, MCP status, settings editor, and a chat interface.

## Using as a Library

```typescript
import { createHarness } from 'agent-harness';

const agent = createHarness({
  dir: './my-agent',
  apiKey: process.env.OPENROUTER_API_KEY,
});

await agent.boot();

// One-shot
const result = await agent.run('What should I work on today?');
console.log(result.text);

// Streaming
for await (const chunk of agent.stream('Explain this codebase')) {
  process.stdout.write(chunk);
}

await agent.shutdown();
```

### Fluent Builder API

```typescript
import { defineAgent } from 'agent-harness';

const agent = defineAgent('./my-agent')
  .model('anthropic/claude-sonnet-4')
  .provider('openrouter')
  .onBoot(({ config }) => console.log(`Booted ${config.agent.name}`))
  .onError(({ error }) => console.error(error))
  .build();
```

## Configuration

`config.yaml`:

```yaml
agent:
  name: my-agent
  version: "0.1.0"

model:
  provider: openrouter           # openrouter | anthropic | openai
  id: anthropic/claude-sonnet-4  # Any model ID for your provider
  max_tokens: 200000
  # summary_model: google/gemma-4-26b-a4b-it  # Cheap model for auto-generation
  # fast_model: google/gemma-4-26b-a4b-it     # Fast model for validation

runtime:
  scratchpad_budget: 10000
  timezone: America/New_York
  auto_process: true             # Auto-fill frontmatter/summaries on file changes

memory:
  session_retention_days: 7
  journal_retention_days: 365

# rate_limits:
#   per_minute: 10
#   per_hour: 100
#   per_day: 500

# budget:
#   daily_limit_usd: 5.00
#   monthly_limit_usd: 100.00
#   enforce: true
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | For OpenRouter | Your OpenRouter API key |
| `ANTHROPIC_API_KEY` | For Anthropic | Direct Anthropic API key |
| `OPENAI_API_KEY` | For OpenAI | Direct OpenAI API key |

Set one based on your `model.provider` in config.yaml. The `.env` file in your harness directory is auto-loaded.

## How Context Loading Works

On every run, the harness:

1. Loads **CORE.md** (always, full content)
2. Loads **state.md** (current goals and mode)
3. Loads **SYSTEM.md** (boot instructions)
4. Scans all primitive directories, loading files at the appropriate disclosure level based on remaining token budget
5. Loads **scratch.md** if it has content

Total harness overhead is typically ~1,000-3,000 tokens depending on how many primitives you have.

## The Learning Loop

Agent Harness agents learn from experience through an automated pipeline:

```
Interaction → Session recorded → Journal synthesized → Instincts proposed → Auto-installed
```

1. Every interaction is saved as a **session** in `memory/sessions/`
2. Run `harness journal` to synthesize sessions into a daily **journal** entry
3. Run `harness learn --install` to detect behavioral patterns and install new **instincts**
4. On the next run, the agent loads its new instincts and behaves differently

This means your agent gets better over time — without you writing any code.

## Tested Models

These local-capable models work well with the harness via OpenRouter:

| Model | Speed | Quality | Best For |
|-------|-------|---------|----------|
| google/gemma-4-26b-a4b-it | Fast (2s) | Excellent | Default local model |
| google/gemma-4-31b-it | Medium (8s) | Good | Complex reasoning |
| qwen/qwen3.5-35b-a3b | Slow (30s) | Good | Very concise responses |
| z-ai/glm-4.7-flash | Fast (5s) | Good | Natural conversation |

## Philosophy

- **The agent is the filesystem.** Not the code.
- **Ownership is law.** Every file has exactly one owner.
- **You shouldn't need to write code to build a capable agent.** But you can.
- **Progressive disclosure.** Load what you need, at the level you need.
- **Agents learn.** Instincts evolve. Sessions become journals.
- **Infrastructure does bookkeeping.** The agent does thinking.

## License

MIT
