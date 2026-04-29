# Authoring skills

This guide describes how to write skills that conform to the [Agent Skills specification](https://agentskills.io/specification) and integrate well with agent-harness.

## File layout

A skill is a directory containing `SKILL.md` and optional support directories:

```
skills/<name>/
├── SKILL.md          # required: frontmatter + instructions
├── scripts/          # optional: executable code the agent invokes
├── references/       # optional: detailed docs the agent loads on demand
└── assets/           # optional: templates, data files
```

The directory name MUST equal the `name` field in the frontmatter.

## Frontmatter

Required:
- `name` — 1–64 chars, lowercase a–z and 0–9 and hyphens, no leading/trailing/consecutive hyphens
- `description` — 1–1024 chars, describes what the skill does AND when to use it (per the [optimizing-descriptions guide](https://agentskills.io/skill-creation/optimizing-descriptions))

Optional spec fields:
- `license`
- `compatibility` — ≤500 chars, e.g., "Requires Node.js 20+"
- `metadata` — string→string map for tool-specific extensions
- `allowed-tools` — space-separated string, e.g., `"Read Bash(jq:*)"`

Harness-specific extensions are stored in `metadata` with the `harness-` prefix:
- `metadata.harness-tags` — comma-separated string of tag names
- `metadata.harness-status` — `active` | `archived` | `deprecated` | `draft`
- `metadata.harness-author` — `human` | `agent` | `infrastructure`
- `metadata.harness-created` — ISO date string
- `metadata.harness-updated` — ISO date string
- `metadata.harness-related` — comma-separated string of related skill names

Example:

```yaml
---
name: research-synthesis
description: Synthesize information from multiple sources into a structured report. Use when given a research question and access to source material.
license: MIT
allowed-tools: Read Bash(jq:*)
metadata:
  harness-tags: "knowledge-work,research"
  harness-status: active
  harness-author: human
  harness-created: "2026-04-28"
---
```

## Body content

Recommended sections:
1. **When to use** — imperative phrasing matching the description
2. **Available scripts** — bullet list of bundled scripts with one-line purpose
3. **Workflow** — numbered steps with concrete script invocations
4. **Gotchas** — non-obvious facts the agent would otherwise get wrong
5. **Failure modes** — known errors and recovery hints

Keep `SKILL.md` under 500 lines / 5000 tokens. Move detailed material to `references/` and tell the agent when to load it.

## Validation

```bash
harness doctor --check -d <harness-dir>
```

The doctor reports any spec violations across every skill in the harness.

## Migration

If you have skills authored before 2026-04-28 (with `id`, top-level `tags`/`status`/etc., flat `.md` files, or L0/L1 HTML comments), run:

```bash
harness doctor --migrate -d <harness-dir>
```

The migration is idempotent and reversible via git.

## Lifecycle-triggered skills

A skill can hook into the AI SDK lifecycle by setting `metadata.harness-trigger`:

```yaml
---
name: inject-current-state
description: Adds the agent's current goals to the system prompt.
metadata:
  harness-trigger: prepare-call
---
```

The skill MUST have a script in `scripts/run.sh` (or `.py`/`.ts`/`.js`). The harness invokes it with the trigger name + bundle directory as argv and a JSON payload on stdin. The script returns JSON on stdout matching the contract defined in [docs/specs/2026-04-30-skill-content-rewrite-design.md](specs/2026-04-30-skill-content-rewrite-design.md) §4.1.

Lifecycle skills are NOT in the model-invokable catalog — the harness fires them, not the model.

## Scheduled skills

A skill with `metadata.harness-schedule: <cron>` is invoked by the harness scheduler:

```yaml
---
name: morning-brief
description: Synthesize today's plan from journal and calendar.
metadata:
  harness-schedule: "0 7 * * *"
---
Body.
```

Scheduled skills are NOT in the model-invokable catalog. When the cron fires, the harness constructs an `agent.generate` call with the skill's body added to the system prompt.

## Subagent skills

A skill with `metadata.harness-trigger: subagent` is model-invokable but runs in an isolated session:

```yaml
---
name: summarizer
description: Summarize a long text into 3 bullet points.
metadata:
  harness-trigger: subagent
---
You are a summarization agent. Return exactly 3 bullet points capturing the key points of the input.
```

When the model invokes the skill via `activate_skill`, the harness spawns a fresh `agent.generate` with the skill's body as the system prompt and the args as the user prompt. The subagent's final text is returned to the parent.

## Script feedback contract

Every script bundled in a skill — whether invoked by the model via `activate_skill` or fired by the harness as a lifecycle trigger — follows the same contract. This section is the canonical authoring reference; the full design rationale is in [docs/specs/2026-04-30-skill-content-rewrite-design.md](specs/2026-04-30-skill-content-rewrite-design.md) §4.1.

Real examples of scripts that follow this contract live in:
- `defaults/skills/delegate-to-cli/scripts/` — `delegate.sh`, `verify-cli.sh`
- `defaults/skills/daily-reflection/scripts/` — `synthesize.sh`, `propose-rules.sh`
- `defaults/skills/ship-feature/scripts/` — `pre-pr-checklist.sh`, `verify-tests.sh`, `verify-build.sh`

### Output shape

A script writes a single JSON object to stdout on completion. No surrounding prose, no log lines mixed in — stdout is structured output only. Diagnostics, progress messages, and warnings go to stderr.

Schema:

```typescript
interface ScriptResult {
  // Required
  status: 'ok' | 'error' | 'blocked';

  // Present on success
  result?: unknown;  // domain-specific payload; document the shape in SKILL.md

  // Present on error or blocked
  error?: {
    code: string;       // SCREAMING_SNAKE_CASE constant; document all codes in SKILL.md
    message: string;    // human- and agent-readable
    evidence?: string;  // what was observed, e.g. "no output for 60s on edit-class task"
    action?: 'abort' | 'retry' | 'escalate' | 'ignore';  // hint to the harness
  };

  // Actionable next steps the agent (or human) can take
  next_steps?: string[];

  // Observability
  metrics?: {
    duration_ms?: number;
    tokens_used?: number;
    api_calls?: number;
    [k: string]: unknown;
  };

  // Files the agent should read — returned as absolute or harness-root-relative paths
  artifacts?: Array<{ path: string; description?: string }>;
}
```

Example output from `scripts/synthesize.sh` in `daily-reflection`:

```json
{
  "status": "ok",
  "result": {
    "journal_path": "memory/journal/2026-04-30.md",
    "sessions_processed": 7,
    "patterns_detected": 3,
    "rule_candidates": 1
  },
  "metrics": { "duration_ms": 4200, "tokens_used": 8400 },
  "artifacts": [
    { "path": "memory/journal/2026-04-30.md", "description": "Today's synthesized journal entry" }
  ]
}
```

`status: blocked` means the script cannot proceed without a decision the agent or user must make. Pair it with `error.code: BLOCKED_NEEDS_DECISION` and a `next_steps` list that enumerates the choices.

### Exit codes

| Exit code | Meaning |
|---|---|
| 0 | `status: ok` returned |
| 1 | `status: error` returned (general error) |
| 2 | `status: error` returned, `error.code: INVALID_INPUT` (argv / stdin malformed) |
| 3 | `status: error` returned, `error.code: ENVIRONMENT_MISSING` (binary not on PATH, env var unset, etc.) |
| 4 | `status: blocked` returned |
| other | Reserved; harness logs but does not ascribe meaning |

The harness reads stdout regardless of exit code. The exit code is a fast-path for the harness to categorize the result without parsing JSON; the JSON object is always the source of truth.

### Argv and stdin

**When invoked by the model** (via `activate_skill` and then a Bash tool call into the script):

- **Argv**: positional arguments are the script's primary inputs (paths, modes, options). All inputs must also be expressible as named flags so `--help` is comprehensive.
- **Stdin**: optional. Used for large inputs (file content, JSON payloads) when argv would be unwieldy. If stdin is consumed, document it in `--help`.

Example from `defaults/skills/delegate-to-cli/scripts/delegate.sh`:
```
scripts/delegate.sh claude read "Summarize the README"
scripts/delegate.sh codex edit "Add a docstring to foo.py"
```

**When invoked by the harness as a lifecycle trigger** (e.g., `metadata.harness-trigger: prepare-call`):

- **Argv**: `<trigger-name> <skill-dir-absolute>` — fixed by the harness.
- **Stdin**: JSON payload with the AI SDK hook context — fixed by the harness.
- **Stdout**: same JSON contract above; the `result` field's shape depends on the trigger (for example, `prepare-call` returns `{ instructions?, tools?, activeTools? }`).

Lifecycle-trigger scripts receive their context from stdin, not from the model. The harness manages the entire invocation.

### `--help` is mandatory

Every script must support `--help` (or `-h`) and produce, in under ~30 lines:

```
Usage: scripts/<name>.sh [OPTIONS] <ARGS>

<one-paragraph description>

Options:
  --flag VALUE     Description (default: X)
  ...

Examples:
  scripts/<name>.sh ...
  scripts/<name>.sh --flag value ...

Exit codes:
  0  Success
  1  Error
  2  Invalid input
  3  Environment missing
  4  Blocked (decision needed)

Returns JSON to stdout. See SKILL.md for the result schema.
```

`harness doctor` verifies that `--help` produces output containing the strings `Usage:` and `Exit codes:`. Missing or non-conformant `--help` is an error-level lint.

### No interactive prompts

Scripts must not block on stdin for user input, password dialogs, confirmation menus, or any TTY interaction. The harness invokes scripts in non-interactive subprocess contexts — an interactive prompt hangs the run indefinitely.

For destructive operations that would normally require confirmation, accept a `--confirm` or `--force` flag instead. Without it, return:

```json
{
  "status": "blocked",
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "This operation will delete 14 files. Re-run with --confirm to proceed.",
    "action": "escalate"
  },
  "next_steps": ["Re-run with --confirm after verifying the file list", "Run with --dry-run first to review what would be deleted"]
}
```

The agent can then decide whether to retry with the flag — typically after surfacing the confirmation to the user via the harness's approval flow.

### Idempotency

Scripts should be idempotent where possible. "Create if not exists" is preferred over "create and fail on duplicate." Running the same script twice on the same inputs should produce the same result without side effects.

When an operation is inherently destructive (delete, overwrite, migrate):

- Document the destruction in `--help`.
- Require `--confirm` or `--force` (per "No interactive prompts" above).
- Provide `--dry-run` that prints what would happen without doing it.
- Include `artifacts` in the return value listing what was changed so the agent can verify.

### Predictable output size

Tool harnesses commonly truncate stdout above a threshold (10–30k chars). A script that occasionally emits 50KB silently truncates and confuses the model.

Scripts that might produce large output must:

- Default to a summary or the N most-relevant items, **or**
- Support `--offset` / `--limit` for paging, **or**
- Accept `--output FILE` to write full output to disk and return the path in `artifacts`.

Document the chosen strategy in `--help`. `harness doctor` warns when a script's `--help` does not contain at least one of these keywords: `--limit`, `--offset`, `--output`.

### Long-running scripts

Scripts that may take more than 10 seconds use one of two patterns:

**Pattern A — fire-and-poll** (preferred for genuinely long work):

The script forks a child process for the actual work and returns immediately:

```json
{
  "status": "ok",
  "result": {
    "progress_file": "/tmp/skill-synthesize-94821.progress",
    "pid": 94821
  }
}
```

The agent reads the progress file periodically via standard Read/Bash tools (not by re-invoking the script) until the child writes a final result and exits. This pattern is documented in `defaults/skills/dispatching-parallel-agents/SKILL.md` with a worked example.

**Pattern B — synchronous with stderr progress** (default for typical scripts):

The script writes progress lines to stderr as it runs:

```bash
echo "Processing session 3 of 7..." >&2
```

The harness logs stderr but does not surface it to the model. A wall-clock timeout applies (default 5 minutes for non-trigger scripts; configurable via `metadata.harness-script-timeout-ms` in frontmatter). On timeout the harness sends SIGTERM, then SIGKILL after a grace period.

Pattern A is preferred when work genuinely takes minutes or fans out across parallel sub-processes. Pattern B is the right choice for scripts that take seconds to a minute.

## Validation

Run lints on a single skill:

```bash
harness skill validate <name>
```

Run full harness validation (all skills, all lints, bundle structure checks):

```bash
harness doctor --check
```

Apply auto-fixable corrections (adds executable bit to scripts that have a shebang but lack `chmod +x`; generates `--help` skeletons for scripts missing it; reformats metadata to use the `harness-` prefix):

```bash
harness doctor --fix
```

Unsafe corrections (rewriting scripts, generating descriptions) are never auto-fixed. Doctor reports them for manual review with a specific list of issues per file.

## Scaffolding a new skill

```bash
harness skill new <name>
```

This produces a `skills/<name>/` bundle pre-populated with a spec-conformant `SKILL.md`, a starter `scripts/run.sh` that already follows the JSON contract, empty `references/` and `assets/` directories, and placeholder `--help` output. The scaffolded skill passes `harness skill validate` immediately — edit the payloads and instructions to make it do real work.

## Writing evals

Skills can ship with two kinds of eval coverage:

- **Trigger evals** (`evals/triggers.json`) — verify the model picks this skill on intended queries and skips it on near-misses
- **Quality evals** (`evals/evals.json`) — verify the skill produces measurably better output than no skill on representative tasks

The 16 default skills ship with trigger evals. High-effort defaults (delegate-to-cli, daily-reflection, ship-feature) also ship with quality evals.

To author evals for a skill you're building, see the canonical reference: [skill-evals.md](skill-evals.md).

Quick-start commands:

- `harness skill eval-triggers <name>` — runs trigger eval, reports per-query pass/fail
- `harness skill eval-quality <name>` — runs quality eval, reports with-vs-without-skill delta
- `harness skill optimize-description <name>` — iteratively refines the skill's description against the trigger set
- `harness skill optimize-quality <name>` — iteratively refines the skill's body against the quality eval

## See also

- [Agent Skills specification](https://agentskills.io/specification)
- [Best practices for skill creators](https://agentskills.io/skill-creation/best-practices)
- [Optimizing skill descriptions](https://agentskills.io/skill-creation/optimizing-descriptions)
- [Using scripts in skills](https://agentskills.io/skill-creation/using-scripts)
- [Skill evals reference](skill-evals.md)
- [Script feedback contract — design rationale](specs/2026-04-30-skill-content-rewrite-design.md)
