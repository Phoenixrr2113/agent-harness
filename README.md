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
├── workflows/           # Cron-driven automations (coming soon)
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

## CLI Commands

| Command | Description |
|---------|-------------|
| `harness init <name>` | Create a new agent harness |
| `harness run <prompt>` | Run a single prompt |
| `harness run <prompt> --stream` | Stream the response |
| `harness chat` | Interactive REPL |
| `harness info` | Show loaded context and token budget |
| `harness prompt` | Display the full assembled system prompt |
| `harness index` | Rebuild all index files |
| `harness dev` | Watch mode — auto-rebuild indexes on file changes |

## Using as a Library

```typescript
import { createHarness } from 'agent-harness';

const agent = createHarness({
  dir: './my-agent',
  apiKey: process.env.OPENROUTER_API_KEY,
});

// One-shot
const result = await agent.run('What should I work on today?');
console.log(result.text);

// Streaming
for await (const chunk of agent.stream('Explain this codebase')) {
  process.stdout.write(chunk);
}

await agent.shutdown();
```

## Configuration

`config.yaml`:

```yaml
agent:
  name: my-agent
  version: "0.1.0"

model:
  provider: openrouter
  id: anthropic/claude-sonnet-4    # Any OpenRouter model
  max_tokens: 200000

runtime:
  scratchpad_budget: 10000
  timezone: America/New_York

memory:
  session_retention_days: 7
  journal_retention_days: 365
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | Yes | Your OpenRouter API key |

## How Context Loading Works

On every run, the harness:

1. Loads **CORE.md** (always, full content)
2. Loads **state.md** (current goals and mode)
3. Loads **SYSTEM.md** (boot instructions)
4. Scans all primitive directories, loading files at the appropriate disclosure level based on remaining token budget
5. Loads **scratch.md** if it has content

Total harness overhead is typically ~1,000-3,000 tokens depending on how many primitives you have.

## Philosophy

- **The agent is the filesystem.** Not the code.
- **Ownership is law.** Every file has exactly one owner.
- **You shouldn't need to write code to build a capable agent.** But you can.
- **Progressive disclosure.** Load what you need, at the level you need.
- **Agents learn.** Instincts evolve. Sessions become journals.
- **Infrastructure does bookkeeping.** The agent does thinking.

## License

MIT
