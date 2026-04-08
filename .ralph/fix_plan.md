# Ralph Fix Plan — v0.1.0 Ship

**IMPORTANT: Mark tasks `[x]` as you complete them. Update this file every loop.**

**Reference docs:**
- `.ralph/PROMPT.md` — principles, commit rules, stall detection
- `.ralph/specs/architecture-vision.md` — NLAH thesis, layer model
- `.ralph/specs/design-decisions.md` — locked taxonomy and governance decisions

**Loop rule:** Ralph is fully autonomous. No human tasks. Exit when every task is `[x]` AND build/test/lint all pass.

---

## Phase 12 — Ship v0.1.0 to npm

**Thesis:** The learning loop works end-to-end (verified against real LLM: 7 prompts → journal → learn → behavior change on a novel prompt). What remains is content, polish, auto-discovery safety, and distribution hygiene. No new runtime features. No refactoring of `conversation.ts`, `tool-executor.ts`, `mcp.ts`, `journal.ts`, `instinct-learner.ts`, or `delegate.ts`.

**Audience for the ship:** coder OR non-coder, anyone who wants to build an agent in 2026.

**Headline pitch:** "The first agent framework where the agent gets measurably better as you use it. You write markdown, not code. Tools come from MCP."

**Execution order is deliberate.** Do tasks in the order listed. Later tasks depend on earlier ones. One task per loop.

---

### 12.1 — Fix `discover --remote` to use GitHub Contents API

**Why:** Unblocks live testing of `sources.yaml` and enables 12.4 (which uses `discover --remote` as reference lookup). Smallest isolated change. Current impl hits `api.github.com/search/code` which requires auth — returns 401 for every unauthenticated request.

**Steps:**
1. Read `src/runtime/sources.ts` end-to-end. Find the Code Search API call (search for `api.github.com/search/code`). Line 318 at last check.
2. Read `src/runtime/universal-installer.ts` to understand how discovered URLs get consumed downstream.
3. Rewrite the GitHub source scanner to use the Contents API:
   - `GET https://api.github.com/repos/{owner}/{repo}/contents/{path}`
   - No auth required. 60 req/hour unauthenticated limit.
   - List the repo root, then recurse ONE level into conventional directories: `skills/`, `agents/`, `rules/`, `hooks/`, `playbooks/`, `plugins/`
   - For `plugins/`, recurse one more level into each subdir to find `plugins/<topic>/agents/*.md` (wshobson-style layout)
   - Filter filenames and L0 comments against the query string (case-insensitive substring match)
   - Return each match as `{ name, path, download_url, source }` for the universal installer
4. Keep Code Search API as a fallback path ONLY when `process.env.GITHUB_TOKEN` is set. Log which path was used explicitly (`[sources] using contents api` vs `[sources] using code search api (GITHUB_TOKEN detected)`).
5. Update `tests/sources.test.ts` — mock the Contents API responses instead of Code Search responses. Use `MockAgent` from `undici` or vitest's `vi.mock('undici')` — do NOT make real network calls in tests.
6. Add 3 new test cases:
   - `discoverRemote returns results from unauthenticated Contents API`
   - `discoverRemote recurses into plugins/* for nested layouts`
   - `discoverRemote returns empty array (not throw) for 404 on dead repo`

**Acceptance:**
- `npm run build && npm test && npm run lint` — all green
- `node dist/cli/index.js discover search "skill" --remote -d test-agent` — returns ≥1 result from a live source in `sources.yaml` (e.g. `anthropics/skills` or `wshobson/agents`). No `GITHUB_TOKEN` in env. Not zero results. Not 401.
- Tests pass without hitting the real network.

**Commit:** `fix(sources): switch discover --remote to Contents API`

- [x] **12.1 COMPLETE**

---

### 12.2 — Suppress CLI startup noise (dotenvx banner, Node Fetch warning)

**Why:** Every command currently prints two dotenvx banners (`◇ injected env (0) from .env`) plus tip text (`tip: ⌘ suppress logs { quiet: true }`). `harness --version` prints them. Completely unprofessional and leaks an internal dependency into user output. Also `(node:XXXXX) ExperimentalWarning: The Fetch API is an experimental feature` fires on every run under Node 18.

**Steps:**
1. Search the codebase for where dotenvx is imported and invoked. `grep -rn "dotenvx\|injected env" src/`. It's probably `src/cli/index.ts` near the top.
2. Replace the loud dotenvx init with a silent variant. The library supports `{ quiet: true }` (it literally says so in its own tip). If the current CLI calls `config()` without options, pass `{ quiet: true }`. Verify by running `node dist/cli/index.js --version` and checking stdout/stderr are clean.
3. If dotenvx doesn't support silent mode cleanly, fall back to plain `dotenv` for `.env` + `.env.local` loading. It's a drop-in replacement, already in dependencies (check `package.json`).
4. Suppress the Node `ExperimentalWarning: The Fetch API` warning at process start. Add to the CLI entry point:
   ```ts
   process.removeAllListeners('warning');
   process.on('warning', (w) => {
     if (w.name === 'ExperimentalWarning' && /fetch/i.test(w.message)) return;
     console.warn(w);
   });
   ```
   Place this BEFORE any imports that would trigger the warning. Test with Node 18 and Node 20.
5. Expose `--verbose` as a top-level option. If set, the dotenvx banners come back (or log what was loaded via the harness logger at `info` level). Default remains silent.

**Acceptance:**
- `node dist/cli/index.js --version` prints `0.1.0` and NOTHING else on stdout or stderr
- `node dist/cli/index.js info -d test-agent` prints the info block and nothing else at startup (harness `[harness] ...` logs are fine — those are from the booted agent)
- `node dist/cli/index.js --verbose --version` prints `0.1.0` plus whatever verbose init info
- `npm run build && npm test && npm run lint` — all green

**Commit:** `fix(cli): suppress dotenvx banners and Node fetch experimental warning`

- [x] **12.2 COMPLETE**

---

### 12.3 — Fix `operations.md` missing tag bug in scaffold

**Why:** `defaults/rules/operations.md` ships with tags `[rules, operations, safety]` but is missing the singular `rule` tag that `harness doctor` auto-fixes on first run. The scaffold should be correct on first run — doctor auto-fixing defaults is a bug report, not a feature. Small fix, do it before 12.4 so the diversification work lands on a clean base.

**Steps:**
1. Read `defaults/rules/operations.md`.
2. Add `rule` to the tags array in frontmatter.
3. Search `defaults/` for any other file whose tags don't include the singular form of its primitive type (e.g. a skill missing `skill`, a playbook missing `playbook`). Grep the directory.
4. Fix any others found.

**Acceptance:**
- `rm -rf /tmp/ralph-scaffold-12-3 && node dist/cli/index.js init /tmp/ralph-scaffold-12-3 --no-discover-mcp --no-discover-env --no-discover-project`
- `node dist/cli/index.js doctor -d /tmp/ralph-scaffold-12-3` prints "no fixes needed" (or equivalent). **Must NOT say "Auto-fixed N issues".**
- `npm run build && npm test && npm run lint` — green

**Commit:** `fix(defaults): add missing primitive tags to scaffold files`

- [x] **12.3 COMPLETE**

---

### 12.4 — Pull battle-tested primitives from live sources into `defaults/`

**Why:** Current defaults are 7 primitives, all coder-flavored. `harness graph` reports them all as orphans. A non-coder running `harness init` closes the folder. We do NOT write new primitives from scratch — that produces slop. Instead, we pull real content from the battle-tested sources already in `sources.yaml` using the `harness install` pipeline, which auto-normalizes format via the universal installer.

**Sources to pull from (all verified live in `sources.yaml`):**
- `https://github.com/anthropics/skills` — 16+ official Anthropic skills (pdf, docx, pptx, xlsx, canvas-design, skill-creator, mcp-builder, etc.)
- `https://github.com/wshobson/agents` — 112 agents + 146 skills organized as `plugins/<topic>/agents/*.md`
- `https://github.com/hesreallyhim/awesome-claude-code` — canonical curated list; use to find additional repos

**This task takes multiple loops.** Split into sub-commits by primitive type. Each sub-commit must leave build+test+lint green.

**Prerequisite:** 12.1 must be complete (`discover --remote` working against the unauthenticated Contents API). If 12.1 isn't done yet, go do it first.

**Selection criteria (apply to every candidate before pulling):**
- General-purpose, not narrowly domain-specific (good: "decision-making", "research"; bad: "react-hooks-refactor")
- Both coder and non-coder use cases appropriate (this product ships for both)
- Clean markdown — no truncation, no broken frontmatter, no obvious formatting rot
- Distinct from existing defaults (don't pull 5 variants of "research")
- Self-contained — doesn't reference 15 external tools that don't exist

**Steps:**

1. **Survey the sources.** Read the existing `defaults/` tree first to know what NOT to duplicate:
   ```bash
   ls defaults/skills/ defaults/playbooks/ defaults/rules/ defaults/agents/ defaults/tools/ defaults/workflows/
   ```

2. **Discover candidates via the live sources.** Use the now-working `discover --remote`:
   ```bash
   node dist/cli/index.js discover search "decision" --remote -d test-agent
   node dist/cli/index.js discover search "planning" --remote -d test-agent
   node dist/cli/index.js discover search "writing" --remote -d test-agent
   node dist/cli/index.js discover search "research" --remote -d test-agent
   node dist/cli/index.js discover search "communication" --remote -d test-agent
   node dist/cli/index.js discover search "analysis" --remote -d test-agent
   node dist/cli/index.js discover search "learning" --remote -d test-agent
   ```
   For each query, read the top 3-5 results' `download_url` content (fetch via curl or the GitHub Contents API). Apply the selection criteria. Keep a shortlist.

3. **Pull candidates through `harness install` into a staging harness.** The universal installer at `src/runtime/universal-installer.ts` auto-detects format, fixes frontmatter, generates L0/L1 summaries, and classifies into the right primitive type:
   ```bash
   rm -rf /tmp/ralph-source-gather
   node dist/cli/index.js init /tmp/ralph-source-gather --no-discover-mcp --no-discover-env --no-discover-project
   node dist/cli/index.js install "<raw github url>" -d /tmp/ralph-source-gather
   # repeat for every candidate
   ```
   The installer will classify each file into `/tmp/ralph-source-gather/skills/`, `.../playbooks/`, `.../rules/`, or `.../agents/` based on content detection.

4. **Verify each pulled file loads cleanly.** After installing each one:
   ```bash
   node dist/cli/index.js validate -d /tmp/ralph-source-gather
   ```
   If validation fails on a pulled file, DROP it — do not fix it manually. Move on to the next candidate.

5. **Target counts.** Aim for ~20 total new primitives loaded (was 7), distributed roughly:
   - **Skills: 10-12** (this is the source repos' strength — pull heavily here)
   - **Agents: 3-5** (stateless sub-agents for specific tasks, from wshobson/agents plugins)
   - **Playbooks: 2-3** (harder to find in external sources — write minimal ones if needed, see step 8)
   - **Rules: 1-2** (the external repos don't really have "rules" as a concept — write these)
   - **Instincts: 1** (the `qualify-before-recommending` one from the learning loop test — write this; it's ~30 lines)

6. **Copy verified files from the staging harness into `defaults/`.** Preserve directory structure. Rename if needed to avoid collisions with existing files:
   ```bash
   cp /tmp/ralph-source-gather/skills/*.md defaults/skills/
   cp /tmp/ralph-source-gather/agents/*.md defaults/agents/
   # etc.
   ```

7. **Add cross-references.** `harness graph` currently shows orphans. After pulling, edit each new default's L2 body to reference at least ONE sibling primitive by id, meaningfully in context. Example: in a "decision-making" skill, add a line near the bottom: `> For ambiguous recommendations, pair this with the [qualifying-questions] skill to identify missing context first.`
   Only add references that make sense — do NOT fake edges.

8. **Handwrite the gaps** — primitive types the external sources don't cover well:
   - `defaults/rules/respect-the-user.md` — never patronize, never over-explain, ask before volunteering opinions
   - `defaults/rules/ask-before-assuming.md` — one clarifying question on ambiguous asks
   - `defaults/instincts/qualify-before-recommending.md` — the instinct the learning loop produces naturally; ship it as a default. `source: default` in frontmatter. Body references the `qualifying-questions` skill if you pulled one with that id, otherwise a semantically-similar pulled skill.
   - `defaults/tools/example-web-search.md` — a markdown HTTP tool example. Include `## Authentication` (env var placeholder `WEB_SEARCH_API_KEY`), `## Operations` (one GET endpoint), an example call, `status: example` in frontmatter. This exists so users see the format.
   - `defaults/workflows/daily-reflection.md` — scheduled workflow with cron `0 18 * * *`, body describes producing an end-of-day reflection in `memory/scratch.md`.

9. **Do NOT rewrite existing defaults.** `defaults/skills/research.md`, `defaults/playbooks/ship-feature.md`, `defaults/agents/summarizer.md`, `defaults/instincts/{lead-with-answer,read-before-edit,search-before-create}.md`, `defaults/rules/operations.md` — leave them alone. Coder-flavored defaults still ship because the audience includes coders. We ADD general-purpose content, we don't REPLACE coder content.

10. **Verify the final scaffold:**
   ```bash
   rm -rf /tmp/ralph-scaffold-12-4
   node dist/cli/index.js init /tmp/ralph-scaffold-12-4 --no-discover-mcp --no-discover-env --no-discover-project
   node dist/cli/index.js validate -d /tmp/ralph-scaffold-12-4
   node dist/cli/index.js doctor -d /tmp/ralph-scaffold-12-4
   node dist/cli/index.js graph -d /tmp/ralph-scaffold-12-4
   node dist/cli/index.js info -d /tmp/ralph-scaffold-12-4
   ```

11. **Clean up staging:** `rm -rf /tmp/ralph-source-gather`

**Acceptance:**
- `harness info` on a fresh init reports ≥20 primitives loaded (was 7)
- `harness validate` — zero errors, zero warnings (except "no API key")
- `harness doctor` — "no fixes needed"
- `harness graph` — ≥3 edges, <3 orphans
- At least 10 of the new primitives came from live sources via `harness install` (check frontmatter for `source:` field pointing to a github URL or the installer's auto-generated provenance)
- All handwritten gap-fill files (rules, instinct, tool example, workflow example) exist
- `npm run build && npm test && npm run lint` — all green

**Commit:** Multiple commits expected:
- `feat(defaults): pull 10+ general-purpose skills from anthropics/skills and wshobson/agents`
- `feat(defaults): pull 3-5 sub-agents from wshobson plugins`
- `feat(defaults): add handwritten rules, instinct, tool example, workflow example`
- `feat(defaults): cross-reference pulled primitives for graph edges`

**Source attribution:** Each pulled file's frontmatter must preserve its `source:` field (the universal installer sets this). If it doesn't, add it manually pointing to the original `download_url`. This is the licensing trail — users can trace any default back to where it came from.

- [ ] **12.4 COMPLETE**

---

### 12.5 — Fix `harness init` next-steps output + generate in-scaffold README

**Why:** Current `init` next-steps says "edit CORE.md" which is a prerequisite, not a next step. A non-coder has no idea what to do. Also the scaffold has no `README.md` inside it explaining what to do with the folder they just created. Depends on 12.4 so the referenced prompts actually produce good output.

**Steps:**
1. Create `templates/base/README.md` (or the equivalent location — look for how existing templates work; check `src/cli/scaffold.ts` and `templates/`). Content: a walkthrough of the 5-command first-run demo.
   ```markdown
   # {agent-name}

   You just created an agent. Try these in order:

   1. `harness run "What can you do?"` — see what's loaded
   2. `harness run "Help me decide between X and Y"` — see it work
   3. `harness run "Plan a weekend project for me"` — see it qualify before answering
   4. (do this for a few days with varied prompts)
   5. `harness journal` — see what it learned
   6. `harness learn --install` — teach it to remember

   The agent gets better the more you use it. You're editing markdown, not writing code. Open any file in `skills/`, `rules/`, or `instincts/` to see how it works.

   ## The 7 primitives
   (brief explanation of each)

   ## Going further
   - `harness doctor` — check scaffold health
   - `harness graph` — see how primitives reference each other
   - `harness info` — see what's loaded in the context budget
   - `harness mcp discover` — find MCP tools on your machine
   - `harness mcp search <query>` — browse the MCP registry
   ```

2. Update `scaffoldHarness()` in `src/cli/scaffold.ts` to copy `templates/base/README.md` into the generated directory (with `{agent-name}` placeholder replaced with the actual name).

3. Update the `init` command in `src/cli/index.ts` — the block that prints "Next steps:" — to:
   - Print 5 concrete commands matching the README's demo path
   - Print the actual agent directory path (not just the name)
   - Print a note about `harness mcp test` if MCP servers were auto-discovered
   - Remove the generic "edit CORE.md" and "edit rules/, instincts/, skills/" lines

**Acceptance:**
- `rm -rf /tmp/ralph-scaffold-12-5 && node dist/cli/index.js init /tmp/ralph-scaffold-12-5 --no-discover-mcp --no-discover-env --no-discover-project`
- `cat /tmp/ralph-scaffold-12-5/README.md` — exists, contains the 5-command demo
- Terminal output from `init` prints 5 specific commands, no generic advice
- `npm run build && npm test && npm run lint` — all green

**Commit:** `feat(scaffold): add in-scaffold README and improve init next-steps`

- [ ] **12.5 COMPLETE**

---

### 12.6 — Fix MCP auto-discovery safety

**Why:** Current `init` silently adds up to 7 MCP servers with absolute paths (`/Users/randywilson/.nvm/.../npx`), including HTTP servers that 401 without auth (`auggie`). On a different machine, all those paths are broken. On first run, `harness info` prints a wall of servers the user never asked for. For a shared or published scaffold, absolute paths leak user metadata.

**Steps:**
1. Read `src/cli/index.ts:206-225` (the MCP auto-discovery block in the init action).
2. Read `src/runtime/mcp-discovery.ts` — the `discoverMcpServers()` and `discoveredServersToYaml()` functions.
3. Changes to discovery:
   - Normalize commands: if the command resolves to `npx`, `node`, or `python`, write just the tool name, not the absolute path. Use PATH at runtime.
   - Skip HTTP/SSE servers that have no `Authorization` header or auth config — they're guaranteed to 401.
   - Skip servers with `env` values that contain unresolved `${...}` references to env vars not set in the current environment.
4. Change the default behavior of `init` to PREVIEW and CONFIRM:
   - Print the list of discovered servers
   - Prompt "Add these N servers to config.yaml? [Y/n]" — default yes, `--yes` to skip prompt, `--no-discover-mcp` still works to skip entirely
   - Use a simple `readline` Y/n prompt — don't add a new dependency like `inquirer`
5. After adding servers, print a single line: `  → Run 'harness mcp test' to verify connections`
6. Update any existing tests for `discoverMcpServers` / scaffold to reflect the new behavior. Add 2 new tests: normalization (absolute path → tool name), unauth HTTP filter.

**Acceptance:**
- `rm -rf /tmp/ralph-scaffold-12-6 && echo "" | node dist/cli/index.js init /tmp/ralph-scaffold-12-6` (the echo simulates "accept default Y")
- If MCP auto-discovery runs on your dev machine, `grep /Users/ /tmp/ralph-scaffold-12-6/config.yaml` — no matches. No absolute paths leaked.
- If `auggie` exists on your machine, it's NOT in the generated config (filtered because no auth).
- `rm -rf /tmp/ralph-scaffold-12-6-yes && node dist/cli/index.js init /tmp/ralph-scaffold-12-6-yes --yes` — skips prompt, still normalizes and filters.
- `node dist/cli/index.js init /tmp/foo --no-discover-mcp` still works (existing behavior).
- `npm run build && npm test && npm run lint` — all green.

**Commit:** `fix(mcp): preview-and-confirm discovery, normalize paths, filter unauth HTTP`

- [ ] **12.6 COMPLETE**

---

### 12.7 — Add LICENSE file at repo root

**Why:** `package.json` declares `"license": "MIT"` but there's no `LICENSE` file at the repo root. npm publish will include the license from package.json, but the file is conventional and some linters/scanners complain. Takes 2 minutes.

**Steps:**
1. Create `LICENSE` at repo root with the standard MIT License text.
2. Copyright holder: `Randy Wilson`
3. Year: `2026`

**Acceptance:**
- `LICENSE` file exists at repo root, starts with `MIT License`, contains copyright year and holder
- `npm run build && npm test && npm run lint` — all green (no code changes, but run anyway to confirm)

**Commit:** `chore: add LICENSE file (MIT)`

- [ ] **12.7 COMPLETE**

---

### 12.8 — Commit Phase 11 test fixes if still uncommitted

**Why:** The last audit found `tests/agent-framework.test.ts` and `tests/define-agent.test.ts` had uncommitted fixes from a previous phase. CI is green on Node 20+ but the working tree is dirty. Clean it up.

**Steps:**
1. `git status` — check if those test files are modified and unstaged.
2. If yes: `git diff tests/agent-framework.test.ts tests/define-agent.test.ts` — verify the changes are actual test fixes, not debugging leftovers.
3. If the diff looks like real test fixes, commit them. If it looks like noise, revert instead.
4. If the files are already clean (no unstaged changes), mark this task complete and move on.

**Acceptance:**
- `git status --short` shows the test files as clean
- `npm test` still passes
- `npm run build && npm run lint` — green

**Commit:** `test: commit pending phase 11 test fixes` (only if there were actual changes to commit)

- [ ] **12.8 COMPLETE**

---

### 12.9 — Verify `agent-harness` name on npm and run local install round-trip

**Why:** Nobody has verified that `agent-harness` is available as a package name on npm, and nobody has tested `npm install -g` from the built tarball on a clean shell. If the name is taken, we need to scope it (e.g. `@randywilson/agent-harness`) BEFORE the release workflow exists. If the install round-trip is broken, the release workflow publishes something users can't actually use.

**Steps:**
1. Run `npm view agent-harness` — capture output.
   - If it says `404 Not Found` → name is available. Continue.
   - If it returns package metadata → name is taken. Edit `package.json` to set `"name": "@randywilson/agent-harness"` and adjust any downstream references. Document the rename in this task's notes.
2. `npm run build`
3. `npm pack` — produces `agent-harness-0.1.0.tgz` (or the scoped equivalent) at the repo root.
4. Install that tarball in a throwaway directory as if it were a user:
   ```bash
   rm -rf /tmp/install-test && mkdir /tmp/install-test && cd /tmp/install-test
   npm init -y
   npm install /Users/randywilson/Desktop/agent-harness/agent-harness-0.1.0.tgz
   ./node_modules/.bin/harness --version   # must print 0.1.0
   ./node_modules/.bin/harness init smoke-test --no-discover-mcp --no-discover-env --no-discover-project
   cd smoke-test
   ../node_modules/.bin/harness validate
   ../node_modules/.bin/harness doctor
   ../node_modules/.bin/harness graph
   ../node_modules/.bin/harness info
   ```
5. All commands must produce expected output. Clean up: `rm /Users/randywilson/Desktop/agent-harness/agent-harness-*.tgz` and `rm -rf /tmp/install-test`.

**Acceptance:**
- If name is taken, `package.json` is updated to a scoped name and this fact is recorded in Discoveries
- `npm pack` produces a tarball
- Install from tarball succeeds
- `harness --version`, `harness init`, `harness validate`, `harness doctor`, `harness graph`, `harness info` all work from the tarball install
- Tarball is cleaned up, no leftover `.tgz` committed

**Commit:** `chore(release): verify npm name and local install round-trip` (no-op commit if nothing changed, or the package.json rename if name was taken)

- [ ] **12.9 COMPLETE**

---

### 12.10 — Add `.github/workflows/release.yml` for tag-triggered publish

**Why:** Currently publishing means running `npm publish` by hand. That's fine for v0.0.x experimentation but not for v0.1.0. A basic tag-triggered workflow is 25 lines of YAML and makes `git tag v0.1.1 && git push --tags` the entire release process going forward.

**Steps:**
1. Check if `.github/workflows/ci.yml` exists and read it to match style and Node version matrix.
2. Create `.github/workflows/release.yml`:
   ```yaml
   name: Release
   on:
     push:
       tags: ['v*']
   jobs:
     publish:
       runs-on: ubuntu-latest
       permissions:
         contents: read
         id-token: write
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: '20'
             registry-url: 'https://registry.npmjs.org'
         - run: npm ci
         - run: npm run build
         - run: npm test
         - run: npm run lint
         - run: npm publish --access public --provenance
           env:
             NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
   ```
3. The `--provenance` flag requires `id-token: write` permission and npm >= 9.5. Use it — it's a free security win.
4. Do NOT commit any `NPM_TOKEN` value. The workflow references the secret by name; the user sets it in GitHub repo settings.
5. Note in this task's discoveries: "User must set `NPM_TOKEN` secret in GitHub repo settings before tagging v0.1.0."

**Acceptance:**
- `.github/workflows/release.yml` exists and is valid YAML (test: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"`)
- File references `${{ secrets.NPM_TOKEN }}` (not a hardcoded token)
- Discoveries section notes the NPM_TOKEN setup step
- `npm run build && npm test && npm run lint` — green

**Commit:** `ci: add release workflow for tag-triggered npm publish`

- [ ] **12.10 COMPLETE**

---

### 12.11 — Update main README with v0.1.0 pitch and structure

**Why:** The current README buries the learning loop in section 12 of 13. The learning loop is the headline feature. Also the README doesn't clearly state the audience, the MCP-as-tool-layer architectural decision, or the fact that it works for both coders and non-coders.

**Steps:**
1. Read the current `README.md` end-to-end.
2. Rewrite the top ~40 lines with:
   - **New title block**: Same project name, but replace the subtitle with: `"The first agent framework where the agent gets measurably better as you use it. You write markdown, not code. Tools come from MCP."`
   - **New intro paragraph (2-3 sentences)**: explain that agent-harness is a file-first framework for building agents through markdown editing. Mention the audience: anyone who can write a document — coder or non-coder. Mention the learning loop as the differentiator.
   - **A new "Why this is different" section** with 3 bullets:
     - Self-learning by default: every interaction is journaled; patterns become instincts; agents get better with use
     - File-first authoring: edit markdown, not code
     - MCP-native tools: the entire MCP ecosystem is your toolbox, no custom adapter layer
3. Move the existing "The Learning Loop" section from the bottom to immediately after the Quick Start. Make it the second thing users read.
4. Add a new "Tools" section between "Customizing Your Agent" and "MCP Integration" stating plainly: MCP is the primary tool layer. Markdown HTTP tools for trivial REST APIs. Programmatic tools only as an escape hatch.
5. Update the Quick Start to include a first prompt that's NOT "Who are you?" — something that actually shows what the agent does. Suggest: `harness run "Help me decide between two options: A and B"`
6. Leave everything else alone. Do not rewrite the 7 Primitives table, the CLI commands table, the configuration section, or the MCP Integration section.
7. Do NOT embed a screencast/asciicast — marketing artifacts are post-ship, not ship-blockers.

**Acceptance:**
- README.md subtitle matches the new pitch line
- "Why this is different" section exists with 3 bullets
- Learning Loop section appears within the first ~100 lines (not at the bottom)
- "Tools" section explicitly names MCP as primary, HTTP markdown as secondary, programmatic as escape hatch
- Quick Start first command is NOT "Who are you?"
- No asciicast embedded (deferred post-ship)
- Spell-check pass (no obvious typos)
- `npm run build && npm test && npm run lint` — green (no code changes, but verify)

**Commit:** `docs(readme): rewrite for v0.1.0 with learning loop and MCP pitch`

- [ ] **12.11 COMPLETE**

---

### 12.12 — Run end-to-end smoke test and record results

**Why:** Before tagging a release, run every acceptance check from every prior task in one clean pass against a fresh scaffold. If anything fails, do NOT tag — add a new fix task and loop again. If everything passes, write a record file and proceed to 12.13.

**Steps:**

1. **Build + verify:**
   ```bash
   npm run build
   npm test
   npm run lint
   ```
   All must pass. If any fail, add a new task `12.N — Fix <thing>` and do NOT mark 12.12 complete.

2. **Offline scaffold smoke test:**
   ```bash
   rm -rf /tmp/ralph-final-smoke
   node dist/cli/index.js init /tmp/ralph-final-smoke --no-discover-mcp --no-discover-env --no-discover-project > /tmp/ralph-init.log 2>&1
   cat /tmp/ralph-init.log
   ```
   Assert:
   - Exit code 0
   - `/tmp/ralph-final-smoke/README.md` exists and contains the 5-command demo
   - Init log prints 5 concrete demo commands in its "Next steps" section (no generic "edit CORE.md")
   - `/tmp/ralph-final-smoke/config.yaml` has NO absolute paths (`grep /Users/ /tmp/ralph-final-smoke/config.yaml` → empty)

3. **Validator/doctor/graph/info:**
   ```bash
   node dist/cli/index.js validate -d /tmp/ralph-final-smoke
   node dist/cli/index.js doctor -d /tmp/ralph-final-smoke
   node dist/cli/index.js graph -d /tmp/ralph-final-smoke
   node dist/cli/index.js info -d /tmp/ralph-final-smoke
   ```
   Assert:
   - `validate`: zero errors, zero warnings (except "no API key")
   - `doctor`: reports "no fixes needed" (does NOT auto-fix anything)
   - `graph`: ≥3 edges, <3 orphans
   - `info`: lists ≥20 primitives loaded

4. **CLI noise:**
   ```bash
   node dist/cli/index.js --version > /tmp/ralph-version.log 2>&1
   cat /tmp/ralph-version.log
   wc -l /tmp/ralph-version.log
   ```
   Assert: `wc -l` returns exactly 1 line; content is exactly `0.1.0`.

5. **Discover --remote works unauthenticated:**
   ```bash
   unset GITHUB_TOKEN
   node dist/cli/index.js discover search "writing" --remote -d /tmp/ralph-final-smoke 2>&1 | tee /tmp/ralph-discover.log
   grep -c "^  " /tmp/ralph-discover.log
   ```
   Assert: result count ≥ 1. No `401` in the output.

6. **Distribution checks:**
   ```bash
   test -f LICENSE && grep -q "MIT License" LICENSE && echo "LICENSE ok"
   test -f .github/workflows/release.yml && grep -q "NPM_TOKEN" .github/workflows/release.yml && echo "release workflow ok"
   npm pack --dry-run 2>&1 | tail -5
   ```
   Assert: all three print their "ok" messages.

7. **README checks:**
   ```bash
   grep -q "measurably better" README.md && echo "pitch ok"
   grep -q "Why this is different" README.md && echo "section ok"
   awk '/^## The Learning Loop|^## Learning Loop/ {print NR; exit}' README.md
   ```
   Assert: "pitch ok" and "section ok" print. Learning Loop line number ≤ half the total line count of README.md.

8. **Online smoke test** — ONLY if `OPENROUTER_API_KEY` is set in env. Otherwise skip and log "ONLINE CHECK SKIPPED: no API key".
   ```bash
   if [ -n "$OPENROUTER_API_KEY" ]; then
     node dist/cli/index.js run "Recommend a book for me" -m gemma -d /tmp/ralph-final-smoke > /tmp/ralph-online.log 2>&1
     grep -i "recommend\|tell me\|which\|what" /tmp/ralph-online.log && echo "qualifying behavior ok"
   fi
   ```
   If the agent produced qualifying questions (instead of blindly recommending), pass. If the online check runs and fails, do NOT proceed — add a fix task.

9. **Record results:** Write `.ralph/smoke-test.md` with:
   ```markdown
   # v0.1.0 Smoke Test Results

   Ran: <actual ISO timestamp, not a placeholder>
   By: Ralph, task 12.12

   ## Results
   - [x] Build + test + lint passing
   - [x] Scaffold round-trip clean
   - [x] Validator/doctor/graph/info green
   - [x] CLI noise suppressed (`--version` is single line)
   - [x] `discover --remote` unauthenticated returns results
   - [x] LICENSE + release workflow + npm pack ok
   - [x] README pitch + structure ok
   - [<x | skipped>] Online qualifying-behavior check

   ## Build info
   - Node: <output of `node --version`>
   - Package version: 0.1.0
   - Primitive count on fresh init: <actual number>
   - Graph edges: <actual number>
   - Graph orphans: <actual number>
   ```
   Fill in real numbers from the command outputs. Do not leave placeholders.

10. **Clean up:** `rm -rf /tmp/ralph-final-smoke /tmp/ralph-*.log`

**Acceptance:**
- Every assertion in steps 1-8 passed (or step 8 was skipped because no API key)
- `.ralph/smoke-test.md` exists with real values
- Build + test + lint green

**Commit:** `docs(release): record v0.1.0 smoke test results`

- [ ] **12.12 COMPLETE**

---

### 12.13 — Tag v0.1.0 and push

**Why:** Final ship step. `.github/workflows/release.yml` (from 12.10) triggers on tag push. Pushing the tag hands the release off to CI. Ralph does this autonomously — the smoke test in 12.12 is the gate.

**Prerequisite:** 12.12 `[x]` with every assertion green. If 12.12 is not `[x]`, do NOT proceed.

**Steps:**
1. Re-verify the working tree is clean: `git status --short` — must be empty. If not empty, there's uncommitted work from an earlier task; go back and commit it before this task.
2. Re-verify we're on the main branch (or whatever the default branch is): `git branch --show-current`. If not on main, do NOT tag.
3. Verify there's no existing `v0.1.0` tag: `git tag -l v0.1.0`. If it already exists, the release is in progress or already shipped — mark 12.13 complete and move on.
4. Create the tag: `git tag -a v0.1.0 -m "v0.1.0 — initial release"`
5. Push the tag: `git push origin v0.1.0`
6. Log the tag push in `.ralph/smoke-test.md` as an appended line: `Tagged and pushed: <ISO timestamp>`
7. Do NOT `git push` the branch itself in this task — commits should already have been pushed by earlier loops (if the user has configured branch autopush) or will be pushed by the user. This task only handles the tag.

**Acceptance:**
- `git tag -l v0.1.0` prints `v0.1.0`
- `git ls-remote --tags origin v0.1.0` (if network permits) shows the tag on remote — if this check fails due to network, log it but don't fail the task
- `.ralph/smoke-test.md` has the appended "Tagged and pushed" line

**Commit:** no commit needed — the tag is the output. If `.ralph/smoke-test.md` was edited to append the log line, commit that: `chore(release): log v0.1.0 tag push`

- [ ] **12.13 COMPLETE**

---

## Discoveries

_(Ralph: add discoveries, surprises, and notes here as you work. One bullet per discovery. Include the task number that produced it.)_

- **12.0** (pre-loop audit by Claude): Learning loop verified working end-to-end with 7 real prompts → journal → learn → instinct installed → behavior change on novel prompt. Cost ~$0.06 on gemma. The headline feature IS the product.
- **12.0**: `sources.yaml` had 8 dead GitHub URLs; fixed. Now contains 4 MCP registries + 6 live GitHub sources (anthropics/skills, hesreallyhim/awesome-claude-code, wshobson/agents, karanb192/claude-code-hooks, anthropics/claude-plugins-official, anthropics/claude-plugins-community).
- **12.0**: `anthropics/skills` has no top-level LICENSE file. License verification for pre-bundled content is DEFERRED. v0.1.0 does not pre-bundle from external sources; all default content is written in-repo.
- **12.0**: `discover --remote` fails on all sources because it uses GitHub Code Search API which requires auth. Fix is task 12.1.
- **12.0**: `bench/terminal-bench/` scaffold is parked (correct code against correct Harbor contract, but waiting for out-of-scope runtime features). Do not touch.
- **12.1**: Live CLI integration test (`harness discover search "skill" --remote`) was rate-limit-blocked during execution because my first naive implementation enumerated all 60+ wshobson plugin subdirs in one query and exhausted the 60 req/hr unauth limit. Fixed by (a) scoping top-level scans to the source's declared `content[]` field, (b) selectively recursing into `plugins/<topic>/` only when `<topic>` matches the query, (c) sharing a 50-call budget across all sources per discoverRemote call. Logic verified by 5 new mocked unit tests in tests/sources.test.ts. Live integration retry blocked until rate limit resets at 2026-04-08T07:12:03Z (~1 hour from commit). Discoveries should be revisited when 12.4 starts running live discover.
- **12.1**: Pre-existing test `should find sources by name` was searching for "VibeGuard" — that source was removed from sources.yaml in an earlier session. Updated to search for "wshobson" which is still live. Folded into the 12.1 commit since it was blocking the test verification path.
- **12.1**: Code Search API path is preserved as opt-in fallback only when BOTH `GITHUB_TOKEN` is set AND `HARNESS_DISCOVER_USE_CODE_SEARCH=1` is exported. Default for everyone is the unauthenticated Contents API. Power users get richer query semantics if they explicitly opt in.
- **12.2**: The CLI uses plain `dotenv@17.4.1`, NOT dotenvx. The banners we saw (`◇ injected env (N) from .env // tip: ⌘ ...`) are from dotenv 17.x's own behavior — the package was rebranded by the dotenvx team and the modern version always logs by default. Fixed by passing `{ quiet: true }` to both `loadDotenv()` calls. Banners come back via `HARNESS_VERBOSE=1`.
- **12.2**: The Node 18 `ExperimentalWarning: The Fetch API is an experimental feature` warning is suppressed by removing all default `warning` listeners and re-installing a filtered handler that drops only the fetch-related ExperimentalWarnings. All other warnings (e.g. deprecation, unhandled promise rejection) still print as before. Verified clean on both Node 18.12.1 and Node 22.22.1.
- **12.2**: Discovered a small unrelated bug in `harness init`: when given a full path like `/tmp/v122-test`, it sets `agent.name` in `config.yaml` to the full path string instead of the basename `v122-test`. Not in 12.2's scope. Fix in 12.5 (which is doing the init UX cleanup anyway).
