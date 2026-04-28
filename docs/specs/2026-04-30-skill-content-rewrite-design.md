# Skill content rewrite + script feedback contract — design

**Date:** 2026-04-30
**Status:** Draft (pending review)
**Spec:** 3 of 5 in the Agent Skills alignment series
**Depends on:** 1 of 5, 2 of 5
**Related specs:**
- 4 of 5 — `2026-05-01-skill-evals-design.md`
- 5 of 5 — `2026-05-02-provider-integration-design.md`

## 1. Goal

Define the contract that skill scripts follow so the harness (and the model) can chain them confidently — a JSON output shape, error code conventions, long-running progress, --help discoverability, and idempotency rules. Rewrite all default skills shipped by agent-harness as proper Agent Skills bundles that follow this contract: thin `SKILL.md` instructions on top of tested scripts that return structured feedback. Add doctor lints that enforce the contract on every skill the harness loads or installs.

## 2. Non-goals (handled in later specs)

- Eval infrastructure for measuring skill output quality and trigger accuracy — spec #4.
- Provider integration (`harness export` to `.claude/`/`.cursor/`/etc.) — spec #5.
- Sandboxing, permission scoping, or security isolation of script execution. The harness trusts the user's local filesystem, same as before.
- Authoring of new skills beyond the default set we already ship. User-authored skills are bound by the contract but not authored in this spec.

## 3. Background

### 3.1 The problem

[defaults/skills/delegate-to-cli.md](../../defaults/skills/delegate-to-cli.md) is the canonical failure case (107 lines). All of its content is *instructions for the agent to follow with its existing tools*. Each invocation, the agent has to:

1. Hold the flag-mapping table in working memory
2. Construct each command from scratch (`start_process` with the right CLI binary + flag for the task type)
3. Re-implement the polling loop (`read_process_output` until exit)
4. Re-implement timeout / stall detection
5. Re-implement result verification (`git diff`)

That's 107 tokens of instructions plus repeated reasoning effort plus reconstruction error risk **on every invocation**. If a CLI changes a flag, every agent silently breaks until someone updates the markdown.

The [Agent Skills "Using scripts" guide](https://agentskills.io/skill-creation/using-scripts) prescribes the correct shape: bundle a tested script that wraps the operation, design it for non-interactive agent use (no TTY prompts, --help, structured output, helpful errors, idempotency, predictable size), and let SKILL.md become a thin decision tree pointing at the scripts.

### 3.2 What we have today

After spec #1 + spec #2 land, defaults/skills/ contains 8 skills:

**Originally agent-harness:**
- [defaults/skills/delegate-to-cli/SKILL.md](../../defaults/skills/delegate-to-cli/SKILL.md) — bundled in spec #1 (was flat); body is unchanged
- [defaults/skills/business-analyst/SKILL.md](../../defaults/skills/business-analyst/SKILL.md) — bundled
- [defaults/skills/content-marketer/SKILL.md](../../defaults/skills/content-marketer/SKILL.md) — bundled
- [defaults/skills/research/SKILL.md](../../defaults/skills/research/SKILL.md) — bundled
- [defaults/skills/ship-feature/SKILL.md](../../defaults/skills/ship-feature/SKILL.md) — migrated from `playbooks/` in spec #2
- [defaults/skills/daily-reflection/SKILL.md](../../defaults/skills/daily-reflection/SKILL.md) — migrated from `workflows/` in spec #2, has `metadata.harness-schedule`

**Vendored from obra/superpowers:**
- [defaults/skills/brainstorming/SKILL.md](../../defaults/skills/brainstorming/SKILL.md)
- [defaults/skills/writing-plans/SKILL.md](../../defaults/skills/writing-plans/SKILL.md)
- [defaults/skills/executing-plans/SKILL.md](../../defaults/skills/executing-plans/SKILL.md)
- [defaults/skills/dispatching-parallel-agents/SKILL.md](../../defaults/skills/dispatching-parallel-agents/SKILL.md)

After spec #2 also lands, the migrated `tools/*` files have produced auto-generated `scripts/call.sh` files in the corresponding skill bundles. Those scripts are flagged for review per spec #2 §4.10.

This spec's job: bring all of this content up to the script-contract bar.

## 4. Design

### 4.1 The script feedback contract

Every script bundled in a skill, when invoked, MUST follow these rules.

#### 4.1.1 Output shape

A script writes a single JSON object to stdout on completion. The schema:

```typescript
interface ScriptResult {
  // Required
  status: 'ok' | 'error' | 'blocked';

  // Present on success
  result?: unknown;  // typed payload — domain-specific shape

  // Present on error or blocked
  error?: {
    code: string;       // SCREAMING_SNAKE_CASE constant; documented per skill
    message: string;    // human + agent readable
    evidence?: string;  // what was observed (e.g., "no output for 60s on edit-class task")
    action?: 'abort' | 'retry' | 'escalate' | 'ignore';  // optional hint to harness
  };

  // Optional — actionable next steps the agent (or human) can take
  next_steps?: string[];

  // Optional — observability
  metrics?: {
    duration_ms?: number;
    tokens_used?: number;
    api_calls?: number;
    [k: string]: unknown;
  };

  // Optional — when the result references files the agent should read
  artifacts?: Array<{ path: string; description?: string }>;
}
```

Strictly JSON, written as a single object to stdout. No surrounding prose, no log lines mixed in. Diagnostics, progress messages, and warnings go to stderr.

The `status: blocked` value is for situations where the script can't proceed without a decision the agent (or user) must make — e.g., "two valid migration paths, pick one." `error.code: BLOCKED_NEEDS_DECISION` plus `next_steps` listing the options.

#### 4.1.2 Exit codes

| Exit code | Meaning |
|---|---|
| 0 | `status: ok` returned |
| 1 | `status: error` returned (general error) |
| 2 | `status: error` returned with `error.code: INVALID_INPUT` (argv / stdin malformed) |
| 3 | `status: error` returned with `error.code: ENVIRONMENT_MISSING` (binary not on PATH, env var unset, etc.) |
| 4 | `status: blocked` returned |
| (other) | reserved; harness logs but doesn't ascribe meaning |

The harness reads stdout regardless of exit code. Exit code is a fast-path for the harness to categorize without parsing JSON; the JSON is the source of truth.

#### 4.1.3 Argv and stdin conventions

For scripts invoked by the model (via `activate_skill` and then a Bash tool call):

- **Argv**: positional arguments are the script's primary inputs (paths, modes, options). All inputs must also be expressible via flags so `--help` is comprehensive.
- **Stdin**: optional. Used for large inputs (file content, JSON payloads) when argv would exceed a reasonable length. If stdin is consumed, the script's `--help` documents that.

For scripts invoked by the harness as lifecycle triggers (per [spec #2 §4.4](2026-04-29-primitive-collapse-design.md#44-ai-sdk-trigger-mapping)):

- **Argv**: `<trigger-name> <skill-dir-absolute>` (fixed by harness)
- **Stdin**: JSON payload with the AI SDK hook context (fixed by harness)
- **Stdout**: same JSON contract above; the `result` field's shape depends on the trigger (e.g., `prepare-call` returns `{ instructions?, tools?, activeTools? }`).

#### 4.1.4 `--help` is mandatory

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

The doctor lint verifies `--help` produces output containing the strings "Usage:" and "Exit codes:".

#### 4.1.5 No interactive prompts

Scripts MUST NOT block on stdin for user input, password dialogs, confirmation menus, or any TTY interaction. The harness invokes scripts in non-interactive subprocess contexts; an interactive prompt hangs the run.

If a destructive operation needs confirmation, the script accepts a `--confirm` or `--force` flag and refuses without it, returning `status: blocked` with `error.code: CONFIRMATION_REQUIRED`. The agent can then decide whether to retry with the flag (typically prompting the user via the harness's approval flow before doing so).

#### 4.1.6 Idempotency

Scripts SHOULD be idempotent where possible. "Create if not exists" is preferred over "create and fail on duplicate." When operations are inherently destructive (delete, overwrite), the script:

- Documents the destruction in its `--help`
- Requires `--confirm` or `--force`
- Provides `--dry-run` that prints what would happen without doing it
- Returns `artifacts` listing what was changed (so the agent can verify)

#### 4.1.7 Predictable output size

Per the [Agent Skills spec on script design](https://agentskills.io/skill-creation/using-scripts#further-considerations): tool harnesses commonly truncate stdout above a threshold (10–30k chars). Scripts that might produce large output:

- Default to a summary or N most-relevant items
- Support `--offset` / `--limit` for paging
- Or accept `--output FILE` for writing the full output to disk and returning the path in `artifacts`

A script that occasionally produces 50KB of stdout will silently truncate and confuse the model. Lint warns when `--help` does not document a size-limiting strategy.

#### 4.1.8 Long-running scripts and progress

Scripts that may take >10 seconds use one of two patterns:

**Pattern A (fire-and-poll)**: the script forks a child process to do the actual work and returns immediately with `status: ok, result: { progress_file: "/tmp/skill-<name>-<pid>.progress", pid: <child-pid> }`. The agent reads the progress file periodically (via standard tools, not via re-invoking the script) until the child writes a final result and exits. Pattern is appropriate for genuinely long-running work — synthesis, batch jobs, parallel fanout. Documented in [defaults/skills/dispatching-parallel-agents](../../defaults/skills/dispatching-parallel-agents/SKILL.md).

**Pattern B (synchronous with stderr progress)**: the script writes progress messages to stderr (which the harness logs but doesn't surface to the model). The harness applies a wall-clock timeout (default 5 minutes for non-trigger scripts; configurable per-skill via `metadata.harness-script-timeout-ms`). On timeout, harness sends SIGTERM, then SIGKILL after a grace period.

Pattern A is preferred for genuinely long-running work. Pattern B is the default for typical scripts (a few seconds to a minute).

### 4.2 SKILL.md content guidelines

SKILL.md is *thin*. The Agent Skills [best practices guide](https://agentskills.io/skill-creation/best-practices) says skills should aim for under 500 lines / 5000 tokens, with detail moved to `references/` and reusable logic in `scripts/`. We adopt and extend those guidelines.

#### 4.2.1 Required sections

Every SKILL.md has, in order:

1. **Frontmatter** — spec-conformant per [spec #1 §4.1.1](2026-04-28-skills-spec-conformance-design.md#411-skills-strict-spec-compliance)
2. **Title** (`# <skill-name>`)
3. **When to use** — 1–3 paragraphs, imperative phrasing ("Use this skill when..."), per [optimizing descriptions](https://agentskills.io/skill-creation/optimizing-descriptions). Mirrors and expands the frontmatter description.
4. **Available scripts** — bullet list of scripts in `scripts/` with one-line purpose each
5. **Workflow** — numbered steps with concrete script invocations
6. **Gotchas** — non-obvious environment-specific facts (per [Best practices §4.1](https://agentskills.io/skill-creation/best-practices#gotchas-sections))
7. **Failure modes** — known errors, their `error.code`, what to try (per the script contract's `next_steps` mechanism)

#### 4.2.2 Optional sections

- **Templates** — short output templates inline (longer ones go in `assets/`)
- **References** — pointers to `references/` files with WHEN-to-load instructions
- **Related skills** — skills the agent should reach for instead, or alongside

#### 4.2.3 Anti-patterns

Per [Best practices](https://agentskills.io/skill-creation/best-practices) and our own observation:

- **Don't explain what the agent already knows.** "PDF (Portable Document Format) is a common file format..." adds nothing.
- **Don't list multiple tool options as equals.** Pick a default ("Use pdfplumber. For OCR, fall back to pdf2image + pytesseract."). Avoid menus.
- **Don't write specific answers.** "Join orders to customers on customer_id, filter region='EMEA'..." — write the *method*, not the *instance*.
- **Don't dump every flag.** Move flag tables to `references/flags.md` and load on troubleshooting.
- **Don't write multi-step prose.** Use numbered checklists or scripts.

#### 4.2.4 Length budget

| Body lines | Verdict |
|---|---|
| < 100 | Likely under-specified or trivially activable; check |
| 100–300 | Sweet spot |
| 300–500 | Acceptable; consider moving sections to `references/` |
| > 500 | Doctor warns; refactor required |

Token-count budget enforced by doctor: warn at 4000 tokens, error at 6000.

### 4.3 Per-skill rewrite plan

Each existing default skill gets a tailored rewrite. Items in **bold** are net-new.

#### 4.3.1 delegate-to-cli (high effort)

**New shape:**
```
defaults/skills/delegate-to-cli/
├── SKILL.md                          (~50 lines: when, decision tree, pointer)
├── scripts/
│   ├── delegate.sh                   (single entrypoint: claude/codex/gemini, mode, prompt)
│   ├── verify-cli.sh                 (binary + version check, structured)
│   └── poll-output.sh                (stall detection wrapper for any subprocess)
└── references/
    ├── permission-flags.md           (the flag table, loaded on troubleshooting)
    └── failure-modes.md              (detailed mode catalog with error codes)
```

`scripts/delegate.sh` interface:
```
Usage: scripts/delegate.sh [OPTIONS] <cli> <mode> <prompt>

Run a bounded subtask via a local CLI agent and return its result.

Arguments:
  <cli>      One of: claude, codex, gemini
  <mode>     One of: read (analysis only) | edit (file modification)
  <prompt>   The prompt to send to the CLI

Options:
  --timeout-ms N   Wall-clock timeout in milliseconds (default: 600000)
  --max-poll N     Maximum poll iterations on stall (default: 60)
  --dry-run        Print the resolved command without executing

Examples:
  scripts/delegate.sh claude read "Summarize the README"
  scripts/delegate.sh codex edit "Add a comment to foo.py explaining the regex"

Exit codes:
  0 Success | 1 Error | 2 Invalid input | 3 Environment missing | 4 Blocked

Returns JSON: { status, result: { output, exit_code, duration_ms }, error?, next_steps?, metrics }
```

`error.code` constants this script can return:
- `CLI_NOT_FOUND` — binary not on PATH
- `CLI_VERSION_TOO_OLD` — claude < 2.1, etc.
- `PERMISSION_FLAG_MISSING` — subprocess stalled, likely missing edit flag
- `RATE_LIMITED` — provider returned 429
- `SUBPROCESS_TIMEOUT` — wall-clock exceeded

SKILL.md body shrinks to: when to delegate (the four conditions from the original), which CLI for which task (the decision matrix), pointer to the script, and a brief "if it fails, read references/failure-modes.md" instruction.

#### 4.3.2 daily-reflection (high effort)

This is a scheduled skill (`metadata.harness-schedule: "0 22 * * *"` from the workflow migration). Its job: synthesize today's sessions into a journal entry.

**New shape:**
```
defaults/skills/daily-reflection/
├── SKILL.md                          (~80 lines)
├── scripts/
│   ├── synthesize.sh                 (reads sessions/, runs synthesis via summary_model, writes journal/)
│   └── propose-rules.sh              (extracts rule candidates from synthesized journal)
└── references/
    └── synthesis-prompt.md           (the prompt template used during synthesis)
```

`synthesize.sh` returns:
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

`propose-rules.sh` is a follow-up the schedule can invoke (or the user can run manually). Returns rule candidates with `next_steps: ["Review at <path>", "Run harness rule install <candidate-id> to promote"]`.

The current `harness journal` and `harness learn` CLI commands continue to work but delegate to these scripts internally.

#### 4.3.3 ship-feature (medium effort)

A methodology skill (was a playbook). Mostly content-driven, but ships with utility scripts:

**New shape:**
```
defaults/skills/ship-feature/
├── SKILL.md                          (~150 lines)
├── scripts/
│   ├── verify-tests.sh               (run tests, return structured result)
│   ├── verify-build.sh               (run build, return structured result)
│   └── pre-pr-checklist.sh           (typecheck + lint + test + build, all-or-nothing)
└── references/
    ├── pr-template.md                (asset for PR description)
    └── commit-conventions.md         (project's commit style — placeholder for user override)
```

The scripts wrap common pre-merge checks. SKILL.md provides the methodology (test-first, small commits, etc.) and points at scripts for the mechanical bits.

#### 4.3.4 brainstorming, writing-plans, executing-plans, dispatching-parallel-agents (low effort)

Vendored from obra/superpowers in spec #1. Already follow the bundle pattern. **Per-skill review** for:
- Frontmatter conformance to spec #1's strict skill schema (likely needs the `harness-` prefix migration applied)
- Body adaptation: strip references to non-vendored superpowers skills (as flagged in spec #1 §4.5.2)
- Add or update scripts to follow the contract from §4.1 if any exist

Most of this is mechanical. `dispatching-parallel-agents` may have scripts that need contract upgrades; the others are largely instruction-only and don't need scripts at all.

#### 4.3.5 business-analyst, content-marketer, research (low effort)

These are domain methodology skills. They benefit minimally from scripts (most "operations" are LLM reasoning, not external commands). Rewrite focus:

- Apply [optimizing descriptions](https://agentskills.io/skill-creation/optimizing-descriptions) guidance: pushy descriptions, imperative framing
- Trim against [best practices](https://agentskills.io/skill-creation/best-practices): drop generic content the model already knows, keep the domain-specific guidance
- Add a `## Gotchas` section with non-obvious facts (one per skill, minimum)
- Aim for under 200 body lines each (currently 181, 184, 34 — research is fine, the others trim)

May add `scripts/draft-report.sh` (for business-analyst), `scripts/draft-post.sh` (content-marketer) that wrap a small LLM call producing a templated output. Optional; skip if it doesn't add value.

#### 4.3.6 Migrated tools (variable effort)

The spec #2 migration auto-generated `scripts/call.sh` for `tools/*` that converted cleanly. Each requires:

- Manual review of the generated curl command (security, correctness)
- Tightening the JSON output to follow the contract from §4.1
- Adding `--help` per §4.1.4
- Adding `--dry-run` if the API call has side effects
- Hand-rewriting if the auto-generation produced something marginal

The doctor `--migrate-skills` reports which scripts came from auto-generation (via `metadata.harness-script-source: auto-generated-from-tools`) so the user can audit.

### 4.4 Doctor lints

`harness doctor` (no flags) and `harness doctor --check` validate every loaded skill against the contract. New lints beyond spec #1's frontmatter checks:

#### 4.4.1 Per-skill lints

| Lint | Severity | Check |
|---|---|---|
| `description-quality` | warn | Description follows imperative form ("Use this skill when..."), is between 80 and 1024 chars, contains the word "when" or describes a trigger context |
| `body-length` | warn at 4000 tok / 500 lines, error at 6000 tok / 800 lines | Per §4.2.4 |
| `body-has-required-sections` | warn | Body contains `## When to use` (or equivalent), and at least one of `## Available scripts`, `## Workflow`, `## Gotchas` |
| `metadata-prefix` | error | All harness extensions in `metadata` use the `harness-` prefix |
| `referenced-files-exist` | error | Every relative path in the body resolves to an existing file in the bundle |

#### 4.4.2 Per-script lints

Run on every file in `scripts/`:

| Lint | Severity | Check |
|---|---|---|
| `shebang` | error | First line is a recognized shebang (`#!/usr/bin/env bash`, `#!/usr/bin/env python3`, etc.) |
| `executable` | error | Mode includes user-execute (`chmod +x` applied) |
| `help-supported` | error | Running `<script> --help` exits 0 and stdout contains "Usage:" and "Exit codes:" |
| `no-interactive` | warn | Script source doesn't contain `read -p`, `read -r`, `input(` (Python), `prompt(` (JS), or `gets` (Ruby) — warns if found, error only with explicit override metadata |
| `pinned-dependencies` | warn | If the script declares dependencies (PEP 723 block, `npm:` imports, `Gemfile.lock`), they're version-pinned |
| `output-discipline` | warn | Static check: `echo` to stdout outside of a clear "JSON-emit" pattern triggers a warning ("you may be mixing diagnostics with structured output") — heuristic, not strict |

#### 4.4.3 Bundle structure lints

| Lint | Severity | Check |
|---|---|---|
| `references-not-empty` | warn | If `references/` exists, it contains at least one file |
| `assets-not-empty` | warn | Same for `assets/` |
| `no-stray-files` | warn | Top-level bundle contains only `SKILL.md`, recognized subdirs (`scripts/`, `references/`, `assets/`), and standard files (`LICENSE`, `NOTICE`, `.gitignore`); other files trigger a warning |

#### 4.4.4 Auto-fix

`harness doctor --fix` applies safe corrections:

- Add executable bit to scripts that have a shebang but aren't `chmod +x`
- Generate a `--help` skeleton (commented `# TODO: fill in`) for scripts that don't support it
- Reformat metadata to use `harness-` prefix where keys are missing it

Unsafe corrections (rewriting scripts, generating descriptions) are NOT auto-fixed; doctor reports them for manual review.

### 4.5 Authoring documentation

[docs/skill-authoring.md](../../docs/skill-authoring.md) (created in spec #1) is expanded with:

- The script contract from §4.1 (canonical reference)
- The SKILL.md content guidelines from §4.2
- Templates for new skills (`harness skill new <name>` scaffolds these)
- Examples of good and bad descriptions, drawn from the [optimizing descriptions guide](https://agentskills.io/skill-creation/optimizing-descriptions)
- A worked example: rewriting an old flat skill as a proper bundle

`harness skill new <name>` (new CLI command, see §4.6) scaffolds a skill bundle pre-populated with placeholder content matching the templates.

### 4.6 New CLI commands

| Command | Purpose |
|---|---|
| `harness skill new <name>` | Scaffold `skills/<name>/SKILL.md` + `scripts/` + `references/` + `assets/` with template content |
| `harness skill validate <name>` | Run the lints from §4.4 on a single skill (subset of `harness doctor` output) |
| `harness skill list [--trigger=<x>] [--scheduled]` | List skills with their trigger/schedule status |

The existing `harness install <url>` command runs the §4.4 lints on every installed skill and refuses installation if any error-level lint fails (with `--force` override). This prevents broken skills from landing.

## 5. Behavior changes (user-visible)

| Before | After |
|---|---|
| delegate-to-cli is a 107-line markdown manual the agent re-interprets each invocation | delegate-to-cli has a tested `scripts/delegate.sh` returning structured JSON; SKILL.md is a 50-line decision tree pointing at scripts |
| daily-reflection is a markdown workflow with embedded synthesis prompts | daily-reflection has `scripts/synthesize.sh` and `scripts/propose-rules.sh` returning structured journal+candidates output |
| Skill bodies tend toward exhaustive explanation | Skill bodies are thin pointers to scripts and references; detail is loaded on demand |
| No standard for what a script returns | Every script returns the JSON contract from §4.1 |
| `harness doctor` validates frontmatter only | `harness doctor` validates frontmatter + body length + script contract + bundle structure |
| Auto-generated `tools/` scripts are flagged but not contract-conformant | Each auto-generated script is reviewed and brought to contract; metadata records audit status |

## 6. Implementation plan

Phase numbers continue from spec #2.

### Phase 16: Doctor lint infrastructure

| # | File | Change |
|---|---|---|
| 16.1 | [src/runtime/doctor.ts](../../src/runtime/doctor.ts) | Add lint registry. Each lint is a function `(skill: HarnessDocument, bundleDir: string) => LintResult[]`. |
| 16.2 | [src/runtime/doctor.ts](../../src/runtime/doctor.ts) | Implement skill-level lints (description quality, body length, required sections, metadata prefix, referenced files). |
| 16.3 | [src/runtime/doctor.ts](../../src/runtime/doctor.ts) | Implement script-level lints (shebang, executable, --help, no-interactive heuristic, pinned-deps, output-discipline). |
| 16.4 | [src/runtime/doctor.ts](../../src/runtime/doctor.ts) | Implement `--fix` for safe corrections. |

### Phase 17: CLI scaffolding

| # | File | Change |
|---|---|---|
| 17.1 | [src/cli/index.ts](../../src/cli/index.ts) | Add `harness skill new <name>`, `harness skill validate <name>`, `harness skill list`. |
| 17.2 | [templates/skill-bundle/](../../templates/skill-bundle/) (new) | Scaffold templates for `SKILL.md`, `scripts/run.sh`, `scripts/run.py`, `references/REFERENCE.md`, `assets/template.md`. The CLI picks language based on `--lang` flag (default bash). |

### Phase 18: Default skill rewrites (highest-effort first)

Each default skill is rewritten in its own commit so the diff is reviewable and the test suite can be run per-skill.

| # | Skill | Effort | Test coverage |
|---|---|---|---|
| 18.1 | delegate-to-cli | high | Integration test: invoke `scripts/delegate.sh claude read "summarize this fixture"` — assert structured JSON output matches contract |
| 18.2 | daily-reflection | high | Integration test: invoke `scripts/synthesize.sh` against a fixture sessions directory — assert journal entry produced and JSON output well-formed |
| 18.3 | ship-feature | medium | Integration test: invoke `scripts/pre-pr-checklist.sh` against a fixture project — assert exit codes match documented |
| 18.4 | brainstorming | low | Smoke test: skill loads, description triggers on a relevant prompt |
| 18.5 | writing-plans | low | Smoke test |
| 18.6 | executing-plans | low | Smoke test |
| 18.7 | dispatching-parallel-agents | low–medium | Integration test if it has scripts; smoke test otherwise |
| 18.8 | business-analyst, content-marketer, research | low | Smoke tests + lint compliance |
| 18.9 | Migrated tools/* | variable | Per-tool integration test of the auto-generated script |

### Phase 19: Documentation

| # | File | Change |
|---|---|---|
| 19.1 | [docs/skill-authoring.md](../../docs/skill-authoring.md) | Expand with §4.1 contract, §4.2 guidelines, examples |
| 19.2 | [README.md](../../README.md) | Update "Why markdown (not code)" section: clarify that *behavior* lives in scripts, *instructions* in markdown |
| 19.3 | [README.md](../../README.md) | Update "Installing content" section: lints run on install, refuse on error |

## 7. Tests

### 7.1 Contract tests

| Test | Asserts |
|---|---|
| `contract — valid result parses` | All combinations of optional fields parse |
| `contract — exit code mapping` | Status:ok → 0, status:error → 1, status:error+code:INVALID_INPUT → 2, etc. |
| `contract — large stdout truncation handling` | Script that writes >50KB to stdout has `--output FILE` documented in --help |

### 7.2 Lint tests

| Test | Asserts |
|---|---|
| `lint — description quality detects vague` | "Process CSV files." flagged; "Analyze CSV and tabular data files; use when..." passes |
| `lint — body length warning at 4000 tokens` | A body padded past 4000 tokens triggers warn |
| `lint — body length error at 6000 tokens` | Same at error threshold |
| `lint — required sections present` | A SKILL.md missing all of `## When to use`, `## Available scripts`, `## Workflow`, `## Gotchas` warns |
| `lint — referenced files exist` | A SKILL.md referring to `scripts/foo.sh` fails when the file is missing |
| `lint — shebang detected` | A script without `#!` errors |
| `lint — executable bit` | A script without `chmod +x` errors |
| `lint — --help required` | A script whose `--help` output doesn't contain "Usage:" / "Exit codes:" errors |
| `lint — no-interactive heuristic` | A script with `read -p` warns |
| `lint — auto-fix executable bit` | `--fix` adds the bit |

### 7.3 Per-skill integration tests

Already enumerated in §6 phase 18. Each rewritten skill gets at minimum a smoke test (loads, triggers on a relevant prompt) and where applicable an integration test (script invocation against a fixture, JSON output validated against contract schema).

### 7.4 End-to-end

| Test | Asserts |
|---|---|
| `e2e — install rejects broken skill` | `harness install <fixture-broken-skill>` fails with the offending lint reported |
| `e2e — install accepts compliant skill` | `harness install <fixture-good-skill>` succeeds |
| `e2e — model invokes activate_skill, runs script, parses result` | Full loop: agent.generate() with a delegate-to-cli invocation, script returns structured JSON, agent uses next_steps to recover from a simulated error |

## 8. Open questions and risks

### 8.1 Resolved during brainstorming

- **JSON contract vs. plain text output**: resolved — JSON is mandatory. Plain-text scripts are a footgun for chained agent use.
- **Long-running progress mechanism**: resolved — Pattern A (fire-and-poll with progress file) for genuinely long work; Pattern B (synchronous with stderr progress) for typical scripts.
- **Where does the contract live?**: resolved — in [docs/skill-authoring.md](../../docs/skill-authoring.md) (canonical), referenced from this design.

### 8.2 Open

- **Should the contract include a `request_id` field for telemetry correlation?** Likely yes for skills that span multiple scripts or trigger sub-agents. Defer to spec #4 (evals) where telemetry becomes load-bearing.
- **Should skills be allowed to ship multiple-language scripts (Bash + Python + Node) for environment compatibility?** Current plan: yes, the `## Available scripts` section can list alternatives, and the skill body picks based on environment via `compatibility` frontmatter. Fine but unscoped here.
- **Can scripts call other scripts within the same bundle?** Yes, via relative paths from skill root (per [Agent Skills file references](https://agentskills.io/specification#file-references)). Not expanded in this spec.

### 8.3 Risks

- **R1**: The contract is detailed enough that authoring a script is no longer trivial. Mitigation: `harness skill new` scaffolds a complete script template that already conforms; users edit the `result` payload structure rather than re-writing boilerplate. Templates ship with comprehensive `--help` and JSON-emit scaffolding.
- **R2**: Auto-generated tools scripts may not pass lints. Mitigation: doctor reports them with the audit metadata; `harness doctor --fix` adds executable bits and shebangs; the rest is flagged for manual review with a clear list of issues per script.
- **R3**: The `body-has-required-sections` lint may be too strict. Some skills are pure-content (research methodology) and don't have `## Available scripts`. Mitigation: the lint accepts at least *one* of the listed sections, not all; smoke-test against current defaults.
- **R4**: Existing user-installed third-party skills may not pass lints. Mitigation: lints run on `harness install` only at error-level for shipping defaults and freshly-installed content. For already-installed skills, doctor reports but doesn't block. Strict mode is opt-in via config.

## 9. Backward compatibility

Spec #1 + spec #2 already constituted breaking changes. Spec #3 doesn't add new structural breaks — it tightens content quality.

The new lints are non-breaking for existing harnesses (warnings, not errors) for one minor version. After 1.0.0, error-level lints can refuse loading non-conformant skills (override via `config.yaml: loader.lenient: true`).

## 10. Definition of done

- All contract, lint, and per-skill integration tests in §7 pass
- Every default skill in [defaults/skills/](../../defaults/skills/) passes `harness doctor` clean
- `harness skill new <name>` scaffolds a skill that passes `harness doctor` immediately
- `harness install <good-skill-fixture>` succeeds; `harness install <broken-skill-fixture>` fails with the right lint message
- Every script in default skills has `--help` documented per §4.1.4
- A worked end-to-end test demonstrates: model activates delegate-to-cli, calls `scripts/delegate.sh`, parses JSON, uses `next_steps` to recover from a simulated `CLI_VERSION_TOO_OLD` error
- README and skill-authoring guide updated
- `npm test` passes
- `npm run lint` passes
- Post-publish smoke test confirms `harness skill new test-skill` produces a clean skill, `harness skill validate test-skill` reports clean

---

*End of design.*
