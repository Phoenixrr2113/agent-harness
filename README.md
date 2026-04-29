# Agent Harness

> **A self-managing, self-improving agent runtime. Point it at a problem, write what it should know in markdown, and watch it get better as you use it.**

Agent Harness is the layer between "I have an LLM API key" and "I have a working agent that does useful work." It handles identity, memory, tools, context budgeting, session capture, journal synthesis, rule learning, progressive disclosure, durable workflows, and MCP integration — so you describe the problem in markdown instead of wiring up 500 lines of TypeScript.

**Who this is for**: anyone technical or semi-technical who has a repeating problem they want an agent to own. Writers, founders, ops people, researchers, developers, consultants, analysts. If you can describe what you want in a document, you can build an agent for it.

## When to use this (and when not to)

**Use it as itself.** `harness init my-agent && harness chat` — you're talking to an agent that works on whatever you give it. Standalone, identity in `IDENTITY.md`, memory under `memory/`, learning loop on by default.

**Use it as your project's resident assistant.** Initialize a harness inside any codebase or workspace; the agent operates on that project's files, runs scripts, manages tasks, learns your patterns over time. Like having a colleague who's read every file and remembers every conversation.

**Don't try to embed it inside another agent product.** If you're building something like Claude Code, Cursor, an in-house ops bot, a phone assistant, or any product where *you* own the agent loop, agent-harness isn't infrastructure for you — it is itself an agent, and embedding it gives you two minds in one process: two identity layers, two memory systems, two reflection loops, two tool registries, and a permanent orchestration tax between them. People have tried this and burned days on it. Don't.

If you're building your own agent product and want what's good here, **copy the patterns, not the runtime.** The file format is open ([Agent Skills compatible](https://agentskills.io)), the source is MIT-licensed, and ideas like progressive disclosure, session capture, journal synthesis, the instinct review queue, and the durable workflow engine all transplant cleanly into your codebase. The runtime itself is intentionally not exposed as a library — no `import { createAgent }`, no `exports` field in `package.json`, no published types. The `harness` CLI is the only supported entry point. That's by design, not an oversight.

## What makes it different

Most agent frameworks give you a box of parts and leave the rest to you. agent-harness gives you a runtime that does three things nobody else does:

### 1. It manages itself
- **Context budget**: three disclosure tiers (discovery / activation / resources) loaded intelligently so you never hit the token ceiling
- **Session capture**: every interaction is recorded without asking
- **Journal synthesis**: run `harness journal` and the agent writes its own daily reflection
- **Dead primitive detection**: orphan files get flagged, contradictions get surfaced
- **Format auto-repair**: `harness doctor` fixes missing frontmatter, tags, and summaries
- **Scaffold validation**: primitives are checked for consistency on every load

You don't prune files, check token counts, or write cleanup scripts. The harness does its own housekeeping.

### 2. It learns from itself

```
Interaction → Session → Journal → Rule proposed → Auto-installed → Behavior changes
```

1. Every `harness run` or `harness chat` is saved as a session.
2. `harness journal` synthesizes the day's sessions and finds patterns across them.
3. `harness learn --install` promotes patterns to **rules** — behavioral rules written to disk with full provenance ("learned from session X because you kept doing Y").
4. On the next run, the agent loads the new rules and **actually behaves differently**.

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
harness learn --install    # promote patterns to rules
harness run "Same question again" # agent now applies its new rules

# File watcher + scheduler (no dashboard by default — pass --web to start it)
harness dev
harness dev --web    # also start the dashboard at http://localhost:8080
```

## Why markdown (not code)

Writing an agent in TypeScript or Python couples the agent's behavior to your programming environment. Markdown decouples them completely:

- **Non-coders can author and edit** — if you can write a document, you can write a skill.
- **Content is greppable, diffable, reviewable** — normal PR workflows work on agent behavior.
- **The agent reads itself** — when you edit `skills/research.md`, the next run picks it up. No rebuild, no restart.
- **The harness can write back** — `harness learn` produces markdown files you can read and edit by hand before accepting them.
- **Portability** — the folder IS the agent. Share it by copying. Version it with git. Deploy it by tarring it.

The authoring surface is markdown files in a harness directory and the `harness` command — there's no library API by design (see [When to use this](#when-to-use-this-and-when-not-to)). For automation — cron jobs, CI runners, scheduled tasks — shell out to `harness run` or POST to `harness serve`.

## How it works

When you run `harness init my-agent`, you get this directory:

```
my-agent/
├── IDENTITY.md             # Agent identity
├── config.yaml             # Model, runtime, memory, MCP, scheduler
├── rules/                  # Always-loaded behavioral guidance
├── skills/                 # Agent Skills bundles (discovery + activation)
└── memory/
    ├── state.md
    ├── sessions/
    ├── journal/
    └── scratch.md
```

### Progressive disclosure

The harness loads files at three tiers per the [Agent Skills spec](https://agentskills.io/specification#progressive-disclosure):

1. **Discovery** (~50–100 tokens per skill): name + description loaded for every skill at boot
2. **Activation** (full body): loaded when the model invokes the skill
3. **Resources** (`scripts/`, `references/`, `assets/`): loaded on demand via the agent's read tools

Identity (`IDENTITY.md`) and rules (`rules/`) are always loaded in full. Skills are loaded progressively.

## The 2 primitives

agent-harness has exactly two primitive types:

| Primitive | Owner | Activation | Always loaded? |
|---|---|---|---|
| **Rules** | Human or learned (`author: agent`) | Always | Yes — full body in every system prompt |
| **Skills** | Mixed | Discovery + activation per Agent Skills spec | No — only `name` + `description` until invoked |

Skills can have different activation triggers via `metadata.harness-trigger`:

| Trigger | When the harness fires the skill |
|---|---|
| (none) | User-invokable via the `activate_skill` tool |
| `subagent` | User-invokable, runs in an isolated subagent session |
| `prepare-call` | Per AI SDK call (modifies model/tools/instructions) |
| `prepare-step` | Per step in the tool loop |
| `step-finish` | After each step (observation) |
| `run-finish` | After the run (observation) |
| `tool-pre` / `tool-post` | Wraps every tool's execute |
| `repair-tool-call` | When a tool call fails to validate |
| `stop-condition` | Step boundaries (vote on early stop) |
| `stream-transform` | Streaming output transform |

A skill with `metadata.harness-schedule: <cron>` is invoked by the harness scheduler at the cron times instead of by the model.

For the previous 7-primitive shape and the migration story, run `harness doctor --migrate -d <dir>`.

## Flat files vs bundled primitives

Both primitives (rules and skills) can live as a single `.md` file (`skills/research.md`, `rules/operations.md`) or as a **bundle**: a directory containing an entry markdown plus arbitrary support files — scripts, templates, references, examples.

### Convention (Agent Skills compatible)

The harness follows the [Agent Skills open standard](https://agentskills.io) — adopted by Claude Code, OpenAI Codex, Cursor, GitHub Copilot, and ~40 other tools. A bundled skill drops into any of those tools without modification.

```
skills/
├── research.md                         ← flat (single-file)
└── debug-workflow/                     ← bundled
    ├── SKILL.md                        ← entry, frontmatter + instructions
    ├── scripts/
    │   └── run-diagnostics.sh
    ├── references/
    │   └── error-catalog.md
    └── assets/
        └── bug-report-template.md

rules/
├── never-deploy-friday.md              ← flat
└── content-policy/                     ← bundled
    └── RULE.md
```

**Entry filename is kind-specific and uppercase**: `SKILL.md` for skills, `RULE.md` for rules. The loader looks for it in the bundle's root; missing it = parse error.

### What's loaded into context

Only the entry markdown (name + description at discovery tier, full body at activation tier) enters the agent's system prompt — same progressive disclosure as flat files. Support files (`scripts/`, `references/`, `assets/`) stay on disk. The agent reads or executes them on demand via its Read/Bash tools when the body of the entry file points to them.

This keeps context budget predictable: a 12-file bundled skill costs the same tokens as a 1-file flat skill at discovery, until the agent decides a support file is worth pulling in.

### Frontmatter schemas

Skills use the strict Agent Skills schema; rules use the harness extension schema:

```yaml
# Agent Skills schema (canonical for skills/)
---
name: my-skill
description: One-line description of what this skill does and when to use it.
license: MIT
allowed-tools: Read Bash(jq:*)
metadata:
  harness-tags: "knowledge-work,research"
  harness-status: active
  harness-author: human
  harness-created: "2026-04-28"
---
```

```yaml
# Harness extension schema (rules/)
---
name: my-rule
description: One-line description.
tags: [boundary]
status: active
author: human
created: 2026-04-28
---
```

**See [docs/skill-authoring.md](./docs/skill-authoring.md) for detailed authoring guidance.** Script authors: the [Script feedback contract](./docs/skill-authoring.md#script-feedback-contract) section covers JSON output shape, exit codes, `--help` requirements, idempotency, and long-running patterns.

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

Run `harness init` with no args for interactive mode — it walks you through name, purpose, template, and optional AI-generated IDENTITY.md.

## The learning loop

```bash
# After a few days of use
harness journal --all     # synthesize every day with sessions
harness learn --install   # propose + install rules
harness harvest --install # pull rule candidates from journal entries
harness auto-promote --install --threshold 3  # promote patterns seen 3+ times
```

Inspect the learning state:
```bash
harness status         # primitives, sessions, config, state
harness analytics      # session trends, tools used, token burn
harness suggest        # skills the agent doesn't have yet but needs
harness contradictions # conflicts between rules and skills
harness dead-primitives # orphaned files not used in 30+ days
```

## Evaluating skills

Skills can be evaluated for trigger reliability (does the model pick this skill when it should?) and output quality (does the skill produce better results than no skill?). Each default skill ships with `evals/triggers.json`; high-effort defaults also ship with `evals/evals.json`.

```bash
# Run trigger eval for a skill
harness skill eval-triggers research

# Run quality eval (with-skill vs no-skill baseline)
harness skill eval-quality delegate-to-cli

# Iteratively refine a skill's description against its trigger set
harness skill optimize-description research

# Iteratively refine a skill's body against its quality eval
harness skill optimize-quality delegate-to-cli
```

For the full reference — schema, scoring, workspace layout, promotion gate — see [docs/skill-evals.md](./docs/skill-evals.md).

The promotion gate (default-on for `harness rules promote`) verifies that agent-learned rules show measured benefit before being installed:

```bash
harness rules promote <candidate-id>                  # gated by default
harness rules promote <candidate-id> --no-eval-gate   # power-user bypass
```

## Provider integration

`harness export` adapts harness skills, rules, and identity into the formats other agent tools expect — so a project that already has `.claude/`, `.cursor/`, or `.github/copilot-instructions.md` can stay in sync with one source of truth. The harness directory is canonical; provider directories are generated artifacts (similar to a `dist/` build output) with embedded sha256 provenance markers used for drift detection.

Six providers ship in v0.13.0: `claude`, `codex`, `agents` (cross-tool `.agents/`), `cursor`, `copilot`, `gemini`.

```bash
harness export claude                 # single provider
harness export                        # all configured targets from config.yaml
harness export --dry-run              # preview without writing
harness doctor --check-drift          # check for external edits to generated files
```

Configure targets per-provider in `config.yaml`:

```yaml
export:
  enabled: true
  targets:
    - provider: claude
      path: ".claude"
    - provider: cursor
      path: ".cursor"
  on_drift: warn
```

For the full reference — per-provider format mapping, drift resolution, resync semantics, configuration schema — see [docs/provider-integration.md](./docs/provider-integration.md).

> **Renamed in v0.13.0.** The previous `harness export <output.json>` (portable harness bundle) is now `harness export-bundle <output.json>`. Same behavior; only the verb changed to free up `export` for provider integration.

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

Define a subagent skill by setting `metadata.harness-trigger: subagent` in the skill's frontmatter. When the model invokes the skill via `activate_skill`, the harness spawns a fresh `agent.generate` call with the skill's body as the system prompt and returns the final text to the parent. See [docs/skill-authoring.md](./docs/skill-authoring.md#subagent-skills) for the full authoring pattern.

```yaml
---
name: summarizer
description: Summarize a long text into 3 bullet points.
metadata:
  harness-trigger: subagent
  harness-model: fast   # primary (default) | summary | fast
---
You are a summarization agent. Return exactly 3 bullet points capturing the key points of the input.
```

- **`primary`** — uses `config.model.id`. Same model as `harness run`.
- **`summary`** — uses `config.model.summary_model`, falling back to primary.
- **`fast`** — uses `config.model.fast_model`, then summary, then primary.

Call a skill-based subagent directly from the CLI:

```bash
harness skill list                           # list all skills including subagent skills
harness skill run summarizer "Summarize this paragraph: ..."
```

All three model roles resolve on the **same provider** as your primary config.

## CLI agent delegation (opt-in)

The harness can delegate bounded subtasks to local CLI agents you already have installed — `claude`, `codex`, or `gemini` — by shelling out via a shell MCP. The CLI does its own tool-use internally and returns text; the harness only sees the final answer. This pushes heavy work (reading many files, long summarizations) onto your CLI subscription instead of the harness's API budget.

> ⚠ **TOS notice.** Invoking a subscription-backed CLI programmatically from another agent may fall outside the acceptable-use terms of that subscription. Delegation is **opt-in, default off**. Review each provider's terms before enabling.

During `harness init`, if any of `claude` / `codex` / `gemini` are on your PATH, you'll see a prompt with a TOS warning. Typing `y` activates the `skills/delegate-to-cli.md` decision-tree skill and installs the `shell` MCP (desktop-commander, filtered to process tools only).

**Picking the right permission flag matters** — without it, the subagent subprocess stalls silently in a non-TTY context:

| CLI | Read-only | In-place edits |
|---|---|---|
| `claude` | *(no flag)* | `--permission-mode bypassPermissions` |
| `codex` | `-s read-only` *(default)* | `--dangerously-bypass-approvals-and-sandbox` |
| `gemini` | *(no flag)* | verify with `gemini --help` in current release |

The `delegate-to-cli` skill documents the full decision tree (when to delegate, which CLI for which task, orchestration loop, failure modes). To activate later without rerunning init:

```bash
# Flip status on the skill you want, then install the shell MCP.
sed -i '' 's/^status: draft/status: active/' skills/delegate-to-cli/SKILL.md
harness mcp install shell -d <harness-dir>
```

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

Two tool layers, in priority order:

1. **MCP servers** — the primary tool layer. Anything an agent reaches beyond its own files comes from an MCP server: web search, browsers, databases, file systems, code execution. `harness mcp search <query>` to find one, `harness mcp install <name>` to wire it up.

2. **Narrowing per run** — `harness run "..." --tools read_text_file,edit_file` restricts a run to a subset of tools. Also settable in skill frontmatter as `active_tools:`.

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
      args: ["-y", "@wonderwhy-er/desktop-commander"]
      tools:
        include: [start_process, read_process_output, interact_with_process, force_terminate, list_processes]
    my-api:
      transport: http
      url: https://example.com/mcp
      headers:
        Authorization: "Bearer ${API_KEY}"
```

During `harness init`, MCP servers on your machine are auto-discovered and added to your config.

## Dev mode and dashboard

`harness dev` starts the file watcher + scheduler. The web dashboard is a separate opt-in (was on by default before v0.15.0):

- **File watcher** — auto-rebuilds indexes when you edit primitives
- **Auto-processor** — fills missing frontmatter and descriptions on save
- **Scheduler** — runs scheduled skills (`metadata.harness-schedule`) and drains resumable durable workflow runs
- **Web dashboard** — opt-in via `--web`. Browse primitives, chat, view sessions at `http://localhost:8080`.

```bash
harness dev                    # Watcher + scheduler (no dashboard)
harness dev --web              # Also start the dashboard on port 8080
harness dev --web --port 9090  # Custom port for the dashboard
harness dev --no-auto-process  # Skip auto-processing primitives on save
harness dev --no-schedule      # Skip the scheduler
```

The dashboard shows: agent status, health, spending, sessions, workflows, primitives browser, file editor, MCP status, settings editor, and a chat interface. `harness serve` is the API-only equivalent (same port default — pick one or the other; they don't run together by default).

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
`workflows status|resume|cleanup|inspect` (durable runs), `metrics show|history`

### Skills
`skill new <name>`, `skill list [--scheduled] [--trigger <kind>]`, `skill validate <name>`, `skill eval-triggers <name>`, `skill eval-quality <name>`, `skill optimize-description <name>`, `skill optimize-quality <name>`

### Rules
`rules promote <candidate-id> [--no-eval-gate]`

### MCP
`mcp list|test|discover|search|install`

### Content
`install`, `bundle`, `bundle-install`, `installed`, `uninstall`, `update`, `registry search|install`, `sources search|list|add|remove`, `browse`

### Development
`dev`, `index`, `process`, `search`, `graph`, `serve`, `generate system`

### Ops + governance
`costs show|budget|clear`, `health`, `ratelimit status|clear`, `dashboard`, `check-rules`, `list-rules`, `gate run`, `intelligence promote|dead|contradictions|suggest|failures`

### Portability
`export-bundle`, `import`, `scratch`, `cleanup`, `version init|snapshot`, `semantic index|stats`

### Provider integration
`export [provider]`, `doctor --check-drift`

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

`harness serve` exposes a REST API for webhooks, scheduled jobs, and remote access — for triggering the agent from external systems like CI runners, cron, Zapier, or GitHub Actions. This is **not** a way to embed the agent inside another agent product (see [When to use this](#when-to-use-this-and-when-not-to)); it's a remote control surface for the same standalone agent.

```bash
harness serve --port 8080 --webhook-secret $SECRET
curl -X POST http://localhost:8080/run -H "Authorization: Bearer $SECRET" \
  -d '{"prompt":"Summarize today"}'
```

## How context loading works

On every run, the harness:

1. Loads **IDENTITY.md** (always, full content)
2. Loads **memory/state.md** (current goals and mode)
3. Loads **rules/** — every active rule, full body
4. Loads the **skills catalog** — name + description for each model-invokable skill (lifecycle-triggered and scheduled skills are excluded)
5. Loads **memory/scratch.md** if it has content

Full skill bodies are loaded only when the model calls `activate_skill`. This keeps context predictable regardless of how many skills you have.

Total harness overhead is typically ~1,000–3,000 tokens depending on how many rules and skills you have.

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

## Upgrading from older versions

If your harness was created before 2026-04-28, run:

```bash
harness doctor --check                # see what would change
harness doctor --migrate --dry-run    # preview the migration without applying (v0.14.0+)
harness doctor --migrate              # apply the migration
```

This handles renaming `CORE.md` → `IDENTITY.md`, deleting `SYSTEM.md` (now infrastructure docs), moving `state.md` → `memory/state.md`, restructuring flat skills into bundles, rewriting frontmatter to the strict Agent Skills shape, and migrating the old 7-primitive directories (instincts, playbooks, workflows, tools, agents) into the 2-primitive shape (skills + rules). The migration is idempotent.

For the full version-by-version diff and the breaking changes between v0.8.x and v0.15.0, see [CHANGELOG.md](./CHANGELOG.md).

## Philosophy

- **The agent is the filesystem.** Not the code.
- **Ownership is law.** Every file has exactly one owner.
- **You shouldn't need to write code to build a capable agent.** But you can.
- **Progressive disclosure.** Load what you need, at the level you need.
- **Durability isn't optional.** Long runs fail. Checkpoint everything.
- **Agents learn.** Rules evolve. Sessions become journals.
- **Infrastructure does bookkeeping.** The agent does thinking.

## License

MIT
