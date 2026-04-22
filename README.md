# Agent Harness

> **A self-managing, self-improving agent runtime. Point it at a problem, write what it should know in markdown, and watch it get better as you use it.**

Agent Harness is the layer between "I have an LLM API key" and "I have a working agent that does useful work." It handles identity, memory, tools, context budgeting, session capture, journal synthesis, instinct learning, progressive disclosure, durable workflows, and MCP integration — so you describe the problem in markdown instead of wiring up 500 lines of TypeScript.

**Who this is for**: anyone technical or semi-technical who has a repeating problem they want an agent to own. Writers, founders, ops people, researchers, developers, consultants, analysts. If you can describe what you want in a document, you can build an agent for it.

## What makes it different

Most agent frameworks give you a box of parts and leave the rest to you. agent-harness gives you a runtime that does three things nobody else does:

### 1. It manages itself
- **Context budget**: three disclosure levels (L0/L1/L2) loaded intelligently so you never hit the token ceiling
- **Session capture**: every interaction is recorded without asking
- **Journal synthesis**: run `harness journal` and the agent writes its own daily reflection
- **Dead primitive detection**: orphan files get flagged, contradictions get surfaced
- **Format auto-repair**: `harness doctor` fixes missing frontmatter, tags, and summaries
- **Scaffold validation**: primitives are checked for consistency on every load

You don't prune files, check token counts, or write cleanup scripts. The harness does its own housekeeping.

### 2. It learns from itself

```
Interaction → Session → Journal → Instinct proposed → Auto-installed → Behavior changes
```

1. Every `harness run` or `harness chat` is saved as a session.
2. `harness journal` synthesizes the day's sessions and finds patterns across them.
3. `harness learn --install` promotes patterns to **instincts** — behavioral rules written to disk with full provenance ("learned from session X because you kept doing Y").
4. On the next run, the agent loads the new instincts and **actually behaves differently**.

No retraining. No fine-tuning. No tokenization. You use the agent for a week and it measurably improves, with an auditable trail of what changed and why.

### 3. It runs durably

Long-running workflows checkpoint to disk per step. If the process dies, the host reboots, or a tool call fails, the next `harness workflows resume <runId>` picks up from the last cached step instead of re-running everything. State + event log live in `.workflow-data/` and are greppable. See [Durable workflows](#durable-workflows).

## Install

```bash
npm install -g @agntk/agent-harness
harness init my-agent && cd my-agent
```

Pick a provider — hosted, free, or fully local:

```bash
# Option A: free hosted (no key needed — rate-limited community tier)
harness config set model.provider agntk-free
harness config set model.id "llama3.1-8b"

# Option B: local via Ollama (zero external calls, your hardware)
ollama pull qwen3:1.7b
harness config set model.provider ollama
harness config set model.id "qwen3:1.7b"

# Option C: hosted via OpenRouter / Anthropic / OpenAI / Cerebras
export OPENROUTER_API_KEY=sk-or-...
# Default template already uses openrouter — no config change needed.

harness run "Help me decide between two options: A or B"
```

That's it. No config file to wire up, no tool layer to build, no state store to provision. Your agent is the folder.

## Quick start: a 5-minute example

```bash
# Scaffold
harness init research-buddy --template local -y
cd research-buddy

# Prepare a local model (skip if you set up hosted in the Install step)
ollama pull qwen3:1.7b

# One-shot
harness run "Summarize the pros and cons of SQLite vs Postgres for side projects"

# Interactive, with conversation memory
harness chat

# See what's loaded, check token budget
harness info

# Dump the full assembled system prompt
harness prompt

# Build the learning loop
harness journal            # synthesize today's sessions
harness learn --install    # promote patterns to instincts
harness run "Same question again" # agent now applies its new instincts

# Watch + dashboard at http://localhost:3000
harness dev
```

## Why markdown (not code)

Writing an agent in TypeScript or Python couples the agent's behavior to your programming environment. Markdown decouples them completely:

- **Non-coders can author and edit** — if you can write a document, you can write a skill.
- **Content is greppable, diffable, reviewable** — normal PR workflows work on agent behavior.
- **The agent reads itself** — when you edit `skills/research.md`, the next run picks it up. No rebuild, no restart.
- **The harness can write back** — `harness learn` produces markdown files you can read and edit by hand before accepting them.
- **Portability** — the folder IS the agent. Share it by copying. Version it with git. Deploy it by tarring it.

agent-harness is a CLI, not a library. There is no `import { createAgent }` API — the entire authoring surface is markdown files inside a harness directory and the `harness` command. If you need programmatic control, script the CLI from your shell or call `harness run` / `harness serve` from any process spawn (subprocess, Lambda, GitHub Actions).

## How it works

When you run `harness init my-agent`, you get this directory:

```
my-agent/
├── CORE.md              # Agent identity (frozen — who am I?)
├── SYSTEM.md            # Boot instructions (how do I operate?)
├── config.yaml          # Model, runtime, memory settings
├── state.md             # Live state (mode, goals, last interaction)
├── rules/               # Human-authored operational boundaries
├── instincts/           # Agent-learned reflexive behaviors
├── skills/              # Capabilities with embedded expertise
├── playbooks/           # Adaptive guidance for outcomes
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
- **L1** (~50–100 tokens): Paragraph summary in an HTML comment
- **L2** (full body): Complete content

The harness loads files intelligently based on token budget — L0 to decide relevance, L1 to work with, L2 only when actively needed.

## The 7 primitives

| Primitive | Owner | Purpose | Example |
|-----------|-------|---------|---------|
| **Rules** | Human | Operational boundaries that don't change | "Never deploy on Fridays" |
| **Instincts** | Agent | Learned behaviors that evolve over time | "Lead with the answer, not reasoning" |
| **Skills** | Mixed | Capabilities with embedded judgment | "How to do research" |
| **Playbooks** | Mixed | Adaptive guidance for achieving outcomes | "How to ship a feature" |
| **Workflows** | Infra | Cron-driven deterministic automations | "Hourly health check" |
| **Tools** | External | Service integration knowledge | "GitHub API patterns" |
| **Agents** | External | Sub-agent roster and capabilities | "Code reviewer agent" |

Every file has exactly one owner — **human** writes rules and CORE.md, **agent** writes instincts and sessions, **infrastructure** writes indexes and journals.

## Templates

`harness init <name> --template <t>` picks a starting config:

| Template | For |
|---|---|
| `base` | Default — OpenRouter + Claude Sonnet |
| `local` | Fully local — Ollama + a 70B-class model on your hardware |
| `dev` | Developer agent with filesystem + shell MCP pre-wired |
| `claude-opus` | Claude Opus via OpenRouter |
| `gpt4` | GPT-4o via OpenRouter |
| `assistant` | General-purpose assistant profile |
| `code-reviewer` | Code review profile |

Run `harness init` with no args for interactive mode — it walks you through name, purpose, template, and optional AI-generated CORE.md.

## The learning loop

```bash
# After a few days of use
harness journal --all     # synthesize every day with sessions
harness learn --install   # propose + install instincts
harness harvest --install # pull instinct candidates from journal entries
harness auto-promote --install --threshold 3  # promote patterns seen 3+ times
```

Inspect the learning state:
```bash
harness status         # primitives, sessions, config, state
harness analytics      # session trends, tools used, token burn
harness suggest        # skills/playbooks the agent doesn't have yet but needs
harness contradictions # conflicts between rules and instincts
harness dead-primitives # orphaned files not used in 30+ days
```

## Durable workflows

As of 0.7.0, workflows run durably. Each step of a tool-using agent checkpoints to disk, so interruptions don't cost the whole run.

```bash
harness workflows status               # list runs (active, complete, failed)
harness workflows inspect <runId>      # print state + full event log
harness workflows resume <runId>       # manually resume an incomplete run
harness workflows cleanup --older-than 30  # drop old completed runs
```

The scheduler also drains resumable runs on boot. Tool calls with identical inputs replay from cache instead of re-executing — idempotency is free. Run state and JSONL event log live in `.workflow-data/`.

Opt any individual workflow in by setting `durable: true` in its frontmatter, or flip the default in `config.yaml`:

```yaml
workflows:
  durable_default: true
memory:
  workflow_retention_days: 30
```

## Sub-agents and delegation

Drop a markdown file into `agents/` to define a sub-agent. The harness auto-exposes it as a tool on the primary agent, so the primary can call it the same way it calls any MCP tool.

```yaml
---
id: agent-summarizer
tags: [agent, utility]
model: fast   # primary (default) | summary | fast
---

# Agent: Summarizer
Condense arbitrary text into 3 bullet points.
```

- **`primary`** — uses `config.model.id`. Same model as `harness run`.
- **`summary`** — uses `config.model.summary_model`, falling back to primary.
- **`fast`** — uses `config.model.fast_model`, then summary, then primary.

Call one directly:

```bash
harness agents                               # list all sub-agents
harness delegate summarizer "Summarize this paragraph: ..."
```

All three model roles resolve on the **same provider** as your primary config.

## Guardrails

### Per-tool approval

Dangerous tools (delete, write, exec) prompt before running. Defaults live in `config.yaml`, overrides are per-run:

```bash
harness run "Clean up stale files" --approve-all   # script/CI mode
```

### Reflection (self-critique)

Optional `prepareStep` middleware that makes the agent critique its own draft before emitting a tool call or final response. Enable via config — useful when running cheaper models for work that needs a second look.

### Content filters

Output filters for PII, blocked topics, and length. Applied as the last hop before text reaches the user. Configure per-agent.

### Rule engine

`harness check-rules <action>` runs a proposed action through every rule file and tells you what would be blocked and why. Also runs automatically in the middleware path before the model executes a tool.

## Installing content

```bash
# Install from any source — file, URL, or registry name
harness install https://raw.githubusercontent.com/.../skill.md

# Search across configured sources
harness sources search "code review"

# Browse starter packs + installed primitives
harness browse

# MCP servers from the registry (or detected locally)
harness mcp discover          # scans Claude Desktop, Cursor, VS Code, Cline, etc.
harness mcp search github
harness mcp install github
```

The installer auto-detects format (Claude Code skills, raw markdown, bash hooks, MCP configs) and normalizes to harness convention with proper frontmatter.

### Automatic provenance + license safety

Every `harness install <url>` records where content came from and what license governs it:

```yaml
# Auto-written into the installed file's frontmatter
source: https://raw.githubusercontent.com/owner/repo/main/skill.md
source_commit: 60af65e1d74303b965587f7d43ed7beb53e84d84
license: MIT
copyright: Copyright (c) 2024 Seth Hobson
license_source: https://github.com/owner/repo/blob/main/LICENSE
installed_at: '2026-04-08T13:50:09.623Z'
installed_by: agent-harness@<version>
```

The detector checks per-file LICENSE siblings first (catches repos where each subdirectory has its own proprietary LICENSE), then the repo-root LICENSE via the GitHub API, then the file's own frontmatter. Strictest finding wins.

**Proprietary content is blocked by default.** Configure the policy in `config.yaml`:

```yaml
install:
  allowed_licenses: [MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, CC-BY-4.0, CC0-1.0, Unlicense]
  on_unknown_license: warn      # allow | warn | prompt | block
  on_proprietary: block
```

Override for one install with written permission:

```bash
harness install <url> --force-license MIT
```

Share your own primitives as bundles:

```bash
harness bundle my-skills.tar --types skills,rules
harness bundle-install my-skills.tar
harness installed               # list installed bundles
harness update <bundle-name>    # pull a new version
```

## Tools

Three tool layers, in priority order:

1. **MCP servers** — the primary tool layer. Anything an agent reaches beyond its own files comes from an MCP server: web search, browsers, databases, file systems, code execution. `harness mcp search <query>` to find one, `harness mcp install <name>` to wire it up.

2. **Markdown HTTP tools** — for trivial REST APIs where spinning up an MCP server is overkill. Drop a markdown file in `tools/` with frontmatter, an `## Authentication` section, and an `## Operations` section. The HTTP executor calls them directly.

3. **Narrowing per run** — `harness run "..." --tools read_text_file,edit_file` restricts a run to a subset of tools. Also settable in agent frontmatter as `active_tools:`.

### MCP configuration

```yaml
# config.yaml
mcp:
  servers:
    filesystem:
      transport: stdio
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
      tools:
        include: [read_text_file, edit_file, list_directory]
    shell:
      transport: stdio
      command: npx
      args: ["-y", "shell-exec-mcp"]
    my-api:
      transport: http
      url: https://example.com/mcp
      headers:
        Authorization: "Bearer ${API_KEY}"
```

During `harness init`, MCP servers on your machine are auto-discovered and added to your config.

## Dev mode and dashboard

`harness dev` starts everything at once:

- **File watcher** — auto-rebuilds indexes when you edit primitives
- **Auto-processor** — fills missing frontmatter and L0/L1 summaries on save
- **Scheduler** — runs cron-based workflows, drains resumable durable runs
- **Web dashboard** — browse primitives, chat, view sessions at `localhost:3000`

```bash
harness dev                    # Everything
harness dev --port 8080        # Custom port
harness dev --no-web           # Skip dashboard
harness dev --no-auto-process  # Skip auto-processing
```

The dashboard shows: agent status, health, spending, sessions, workflows, primitives browser, file editor, MCP status, settings editor, and a chat interface.

## Configuration

`config.yaml`:

```yaml
agent:
  name: my-agent
  version: "0.1.0"

model:
  provider: openrouter           # openrouter | anthropic | openai | ollama | cerebras | agntk-free
  id: anthropic/claude-sonnet-4  # Model ID format depends on provider
  max_tokens: 200000
  # base_url: https://...        # Override for OpenAI-compatible endpoints
  # summary_model: ...            # Cheap model for auto-generation tasks
  # fast_model: ...               # Fast model for validation/checks

runtime:
  scratchpad_budget: 10000
  timezone: America/New_York
  auto_process: true

memory:
  session_retention_days: 7
  journal_retention_days: 365
  workflow_retention_days: 30

workflows:
  durable_default: false

# rate_limits:
#   per_minute: 10
#   per_hour: 100
#   per_day: 500

# budget:
#   daily_limit_usd: 5.00
#   monthly_limit_usd: 100.00
#   enforce: true
```

Read, write, or inspect config from the CLI:

```bash
harness config show
harness config get model.id
harness config set model.provider ollama
```

## Providers

| Provider | Env var | Notes |
|---|---|---|
| `openrouter` | `OPENROUTER_API_KEY` | Any model on OpenRouter. Default. |
| `anthropic` | `ANTHROPIC_API_KEY` | Native Anthropic — use native model IDs (e.g. `claude-sonnet-4-5-20250929`) |
| `openai` | `OPENAI_API_KEY` | Native OpenAI. `model.base_url` overrides for OpenAI-compat endpoints (Groq, Together, Fireworks, vLLM). |
| `ollama` | — | Local. Reads `OLLAMA_BASE_URL` (default `http://localhost:11434/v1`). No auth. |
| `cerebras` | `CEREBRAS_API_KEY` | Cerebras Inference API. Free developer tier at cerebras.ai. |
| `agntk-free` | — | Free-tier proxy to Cerebras. Rate-limited. No key required. |

`harness hardware` detects your CPU/GPU/RAM and suggests Ollama model tiers that will actually run on your machine.

## CLI reference

The full surface is ~90 commands. `harness --help` shows everything; `harness <cmd> --help` drills down. Most-used:

### Core
`init`, `run`, `chat`, `info`, `prompt`, `status`, `validate`, `doctor`

### Learning
`journal`, `learn`, `harvest`, `auto-promote`, `suggest`, `contradictions`, `dead-primitives`, `enrich`

### Workflows
`workflow list|run`, `workflows status|resume|cleanup|inspect` (durable), `metrics show|history`

### Sub-agents
`agents`, `delegate <agent-id> <prompt>`

### MCP
`mcp list|test|discover|search|install`

### Content
`install`, `bundle`, `bundle-install`, `installed`, `uninstall`, `update`, `registry search|install`, `sources search|list|add|remove`, `browse`

### Development
`dev`, `index`, `process`, `search`, `graph`, `serve`, `generate system`

### Ops + governance
`costs show|budget|clear`, `health`, `ratelimit status|clear`, `dashboard`, `check-rules`, `list-rules`, `gate run`, `intelligence promote|dead|contradictions|suggest|failures`

### Portability
`export`, `import`, `scratch`, `cleanup`, `version init|snapshot`, `semantic index|stats`

### Misc
`hardware`, `fix <file>`, `intake`, `compress`, `tools list|show`, `auth`, `emotional status|signal`, `state-merge apply|ownership`

## Model aliases

Use `-m <alias>` instead of a full model ID:

| Alias | Resolves to |
|---|---|
| `gemma` | `google/gemma-4-26b-a4b-it` |
| `gemma-31b` | `google/gemma-4-31b-it` |
| `qwen` | `qwen/qwen3.5-35b-a3b` |
| `glm` | `z-ai/glm-4.7-flash` |
| `claude` | `anthropic/claude-sonnet-4` |
| `gpt4o` | `openai/gpt-4o` |
| `gpt4o-mini` | `openai/gpt-4o-mini` |

Aliases are shorthand for OpenRouter model IDs — change `model.id` directly if you need different routing.

## HTTP server

`harness serve` exposes a REST API for webhooks and integrations. Run the agent from anywhere you can make an HTTP call:

```bash
harness serve --port 8080 --webhook-secret $SECRET
curl -X POST http://localhost:8080/run -H "Authorization: Bearer $SECRET" \
  -d '{"prompt":"Summarize today"}'
```

## How context loading works

On every run, the harness:

1. Loads **CORE.md** (always, full content)
2. Loads **state.md** (current goals and mode)
3. Loads **SYSTEM.md** (boot instructions)
4. Scans all primitive directories, loading files at the appropriate disclosure level based on remaining token budget
5. Loads **scratch.md** if it has content

Total harness overhead is typically ~1,000–3,000 tokens depending on how many primitives you have.

## Environment variables

| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter provider |
| `ANTHROPIC_API_KEY` | Anthropic provider |
| `OPENAI_API_KEY` | OpenAI provider |
| `CEREBRAS_API_KEY` | Cerebras provider |
| `OLLAMA_BASE_URL` | Override Ollama host (default `http://localhost:11434/v1`) |
| `HARNESS_VERBOSE` | `1` to surface dotenv/debug banners |

The `.env` and `.env.local` files in your harness directory are auto-loaded.

## Philosophy

- **The agent is the filesystem.** Not the code.
- **Ownership is law.** Every file has exactly one owner.
- **You shouldn't need to write code to build a capable agent.** But you can.
- **Progressive disclosure.** Load what you need, at the level you need.
- **Durability isn't optional.** Long runs fail. Checkpoint everything.
- **Agents learn.** Instincts evolve. Sessions become journals.
- **Infrastructure does bookkeeping.** The agent does thinking.

## License

MIT
