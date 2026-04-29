# Evaluating skills

This is the canonical reference for skill evals in agent-harness. Use it to author trigger and quality eval coverage for any skill, refine descriptions and bodies against the eval signals, and gate promotion of agent-learned rules.

For the design rationale and the broader Agent Skills alignment series, see [docs/specs/2026-05-01-skill-evals-design.md](specs/2026-05-01-skill-evals-design.md). For overall skill authoring, see [skill-authoring.md](skill-authoring.md). The external [optimizing skill descriptions](https://agentskills.io/skill-creation/optimizing-descriptions) and [evaluating skill output quality](https://agentskills.io/skill-creation/evaluating-skills) guides are the upstream references; this document tracks how the harness implements them.

## Why evaluate skills

A skill has two failure modes that look similar to the user but are unrelated in cause:

1. **Trigger failures** — the model never invokes the skill on prompts where it should, or invokes it on prompts where it shouldn't. This is a description problem. The harness loads only `name + description` for every skill at boot (the discovery tier of progressive disclosure); when the model picks a skill it's pattern-matching the user's prompt against descriptions. A vague or misaligned description means the skill is dead even if the body is excellent.

2. **Output-quality failures** — the model invokes the skill on the right query, but the result is no better than what it would have produced without the skill loaded. This is a body and scripts problem. The instructions inside `SKILL.md`, the helper scripts in `scripts/`, and the reference material in `references/` together must produce measurably better output than no skill at all.

These two problems take different fixes — rewording the description, vs. rewriting the workflow or fixing a script — and require different evals. Skills can ship with one, the other, both, or neither. Most default skills ship with trigger evals; high-effort defaults also ship with quality evals.

## The trigger eval format

A trigger eval is a labeled set of representative user queries with a ground-truth answer for whether each one should activate the skill. Run the agent against each query in a clean session, observe whether `activate_skill` was called for the named skill, and compute pass rates.

The query set lives at `skills/<name>/evals/triggers.json` and follows this schema (see `src/runtime/evals/triggers-schema.ts`):

```json
[
  {
    "id": "research-explicit",
    "query": "I need to research the trade-offs between SQLite and Postgres for a side project. Can you find authoritative sources?",
    "should_trigger": true,
    "split": "train",
    "notes": "Explicit ask for sourced research."
  },
  {
    "id": "near-miss-data-cleaning",
    "query": "Can you clean up this CSV — drop blank rows and dedupe?",
    "should_trigger": false,
    "split": "validation"
  }
]
```

Required fields:

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable identifier (used in reports and logs) |
| `query` | string | Realistic user prompt, ≤500 chars |
| `should_trigger` | boolean | Ground truth — should this query invoke the skill? |
| `split` | `"train"` \| `"validation"` | Stable split for overfitting protection |

Optional:

| Field | Type | Notes |
|---|---|---|
| `notes` | string | Why this query is in the set, for human reviewers |

Aim for **20 queries per skill**: 10 should-trigger, 10 should-not-trigger, in a 60/40 train/validation split. The validation split is what `optimize-description` uses to pick the winning iteration — train queries are never used to choose the final description, only to identify failures and propose revisions.

### A well-designed trigger set

The `research` skill ships with this set (excerpt from `defaults/skills/research/evals/triggers.json`):

```json
[
  { "id": "research-train-1", "query": "Find authoritative sources comparing Postgres logical replication vs streaming for our setup", "should_trigger": true, "split": "train" },
  { "id": "research-train-3", "query": "Cross-reference the latest Next.js 15 release notes against the migration guide", "should_trigger": true, "split": "train" },
  { "id": "research-train-neg-2", "query": "Search the codebase for places we already implement retry logic", "should_trigger": false, "split": "train" },
  { "id": "research-train-neg-5", "query": "Summarize this Stack Overflow answer for me", "should_trigger": false, "split": "train" },
  { "id": "research-val-2", "query": "I want a confidence-leveled recommendation on Bun vs Node for production APIs, with citations", "should_trigger": true, "split": "validation" },
  { "id": "research-val-neg-4", "query": "Decide which library to use — I trust your gut, no need to verify", "should_trigger": false, "split": "validation" }
]
```

What makes this set good:

- **Realistic phrasing.** "Cross-reference the latest Next.js 15 release notes against the migration guide" is a sentence a developer actually types. Synthetic prompts that read like exam questions distort the trigger surface.
- **Varied tone.** Some queries are imperative ("Cross-reference..."), some declarative ("I want..."), some explicit about what's needed ("with citations"), some implicit. The model has to pattern-match across all of them.
- **Near-miss negatives.** "Search the codebase for places we already implement retry logic" shares the verb *search* with research queries but should not trigger — the right primitive is a code-search tool. "Decide which library to use — I trust your gut, no need to verify" actively rejects the research framing. These are the negatives that exercise the skill's *boundary*, not just its absence.
- **Stable IDs.** `research-train-1` / `research-val-neg-4` are diff-friendly, easy to reference in reports, and survive query edits.

### A poorly-designed trigger set

By contrast:

```json
[
  { "id": "q1", "query": "research", "should_trigger": true, "split": "train" },
  { "id": "q2", "query": "do research", "should_trigger": true, "split": "train" },
  { "id": "q3", "query": "research please", "should_trigger": true, "split": "train" },
  { "id": "q4", "query": "tell me about cats", "should_trigger": false, "split": "train" },
  { "id": "q5", "query": "what time is it", "should_trigger": false, "split": "validation" }
]
```

What's wrong:

- **The positives are degenerate.** "research" / "do research" / "research please" all match by surface keyword. The set has no signal about whether the description correctly distinguishes "research" (deep dig with sources) from "look something up" — they all read the same to a description-driven trigger.
- **The negatives are unrelated.** "Tell me about cats" and "what time is it" don't share any concept space with research. A description that triggers on these would be flagrantly broken; a description that doesn't proves nothing about how the skill behaves on the actual near-miss surface.
- **Too small for a 0.5 threshold to mean anything.** Five queries × 3 runs = 15 invocations. One stochastic miss is a 6.7% pass-rate swing.
- **No validation split.** Without holding queries out, the optimizer can't detect overfitting.

A useful trigger set has positives that *vary the language for the same intent* and negatives that *share keywords with positives but actually need a different skill*. Spending 30 minutes on a thoughtful 20-query set is a better investment than spending 5 minutes on 50 lazy queries.

## The quality eval format

A quality eval is a set of representative tasks with assertions describing what a good output looks like. The runner executes each task twice — once with the skill in the catalog, once with the skill explicitly excluded — saves both outputs, grades both against the assertions, and reports the delta.

The task set lives at `skills/<name>/evals/evals.json` and follows the [Agent Skills evals format](https://agentskills.io/skill-creation/evaluating-skills#designing-test-cases) verbatim:

```json
{
  "skill_name": "delegate-to-cli",
  "evals": [
    {
      "id": "delegate-codex-review",
      "prompt": "Review this Python file for security issues using Codex.",
      "expected_output": "A review report from Codex covering security concerns in the file.",
      "files": ["evals/files/sample.py"],
      "assertions": [
        "The output references Codex or codex-cli",
        "The output identifies at least one security concern",
        "The output is presented as a structured review"
      ]
    },
    {
      "id": "delegate-handles-missing-cli",
      "prompt": "Use foobar-cli to summarize this README.",
      "expected_output": "An error message or fallback that informs the user the requested CLI is not installed.",
      "files": ["evals/files/README.md"],
      "assertions": [
        "The output mentions foobar-cli is not available or installed",
        "The output is presented as a structured error or graceful fallback"
      ]
    }
  ]
}
```

Schema (see `src/runtime/evals/evals-schema.ts`):

| Field | Type | Notes |
|---|---|---|
| `skill_name` | string | Must match the bundle directory name |
| `evals` | array | Test cases; ≥1, typically 3–7 |
| `evals[].id` | string | Stable identifier |
| `evals[].prompt` | string | The user message that initiates the task |
| `evals[].expected_output` | string | Prose description of what success looks like (for human reviewers and the LLM judge) |
| `evals[].files` | string[] | Optional input files. Paths are relative to the skill bundle; copied into a temp working directory before each run |
| `evals[].assertions` | string[] | Statements that must hold on the agent's output. Each is graded individually (see Scoring methodology below) |

Input files referenced by `files` live in `skills/<name>/evals/files/` and are copied into a fresh per-run working directory. The agent runs against the working directory; nothing it writes pollutes the source bundle.

### A worked example: `delegate-to-cli`

The full task set is at `defaults/skills/delegate-to-cli/evals/evals.json`. Three test cases:

1. **`delegate-codex-review`** — exercises the happy path of dispatching a code review to Codex.
2. **`delegate-claude-second-opinion`** — exercises a different CLI choice, with an assertion that the response takes a clear stance (a quality assertion the LLM judge has to evaluate).
3. **`delegate-handles-missing-cli`** — exercises the failure mode where the requested CLI isn't installed. The assertions check that the error is *informative*, not just present.

The mix matters. A quality eval that only exercises the happy path measures whether the skill does its primary job; a quality eval that includes failure modes measures whether the skill's output is *useful* across the surface area the user actually encounters.

## CLI reference

Four eval-related commands plus the rule promotion command. All are subcommands of `harness skill` (or `harness rules` for promotion).

### `harness skill eval-triggers <name>`

Runs the trigger eval against `skills/<name>/evals/triggers.json` and prints per-query pass/fail.

**Flags:**

| Flag | Default | Notes |
|---|---|---|
| `--runs <n>` | `3` | Independent runs per query. Higher is more stable, more expensive. |
| `--split <split>` | `all` | `train` \| `validation` \| `all` |
| `--harness <dir>` | `process.cwd()` | Harness directory |

**Example:**

```bash
$ harness skill eval-triggers research

Skill: research
Split: all
Runs/query: 3

Results:
  [PASS] research-train-1 (should trigger): 1.00
  [PASS] research-train-2 (should trigger): 1.00
  [FAIL] research-train-neg-2 (should NOT trigger): 0.67
  ...

Summary: 18/20 passed (90.0%)
```

**Exit code:** `0` if all queries passed, `1` if any failed.

A query passes when:
- `should_trigger=true` and `trigger_rate >= 0.5`
- `should_trigger=false` and `trigger_rate < 0.5`

The 0.5 threshold is mid-point: a should-trigger query passes if the model triggers on a majority of runs.

### `harness skill eval-quality <name>`

Runs the quality eval against `skills/<name>/evals/evals.json`. Each test case is run twice — with the skill, then with the skill explicitly excluded from the catalog — and graded against the assertions.

**Flags:**

| Flag | Default | Notes |
|---|---|---|
| `--baseline <kind>` | `none` | `none` (skill excluded) \| `previous` (snapshot of previous skill version) |
| `--harness <dir>` | `process.cwd()` | Harness directory |

The runner defaults to **1 run per case** to keep cost bounded. Multi-run averaging is reserved for cases where you need stability over noise; the framework supports it but the CLI does not currently expose a `--runs` flag for quality eval.

**Example:**

```bash
$ harness skill eval-quality delegate-to-cli

Skill: delegate-to-cli
Iteration: iteration-1
Baseline: none

with_skill   pass_rate=0.83 tokens=3812 duration_ms=45100
without_skill pass_rate=0.33 tokens=2104 duration_ms=32400

delta: pass_rate=0.50 tokens=1708 duration_ms=12700
```

The delta is the answer to "did this skill help?" — positive `pass_rate` delta means the skill produced measurably better output than no skill. Tokens and duration deltas are typically positive too (skills add overhead); the question is whether the quality improvement justifies the cost.

### `harness skill optimize-description <name>`

Iteratively refines `description` in SKILL.md against the trigger set. On each iteration, runs the trigger eval on train+validation, identifies failing train queries, prompts the `summary_model` to propose a revised description, and re-runs the eval. Picks the iteration with the highest *validation* pass rate (not necessarily the latest), then writes that description to SKILL.md.

**Flags:**

| Flag | Default | Notes |
|---|---|---|
| `--max-iterations <n>` | `5` | Per the optimizing-descriptions guide |
| `--runs <n>` | `3` | Runs per query inside each iteration |
| `--dry-run` | off | Compute the best description but do not modify SKILL.md |
| `--harness <dir>` | `process.cwd()` | Harness directory |

**Example:**

```bash
$ harness skill optimize-description research --max-iterations 3

Best iteration: 2
  validation pass_rate: 0.95
  description: Use this when the user asks for sourced research, primary-source verification, or cross-referenced recommendations. Never use this when the user wants codebase search, opinion, or quick lookups.

History (validation pass_rate by iteration):
  iter 0: 0.75
  iter 1: 0.85
  iter 2: 0.95
  iter 3: 0.90

Applied to SKILL.md.
```

The iteration with the highest validation pass rate wins, even if a later iteration scored higher on training. This protects against overfitting to specific train queries.

### `harness skill optimize-quality <name>`

Iteratively refines the SKILL.md body against the quality eval signals. On each iteration, runs `eval-quality`, identifies failing assertions and low-quality outputs, prompts the `summary_model` to propose body changes, and (with user approval) writes them.

**Flags:**

| Flag | Default | Notes |
|---|---|---|
| `--max-iterations <n>` | `3` | Body changes are higher-stakes than description changes |
| `--auto-approve` | off | Apply each iteration without prompting |
| `--harness <dir>` | `process.cwd()` | Harness directory |

This command is more invasive than `optimize-description` because the proposer can rewrite `## Workflow`, `## Gotchas`, and other sections — not just the description. By default the user confirms each iteration's change before it's written.

## Workspace layout

Eval results live outside the skill bundle so they don't pollute source. Workspace path: `<harness-dir>/.evals-workspace/<skill-name>/`.

```
.evals-workspace/
└── research/
    ├── triggers/
    │   └── 2026-05-04T18-30-21Z.json
    └── quality/
        ├── iteration-1/
        │   ├── eval-top-months-chart/
        │   │   ├── with_skill/
        │   │   │   ├── outputs/         # files the agent wrote
        │   │   │   ├── timing.json      # { total_tokens, duration_ms }
        │   │   │   └── grading.json     # per-assertion verdicts
        │   │   └── without_skill/
        │   │       ├── outputs/
        │   │       ├── timing.json
        │   │       └── grading.json
        │   └── benchmark.json           # aggregated stats + delta
        └── iteration-2/
            └── ...
```

The harness adds `.evals-workspace/` to the harness's `.gitignore` on first eval run so committed history stays clean. See `src/runtime/evals/workspace.ts` for the path resolution and gitignore logic.

Each `triggers/<timestamp>.json` is a complete report — easy to grep across runs for regression-tracking. Each quality `iteration-N/` is a self-contained snapshot of one optimization step, including raw outputs, so you can re-grade or human-review later without re-running the agent.

## Scoring methodology

### Trigger eval scoring

Per-query: `trigger_rate = trigger_count / runs`. Pass/fail thresholds:

| `should_trigger` | Trigger rate | Verdict |
|---|---|---|
| `true` | `>= 0.5` | pass |
| `true` | `< 0.5` | fail |
| `false` | `< 0.5` | pass |
| `false` | `>= 0.5` | fail |

Per-split: `pass_rate = passed_queries / total_queries`. The CLI exits non-zero if any query fails.

The 0.5 threshold is the upstream guidance from the [optimizing descriptions guide](https://agentskills.io/skill-creation/optimizing-descriptions). It's permissive — a skill that triggers 50% of the time on intended queries is far from production-quality. Use the per-query report to find your weakest queries; aggregate pass rate alone hides them.

### Quality eval scoring

Each assertion is graded by one of two paths (see `src/runtime/evals/grading.ts`):

1. **Mechanical grading.** If the assertion matches a known code-checkable pattern, it's evaluated mechanically without an LLM call. Patterns currently recognized:
   - File-existence assertions (e.g. *"the output includes a file named `chart.png`"*) — checked via `existsSync`.
   - Valid-JSON assertions (e.g. *"`output.json` is valid JSON"*) — checked via `JSON.parse`.
   Mechanical grading is deterministic, free, and is preferred wherever it applies.

2. **LLM judge fallback.** If no mechanical pattern matches, the assertion is sent to the `summary_model` along with the contents of the output directory. The judge replies with `{ "passed": bool, "evidence": "1-sentence reason" }`. The judge prompt is fixed in `buildLiveLlmGrader`.

Per-case: `pass_rate = passed_assertions / total_assertions`. Per-skill: `pass_rate.mean = mean across cases × runs`.

The benchmark report includes both `with_skill` and `without_skill` aggregates and the `delta` (the `with_skill - without_skill` difference for each metric). A positive `delta.pass_rate` is the load-bearing signal — it's what `optimize-quality` drives, and it's the gate for rule promotion (see below).

**Authoring tip: prefer mechanical assertions.** "The output includes a file named `report.md`" runs in microseconds and is deterministic. "The report is well-structured and addresses all three sub-questions" requires an LLM call per run, costs tokens, and has noise. Use prose assertions for genuinely-prose properties; use mechanical assertions for everything else.

## The promotion gate

`harness rules promote <candidate-id>` is the bridge between the journal-synthesis loop (`harness learn`) and rules that actually enter the agent's always-loaded context. It runs both eval families against the candidate before installing it.

```bash
harness rules promote retry-with-backoff
```

Algorithm (see `src/runtime/promote-rule.ts`):

1. Load the candidate via `loadCandidateById`.
2. Generate a small trigger-eval query set (~6 queries) from the candidate's behavior text and the sessions that proposed it. The `summary_model` writes the queries; today the user does not edit them inline (a future iteration will surface them for review).
3. Run the trigger eval. If `pass_rate < 0.5`, the candidate is rejected with reason `trigger eval pass_rate <X> below threshold 0.5`.
4. Run the quality eval. If `delta.pass_rate <= 0`, the candidate is rejected with reason `no measurable improvement (delta pass_rate=<X>)`.
5. Otherwise, write `rules/<candidate-id>.md` with the candidate's behavior, full provenance, `author: agent`, and `status: active`.

If both gates pass, the rule lands on disk and enters the system prompt on the next run.

### `--no-eval-gate`

Power-user bypass:

```bash
harness rules promote retry-with-backoff --no-eval-gate
```

This skips both gates and writes the rule unconditionally. Use it when:

- You're iterating on the eval framework itself and need to install a known-good rule without spinning the gate.
- The candidate is for a domain where the harness's quality-eval signals genuinely don't apply (e.g. a stylistic rule whose effect is qualitative).
- You're scripting a bulk migration of legacy rules.

Default behavior (gate active) is the safe default. `--no-eval-gate` flips to the pre-evals behavior.

> **Known limitation (v0.12.0).** The live promotion gate's `runTriggerEval` and `runQualityEval` functions in `buildLiveRulePromoter` (see `src/runtime/evals/agent-runner.ts`) currently return optimistic constants. The framework is in place — query generation works, the gate flow runs, the rule file gets written — but the actual eval execution of the candidate against the agent is stubbed. In practice this means the gate accepts most candidates today. The stub will be replaced with a real with-vs-without-rule eval run in a future release; track via [docs/specs/2026-05-01-skill-evals-design.md](specs/2026-05-01-skill-evals-design.md) §4.6.

## Cost and runtime expectations

Eval runs invoke the configured LLM provider, so they cost what your provider charges per token plus wall-clock time per call. Order-of-magnitude expectations:

### Trigger eval

- **One run** = one agent.generate() call against a query, with `activate_skill` as the only tool. Returns when the model emits final text or hits `maxToolSteps=5`.
- **Default cost:** 20 queries × 3 runs = **60 calls per `eval-triggers`**.
- **Default wall time:** 3–10 minutes against a hosted Sonnet-class model; longer against Ollama on CPU.
- **Mitigation:** drop `--runs 1` for fast iteration during description authoring; run `--runs 3` (or `--runs 5`) only on milestone checkpoints. The 0.5 threshold means single-run signals are noisy; trust them only for fast triage.

### Quality eval

- **One case** = two agent.generate() calls (with-skill, without-skill), each with the full toolset, plus N LLM-judge calls (one per non-mechanical assertion).
- **Default cost** for a 3-case skill with 3 assertions per case (1 mechanical, 2 LLM-graded on average): 2 generates + 4 judge calls = **~6 LLM calls per case × 3 cases = 18 calls per `eval-quality`**.
- **Default wall time:** 5–20 minutes against a hosted model.
- **Default `runs` is 1** for cost reasons. The framework supports multi-run averaging, but the CLI doesn't expose a flag yet — multi-run is reserved for cases where output noise is the dominant signal.

### Optimization loops

`optimize-description` runs `eval-triggers` once per iteration up to `--max-iterations`. With defaults (5 iterations × 60 calls per run): **up to 300 LLM calls per `optimize-description`**. Plus one `summary_model` call per iteration to propose the new description (5 calls). Mostly bounded by the trigger eval cost.

`optimize-quality` runs `eval-quality` once per iteration up to `--max-iterations` (default 3). With the example above: **up to 54 quality-eval calls + 3 body-proposal calls per `optimize-quality`**. The body proposal is one call against `summary_model` per iteration; the bulk is the quality-eval cost.

### Recommended config

For affordable optimization runs, set `model.summary_model` to a cheap, fast model:

```yaml
# config.yaml
model:
  provider: openrouter
  id: anthropic/claude-sonnet-4
  summary_model: anthropic/claude-haiku-4
```

`summary_model` is what:

- The LLM judge uses to grade assertions.
- The description proposer uses to generate revisions.
- The body proposer uses to rewrite SKILL.md.
- The candidate-rule query generator uses for promotion-gate query sets.

With Haiku-class for `summary_model` and Sonnet-class for the primary, optimization-run cost drops substantially. For local-only runs, point both at an Ollama model that runs comfortably on your hardware (`harness hardware` suggests tiers).

## Authoring guidance

### Writing good trigger queries

- **Vary the language for the same intent.** If three of your should-trigger queries all start with "Research X", you're testing whether the description matches the word *research*, not whether it captures the intent. Mix imperative ("Find sources on..."), declarative ("I want a recommendation on..."), question-form ("What do the official docs say about..."), and contextual ("In the latest release notes...").
- **Make the negatives near-misses.** A negative that shares no concept space with the skill is wasted budget. The most useful negatives are prompts that *share keywords or framing* with positives but actually need a different skill (or no skill). For `research`: "search the codebase" shares the verb *search*; "I trust your gut" actively rejects the verification framing.
- **Stay under ~500 chars per query.** Long queries blow out the trigger surface and make per-run cost balloon.
- **Use stable IDs.** `<skill>-<split>-<n>` is a good convention. Avoid IDs that embed query content — you'll edit the query and the ID becomes a lie.
- **Add `notes` for non-obvious cases.** When future-you (or a reviewer) asks "why is this a positive?", a one-line note saves a 10-minute argument.
- **Keep the train/validation split balanced.** 60/40 is the upstream guidance. Don't put all your hard cases in one split.

### Writing good quality test cases

- **Mix mechanical and prose assertions.** Mechanical assertions ("the output file `report.md` exists") are fast and deterministic. Prose assertions ("the report identifies at least one security concern") need the LLM judge but capture quality the file system can't see. A test case with 4 assertions, 2 mechanical and 2 prose, is a strong default shape.
- **Make assertions independent.** Each assertion is graded individually; they shouldn't depend on each other. "If the report exists, then it has 3 sections" is two assertions, not one.
- **Be specific.** "The output is good" is unjudgeable. "The chart shows exactly 3 months" is judgeable. "The chart's y-axis is labeled with currency units" is judgeable. Prefer the specific.
- **Cover failure modes too.** A quality eval that only tests the happy path measures whether the skill works when everything is right. A quality eval that includes failure-mode test cases (the requested CLI is missing, the input file is malformed) measures whether the skill is *useful* across the surface area users actually hit.
- **Keep `expected_output` short.** It's prose for human reviewers and a hint for the LLM judge — not a contract. The contract is the assertions array.
- **Bundle small input files.** Files referenced by `evals[].files` live under `evals/files/` and ship with the skill. Keep them small enough that the bundle stays focused; large fixtures belong elsewhere.

### Iteration cadence

A reasonable workflow for a new skill:

1. **Author the skill body and a starter `triggers.json`** (10–12 queries; expand later). Run `harness skill eval-triggers <name> --runs 1` for a first signal.
2. **Run `harness skill optimize-description <name> --max-iterations 3`** to refine. Check that validation pass rate is > 0.85 before shipping.
3. **For high-effort skills, author `evals.json` with 3–5 cases.** Run `harness skill eval-quality <name>` and confirm `delta.pass_rate > 0`.
4. **For dialed-in skills,** run `harness skill optimize-quality <name>` to refine the body.
5. **Re-run trigger eval before each release** to catch regressions in the description.

For default skills, CI asserts `pass_rate > 0.85` on the validation split; treat that as the floor for any skill you ship to others.

## Limitations and known issues

This section tracks where the eval system is still maturing. Some of these are deliberate scope cuts; others are known gaps that will close in future releases.

- **The promotion gate's eval execution is stubbed (v0.12.0).** `buildLiveRulePromoter`'s `runTriggerEval` and `runQualityEval` return optimistic constants — the rule eventually gets written, the trigger query set gets generated, but the actual measurement of agent behavior with vs. without the candidate rule is not yet implemented. Effective behavior: the gate accepts most candidates. Use `--no-eval-gate` if you want to make this explicit; otherwise, treat the gate as advisory until the stub is replaced. Tracked in [docs/specs/2026-05-01-skill-evals-design.md](specs/2026-05-01-skill-evals-design.md) §4.6.

- **CI does not run real evals.** The CI pipeline validates eval *schemas* (does `triggers.json` parse, does `evals.json` conform) but does not execute them — running real LLM calls against every default skill on every PR is too expensive for the public runner budget. The validation-pass-rate floor in the spec (`> 0.85`) is enforced locally before release, not on every commit.

- **Quality eval defaults to `runs=1`.** The framework supports multi-run averaging, but the CLI does not currently expose a `--runs` flag for `eval-quality`. Cost was the trade-off; revisit when budgets allow.

- **The LLM judge has nonzero error rate.** Even with `summary_model` set to a good grader, prose assertions have a noise floor. Mitigation: prefer mechanical assertions where the property is mechanical; spot-check `grading.json` outputs for plausibility on important runs; treat single-iteration verdicts on prose assertions as suggestive, not authoritative.

- **The grader and the production agent may share biases.** When the grader and the agent come from the same model family, a rule the grader thinks helps may not actually help. For high-stakes promotions, consider configuring a `summary_model` from a different family than the primary `model.id`.

- **Optimization loops can plateau.** If `optimize-description` converges to validation pass rate < 0.85 across multiple runs with different seeds, the description is probably hitting an upper bound — the trigger query set may be too hard, the skill's intent may overlap another skill, or the description may need restructuring beyond what the proposer can suggest. At that point, hand-author.

- **No cross-user eval result sharing.** By design — eval queries can contain personal context. Eval results stay local in `.evals-workspace/`.

- **Evals are authoring-time, not runtime.** This system measures skills before they ship; it does not observe production activations or feed real-traffic signals back into rule promotion. Continuous evaluation on real traffic is a separate concern and not in scope here.

## See also

- [Skill authoring guide](skill-authoring.md) — overall structure of `SKILL.md`, frontmatter, scripts, lifecycle triggers
- [Skill evals design spec](specs/2026-05-01-skill-evals-design.md) — design rationale, trade-offs, phase plan
- [Optimizing skill descriptions](https://agentskills.io/skill-creation/optimizing-descriptions) — upstream guidance on trigger eval design
- [Evaluating skill output quality](https://agentskills.io/skill-creation/evaluating-skills) — upstream guidance on quality eval design
- [Agent Skills specification](https://agentskills.io/specification) — the format that makes any of this portable
