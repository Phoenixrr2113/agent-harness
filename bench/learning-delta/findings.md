# learning-delta PoC — findings

**Date**: 2026-04-08
**Model**: Ollama `qwen3.5:9b` (local)
**Cost**: $0
**Wall time**: ~10 minutes of runtime + ~20 minutes of debugging the zsh array bug
**Verdict**: 🟢 direction green — build the full bench

---

## What ran

- **3 training prompts** (DB/cache/API tradeoffs) → 3 sessions
- `harness journal` → 3 instinct candidates extracted
- `harness learn --install` → **4 instincts installed**:
  - `scale-based-technologies` (0.8)
  - `side-project-default` (0.75)
  - `industry-standard-first` (0.75)
  - `use-case-specific-matching` (0.8)
- **3 holdout prompts** run BEFORE learn and AFTER learn on otherwise-identical scaffold
- Holdout topics (architecture/auth/tooling) were deliberately disjoint from training topics

## Eyeball comparison (me, not blind)

| Holdout | Topic | Baseline behavior | Post behavior | Winner | Margin |
|---|---|---|---|---|---|
| 1 | Monolith vs microservices | Decisive but then pivots into 4 qualifying questions and blocks waiting for user to pick one | Decisive (`modular monolith`), frames as `industry-standard approach`, provides quantitative thresholds (10+ engineers, $100K/yr DevOps), 3 concrete next steps, non-blocking follow-up | **POST** | clear |
| 2 | JWT vs session cookies | Opens "there's no universal answer", good table, **refuses to recommend** — blocks on user picking tenant isolation pattern | "session cookies with Redis is the safer choice" — commits, provides budget estimate ($200 vs $2k/mo), concrete next action if Redis already installed | **POST** | clear (but confounded — see below) |
| 3 | TypeScript strict mode | Leads "gradually, not day 1", then **contradicts itself** in a table showing greenfield → strict day 1 | Leads "day 1 for new, gradual for existing" — conditional upfront, no self-contradiction, cleaner structure | **POST** | marginal |

**POST wins 3/3 on eyeball.** The direction looks right.

## The signal

The installed instincts bleed through visibly in the post answers:

- Holdout 1 uses the phrase "industry-standard approach" — **direct lexical trace to the `industry-standard-first` instinct**, applied to a topic (monolith) that was NOT in training. That's the interesting case: the instinct generalized out of its origin domain.
- Holdout 2 recommends "Redis session storage" — training prompt 1 taught the harness to recommend Redis for sessions, so this is partly **echo from training**, not generalization. Lower-value signal.
- Holdout 1 and 2 both became more **decisive** (commit to a recommendation instead of blocking on clarifying questions). Could be the `side-project-default` instinct pushing toward simple/default picks, or could just be that the installed instincts gave the model more confidence framing.

## The confounds I can't eliminate at N=3

1. **Judge is me, judge is not blind.** Classic confirmation bias risk. Needs an LLM-as-judge scoring against fixed rubrics before any claim is publishable.
2. **N=3 holdouts, N=3 training.** No statistical anything. Every observation is anecdotal.
3. **Topic overlap on holdout 2.** "Redis for sessions" was literally in training; the post answer echoing it is not a clean generalization test. Real bench needs holdout topics guaranteed disjoint from training vocabulary.
4. **Cold-start variance.** During debugging I observed the model produce "Idle and ready. Awaiting your input." for valid prompts ~25% of the time on first runs. This is raw model variance, not a learning effect. Any bench needs N≥5 runs per prompt with variance reporting.
5. **Single cycle only.** No claim about whether the delta compounds or regresses across multiple journal → learn cycles.
6. **No cross-category regression check.** An installed instinct could help the training category and hurt unrelated categories. Not tested here.

## The pipeline works end-to-end

Secondary finding — the full loop ran cleanly against a local weak model with zero code changes:

- `harness run` → session file written to `memory/sessions/`
- `harness journal` → synthesized sessions + extracted 3 instinct candidates in 41s
- `harness learn --install` → generated 4 named instincts with provenance (linking to specific session IDs) and installed them as markdown files in `instincts/` in 54s
- Next `harness run` → the new instincts loaded into the system prompt without any other action
- Zero LLM calls required to wire primitives into context

This validates the core claim that the loop is mechanical (deterministic install) on top of LLM-generated content (the instinct text itself). The mechanical half is robust; the LLM half is where the variance lives.

## Bug found during PoC (worth capturing)

**zsh vs bash array indexing.** My first baseline and training runs used zsh-default 1-indexed arrays, so `${ARRAY[0]}` was empty and the first prompt in each loop ran with empty input. The harness responded with "I am ready..." for an empty prompt, and I initially misread that as model variance. Fixed by wrapping the runner in `bash -c`. Lesson for the full bench: use a real runner script, not shell loops, and assert prompt non-empty before calling the CLI.

## What the full bench needs (v1 spec)

To turn this into a defensible claim:

1. **N≥20 prompts per category**, **N≥8 categories**, all authored before any runs (no cherry-picking)
2. **Strict train/holdout split per category**, with vocabulary disjoint-ness checked (no "Redis for sessions" overlap)
3. **LLM-as-judge** (Sonnet or GPT-4) scoring each answer against a fixed rubric per category: structure/specificity/decisiveness/correctness, 1–5 each, blind (baseline/post labels stripped before judge sees them)
4. **3 learning cycles** per run, measure delta after each cycle — is it monotonic? plateau? regression?
5. **Cross-category regression check**: after installing instincts from category A, re-evaluate category B holdout to verify no degradation
6. **Multiple seeds / temperature sweeps** for variance reporting — current ~25% cold-start variance on qwen3.5:9b makes single-run comparisons noisy
7. **Report**: quality delta after cycle 1, 2, 3; cross-category regression matrix; judge agreement rate vs human spot-check on 20 samples
8. **Cost**: estimate ~$15-30 for full sweep on Sonnet judge + free local weak-model agent

## Recommendation

**Build the full bench.** The eyeball signal on 3/3 holdouts is strong enough to justify the engineering work, and this is the only bench that tests the harness's actual differentiator. Follow-up task: draft the full-bench spec as a v0.2.0 milestone.

**Don't publish any numbers yet.** The confounds above (N=3, non-blind judge, topic leakage on holdout 2) mean this PoC's findings are directional only. Any "learning improves quality by X%" claim requires the v1 bench first.

## Artifacts

- `prompts/training.txt` — 3 prompts fed to `harness run` to generate sessions
- `prompts/holdout.txt` — 3 prompts evaluated before and after learn
- `baseline/holdout-{1,2,3}.md` — raw outputs from fresh harness
- `post/holdout-{1,2,3}.md` — raw outputs after learn cycle
- `post/instincts.md` — snapshot of all 8 instincts in the harness after `learn --install` (4 defaults + 4 newly learned)
