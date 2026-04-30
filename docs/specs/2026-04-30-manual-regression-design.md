# Manual Regression Test Plan — design

**Date:** 2026-04-30
**Status:** Draft (pending review)
**Spec:** standalone (not part of the 5-spec series; comes after v0.16.0)
**Related:**
- `memory/agent_harness_v0_13_e2e_findings.md` — round 1 (8 bugs)
- `memory/agent_harness_v0_14_e2e_findings.md` — round 2 (4 bugs)
- `memory/agent_harness_v0_14_1_deep_e2e_findings.md` — round 3 (13 bugs)

## 1. Goal

Build a **reusable manual regression suite** — a pre-committed checklist with declared expected outputs — that catches the kinds of bugs the prior three e2e rounds missed, and turn the mechanically-checkable items into vitest assertions so they don't regress.

The deliverable is two files:
1. `docs/manual-regression.md` — the checklist itself, three tiers (Required / Extended / Exhaustive), runnable before each release.
2. `tests/regression-suite.test.ts` (or similar) — vitest assertions for the items in the checklist that are mechanically checkable (no human judgment required).

The act of executing the checklist for the first time is the immediate triggering use case (the user wants this round to find what we've been missing). The act of re-executing it before every release is the long-term use case.

## 2. Non-goals

- Replacing the 1443 existing unit/integration tests. The checklist supplements; it does not duplicate.
- Automating the perception-and-content-quality items. ("Is this default skill actually useful?" requires a human read.) These stay manual forever.
- A CI-runnable smoke test. The required tier should be runnable in CI as a pre-publish gate, but that's a follow-up — this spec covers the manual checklist + inline unit-test additions only.
- Introducing a test framework other than vitest (the project's existing standard).

## 3. Background

### 3.1 What previous rounds found

| Round | Trigger | Bugs found | Theme |
|---|---|---|---|
| 1 (→ v0.14.0) | "test the production surface across the 3 README scenarios" | 8 (B1–B8) | Scaffold artifacts, init UX, basic export adapter behavior |
| 2 (→ v0.14.1) | "run the scenarios end to end again like a real user" | 4 (N1–N4) | Polish gaps the first round missed |
| 3 (→ v0.15.0) | "test everything deeply end to end like a real user" | 13 (D1–D15) | Interactive commands, file watcher, REST API, doctor migration, learning loop, error paths |

Each round used essentially the same method: walk through the 3 README scenarios, run the commands, inspect the high-level outputs (exit codes, marquee files), report findings.

### 3.2 What previous rounds missed

After three rounds of manual testing and a published v0.15.1, the user found three obvious bugs in minutes:

1. **L0/L1 markers in shipped default rules.** Spec #1 (v0.9.0) deprecated the `<!-- L0: -->` / `<!-- L1: -->` HTML body markers in favor of `description:` in frontmatter. The runtime, the migration tool, and the schema were all updated. Seven runtime writers and the seven shipped default rules in `defaults/rules/` were not. Every `harness init` shipped legacy markers verbatim.
2. **Default skills that don't apply to most projects.** Fresh `harness init` ships 16 skills including `business-analyst` (174 lines of generic role-prompt content), `content-marketer` (177 lines), and four auto-generated stubs (`ask-claude`, `ask-codex`, `ask-gemini`, `example-web-search`). Most are irrelevant to most users.
3. **Dev template uses pre-collapse primitive directories.** `templates/dev/defaults/` still has `agents/` and `playbooks/` directories — the v0.10.0 collapse removed those primitive types from the runtime. `harness init --template dev` silently scaffolds dead files.

These bugs share a property: they look fine if you don't already know what should be there. They cannot be caught by "run the command and check exit code." They require **opening the file as if seeing it for the first time** and asking "is this what I'd expect?"

### 3.3 Why prior rounds had this gap

Three reasons:
1. **Author bias.** I wrote (or co-wrote) every default skill, every rule, every scaffold path. I see what I expected to see, not what's actually there.
2. **No declared expected output.** Each round's evidence was "ran command X, looked at output, seemed fine." Without "here's exactly what should be in `rules/operations.md`" written down before the run, "seemed fine" is whatever I happen to remember.
3. **No file inspection after every command.** Prior rounds inspected marquee artifacts (top-level `IDENTITY.md`, the export `.claude/CLAUDE.md`) but skipped the per-file walk. The L0/L1 bug lived in 7 files, all of which got scaffolded into every `harness init`. Reading them once would have surfaced it.

## 4. Design

### 4.1 The three lenses (from brainstorming, lens D)

Every checklist item belongs to one or more of these lenses:

- **Lens A — CLI sweep.** Run the command, check exit code, check effects. ~90 commands, every flag combination on key commands. Catches crashes and obvious regressions.
- **Lens B — File review.** After every command that writes a file, **open every modified file and check content matches the current spec** (description in frontmatter, no `<!-- L0:`, no legacy primitive types, etc.). Catches stale-content drift.
- **Lens C — Persona walkthrough.** Three first-time-user personas walk through the 3 README scenarios. Each persona has a goal, time budget, and prior knowledge level. Catches things that work mechanically but don't meet user expectations.

Required tier hits all three lenses in a tight subset; Extended fans out coverage; Exhaustive covers edge cases.

### 4.2 Step format

Every checklist item follows this exact shape:

````markdown
### {tier-prefix}-{NN} — {one-line description}

**Lens:** A | B | C | A+B | etc.
**Concern:** boot/scaffold | identity/loading | session/learn | export | mcp | long-running | error | anti-pattern

**Action:**
```bash
{exact commands to run, copy-pasteable}
```

**Expected:**
- {bullet list of expected behaviors and file states, declared BEFORE running}
- {include exact file paths, frontmatter fields, content fragments}
- {include exit code expectation}

**Actual:** *(filled at runtime)*
- {what was observed}

**Verdict:** PASS | FAIL | SURPRISE
**Notes:** *(anything unexpected — feeds new checklist items)*
````

`Expected` is the load-bearing field. It is written **before** running the command. If `Actual` doesn't match `Expected`, the item is FAIL or SURPRISE — never rationalized as PASS. SURPRISE means "the behavior is different from expected but might not be wrong"; SURPRISE items go to triage (could become a fix, could become a doc change, could become an updated checklist).

### 4.3 Tier structure

Three tiers. Each is a section of the same `docs/manual-regression.md` file.

#### 4.3.1 Required tier (~50 items, runs ~2–3 hours)

The release-gate tier. Run before every version bump. Covers the 3 scenarios end-to-end with every shipped artifact inspected.

**Concerns and item counts:**

| Concern | Items | Lens emphasis |
|---|---|---|
| Boot / scaffold | 5 | A + B |
| Identity & rules loading | 5 | B |
| Skills loading | 5 | B + C |
| Session / journal / learn loop | 8 | A + B |
| Export adapters (all 6) | 8 | A + B |
| MCP integration | 3 | A |
| Long-running (`dev`, `serve`) | 4 | A + B |
| Doctor (validate / migrate / fix) | 4 | A + B |
| Anti-pattern (Scenario 3) | 3 | A |
| Persona walkthroughs (3 scenarios) | 5 | C |

Total: 50 items.

**The Persona items** (lens C) are the most important new addition. Each persona walks the 3 scenarios cold:

- **P-01 Solo developer** — heard about it on a podcast, has Node + npm, no API key, goal: agent running on laptop in <10 min.
- **P-02 Mid-level engineer evaluating Cursor** — existing project with `.cursor/`, goal: see if init scaffolds correctly, export round-trips, drift detection works.
- **P-03 Ops/automation person** — has a "triage incidents at 9am" task, goal: schedule a skill, watch it fire.

Each persona item declares the persona's prior knowledge, the goal, the success criteria from the user's perspective, and the artifacts that would prove the goal was met. The persona items often **fail** even when all underlying CLI commands pass — that's the whole point.

#### 4.3.2 Extended tier (~80 items)

Run quarterly or after significant changes. Covers the long tail.

**Includes:**
- The remaining ~40 CLI commands not exercised in Required (`status`, `analytics`, `dead-primitives`, `contradictions`, `graph`, `compress`, `intake`, `harvest`, `auto-promote`, `enrich`, `costs`, `metrics`, `health`, `ratelimit`, `dashboard`, `check-rules`, `list-rules`, `gate run`, `intelligence`, `costs budget`, `tools`, `auth`, `emotional`, `state-merge`, `version init/snapshot`, `semantic index/stats`, `bundle`, `installed`, `uninstall`, `update`, `registry`, `sources`, `browse`, `index`, `process`, `search`).
- Provider switch: same scenario run against `agntk-free` instead of Ollama. Verify the agntk-free code path works end-to-end (no key, free tier, hits the proxy).
- Multi-day learning loop simulation: 5 simulated sessions across 3 simulated days, journal each day, run `learn`, verify rule promoted, run a 6th session and verify rule fires.
- Error paths: broken yaml frontmatter, missing IDENTITY.md, missing API key, broken script (no shebang, no +x), malformed config.yaml, network timeout (kill Ollama mid-run), file-permission errors.
- Edge cases on file content: long descriptions (>1024), unicode in IDENTITY.md, large session bodies (>10k tokens), many primitives (>50 skills).
- Doctor migrate against a fully-formed v0.8.x legacy harness with all 7 legacy primitive types populated.
- All 6 export adapters with append-block on existing user content; verify idempotence and drift detection.

Approximate counts per concern: 10 long-tail CLI, 10 provider switch, 10 multi-day, 15 error paths, 15 edge cases, 10 migrate, 10 export-adapter edge.

#### 4.3.3 Exhaustive tier (~70 items)

Opt-in. Run when something looks off and you want to find siblings.

**Includes:**
- Every flag combination on `init`, `dev`, `doctor`, `export`, `run`, `chat`.
- Every config knob in `config.yaml` exercised (rate limits, budgets, timezone, scratchpad budget, retention days, durable defaults).
- Hosted provider integration: smoke-test Anthropic, OpenRouter, OpenAI, Cerebras (one prompt each, costs a few cents).
- Concurrent processes: `dev` + `serve` + scheduler at the same time on different ports.
- Durable workflow resume after `kill -9` mid-run.
- Eval system end-to-end with real model judging (slow, $$).
- Worktree-style multi-harness: two `.harness/` directories in the same project, do they conflict?
- Stress: 100 sessions, then journal/learn — does anything break?

### 4.4 File-inspection requirements (lens B detail)

Every command that writes a file gets a file-inspection block in the checklist item. The block lists every file the command should write OR modify, and what content the test should verify.

**Example — for `harness init test-agent`:**

```markdown
**Files to inspect (lens B):**
- `IDENTITY.md` → must contain `# test-agent`, `## Purpose`, `## Values`, `## Ethics`. Must NOT contain `<!-- L0:`, `<!-- L1:`.
- `config.yaml` → `agent.name: test-agent`, `model.provider: openrouter` (or whatever default), `model.id: anthropic/claude-sonnet-4`.
- `README.md` → must reference `IDENTITY.md` (not `CORE.md`), reference `memory/state.md` (not top-level `state.md`), reference `--web` flag (not `--no-web`).
- `memory/state.md` → must exist (NOT top-level `state.md`).
- All `rules/*.md` (7 files) → each must have `description:` in frontmatter, must NOT contain `<!-- L0:` or `<!-- L1:`.
- All `skills/*/SKILL.md` (16 bundles) → each must have valid Agent Skills frontmatter (name, description). Must NOT contain `<!-- L0:` or `<!-- L1:` in body.
```

For commands that write many files (`init`, `dev`, `export`), the file-inspection block scales — every file is listed by path with content assertions. This is verbose but explicit.

For commands that don't write files (`info`, `prompt`, `validate`, `status`), the inspection block instead captures **stdout content** that should be present.

### 4.5 Persona walkthrough format

Each persona item is a longer narrative-style block, not a single command. Pattern:

````markdown
### P-01 — Solo developer first 10 minutes

**Persona:** Solo developer. Heard about agent-harness on a podcast. Has Node 20+ and npm. No API keys configured. No prior agent-framework experience.

**Goal:** Get an agent running on their laptop and have a useful conversation in under 10 minutes.

**Walkthrough actions** (each is a checklist sub-item with its own Expected/Actual/Verdict):

1. `npm install -g @agntk/agent-harness` — succeeds, prints version.
2. `harness init my-first-agent` — prints success, lists generated files. **First-impression check:** Does the output suggest a clear next step?
3. `cd my-first-agent && harness run "Help me decide between Postgres and SQLite for a side project"` — what happens?
4. **Expected: API-key error with helpful guidance toward Ollama.** First-impression check: Is the error message scary or actionable?
5. Follow the Ollama path: install Ollama, `ollama pull qwen3:1.7b`, switch provider via `harness config set`.
6. Re-run the prompt. Does the agent give a useful answer? Is there visible thinking-time? Streaming?
7. `harness journal` — does it work after one session, or does it complain about needing more?
8. `harness learn --install` — what does this offer to install? Are the candidates sensible?
9. Open `IDENTITY.md`, `config.yaml`, `rules/operations.md` in an editor. **Read them as a first-time user.** Does anything look like template residue or developer-internal scaffolding?
10. Open `skills/business-analyst/SKILL.md`. **Read it.** Does this look like something this user wants to ship with their agent?

**Success criteria from the user's perspective:**
- Got to a useful agent response in <10 minutes (timer is part of the walkthrough)
- Did not need to read the README beyond the install + 3-bullet quickstart
- Files in the harness directory feel like part of THEIR agent, not someone else's template

**Verdict:** PASS / FAIL / SURPRISE for each numbered action above. Persona-level verdict is the rollup.

**Notes:**
- Anything that felt awkward, confusing, or surprising goes here.
- Especially: any file that made the user think "why is this in my project?"
````

P-02 (Cursor evaluator) and P-03 (ops/scheduling) follow the same pattern with different goals and prior knowledge.

### 4.6 Provider strategy

| Tier | Required provider | Optional providers |
|---|---|---|
| Required | Ollama (qwen3:1.7b) | — |
| Extended | Ollama + agntk-free | — |
| Exhaustive | Ollama | Hosted (Anthropic, OpenRouter, OpenAI, Cerebras) |

Required tier uses Ollama exclusively, matching what prior rounds used. Free, local, no rate limits, no cost. Adequate for surfacing most behavior bugs (model quality is irrelevant to "did this command emit the right files").

Extended adds agntk-free to verify that specific provider path works (it's part of the shipped surface). agntk-free is rate-limited but has no key requirement.

Exhaustive optionally tests hosted providers — only if the operator chooses to spend a few cents.

### 4.7 Inline unit-test additions

As we walk the checklist, items that are **mechanically checkable** get translated to vitest assertions in `tests/regression-suite.test.ts`. The criterion: if a human's only job is to read a file and check whether a regex matches, that's an assertion, not a manual check.

**Examples (from the bugs we just fixed):**

```typescript
// Catches the L0/L1-in-defaults regression
describe('shipped defaults', () => {
  it('no rule in defaults/rules/ has legacy <!-- L0: --> or <!-- L1: --> markers', () => {
    for (const file of glob.sync('defaults/rules/*.md')) {
      const content = readFileSync(file, 'utf-8');
      expect(content, file).not.toMatch(/<!--\s*L0:/);
      expect(content, file).not.toMatch(/<!--\s*L1:/);
    }
  });

  it('every rule in defaults/rules/ declares description: in frontmatter', () => {
    for (const file of glob.sync('defaults/rules/*.md')) {
      const { data } = matter(readFileSync(file, 'utf-8'));
      expect(data.description, `${file} missing description:`).toBeTruthy();
      expect(String(data.description).length, `${file} description too short`).toBeGreaterThanOrEqual(20);
    }
  });

  it('every shipped skill in defaults/skills/ has valid Agent Skills frontmatter', () => {
    for (const file of glob.sync('defaults/skills/*/SKILL.md')) {
      const { data } = matter(readFileSync(file, 'utf-8'));
      expect(SkillFrontmatterSchema.safeParse(data).success, file).toBe(true);
    }
  });

  it('templates/dev/defaults/ uses only post-collapse primitive directories', () => {
    const allowed = new Set(['rules', 'skills', 'memory', 'intake']);
    const present = readdirSync('templates/dev/defaults/').filter((f) => existsSync(join('templates/dev/defaults/', f)) && statSync(join('templates/dev/defaults/', f)).isDirectory());
    for (const dir of present) {
      expect(allowed, `templates/dev/defaults/ contains legacy primitive dir: ${dir}`).toContain(dir);
    }
  });
});
```

**Mechanically checkable categories that go to vitest:**
- "No file in <dir> contains <regex>"
- "Every file in <dir> has frontmatter field <X> with value matching <pattern>"
- "Schema parse succeeds for every file in <dir>"
- "Top-level harness directory contains exactly the expected file/dir set after `harness init`"
- "Output of `harness info` contains line matching <regex>"
- "Generated `.claude/CLAUDE.md` provenance marker exists and matches sha256 of source"

**Stays manual (lens B + C judgment):**
- "Description in `business-analyst` skill is appropriate for most users"
- "First-time user reading `rules/operations.md` understands what the rule means"
- "After a journal run, the synthesized text reflects what actually happened in the sessions"
- "Export to `.claude/` produces something a Claude Code user would actually want"

The split is roughly: items that fail because of a stale reference, missing field, or schema violation → automated. Items that fail because of content quality, UX, or first-impression — stay manual.

### 4.8 Workflow

How this gets executed:

1. **Build the checklist file** (`docs/manual-regression.md`) — Required tier first, in full, with all expected outputs declared. Commit to repo.
2. **Build the inline test file** (`tests/regression-suite.test.ts`) skeleton with the obvious assertions from §4.7. Run `npm test`, fix any new failures, commit.
3. **Execute the Required tier** against current main. Capture findings in `docs/manual-regression-findings-2026-04-30.md` (date-stamped, separate from the checklist itself). Each finding: which item, what was expected, what was actual, what to do about it.
4. **Triage findings:**
   - Bug → fix immediately, re-run that item, mark PASS in the findings doc.
   - Doc error in Expected → update checklist (the spec was wrong, not the code).
   - Edge case revealing a missing automated test → add to `tests/regression-suite.test.ts`.
   - Out-of-scope or non-blocker → file as a follow-up, mark in findings as KNOWN.
5. **Build Extended tier** (in `docs/manual-regression.md` as separate section). Don't execute yet — Extended is "after Required is clean."
6. **Build Exhaustive tier** as outline only. No item-level expected outputs yet — those get filled when first executed.
7. **Bump version, ship.** Future releases: re-run Required before publish.

**Re-run cadence:** Required is the gate for every minor or major version bump (e.g., 0.16.0 → 0.17.0, 0.17.x → 1.0.0). Patch bumps that are documentation-only, revert-only, or single-file mechanical fixes (e.g., a typo in CHANGELOG) do not require a Required re-run, but the maintainer should note in the PR/commit which items they spot-checked.

The first execution of the Required tier is the immediate deliverable for the user. The checklist file + inline tests are the long-term artifacts.

### 4.9 Findings document format

`docs/manual-regression-findings-YYYY-MM-DD.md` (one per round). Format:

```markdown
# Manual Regression Findings — {date} — vX.Y.Z

**Tier executed:** Required / Extended / Exhaustive
**Provider used:** Ollama qwen3:1.7b / agntk-free / hosted
**Built dist:** {commit sha}
**Total items:** N (M PASS, X FAIL, Y SURPRISE, Z KNOWN)

## Findings

### F-01 (item R-XX) — {one-line summary}

**Item:** R-XX — {item title from checklist}
**Expected:** {copied from checklist}
**Actual:** {what happened}
**Triage:** Bug | Doc error | Test gap | Known limitation
**Action:** {fix this commit / file follow-up / update checklist / nothing}
**Resolved in:** {commit sha or "open"}

...
```

Each finding gets a unique F-NN id within that day's findings doc. Findings docs accumulate over time as a release-by-release record.

## 5. Architecture diagrams

### 5.1 Document layout

```
docs/
├── manual-regression.md                   # the checklist (reusable artifact)
│   ├── ## Required tier (~50 items)
│   ├── ## Extended tier (~80 items)
│   └── ## Exhaustive tier (~70 items)
├── manual-regression-findings-2026-04-30.md  # first-run findings
├── manual-regression-findings-2026-MM-DD.md  # subsequent rounds
tests/
└── regression-suite.test.ts                # vitest assertions for mechanical items
```

### 5.2 Per-item flow

```
Pre-committed Expected
        │
        ▼
   Run Action ───► capture stdout/stderr/exit
        │
        ▼
File-inspection: open every modified file
        │
        ▼
Compare Actual vs Expected
        │
   ┌────┴────┬────────┐
   ▼         ▼        ▼
  PASS    FAIL    SURPRISE
   │       │       │
   │       ▼       ▼
   │  Triage to findings doc
   │       │
   │       ▼
   │  Fix / update checklist / file follow-up
   │       │
   ▼       ▼
  Mark item complete in current run
```

## 6. What this catches that prior rounds missed

The three bugs the user found post-v0.15.1 each map to specific Required-tier items:

| Bug | Caught by | How |
|---|---|---|
| L0/L1 in default rules | R-07 (lens B) + automated test | Expected says "no `<!-- L0:`, no `<!-- L1:`, has `description:`"; vitest asserts the same |
| Defaults bloat (business-analyst etc.) | P-01 step 10 (lens C) | Persona explicitly opens `skills/business-analyst/SKILL.md` and asks "does this belong in my agent?" |
| Dev template legacy dirs | new Required-tier item in boot/scaffold concern (lens B) — `harness init --template dev` inspection | Expected lists post-collapse dir set; `templates/dev/defaults/` legacy `agents/` and `playbooks/` directories surface immediately as deviations |

## 7. Risks and trade-offs

**The checklist could grow unmaintainable.**
- *Mitigation:* tier discipline. Required stays ≤60 items even if we add over time. Items that aged out get moved to Extended.

**Pre-committed Expected can be wrong.**
- *Mitigation:* during execution, an Actual that differs from Expected is a finding even if the system behavior is correct. Triage either fixes the spec (Expected was outdated) or fixes the code (Actual was wrong). Both are useful outcomes.

**Persona walkthroughs are subjective.**
- *Mitigation:* each persona declares concrete success criteria (timer, specific files opened, specific user-perspective checks). Reduces but doesn't eliminate subjectivity. Subjectivity is the feature here — we *want* "does this feel right?" judgments.

**Author bias remains.**
- *Mitigation:* the persona items are explicit about pretending to be a first-time user. As a follow-up (not in scope here), a fresh subagent with zero session context could run scenario 1 cold using only the README — closest we can get to a real first-time user. That's a separate spec.

**Mechanical-vs-manual split is fuzzy.**
- *Mitigation:* default to manual when uncertain. Items that turn out to be mechanically checkable can be promoted to vitest in any subsequent round.

## 8. Acceptance criteria

The work described in this spec is complete when:

1. `docs/manual-regression.md` exists in the repo with all three tiers populated. Required tier has full Expected blocks for every item. Extended tier has actions and high-level expected, but Expected blocks may be sparse for items not yet executed. Exhaustive tier is outline-only.
2. `tests/regression-suite.test.ts` exists with the obvious mechanical assertions (no L0/L1 in defaults, schema validity, primitive-dir enforcement). All assertions pass against current main.
3. The Required tier has been executed once against current main. `docs/manual-regression-findings-2026-04-30.md` exists with the findings.
4. Every finding is triaged: fixed, filed as follow-up, or marked KNOWN.
5. The README's "Upgrading from older versions" section gains a one-liner pointing at `docs/manual-regression.md` so future contributors know it exists.

## 9. Out of scope (for follow-up)

- A CI-runnable smoke test wrapping the Required tier. (The mechanical assertions in `tests/regression-suite.test.ts` are runnable in CI; the perception-and-content items are not. Wrapping the latter in CI requires a different design — likely a "diff vs baseline" approach for files that can be snapshot.)
- A "fresh subagent runs scenario 1 cold" pass for true first-time-user simulation.
- Automated drift detection between the checklist and the actual CLI surface (catches new commands not in the checklist).
- Visual/screenshot regression for `harness dev --web` dashboard.

## 10. Decisions log

These are the answers to the four brainstorming questions, recorded for traceability:

| # | Question | Answer |
|---|---|---|
| Q1 | Primary lens for this round | D — all three layered (persona + file review + CLI sweep), with mandatory file inspection after every command |
| Q2 | Evidence format | C — pre-committed checklist with Expected declared upfront, Actual captured below |
| Q3 | Deliverable shape | C — reusable manual regression suite + automated coverage delta in vitest |
| Q4 | Tier structure | C — Required / Extended / Exhaustive |

These decisions are load-bearing for §4. Changing any of them changes the design.
