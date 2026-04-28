# Skill evals — design

**Date:** 2026-05-01
**Status:** Draft (pending review)
**Spec:** 4 of 5 in the Agent Skills alignment series
**Depends on:** 1, 2, 3
**Related specs:**
- 5 of 5 — `2026-05-02-provider-integration-design.md`

## 1. Goal

Build an in-harness eval system that can answer two questions about every skill:

1. **Does the skill trigger reliably?** Given a representative set of user prompts, does the model pick this skill when it should and skip it when it shouldn't? — based on [Optimizing skill descriptions](https://agentskills.io/skill-creation/optimizing-descriptions).

2. **Does the skill produce better output than no skill?** Given a representative set of tasks, does the model with this skill loaded produce better results than the model without it? — based on [Evaluating skill output quality](https://agentskills.io/skill-creation/evaluating-skills).

Make this part of the routine authoring loop (not a power-user feature) so that every default skill ships with eval coverage and every user-authored skill has an obvious path to validation. Auto-promotion of agent-learned rules (the renamed instinct flow) goes through eval gating before becoming active.

## 2. Non-goals

- Skill marketplace ratings, public eval leaderboards, or eval result sharing across users (privacy-sensitive; out of scope).
- Provider integration / `harness export` — spec #5.
- Prompt engineering for IDENTITY.md or rules. Evals here are scoped to skills, where the spec's progressive disclosure makes triggering measurable.
- Continuous evaluation in production (running evals on real user traffic). Evals are an authoring-time tool here. Ongoing telemetry on real activations is a separate concern, not in this design.

## 3. Background

### 3.1 The two eval problems are different

**Trigger eval** is about the *description*. The harness loads `name`+`description` for every skill at boot ([spec #2 §4.3.2](2026-04-29-primitive-collapse-design.md#432-skill-catalog)). When the model picks which skill to invoke (or none), it's pattern-matching the user's prompt against descriptions. A poorly-worded description means the skill never triggers when it should, or triggers when it shouldn't.

The fix is iterative: write candidate descriptions, run them against a labeled query set, measure trigger rate, refine. The [optimizing descriptions guide](https://agentskills.io/skill-creation/optimizing-descriptions) prescribes the exact protocol — 20 queries (mix of should-trigger and should-not-trigger), 3 runs each, 0.5 trigger-rate threshold, 60/40 train/validation split, ≤5 revision iterations.

**Quality eval** is about the *body and scripts*. Once the skill is activated, does it lead to better task output than the model would produce without it? You measure this by running the same task with-skill and without-skill, grading both outputs against assertions, and comparing pass rates and resource cost.

The [evaluating skills guide](https://agentskills.io/skill-creation/evaluating-skills) prescribes evals/evals.json with prompts + expected_output + assertions, separate workspace directories per iteration, blind comparison for holistic quality, and aggregated benchmark.json statistics.

### 3.2 What we have today

Nothing. agent-harness has no eval infrastructure. The closest thing is the journal synthesis loop, which does pattern detection on past sessions but doesn't measure quality against a benchmark.

The reference [skill-creator skill](https://github.com/anthropics/skills/tree/main/skills/skill-creator) automates much of this for Anthropic's Skills tooling. We can borrow the patterns but the runner has to integrate with our harness model.

## 4. Design

### 4.1 evals/ directory layout

The Agent Skills [evaluating skills guide](https://agentskills.io/skill-creation/evaluating-skills#workspace-structure) defines this. We adopt verbatim, with one addition (`triggers.json` for trigger evals).

Inside any skill bundle:

```
skills/<name>/
├── SKILL.md
├── scripts/
├── references/
├── assets/
└── evals/                       # NEW
    ├── triggers.json            # query set for description trigger eval
    ├── evals.json               # task set for output quality eval
    ├── files/                   # optional input files referenced by tasks
    └── (workspace lives outside the bundle — see §4.3)
```

A skill MAY have `evals/triggers.json` only, `evals/evals.json` only, both, or neither. Doctor lints warn when defaults skills lack evals but doesn't error.

#### 4.1.1 `triggers.json` schema

```json
[
  {
    "id": "research-explicit",
    "query": "I need to research the trade-offs between SQLite and Postgres for a side project. Can you find authoritative sources?",
    "should_trigger": true,
    "split": "train"
  },
  {
    "id": "near-miss-data-cleaning",
    "query": "Can you clean up this CSV — drop blank rows and dedupe?",
    "should_trigger": false,
    "split": "validation"
  }
]
```

Fields:

| Field | Required | Type | Notes |
|---|---|---|---|
| `id` | yes | string | Stable identifier |
| `query` | yes | string | A realistic user prompt, ≤500 chars |
| `should_trigger` | yes | boolean | Ground truth |
| `split` | yes | `"train" \| "validation"` | Stable split for overfitting protection |
| `notes` | no | string | Why this query is in the set (for human reviewers) |

Aim for 20 queries per skill (10 should-trigger, 10 should-not-trigger), 60/40 train/validation. Per the [guidance](https://agentskills.io/skill-creation/optimizing-descriptions#designing-trigger-eval-queries), the most useful negatives are *near-misses* — prompts that share keywords or concepts but actually need a different skill or no skill at all.

#### 4.1.2 `evals.json` schema

Mirrors the [Agent Skills evals format](https://agentskills.io/skill-creation/evaluating-skills#designing-test-cases) verbatim:

```json
{
  "skill_name": "csv-analyzer",
  "evals": [
    {
      "id": "top-months-chart",
      "prompt": "I have monthly sales data in data/sales_2025.csv. Find top 3 months by revenue and make a bar chart.",
      "expected_output": "A bar chart image showing top 3 months by revenue, with labeled axes and values.",
      "files": ["evals/files/sales_2025.csv"],
      "assertions": [
        "The output includes a bar chart image file",
        "The chart shows exactly 3 months",
        "Both axes are labeled",
        "The chart title or caption mentions revenue"
      ]
    }
  ]
}
```

We adopt the schema literally so any existing tooling that consumes `evals.json` (skill-creator, third-party validators) interoperates.

### 4.2 Eval runner

A new harness module [src/runtime/evals.ts](../../src/runtime/evals.ts) plus CLI commands.

#### 4.2.1 Trigger eval flow

```
harness skill eval-triggers <name> [--runs=3] [--split=train|validation|all]
```

Algorithm:

1. Load the skill's `evals/triggers.json`.
2. For each query in the requested split:
   1. Run `<RUNS>` independent agent.generate() invocations, each in a clean session (no carryover history).
   2. For each invocation, observe whether the model called `activate_skill` with this skill's name within the run.
   3. Compute `trigger_rate = trigger_count / RUNS`.
3. Determine pass/fail: a should_trigger query passes if `trigger_rate >= 0.5`; a should_not_trigger query passes if `trigger_rate < 0.5`.
4. Aggregate: `pass_rate = passed_queries / total_queries` per split.
5. Write report to `evals-workspace/<skill-name>/triggers/<timestamp>.json`.

Output shape:

```json
{
  "skill": "research",
  "split": "train",
  "runs_per_query": 3,
  "results": [
    { "id": "research-explicit", "should_trigger": true, "trigger_count": 3, "trigger_rate": 1.0, "passed": true },
    ...
  ],
  "summary": { "passed": 11, "failed": 1, "total": 12, "pass_rate": 0.917 }
}
```

#### 4.2.2 Quality eval flow

```
harness skill eval-quality <name> [--baseline=none|previous|<path>] [--runs=1]
```

Algorithm:

1. Load `evals/evals.json`.
2. For each test case:
   1. Run with-skill: `agent.generate()` with the skill catalog including this skill, prompt set to the test prompt, input files copied to a temp working directory.
   2. Run baseline: same prompt, same files, but skill catalog *excludes* this skill (or uses the previous version's snapshot if `--baseline=previous`).
   3. Save outputs (any files written by the agent) and a `timing.json` with `{ total_tokens, duration_ms }`.
3. Grade each output against the assertions:
   1. For each assertion, prompt a small grader model (`config.model.summary_model` or `fast_model`) to evaluate `passed: bool` + `evidence: string` based on the actual output files.
   2. For mechanical assertions (file exists, valid JSON, exact count), prefer code-based verification over LLM grading.
   3. Save `grading.json` per run.
4. Aggregate to `benchmark.json`:

```json
{
  "skill": "csv-analyzer",
  "iteration": "iteration-1",
  "baseline": "none",
  "with_skill": { "pass_rate": { "mean": 0.83 }, "tokens": { "mean": 3800 }, "duration_ms": { "mean": 45000 } },
  "without_skill": { "pass_rate": { "mean": 0.33 }, "tokens": { "mean": 2100 }, "duration_ms": { "mean": 32000 } },
  "delta": { "pass_rate": 0.50, "tokens": 1700, "duration_ms": 13000 }
}
```

5. Print a summary; full reports stay in the workspace.

#### 4.2.3 Workspace layout

Outside the skill bundle (so eval results don't pollute the bundle's source tree):

```
<harness-dir>/.evals-workspace/
└── <skill-name>/
    ├── triggers/
    │   └── <timestamp>.json
    └── quality/
        ├── iteration-1/
        │   ├── eval-top-months-chart/
        │   │   ├── with_skill/
        │   │   │   ├── outputs/
        │   │   │   ├── timing.json
        │   │   │   └── grading.json
        │   │   └── without_skill/
        │   │       ├── outputs/
        │   │       ├── timing.json
        │   │       └── grading.json
        │   └── benchmark.json
        └── iteration-2/
            └── ...
```

`.evals-workspace/` is gitignored by default (the harness writes a `.gitignore` entry on first eval run if not already present).

### 4.3 Description optimization workflow

A higher-level command that wraps trigger evals:

```
harness skill optimize-description <name> [--max-iterations=5]
```

Implements the [optimization loop](https://agentskills.io/skill-creation/optimizing-descriptions#the-optimization-loop):

1. Run trigger eval on the train+validation set with the current description.
2. Record train pass rate and validation pass rate.
3. If train pass rate is 1.0, exit (no failures to fix).
4. Identify failures in the train set only.
5. Use the `summary_model` to propose a revised description, given:
   - Current SKILL.md
   - List of failing train queries with their pass/fail status
   - Generic guidelines (imperative phrasing, pushy, focus on intent)
6. Update the description in SKILL.md (in a temporary copy or by branch).
7. Re-run train+validation eval.
8. Repeat steps 3–7 up to `max-iterations` times.
9. Select the iteration with the highest *validation* pass rate (not necessarily the latest).
10. Apply the selected description to SKILL.md, prompt user for confirmation before writing.
11. Save full optimization log to workspace.

The user may abort at any iteration. The command is destructive in that it modifies SKILL.md on success — `--dry-run` mode prints the proposed final description without writing.

### 4.4 Quality eval iteration workflow

Mirrors the [iterating-on-the-skill loop](https://agentskills.io/skill-creation/evaluating-skills#iterating-on-the-skill):

```
harness skill optimize-quality <name> [--max-iterations=3]
```

Algorithm:

1. Snapshot the skill's current state to `.evals-workspace/<name>/quality/iteration-N/skill-snapshot/`.
2. Run quality eval with `--baseline=previous` (against the snapshot, not no-skill).
3. Identify failed assertions, low-quality outputs (via human-review prompt or LLM judge).
4. Use the `summary_model` to propose changes to SKILL.md (and hint at script changes), given the eval signals.
5. Apply proposed SKILL.md changes (with user approval).
6. Repeat.

This command is more invasive than `optimize-description` because it can suggest edits to `## Workflow` sections, `## Gotchas`, etc. — not just the description. User confirmation is required before each iteration's apply.

### 4.5 Default-skill eval coverage

Every default skill in [defaults/skills/](../../defaults/skills/) ships with `evals/triggers.json` (~20 queries). High-effort skills (delegate-to-cli, daily-reflection, ship-feature) also ship with `evals/evals.json` with at least 3 test cases.

The CI build runs `harness skill eval-triggers --split=validation` on every default skill and asserts validation pass rate > 0.85. A regression below that threshold blocks the release.

The four superpowers skills vendored in spec #1 may not arrive with evals. Phase 22 of this spec authors trigger evals for each.

### 4.6 Auto-promotion gate for learned rules

In spec #2, "instincts" became "rules with `author: agent`." The journal synthesis loop ([src/runtime/instinct-learner.ts](../../src/runtime/instinct-learner.ts)) proposes rule candidates from session patterns. Today these can be auto-installed (`harness learn --install`).

After this spec lands: auto-installation is gated on eval. Specifically, before promoting a candidate rule:

1. Generate a small trigger-eval query set for the rule (~6 queries) using the `summary_model` based on the rule's text and the sessions that proposed it.
2. The user reviews the generated queries (CLI prompt) and accepts/edits.
3. Run a quality eval comparing the agent with the rule loaded vs. without (using past similar tasks from sessions as the test set).
4. Promote only if the rule shows a positive delta in pass rate AND the trigger eval shows it doesn't fire on irrelevant queries.

This addresses the "auto-installed instincts" concern raised in the user's CLAUDE.md (the original Edith concern). Rules don't enter the agent's always-loaded context without measured benefit.

`--no-eval-gate` flag bypasses for power users.

### 4.7 New CLI commands

| Command | Purpose |
|---|---|
| `harness skill eval-triggers <name> [--split=...]` | Trigger eval (§4.2.1) |
| `harness skill eval-quality <name> [--baseline=...]` | Quality eval (§4.2.2) |
| `harness skill optimize-description <name> [--max-iterations=N]` | Description optimization loop (§4.3) |
| `harness skill optimize-quality <name>` | Body/script optimization loop (§4.4) |
| `harness rules promote <candidate-id>` | Promote a learned rule with eval gate (§4.6) |
| `harness rules promote <id> --no-eval-gate` | Bypass for power users |

The existing `harness learn --install` is changed to invoke `harness rules promote` per candidate, applying the gate by default.

## 5. Behavior changes (user-visible)

| Before | After |
|---|---|
| No way to measure if a skill triggers reliably | `harness skill eval-triggers <name>` returns trigger pass rate per query |
| No way to compare skill output quality to baseline | `harness skill eval-quality <name>` returns with-vs-without delta |
| Description tuning is manual | `harness skill optimize-description <name>` runs the iteration loop |
| Auto-installed instincts (now learned rules) land directly | Promotion is gated on eval; user can override |
| Default skills have no eval coverage | All defaults ship with `evals/triggers.json`; high-effort defaults also have `evals/evals.json` |

## 6. Implementation plan

Phase numbers continue from spec #3.

### Phase 20: Eval runner core

| # | File | Change |
|---|---|---|
| 20.1 | [src/runtime/evals/triggers.ts](../../src/runtime/evals/triggers.ts) (new) | Trigger eval runner: load triggers.json, parallel-run agent.generate per query×runs, observe activate_skill calls, compute trigger rates |
| 20.2 | [src/runtime/evals/quality.ts](../../src/runtime/evals/quality.ts) (new) | Quality eval runner: with-skill vs baseline, save outputs+timing, grade via summary_model or code, write benchmark.json |
| 20.3 | [src/runtime/evals/grading.ts](../../src/runtime/evals/grading.ts) (new) | Assertion grader: code-checks first (file exists, valid JSON, regex match), LLM-judge fallback for prose-style assertions |
| 20.4 | [src/runtime/evals/workspace.ts](../../src/runtime/evals/workspace.ts) (new) | Workspace path resolution, gitignore management, iteration management |

### Phase 21: Optimization loops

| # | File | Change |
|---|---|---|
| 21.1 | [src/runtime/evals/optimize-description.ts](../../src/runtime/evals/optimize-description.ts) (new) | Description optimization loop per §4.3 |
| 21.2 | [src/runtime/evals/optimize-quality.ts](../../src/runtime/evals/optimize-quality.ts) (new) | Quality optimization loop per §4.4 |
| 21.3 | [src/cli/index.ts](../../src/cli/index.ts) | Register the four new `harness skill eval-*` / `optimize-*` commands |

### Phase 22: Default eval authoring

| # | Skill | Effort |
|---|---|---|
| 22.1 | Author `evals/triggers.json` for every default skill | medium |
| 22.2 | Author `evals/evals.json` for delegate-to-cli, daily-reflection, ship-feature | medium |
| 22.3 | Author `evals/triggers.json` for the 4 vendored superpowers skills | medium |
| 22.4 | CI integration: assert validation trigger pass rate > 0.85 on every default skill before release | low |

### Phase 23: Promotion gate

| # | File | Change |
|---|---|---|
| 23.1 | [src/runtime/instinct-learner.ts](../../src/runtime/instinct-learner.ts) | Rename throughout to reflect rules-not-instincts (cosmetic, post-spec-2) |
| 23.2 | [src/runtime/promote-rule.ts](../../src/runtime/promote-rule.ts) (new) | Rule promotion with eval gate per §4.6 |
| 23.3 | [src/cli/index.ts](../../src/cli/index.ts) | `harness rules promote` command + `--no-eval-gate` flag |
| 23.4 | [src/cli/index.ts](../../src/cli/index.ts) | Update `harness learn --install` to call promotion gate |

### Phase 24: Documentation

| # | File | Change |
|---|---|---|
| 24.1 | [docs/skill-authoring.md](../../docs/skill-authoring.md) | New section on writing evals |
| 24.2 | [docs/skill-evals.md](../../docs/skill-evals.md) (new) | Detailed reference on trigger and quality eval format, scoring, workspace layout |
| 24.3 | [README.md](../../README.md) | New "Evaluating skills" section with the two CLI commands |

## 7. Tests

### 7.1 Trigger eval

| Test | Asserts |
|---|---|
| `triggers — schema validates` | Valid triggers.json parses; invalid ones (missing fields, bad split) rejected |
| `triggers — runner executes runs in clean sessions` | Each invocation has empty conversation history |
| `triggers — observes activate_skill correctly` | A scripted model that calls activate_skill is recorded as triggering; one that doesn't isn't |
| `triggers — trigger rate computation` | 2/3 invocations triggering = trigger_rate 0.667 |
| `triggers — pass/fail thresholds` | should_trigger=true with rate 0.5 passes; with rate 0.49 fails |
| `triggers — split filtering` | `--split=train` runs only train queries |

### 7.2 Quality eval

| Test | Asserts |
|---|---|
| `quality — runner records timing` | timing.json has total_tokens and duration_ms |
| `quality — outputs captured` | Files written by the agent end up in outputs/ |
| `quality — code-based assertions` | "Output file is valid JSON" check works mechanically |
| `quality — LLM-judge assertions` | "Chart has labeled axes" gets evaluated by summary_model |
| `quality — benchmark aggregation` | with_skill and without_skill stats correctly computed; delta is the difference |
| `quality — baseline=previous works` | Snapshot of previous skill version is loaded as baseline |

### 7.3 Optimization loops

| Test | Asserts |
|---|---|
| `optimize-description — converges on better description` | Starting from a vague description, after iterations validation pass rate strictly improves OR stays flat |
| `optimize-description — picks best validation` | Returned description is the one with highest validation pass rate, not necessarily the last |
| `optimize-description — dry-run doesn't write` | SKILL.md unchanged after `--dry-run` |
| `optimize-description — abort preserves original` | User aborting at iteration 2 leaves SKILL.md at iteration 0's content |

### 7.4 Promotion gate

| Test | Asserts |
|---|---|
| `promote — gate runs trigger and quality evals` | Both evals execute against generated query sets |
| `promote — accepts positive delta` | Rule with measured improvement is promoted |
| `promote — rejects negative delta` | Rule with no improvement is not promoted |
| `promote — --no-eval-gate skips` | Flag bypasses; rule installed without eval |

### 7.5 End-to-end

| Test | Asserts |
|---|---|
| `e2e — full optimize-description loop on a fixture skill` | Vague description → optimization loop → improved description; validation pass rate measurably higher |
| `e2e — quality eval delta on delegate-to-cli` | Default skill's quality eval produces a measurable benefit on at least one test case |

## 8. Open questions and risks

### 8.1 Resolved during brainstorming

- **Should evals run in production?**: resolved — no, they're authoring-time. Ongoing telemetry on real activations is a separate concern.
- **Should eval results be shared cross-user?**: resolved — no. Privacy-sensitive (queries may contain personal context). Local-only.
- **LLM judge vs. mechanical grading**: resolved — code-first for what's mechanically checkable, LLM judge for prose assertions, consistent with the [evaluating skills guide](https://agentskills.io/skill-creation/evaluating-skills).

### 8.2 Open

- **Cost discipline**: a full quality eval with 5 test cases × 2 baselines × 3 runs × LLM grading = ~30 LLM invocations per `optimize-quality` iteration, multiplied by max-iterations. On hosted models this can be expensive. Mitigation: default `runs=1` for `eval-quality` (multi-run is opt-in), default to `summary_model` (cheap) for grading, document expected cost in the CLI help. Also: the eval workspace caches with-skill outputs by content hash so re-runs of unchanged skills don't re-invoke the model.
- **Determinism in trigger evals**: even with multiple runs and a 0.5 threshold, results can be noisy. Should we increase default `runs` to 5 for stability? Defer the call to implementation; if 3-run stability is poor on default skills, bump.
- **Rule promotion eval set generation**: how does the harness know what queries to generate for a learned rule? Plan: use the sessions that originally surfaced the pattern as positive examples, plus randomly-sampled unrelated sessions as negatives. Human review of the generated set is required.

### 8.3 Risks

- **R1**: LLM-graded assertions have non-zero error rate. A "passes" verdict from the grader doesn't always mean the output is good. Mitigation: human-review prompt at the end of each `eval-quality` run that surfaces feedback.json (per the [reviewing-results-with-a-human guidance](https://agentskills.io/skill-creation/evaluating-skills#reviewing-results-with-a-human)). Also: report grader confidence and flag low-confidence verdicts.
- **R2**: Optimization loops can overfit to the train set. Mitigation: validation pass rate is the selector, not train pass rate. Train queries are never used to pick the final description.
- **R3**: Authoring 20 queries per skill is real work. Mitigation: scaffold templates. `harness skill new` generates a starter `evals/triggers.json` with 4–6 queries that the author edits and expands. Better minimal coverage than no coverage.
- **R4**: The promotion gate adds latency to the journal-synthesis loop. Mitigation: gate is async — synthesis still runs nightly, gate runs separately, the user reviews proposed promotions in the morning. Existing UX of `harness learn` doesn't slow down.
- **R5**: The grader model and the production agent may share biases. A rule the grader thinks helps may not actually help in real use. Mitigation: human review on first promotion of any new rule type; track promoted-rule-effectiveness over time (out of scope here, but flagged).

## 9. Backward compatibility

evals/ is a new optional directory inside skill bundles. Skills without evals load and run unchanged. The new CLI commands are additive. No breaking changes.

The promotion-gate behavior change does affect users who relied on `harness learn --install` automation. Default behavior (gate active) is the new safe default; `--no-eval-gate` preserves the old behavior. Document the change in release notes.

## 10. Definition of done

- All eval, optimization, promotion, and integration tests in §7 pass
- Every default skill has `evals/triggers.json` with ≥10 queries (5 should-trigger, 5 should-not-trigger)
- delegate-to-cli, daily-reflection, ship-feature each have `evals/evals.json` with ≥3 test cases
- CI asserts validation trigger pass rate >0.85 on every default skill
- `harness skill eval-triggers research` runs end-to-end on a fresh harness
- `harness skill eval-quality delegate-to-cli` produces a benchmark.json with non-zero delta
- `harness skill optimize-description <fixture>` improves a deliberately-bad description's validation pass rate by ≥0.2 in ≤5 iterations
- `harness rules promote` correctly accepts a positive-delta candidate and rejects a no-delta one
- README, skill-authoring, skill-evals docs updated
- `npm test` passes
- `npm run lint` passes
- Post-publish smoke test confirms `harness skill eval-triggers research` works against an installed package

---

*End of design.*
