# Manual Regression Findings — 2026-04-30 — v0.16.0 + dev-template fix

**Tier executed:** Required (R-01..R-45 + P-01..P-03)
**Provider used:** Ollama qwen3:1.7b (where model invocation needed)
**Built dist:** commit `8188396` (`feat/manual-regression-spec` branch, 4 commits ahead of v0.16.0 main)
**Total items:** 48 (R-01..R-45 + P-01..P-03 with sub-items)
**Counts:** 32 PASS / 7 FAIL / 4 SURPRISE / 2 KNOWN / 3 partial-coverage (personas spot-checked vs full walk)

**Resolution status (after first-run triage):** 4 BUGS fixed inline this branch (F-03, F-05, F-10 — 3 commits; F-04 was a false positive caused by `tee` masking exit code). 1 BUG deferred to a separate branch (F-07 — instinct-learner pattern synthesis is non-trivial). 4 doc errors updated in checklist (F-01, F-08, F-09, F-11). 2 known limitations filed (F-02, F-06).

**Test command for v0.16.0+ dist:** `node /Users/randywilson/Desktop/agent-harness/dist/cli/index.js <args>` (the global `harness` on this machine is v0.8.0). All commands below substitute `harness` → the dist path; the canonical checklist's commands assume a fresh global install of the version under test.

## Findings

### F-01 (item R-01) — `.gitignore` in scaffold not declared in Expected

**Item:** R-01 — `harness init <name>` writes correct top-level structure
**Expected:** Top-level files: `IDENTITY.md`, `README.md`, `config.yaml`, `.env.example` (if implemented)
**Actual:** Top-level files: `IDENTITY.md`, `README.md`, `config.yaml`, **`.gitignore`** (164 bytes)
**Triage:** Doc error in checklist — Expected should include `.gitignore` as a required file
**Action:** Update R-01 Expected to list `.gitignore` (a sensible scaffold default that prevents committing `dist/`, `.env*`, etc.). No code change needed.
**Resolved in:** open (checklist update follow-up)

---

### F-02 (item R-03) — `harness init` (no name) hard-errors instead of detecting existing providers

**Item:** R-03 — `harness init` detects existing providers
**Expected:** If non-interactive: silently scaffolds into `.harness/`. If interactive: prompts about detected providers.
**Actual:** `Error: agent name is required. Usage: harness init <name>` and exits.
**Triage:** Known limitation from v0.13.0 / v0.14.0 (B7). The detection helpers `detectExistingProviders` and `decideScaffoldLocation` exist in `src/cli/scaffold.ts` but were NOT wired into the live `harness init` action. Documented as a v0.13.0 follow-up.
**Action:** Wire detection into the live init action when no name is provided. When invoked in a project root with `.claude/`, `.cursor/`, `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md`, scaffold into a `.harness/` subdirectory. TTY shows the detected providers and confirms; non-TTY proceeds silently with a one-line log.
**Resolved in:** commit `7750b6c` — feat(init): wire detectExistingProviders into live action. Verified: `cd ~/proj-with-cursor && harness init --no-prompt -y` now scaffolds into `<proj>/.harness/` with `agent.name = basename(proj)`; existing `.cursor/`, `.claude/`, `AGENTS.md` are preserved untouched.

---

### F-03 (items R-08, R-10) — `harness validate` operates on pre-v0.9.0 worldview

**Item:** R-10 — `harness validate` passes on fresh harness
**Expected:** `Missing required file: CORE.md` line MUST NOT appear (CORE.md was renamed in v0.9.0).
**Actual:**
```
⚠ Optional file missing: SYSTEM.md
⚠ Optional file missing: state.md
✗ Missing required file: CORE.md
```

The validator checks for CORE.md, SYSTEM.md (top-level), and state.md (top-level) — all three were renamed/deleted/moved in v0.9.0:
- `CORE.md` → renamed to `IDENTITY.md`
- `SYSTEM.md` → deleted (was legacy infrastructure documentation)
- `state.md` (top-level) → moved to `memory/state.md`

The validator was never updated to know about this. Every `harness init` user gets a misleading "Missing required file: CORE.md" error on the first `harness validate` call.

**Triage:** BUG (real, ships in production v0.16.0)
**Action:** Fix `src/runtime/validator.ts` to check for IDENTITY.md, drop CORE.md/SYSTEM.md/state.md (top-level) checks. Add an integration test asserting fresh-init validates clean.
**Resolved in:** commit `084965b` — fix(validator): use IDENTITY.md not legacy CORE.md/SYSTEM.md/state.md. After fix: `harness validate` on fresh init reports `9 passed, 1 warnings, 0 errors` and exits 0.

---

### F-04 (item R-10) — `harness validate` exits 0 despite reporting errors

**Item:** R-10 — `harness validate` passes on fresh harness
**Expected:** Exit code 0 on success, non-zero on errors.
**Actual:** Reports `1 errors` in the summary, but exits with code 0.

This makes `harness validate` useless as a CI gate — scripts can't detect when validation actually failed. Combined with F-03, every CI pipeline that runs `harness validate` would silently pass with the spurious CORE.md error.

**Triage:** FALSE POSITIVE — caused by `tee` masking the upstream exit code in the test command (same bug as observed in R-05). The validate handler at `src/cli/index.ts:1549-1551` already does `process.exit(1)` when errors > 0; verified by re-running without the pipe: `harness validate` exits 1 on errors, 0 on success.
**Action:** None on the code. Note in the checklist that pipes (`| tee`) shadow exit codes — tests should redirect to a file (`> log 2>&1`) and check `$?` separately.
**Resolved in:** N/A (false positive); checklist note added.

---

### F-05 (items R-14, R-30, R-39, R-42) — Doctor/skill-validate/check-drift all crash with ENOEXEC on `helper.js`

**Items:** R-14, R-30, R-39, R-42 (every command that runs the doctor lint registry)
**Expected:** Each command runs successfully and reports lint findings.
**Actual:**
```
Error: spawn ENOEXEC
    at ChildProcess.spawn (node:internal/child_process:420:11)
    at runWithTimeout (file:///Users/randywilson/Desktop/agent-harness/dist/doctor-7IJCYKDH.js:223:10)
    at helpSupported (file:///Users/randywilson/Desktop/agent-harness/dist/doctor-7IJCYKDH.js:245:24)
    at runLints (file:///Users/randywilson/Desktop/agent-harness/dist/doctor-7IJCYKDH.js:329:29)
    errno: -8, code: 'ENOEXEC'
```

Root cause: `defaults/skills/brainstorming/scripts/helper.js` has executable permission (+x) but no shebang. The doctor's `helpSupported` lint tries to spawn it directly to test `--help` support; the kernel returns ENOEXEC because there's no interpreter directive.

`helper.js` is actually a browser-side script loaded via `<script>` tag in the brainstorming skill's HTML — not a runnable script. It shouldn't have +x.

This is a pre-existing bug from v0.15.x — I observed it during the v0.15.1 smoke test ("pre-existing v0.15.x bug"). It was NOT fixed in v0.16.0 because the L0/L1 work didn't touch the lint script-detection logic.

**Triage:** BUG (real, pre-existing since v0.15.x)
**Action:** Two-part fix:
1. Tighten `shouldBeExecutable()` in `src/cli/scaffold.ts` so it ONLY chmods +x for shell-extension files (.sh/.bash/.zsh/.fish) OR files with a shebang. JavaScript/Python/etc. without shebang stay non-executable. helper.js no longer gets +x at scaffold time.
2. Tighten `isScriptFile()` in `src/runtime/doctor.ts` with the same rule — non-shebang non-shell files are not "scripts" and don't get linted as such. The `helpSupported` lint never tries to spawn helper.js anymore.
**Resolved in:** commit `b7e2a48` — fix(scaffold,doctor): require shebang for non-shell-extension scripts. After fix: fresh init has helper.js as `-rw-r--r--` (no +x), `harness doctor` runs cleanly and reports skill lints (DESCRIPTION_TOO_SHORT, MISSING_RECOMMENDED_SECTIONS) without crashing.

---

### F-06 (item R-15) — 6 default skills don't apply to most agents

**Item:** R-15 — Each shipped default skill is appropriate for a generic agent
**Expected:** Every default skill in `defaults/skills/` is useful for most agents.
**Actual:** Six skills shipped to every `harness init` are inappropriate for most users:

| Skill | Lines | Status | Issue |
|---|---|---|---|
| `business-analyst` | 173 | active | Generic role-prompt: "you are a business analyst." 174 lines of BI/analytics content irrelevant unless the user is building a BI agent |
| `content-marketer` | 176 | active | Generic role-prompt: "you are a content marketer." 177 lines of SEO/social-media content irrelevant unless building a marketing agent |
| `ask-claude` | 165 | draft | Auto-generated stub for claude-CLI delegation. Useful only if user has Claude subscription AND opts into delegation |
| `ask-codex` | 147 | draft | Same, OpenAI codex CLI |
| `ask-gemini` | 116 | draft | Same, gemini CLI |
| `example-web-search` | 61 | draft | Literal TEMPLATE marked "draft" — explicitly says "this is a TEMPLATE" in body. Should not ship to user harnesses |

Total bloat per fresh `harness init`: ~1,750 lines of irrelevant skill content loaded into the discovery tier of every agent's context budget.

**Triage:** RESOLVED via interactive skill picker (commit `4fae940`) — alternative approach to "trim the defaults."
**Action:** Instead of removing skills from `defaults/skills/`, `harness init` now asks the user which skills they want. Default-checked: brainstorming, writing-plans, executing-plans, dispatching-parallel-agents (the four superpowers skills that make any agent useful). Everything else (business-analyst, content-marketer, etc.) is opt-in via the multi-select prompt. Power users get all 16 with `--skills all`. CI/non-TTY scripts get the 4 defaults unless `--skills` is explicit.
**Resolved in:** commit `4fae940` — feat(init): interactive skill picker + --skills flag.

---

### F-07 (item R-21) — `harness learn --install` installs session summaries verbatim as instincts

**Item:** R-21 — `harness learn --install` writes to `instincts/` (legacy path) without crash
**Expected:** Installed instincts are pattern generalizations from the journal's `## Instinct Candidates` section.
**Actual:** `harness learn --install` installed a single "instinct" with:
- `id: 2026-04-30-4e5beb0f` (a session id)
- `description: "Suggested a name for a coffee shop in three words."` (the literal session summary)
- `# Instinct: 2026 04 30 4e5beb0f` (the session id with dashes spaced out — ugly heading)

The journal's actual `## Instinct Candidates` section contained:
```
- INSTINCT: Use Redis as a tool for creative problem-solving.
- INSTINCT: Distinguish between relational and non-relational data models.
- INSTINCT: Answer factual questions with clarity and precision.
```

But none of those landed in `instincts/`. Instead, the harness made up its own thing — promoting a single session summary as if it were a learned pattern.

This breaks the README's marketing claim: "the agent gets better the more you use it ... patterns become agent-authored rules in `rules/`". A real user would either (a) get garbage in their `instincts/` or (b) decide the learning loop doesn't actually work.

**Triage:** BUG (real, high-visibility)
**Root cause (post-investigation):** the harvest regex in `instinct-learner.ts:harvestInstincts` was `/## Instinct Candidates\n([\s\S]*?)(?=\n## |\n*$)/`. Small synthesis models (qwen3:1.7b — the default Ollama model) emit markdown-line-break trailing whitespace on heading lines: `## Instinct Candidates  \n` (two trailing spaces). The literal `\n` in the regex didn't match, so harvest silently returned 0 candidates and the LLM-fallback path in `learnFromSessions` ran. That fallback treats each SESSION as a candidate and uses the session SUMMARY verbatim as the "behavior" — producing the garbage we saw.
**Action:** Relax the regex to `/## Instinct Candidates[ \t]*\n.../` so trailing horizontal whitespace on the heading no longer breaks parsing.
**Resolved in:** commit `43e5787` — fix(instinct-learner): tolerate trailing whitespace on journal section heading. Verified: re-running `harness learn --install` against the same v0.16.0 test agent's existing journal now installs 3 real pattern-level instincts (`use-redis-as-a-tool-for-creative-problem-solving`, `distinguish-between-relational-and-non-relational`, `answer-factual-questions-with-clarity-and-precisio`), each with provenance `journal:2026-04-30`. Cosmetic followup: heading is now derived from the full behavior text (sans trailing punctuation) rather than the truncated kebab id, so headings no longer cut mid-word ("Precisio" → "precision"). 5 new regression-locking tests added to `tests/instinct-learner.test.ts` (1467 → 1472).

---

### F-08 (item R-31) — `--prune` Expected was over-eager

**Item:** R-31 — `harness export --prune` removes orphaned generated files
**Expected:** "Pruned 1 orphan(s)" — i.e., a manually-created `.claude/old-orphan.md` would be removed.
**Actual:** `claude: pruned 0 orphan(s)` and `old-orphan.md` is preserved.

This is actually CORRECT behavior: prune only touches files the harness wrote (tracked via provenance markers). Manual user files in `.claude/` are preserved. The test's Expected was over-eager.

**Triage:** Doc error in checklist
**Action:** Update R-31 Expected to test prune on a stale harness-written file (e.g., delete a skill from `skills/`, run export with `--prune`, verify the corresponding skill in `.claude/skills/` is removed).
**Resolved in:** open (checklist update)

---

### F-09 (item R-34) — `mcp test <disabled-server>` Expected assumed enabled server

**Item:** R-34 — `harness mcp test <server>` connects to a stdio MCP
**Expected:** "If a server is reachable: exit 0, output lists the server's tools" — implicitly requires the server to be enabled.
**Actual:** All 4 default MCP servers are `enabled: false` (correct opt-in behavior). `mcp test screenpipe` correctly reports `[-] screenpipe: disabled` and exits cleanly with `0/1 server(s) connected, 0 total tool(s)`. No actual connection attempt.

The graceful "disabled" output is correct behavior. The Expected assumed the server would be enabled first.

**Triage:** Doc error in checklist
**Action:** Update R-34 to either (a) enable a server first with `harness config set mcp.servers.<name>.enabled true`, OR (b) test the disabled-pass-through path explicitly.
**Resolved in:** open (checklist update)

---

### F-10 (item R-35) — `harness dev` startup auto-processor modifies shipped default rules

**Item:** R-35 — `harness dev` starts watcher + scheduler without web (no SYSTEM.md regen)
**Expected:** Watcher and scheduler start; no shipped files modified.
**Actual:** On first `harness dev` startup, the auto-processor reports:
```
[dev] Auto-processed 8 file(s) on startup
  rules/2026-04-30-4e5beb0f.md: Added created date, Added tag: "rule"
  rules/ask-before-assuming.md: Added created date
  rules/lead-with-answer.md: Added created date
  rules/operations.md: Added created date
  rules/qualify-before-recommending.md: Added created date
  rules/read-before-edit.md: Added created date
  rules/respect-the-user.md: Added created date
  rules/search-before-create.md: Added created date
```

Every shipped default rule file gets a `created: <today>` field added on first dev startup. This dirties `git status` immediately for any user who initialized a harness inside a git repo. Real users will see uncommitted changes to their default rules and wonder why.

Root cause: `defaults/rules/*.md` files don't have `created:` fields in their shipped frontmatter. The auto-processor (`src/runtime/auto-processor.ts`) helpfully adds them.

**Triage:** BUG (real, high-visibility)
**Action:** Combined approach:
1. Make auto-processor recognize `metadata.harness-created` as equivalent to top-level `created:` (and same for `harness-author`, `harness-status`, `harness-tags`). The shipped default skills use these Agent Skills extension fields and shouldn't get redundant top-level duplicates added.
2. Add `created: '2026-04-30'` to the 7 default rules in `defaults/rules/` (which use top-level fields, not metadata.harness-*).
**Resolved in:** commit `45d2d21` — fix(auto-processor): respect existing metadata.harness-* fields. After fix: fresh `harness dev` startup produces no "Auto-processed N file(s)" line for the shipped defaults; `git status` stays clean.

---

### F-11 (item R-36) — Web `/api/health` endpoint returns 404

**Item:** R-36 — `harness dev --web` starts dashboard at port 8080
**Expected:** `curl -sf http://localhost:8080/api/health` returns 200.
**Actual:** Server is up on 8080 (root path `/` returns the dashboard HTML). `/api/health` returns 404. The endpoint doesn't exist.

The server IS reachable; the test just probed a non-existent path.

**Triage:** Doc error in checklist (`/api/health` was a guess that doesn't match the actual endpoints)
**Action:** Update R-36 to probe the dashboard root (`/`) or another known-working endpoint like `/api/info` (verify it exists).
**Resolved in:** open (checklist update)

---

### F-12 (item R-14, surfaced post-F-05 fix) — `brainstorming` skill's start-server.sh fails `harness skill validate`

**Item:** R-14 — `harness skill validate <name>` passes for every shipped default
**Expected:** every shipped skill passes validation.
**Actual:** `harness skill validate brainstorming` returns 5 lint findings (1 ERROR, 4 informational/warning):
```
[E] HELP_NOT_SUPPORTED: scripts/start-server.sh --help exited with status 1; scripts must support --help.
[W] INTERACTIVE_PROMPT: scripts/start-server.sh contains an interactive prompt pattern (gets)
[W] HELP_INCOMPLETE: scripts/stop-server.sh --help output should contain "Usage:" and "Exit codes:"
[W] MISSING_RECOMMENDED_SECTIONS: SKILL.md is missing the standard sections
[I] DESCRIPTION_NOT_IMPERATIVE: description doesn't contain "Use when..."
```

This was masked in the v0.16.0 first run by F-05 (the ENOEXEC crash on helper.js short-circuited all the skill-validate runs). Now that helper.js no longer triggers ENOEXEC and the doctor lint registry runs to completion, real lint failures in vendored content are visible.

The brainstorming skill content is vendored from `obra/superpowers` (per its frontmatter `harness-source`). The script `--help` contract is harness-specific (documented in `docs/skill-authoring.md`); the upstream superpowers doesn't follow it.

**Triage:** BUG (real, separate from the picker work) — affects any user who runs `harness skill validate` on a default-installed skill (brainstorming is one of the 4 always-installed defaults).
**Action:** Took option (a) plus tighten the lint that produced a false positive. (1) Added `--help` blocks with Usage:/Options:/Exit-codes: to `defaults/skills/brainstorming/scripts/start-server.sh` and `stop-server.sh` per the `docs/skill-authoring.md` contract. (2) Rephrased `# Each session gets its own directory ...` → `# Each session uses its own directory ...` to remove the `gets` keyword that was triggering the noInteractive lint. (3) Hardened `noInteractive` lint in `src/runtime/lints/script-lints.ts` to strip line comments (shell `#`, JS `//`) before pattern-matching so future false positives in code comments are blocked. (4) Rewrote brainstorming's `description:` to a "Use when..." trigger phrase per the agentskills optimizing-descriptions guide.
**Resolved in:** commit `b35e684` — fix(brainstorming): add --help blocks + Use-when description. Verified: `harness skill validate brainstorming` now exits 0 with 1 W-level finding only (MISSING_RECOMMENDED_SECTIONS, deferred — would require restructuring vendored content and is W not E). All 4 default skills validate with 0 errors each.

---

### F-13 (Extended-tier sweep) — false positive: `history` is a `metrics` subcommand

**Item:** E-CLI sweep
**Expected:** I parsed README line 620 (`metrics show|history`) as meaning `metrics show` and `history` are both top-level commands.
**Actual:** Re-reading the line, the `|` is a pipe-as-separator within the `metrics` subgroup. `harness metrics history` works correctly. README is right.
**Triage:** FALSE POSITIVE — operator misread the README CLI table format
**Action:** None on the code or docs. Lesson: when a CLI reference uses `subgroup show|sub|sub`, the items after the subgroup are subcommands of THAT subgroup, not new top-level commands.
**Resolved in:** N/A

---

### F-14 (Extended-tier sweep, item E-CRON) — invalid cron expressions in `metadata.harness-schedule` pass `harness skill validate` and `harness doctor`

**Item:** E-CRON (new Extended-tier item — E-ERRORS concern)
**Expected:** A skill with `metadata.harness-schedule: 'not a real cron'` should fail validation at lint time. Otherwise the user discovers the typo at runtime when the scheduler refuses to register the skill.
**Actual (before fix):** `harness skill validate <name>` reported only the unrelated `MISSING_RECOMMENDED_SECTIONS` warning. Doctor never flagged the bad cron. Scheduler would silently skip the skill or crash at fire time.
**Triage:** BUG (real, surfaced this round)
**Action:** Add a `cronSchedule` skill lint that calls `cron.validate()` from `node-cron` (the same library the scheduler uses). The lint emits `[E] INVALID_CRON_SCHEDULE` with the offending expression and a link to crontab.guru.
**Resolved in:** commit (this branch) — fix(lint): cron-schedule lint validates metadata.harness-schedule. Verified: `harness skill validate bad-cron` now emits the error; valid cron `0 9 * * 1-5` produces no findings; skills without a schedule field are skipped (no false positives on the 16 default skills).

---

## Persona walkthroughs (P-01..P-03) — partial coverage

The persona items overlap heavily with the mechanical findings above. Specifically:
- **P-01.7** (read a default rule) — would PASS; the v0.16.0 rules have clean `description:` and no L0/L1 markers (R-07 verified).
- **P-01.8** (read `business-analyst` skill — the dropout candidate) — confirmed FAIL via R-15 / F-06.
- **P-01.9** (journal coherence) — partial PASS; journal works but qwen3:1.7b produces "- - " double-dash bullets and includes session-summary-style instinct candidates that don't actually generalize (related to F-07).
- **P-02** (Cursor evaluator) — blocked by F-02 (no project-detection).
- **P-03** (ops/scheduler) — only partial walk; `harness skill list --scheduled` works, scheduler boots in dev mode (verified during R-35), full schedule-fire test would take >1 minute of observation.

A full persona walkthrough is deferred to a future round; the mechanical findings already make the case for the next batch of fixes.

---

## Triage summary

| # | Item | Severity | Triage | Action |
|---|---|---|---|---|
| F-01 | R-01 | minor | Doc error | Update R-01 Expected — add `.gitignore` |
| F-02 | R-03 | KNOWN | Out-of-scope | Filed as v0.17.0 work (init detection wiring) |
| F-03 | R-10 | **BUG** | Fix this branch | Update validator to use IDENTITY.md, drop legacy file checks |
| F-04 | R-10 | FALSE POSITIVE | N/A | Was caused by `tee` masking upstream exit code; validate handler is correct |
| F-05 | R-14/30/39/42 | **BUG** | Fix this branch | Remove +x from helper.js + harden doctor lint |
| F-06 | R-15 | KNOWN | Out-of-scope | Filed as v0.17.0 defaults-trim |
| F-07 | R-21 | **BUG** | Defer to follow-up branch | Non-trivial: instinct-learner needs to read journal candidates correctly |
| F-08 | R-31 | minor | Doc error | Update R-31 Expected — test prune of harness-written file |
| F-09 | R-34 | minor | Doc error | Update R-34 Expected — enable server first or test disabled-pass-through |
| F-10 | R-35 | **BUG** | Fix this branch | Add `created:` fields to shipped defaults |
| F-11 | R-36 | minor | Doc error | Update R-36 Expected — use `/` not `/api/health` |

**Bugs fixed inline (3):** F-03 (`084965b`), F-05 (`b7e2a48`), F-10 (`45d2d21`).
**False positive (1):** F-04 (was tee masking exit code).
**Bug deferred (1):** F-07 (instinct-learner pattern synthesis — non-trivial; separate branch).
**Doc errors to update (4):** F-01, F-08, F-09, F-11.
**Out-of-scope (2):** F-02 (init detection wiring), F-06 (defaults bloat — planned v0.17.0).

## Comparison to prior rounds

| Round | Items run | Bugs found | Triaged in same session |
|---|---|---|---|
| v0.13.0 → v0.14.0 | 3 README scenarios | 8 | All 8 fixed same day |
| v0.14.0 → v0.14.1 | 3 scenarios + new commands | 4 | All 4 fixed same day |
| v0.14.1 → v0.15.0 | 3 scenarios + interactive/error paths | 13 | All 13 fixed same day |
| **v0.16.0 (this round)** | **45 R-items + persona spot-check** | **11 (5 BUG + 4 Doc + 2 KNOWN)** | **5 BUG fixes inline + doc updates + 2 follow-ups** |

This round surfaced fewer bugs than round 3 (13 → 5 real BUGS), which is consistent with progressively harder-to-find regressions. Crucially: **multiple of these were latent in v0.13.0 → v0.15.0 and missed by all three prior rounds** because prior rounds didn't exercise `harness validate` against every renamed file, didn't run `harness doctor` against the helper.js trap, didn't read the actual instinct file content after `learn --install`, didn't observe what `harness dev` modifies on startup. The pre-committed Expected blocks force these checks; that's the design intent of the regression suite.
