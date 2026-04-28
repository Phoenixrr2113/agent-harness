# Skills spec conformance — design

**Date:** 2026-04-28
**Status:** Draft (pending review)
**Spec:** 1 of 5 in the Agent Skills alignment series
**Related specs:**
- 2 of 5 — `2026-04-29-primitive-collapse-design.md` (7→2 primitive collapse, AI SDK trigger mapping)
- 3 of 5 — `2026-04-30-skill-content-rewrite-design.md` (defaults rewrite as bundles, script feedback contract)
- 4 of 5 — `2026-05-01-skill-evals-design.md` (eval infrastructure)
- 5 of 5 — `2026-05-02-provider-integration-design.md` (export to .claude/.cursor/.gemini/.github/etc.)

## 1. Goal

Bring agent-harness's primitive format into strict conformance with the [Agent Skills specification](https://agentskills.io/specification) for `skills/`, while keeping non-skill primitives consistent with the same Agent Skills shape but with harness-defined extensions where they make structural sense. Rename and relocate top-level identity/state files to drop dead infrastructure docs and signal that the harness is general-purpose, not a coding tool. Vendor four generic skills from `obra/superpowers` as additional defaults.

## 2. Non-goals (handled in later specs)

- Collapsing the 7 current primitive types (skills, rules, instincts, playbooks, workflows, tools, agents) into 2 (skills + rules) — that's spec #2.
- Defining the AI SDK trigger mapping for lifecycle events — spec #2.
- Rewriting the *content* of existing default skills as proper script-bundled skills with structured feedback — spec #3. This spec only handles the *structural* migration (flat `.md` → `<name>/SKILL.md` bundle, frontmatter shape).
- Eval infrastructure for trigger and quality optimization — spec #4.
- Provider integration (`harness export`, init detection of `.claude/`, `.cursor/`, etc.) — spec #5.

## 3. Background

### 3.1 Current state

The frontmatter schema at [src/core/types.ts:31](../../src/core/types.ts) is a permissive Zod schema that accepts:

- `id` as the primary identifier (required in the inner schema, derived from `name` if missing)
- `name`, `description`, `license`, `compatibility`, `metadata`, `'allowed-tools'` as optional Agent Skills fields with **no constraint enforcement**
- `tags`, `status`, `author`, `created`, `updated`, `related`, plus type-specific fields (`schedule`, `with`, `channel`, `model`, `active_tools`, `durable`, etc.) as top-level extensions

The loader at [src/primitives/loader.ts:46](../../src/primitives/loader.ts) parses with `gray-matter`, applies the schema, and on validation failure silently falls back to a filename-derived `id`. It also extracts L0 and L1 summaries from HTML comments at the top of the markdown body.

Top-level files in a harness directory:
- `CORE.md` — agent identity (purpose, values, ethics)
- `SYSTEM.md` — boot sequence, file ownership table, context loading strategy (mostly harness infrastructure documentation)
- `state.md` — current runtime state (mode, goals, last interaction)
- `config.yaml` — configuration

Default skills at [defaults/skills/](../../defaults/skills/) are flat single-file `.md` per skill: `business-analyst.md`, `content-marketer.md`, `delegate-to-cli.md`, `research.md`.

### 3.2 What's wrong

Six concrete deviations from the [Agent Skills specification](https://agentskills.io/specification):

1. **`allowed-tools` shape**: spec defines a *space-separated string* (e.g., `"Bash(git:*) Bash(jq:*) Read"`); we have `z.array(z.string()).optional()`.
2. **`name` validation**: spec requires 1–64 chars, `[a-z0-9-]`, no leading/trailing/consecutive hyphens, must match parent directory name. We accept any string.
3. **`description` requirement**: spec requires `description` for skills (1–1024 chars, non-empty). We make it optional with no length limit.
4. **`compatibility` length cap**: spec says max 500 chars. We don't enforce.
5. **Parent-dir name match**: spec says `name` must equal the parent directory name for bundled skills. We don't validate.
6. **Silent error fallback**: spec's `skills-ref` validator errors on invalid frontmatter; our loader silently constructs a fallback `id` and continues, hiding authoring mistakes.

Three structural mismatches:

7. **Flat skill files**: defaults like `defaults/skills/research.md` are flat single-file primitives. The Agent Skills spec defines a skill as a *directory* containing `SKILL.md`. Flat skills are not portable to skills-ref or to other Agent Skills tooling.
8. **L0/L1 HTML comments**: agent-harness's invention. The spec's progressive disclosure has only two stages (discovery via `name`+`description`, activation via full body). L0 duplicates what `description` is for; L1 has no spec analog.
9. **`id` legacy field**: spec uses `name` as the identity. Our `id` is redundant and the slugify-from-name dance is friction with no benefit.

Three top-level file issues:

10. **`SYSTEM.md` is dead infrastructure docs**. Its content (boot sequence, file ownership table, L0/L1/L2 strategy) describes how the harness *operates*, not how *this agent* should behave. None of it is per-agent; it's reproduced from the same template into every harness. It should be code, not user-facing markdown.
11. **`CORE.md` is fine in concept, badly named**. "Core" is abstract. The file's purpose is to declare the agent's identity. `IDENTITY.md` says exactly that. (`AGENTS.md` was considered and rejected — it's the emerging *coding-tool* convention from Codex/Cursor/Copilot/etc., and agent-harness is not coding-specific.)
12. **`state.md` at top level is wrong scope**. Runtime state isn't identity. It's auto-mutated on every run, rarely hand-edited, conceptually adjacent to sessions and journal. Belongs under `memory/`.

## 4. Design

### 4.1 Frontmatter schema

Two schema variants, both descended from the Agent Skills spec.

#### 4.1.1 Skills (strict spec compliance)

For any document loaded from `skills/`:

| Field | Required | Validation |
|---|---|---|
| `name` | Yes | 1–64 chars, regex `^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9]))*[a-z0-9]?$` (no leading/trailing/consecutive hyphens), must equal parent directory basename for bundles |
| `description` | Yes | 1–1024 chars, non-empty after trim |
| `license` | No | Free-form string |
| `compatibility` | No | 1–500 chars |
| `metadata` | No | `Record<string, string>` (strict string→string per spec) |
| `allowed-tools` | No | Single space-separated string |

**No other top-level fields are allowed in skill frontmatter.** All harness-specific extensions move into `metadata` with the `harness-` prefix:

```yaml
---
name: research
description: Conducts deep research using web search and document analysis. Use when the user asks to investigate a topic, gather sources, or compare options.
license: MIT
allowed-tools: WebSearch Read Bash(jq:*)
metadata:
  harness-tags: "research,knowledge-work"
  harness-status: active
  harness-author: human
  harness-created: "2026-01-15"
  harness-updated: "2026-04-28"
  harness-related: "writing-plans,executing-plans"
---
```

Spec-defined `metadata` values must be strings, so list-typed harness fields (`tags`, `related`) are stored as comma-separated strings. The loader splits them back into arrays in the internal `HarnessDocument` representation.

#### 4.1.2 Non-skill primitives

For documents loaded from `rules/`, `instincts/`, `playbooks/`, `workflows/`, `tools/`, `agents/` (these still exist in spec #1; spec #2 collapses them):

The Agent Skills core (name, description, license, compatibility, metadata, allowed-tools) **plus** harness-defined top-level fields:

| Top-level field | Type | Applies to | Notes |
|---|---|---|---|
| `tags` | `string[]` | All | List of organizational tags |
| `status` | `'active' \| 'archived' \| 'deprecated' \| 'draft'` | All | Loader filters non-active |
| `author` | `'human' \| 'agent' \| 'infrastructure'` | All | |
| `created` | `string` (ISO date) | All | |
| `updated` | `string` (ISO date) | All | |
| `related` | `string[]` | All | |
| `schedule` | `string` (cron) | workflows | |
| `with` | `string` | workflows | |
| `channel` | `string` | workflows | |
| `duration_minutes` | `number` | workflows | |
| `max_retries` | `number` (≥0) | workflows | |
| `retry_delay_ms` | `number` (>0) | workflows | |
| `durable` | `boolean` | workflows | |
| `model` | `'primary' \| 'summary' \| 'fast'` | agents | |
| `active_tools` | `string[]` | agents | |

`metadata` for non-skill primitives is permissive (`Record<string, unknown>`) since these are agent-harness's own format and not bound by the spec's string→string constraint.

The same `name` and `description` rules apply (required, char limits, parent-dir match for bundles). Non-skill primitives are NOT exposed to skills-ref validation, but applying the same naming hygiene gives us internal consistency and a clean promotion path (a playbook becomes a skill by flattening its top-level fields into metadata).

#### 4.1.3 Removed fields

- `id` — drop entirely. Identity is `name` for all primitives. For flat single-file primitives, `name` defaults to the filename without extension if missing.
- The internal `HarnessDocument.frontmatter.id` field stays as a derived value (set by the loader from `name`), so existing consumers of `doc.frontmatter.id` keep working — but we also expose `doc.id` as the canonical accessor.

### 4.2 Loader behavior

Three changes to [src/primitives/loader.ts](../../src/primitives/loader.ts):

#### 4.2.1 Drop L0/L1 extraction

Remove `L0_REGEX`, `L1_REGEX`, the `getAtLevel()` function, and all body stripping logic that removes the comment markers. The body becomes simply the content after frontmatter.

`HarnessDocument.l0` and `HarnessDocument.l1` fields are removed. Consumers of these (mainly the system prompt assembler in [src/runtime/context-loader.ts](../../src/runtime/context-loader.ts)) migrate to using `frontmatter.description` (for the discovery layer) and `body` (for activation). The new system prompt strategy is detailed in spec #2.

#### 4.2.2 Strict validation with explicit lenient mode

Today, validation failures fall back silently to a filename-derived `id`. This hides authoring mistakes.

New behavior:

- **Default (strict)**: validation errors are returned in the `LoadResult.errors` array with `{ path, error }`. The document is **not** added to `LoadResult.docs`. The loader does not throw, but the doctor command reports these errors loudly and offers to migrate.
- **Lenient mode** (opt-in via `loadAllPrimitivesWithErrors(dir, { lenient: true })`): for cosmetic-only failures (name >64 chars, name doesn't match parent dir, description >1024 chars), warn but load. For substantive failures (missing required field, unparseable YAML, name fails the character-class regex), still error and skip.

The cosmetic-vs-substantive split mirrors the [Adding skills support guide](https://agentskills.io/client-implementation/adding-skills-support#lenient-validation), which explicitly recommends lenient loading for cross-client compatibility.

#### 4.2.3 Normalization layer

To keep internal consumers unchanged, the loader produces a uniform `HarnessDocument` regardless of whether the source was strict-spec frontmatter (skills) or harness-extended frontmatter (others). Pseudo-shape:

```typescript
function normalize(raw: ParsedFrontmatter, kind: string, parentDir: string): HarnessDocument {
  const isSkill = kind === 'skills';
  const meta = raw.metadata ?? {};

  const tags = isSkill
    ? parseList(meta['harness-tags'])
    : (raw.tags ?? []);

  const status = isSkill
    ? (meta['harness-status'] ?? 'active')
    : (raw.status ?? 'active');

  // ... same pattern for author, created, updated, related

  return {
    id: raw.name ?? basename(parentDir),
    name: raw.name,
    description: raw.description,
    license: raw.license,
    compatibility: raw.compatibility,
    allowedTools: raw['allowed-tools']?.split(/\s+/).filter(Boolean) ?? [],
    tags, status, author, created, updated, related,
    // type-specific fields (schedule, durable, etc.) read from top-level for non-skills
    schedule: isSkill ? undefined : raw.schedule,
    durable: isSkill ? undefined : raw.durable,
    // ...
    metadata: isSkill ? stripHarnessKeys(meta) : meta,
    body: raw.body,
    raw: raw.rawText,
    bundleDir: raw.bundleDir,
  };
}
```

Existing consumers (`buildSystemPrompt`, the journal synthesizer, the dashboard) read `doc.tags`, `doc.status`, etc. directly. None know whether the original frontmatter put those fields top-level or in metadata. **The schema change is invisible to most of the codebase.**

### 4.3 File layout changes at the harness root

#### 4.3.1 `CORE.md` → `IDENTITY.md`

The file's purpose is unchanged: declare who the agent is (name, purpose, values, ethics). The rename is purely about clarity. `IDENTITY.md` is loaded into the system prompt the same way `CORE.md` is today.

The system prompt assembler ([src/runtime/context-loader.ts](../../src/runtime/context-loader.ts)) updates to:
1. Look for `IDENTITY.md`. If present, load.
2. As a deprecation grace, also look for `CORE.md`. If found AND no `IDENTITY.md` exists, emit a deprecation warning to stderr ("CORE.md is deprecated; rename to IDENTITY.md or run `harness doctor --migrate`") and load it as identity.
3. If both exist, prefer `IDENTITY.md` and warn that `CORE.md` is being ignored.

#### 4.3.2 Delete `SYSTEM.md`

The system prompt assembler stops loading `SYSTEM.md`. The auto-processor's existing logic for generating a default `SYSTEM.md` ([src/runtime/auto-processor.ts](../../src/runtime/auto-processor.ts) — to verify in implementation) is removed.

For migration: any non-infrastructure content found in an existing `SYSTEM.md` (anything beyond boot-sequence boilerplate, file-ownership tables, and L0/L1/L2 documentation) is auto-extracted by the migration command into `rules/operations.md` with a note in the frontmatter: `metadata.harness-source: migrated-from-system-md`.

The boot sequence, file ownership table, and context loading strategy are no longer authored content. They become documentation in [README.md](../../README.md) only.

#### 4.3.3 `state.md` → `memory/state.md`

The runtime state file moves under `memory/`. The state reader/writer ([src/runtime/state.ts](../../src/runtime/state.ts) — path to verify) updates its path resolution.

For migration: the doctor command moves the file in place when migrating an old harness. Old code paths that reference `<harnessDir>/state.md` are updated to reference `<harnessDir>/memory/state.md`. There is no deprecation grace for this — the rename is mechanical, the migration is automatic, and there's no risk of user content surprise (state.md is rarely hand-edited).

#### 4.3.4 Final layout

```
my-agent/
├── IDENTITY.md            # who the agent is (replaces CORE.md)
├── config.yaml            # config + MCP servers
├── rules/                 # always-loaded behavioral guidance
├── skills/                # Agent Skills bundles
├── instincts/             # (still present in spec #1; spec #2 folds into rules)
├── playbooks/             # (still present in spec #1; spec #2 folds into skills)
├── workflows/             # (still present in spec #1; spec #2 folds into skills with schedule trigger)
├── tools/                 # (still present in spec #1; spec #2 folds into skill scripts)
├── agents/                # (still present in spec #1; spec #2 folds into skills with subagent trigger)
└── memory/
    ├── state.md           # current runtime state (moved from top level)
    ├── sessions/
    ├── journal/
    └── scratch.md         # ephemeral working memory (existing, unchanged)
```

### 4.4 The `harness doctor` migration command

A new flag: `harness doctor --migrate`. Runs all migrations idempotently:

1. **Frontmatter migration for skills**:
   - Move `tags`, `status`, `author`, `created`, `updated`, `related` from top-level into `metadata.harness-*` (string-encoded).
   - Drop `id` if present (name is identity; if name is missing, derive from parent dir / filename).
   - Convert `allowed-tools` from array to space-separated string.
   - If a flat `skills/foo.md` exists, restructure to `skills/foo/SKILL.md` (move file, create directory).
   - Validate name against the spec character regex; if invalid, attempt slugify; if still invalid, report and skip the file with a clear error.
   - Validate `description` is present; if missing, generate from the body's first paragraph using `model.summary_model`. If `summary_model` is unset, skip with a warning.

2. **Frontmatter migration for non-skills**:
   - Same `id` removal (name as identity).
   - Same `allowed-tools` conversion.
   - Top-level extension fields stay top-level (no metadata move).
   - `description` generation if missing.

3. **L0/L1 stripping**:
   - Remove `<!-- L0: ... -->` and `<!-- L1: ... -->` HTML comments from the body.
   - If the file has no `description` in frontmatter and an L0 comment in the body, lift L0 into `description` before stripping.
   - If both exist, keep `description` as-is and just strip the comment.

4. **File renames**:
   - `CORE.md` → `IDENTITY.md` (if `IDENTITY.md` doesn't already exist).
   - Delete `SYSTEM.md` after extracting non-infrastructure content into `rules/operations.md`.
   - Move `state.md` → `memory/state.md` (creating `memory/` if absent).

5. **Reporting**: print a summary of changes per primitive, with file paths. Exit non-zero if any migration step failed (e.g., a description couldn't be generated and no fallback existed).

The command is idempotent: running it twice is a no-op the second time. It writes a `.harness-migration.log` at the harness root recording the migration version and date so we can detect re-migrations cleanly.

A separate `harness doctor --check` (existing flag, semantics tightened) just reports violations without writing.

### 4.5 Vendoring superpowers skills

Four skills from [obra/superpowers](https://github.com/obra/superpowers) are added as harness defaults under `defaults/skills/`:

- `brainstorming`
- `writing-plans`
- `executing-plans`
- `dispatching-parallel-agents`

#### 4.5.1 License audit (mandatory, per [user CLAUDE.md §10](https://CLAUDE.md))

Before pulling any content:

1. `gh api repos/obra/superpowers/license` — confirm root LICENSE is permissive (MIT, Apache-2.0, BSD-*, ISC, MPL-2.0, CC0-1.0, CC-BY-4.0, or Unlicense). If `null` or proprietary, abort and re-author from scratch.
2. For each skill directory, check for a sibling `LICENSE` / `LICENSE.txt` / `LICENSE.md` / `COPYING` that overrides. If any per-file LICENSE is proprietary or "all rights reserved," abort that skill and re-author.
3. Inspect each skill's frontmatter for a `license:` or `copyright:` field. If present and conflicts with the root, treat the file's claim as authoritative.

If audit passes, vendor the content with provenance frontmatter:

```yaml
metadata:
  harness-source: "https://github.com/obra/superpowers/blob/<commit-sha>/skills/<name>/SKILL.md"
  harness-source-commit: "<sha>"
  harness-license: "<spdx>"
  harness-license-source: "https://github.com/obra/superpowers/blob/<commit-sha>/LICENSE"
  harness-vendored-at: "2026-04-28"
```

#### 4.5.2 Adaptation

Pull the skills as-is structurally (`<name>/SKILL.md` plus any `scripts/` / `references/`), but:

- Strip references to obra/superpowers' own internal skills (e.g., a "see writing-plans" reference is fine — that's another vendored one — but a "see test-driven-development" reference is removed since we're not pulling that skill).
- Generic-ify any coding-flavored examples in skill bodies. The four chosen skills are already mostly domain-neutral, but spot-edits may be needed.
- Replace the user-facing references "claude-plugin", ".cursor-plugin", etc. with harness-native equivalents.
- Verify each skill's frontmatter conforms to the strict skill schema defined in §4.1.1 of this spec. Re-author if not.

#### 4.5.3 Templates exposure

The four vendored skills land under `defaults/skills/` and ship with the npm package via the `files` field in [package.json](../../package.json) (already includes `defaults`). They're available to every new harness via `harness init`.

Templates that already vendor extra content ([templates/dev/defaults/](../../templates/dev/defaults/)) are unchanged by this spec; their content is structural-migrated alongside the user-facing defaults.

## 5. Behavior changes (user-visible)

| Before | After |
|---|---|
| Skills can be flat `skills/foo.md` files | Skills must be `skills/foo/SKILL.md` bundles |
| `id` field in frontmatter | Dropped — `name` is the identity |
| `allowed-tools: [Read, Bash]` | `allowed-tools: "Read Bash"` |
| `tags: [foo, bar]` in skill frontmatter | `metadata.harness-tags: "foo,bar"` for skills (top-level still works for non-skill primitives) |
| Missing `description` is fine | `description` is required for skills (enforced); generated by doctor if missing |
| Malformed frontmatter loads silently with derived id | Malformed frontmatter is reported as an error, skipped, and surfaced by `harness doctor` |
| `<!-- L0: ... -->` / `<!-- L1: ... -->` in body | Stripped during migration; `description` is the discovery layer |
| `CORE.md` at harness root | `IDENTITY.md` at harness root; CORE.md still loaded with deprecation warning |
| `SYSTEM.md` at harness root | Deleted; non-infrastructure content moved to `rules/operations.md` |
| `state.md` at harness root | `memory/state.md` |

## 6. Implementation plan

Order matters — earlier steps are prerequisites for later ones.

### Phase 1: Schema & loader

| # | File | Change |
|---|---|---|
| 1.1 | [src/core/types.ts](../../src/core/types.ts) | Split `FrontmatterSchema` into `SkillFrontmatterSchema` (strict) and `NonSkillFrontmatterSchema` (permissive). Add validators for name regex, description length, compatibility length. Drop the `z.preprocess` slugify-from-name dance — replaced by the loader's normalization. Update `'allowed-tools'` to `z.string().optional()`. Update `metadata` to `z.record(z.string(), z.string())` for skills. |
| 1.2 | [src/primitives/loader.ts](../../src/primitives/loader.ts) | Add `normalize()` function (per §4.2.3). Switch schema based on `kind`. Drop `L0_REGEX`, `L1_REGEX`, `getAtLevel()`. Replace silent fallback with strict-error-or-lenient-warn behavior. Validate parent-dir match for skill bundles. Drop `BUNDLE_ENTRY_BY_KIND` for kinds we'll collapse in spec #2 (but keep in spec #1 since collapse is later). |
| 1.3 | [src/core/types.ts](../../src/core/types.ts) | Update `HarnessDocument` interface: drop `l0`/`l1`, add explicit normalized fields (`tags`, `status`, etc.) so consumers don't reach into `frontmatter.tags`. |
| 1.4 | All consumers of `doc.l0`, `doc.l1`, `doc.frontmatter.id` | Migrate to `doc.description`, `doc.body`, `doc.id` (the new top-level alias). Audit via `grep -r "\.l0\|\.l1\|\.frontmatter\.id" src/`. |

### Phase 2: System prompt assembler & state

| # | File | Change |
|---|---|---|
| 2.1 | [src/runtime/context-loader.ts](../../src/runtime/context-loader.ts) | Replace L0/L1/L2 budget logic with: load `IDENTITY.md` always, load every primitive's `description` always, load full body for `rules/` and `instincts/` always, load full body for `skills/playbooks/workflows/tools/agents/` only when activated (mechanism owned by spec #2). For now, keep loading at "L1" (description) for the discoverable kinds — spec #2 will tighten. |
| 2.2 | [src/runtime/context-loader.ts](../../src/runtime/context-loader.ts) | Add `IDENTITY.md` loader with `CORE.md` deprecation grace. |
| 2.3 | [src/runtime/state.ts](../../src/runtime/state.ts) | Update path resolution from `<dir>/state.md` to `<dir>/memory/state.md`. Add fallback that reads `<dir>/state.md` if `memory/state.md` doesn't exist (migration grace). |

### Phase 3: Doctor command

| # | File | Change |
|---|---|---|
| 3.1 | [src/runtime/doctor.ts](../../src/runtime/doctor.ts) (new or extend existing) | Implement `--check` (report violations) and `--migrate` (apply migrations idempotently). All migrations from §4.4. Write `.harness-migration.log` for re-migration detection. |
| 3.2 | [src/runtime/auto-processor.ts](../../src/runtime/auto-processor.ts) | Update on-save behavior to validate against the new strict schema for skills. Auto-fill `name` from parent dir, `description` from body's first paragraph (via summary_model). Stop generating SYSTEM.md content. |
| 3.3 | [src/cli/index.ts](../../src/cli/index.ts) | Wire `harness doctor --check` and `harness doctor --migrate` commands. |

### Phase 4: Defaults & templates migration

| # | File/Dir | Change |
|---|---|---|
| 4.1 | [defaults/skills/](../../defaults/skills/) | Convert each flat `.md` to a bundled `<name>/SKILL.md`. Spec-clean frontmatter. Body content is unchanged for now (rewrite is spec #3). Strip L0/L1 comments. |
| 4.2 | [templates/](../../templates/) | Each template's `CORE.md` → `IDENTITY.md`. Delete each template's `SYSTEM.md`. Ensure no template has top-level `state.md`; if any do, move under `memory/`. |
| 4.3 | [src/cli/scaffold.ts](../../src/cli/scaffold.ts) | Update scaffolding logic: emit `IDENTITY.md`, no `SYSTEM.md`, `memory/state.md` with default empty content. |

### Phase 5: Vendor superpowers skills

| # | Step | Notes |
|---|---|---|
| 5.1 | License audit | `gh api repos/obra/superpowers/license` + per-file LICENSE check + frontmatter inspection. Per §4.5.1. **Halt if proprietary.** |
| 5.2 | Pull skills | Copy `brainstorming`, `writing-plans`, `executing-plans`, `dispatching-parallel-agents` from upstream into [defaults/skills/](../../defaults/skills/). Preserve directory structure (SKILL.md + scripts/ + references/). |
| 5.3 | Adapt frontmatter | Conform to skill schema from §4.1.1. Add provenance metadata per §4.5.1. |
| 5.4 | Body adaptation | Strip references to non-vendored superpowers skills. Replace coding-flavored examples with neutral ones where they'd confuse a non-coding agent. |
| 5.5 | Add NOTICE entries | Append a vendored-content section to [NOTICE](../../NOTICE) with source URL, commit, license, copyright per the user's CLAUDE.md release discipline. |

### Phase 6: Documentation

| # | File | Change |
|---|---|---|
| 6.1 | [README.md](../../README.md) | Update "How it works" directory diagram (CORE→IDENTITY, no SYSTEM, state.md under memory/). Update "Frontmatter schemas" section to reflect strict skill spec. Remove L0/L1/L2 progressive disclosure references where they describe skill format (the harness's *internal* progressive loading is unchanged for now; spec #2 will revise). |
| 6.2 | [README.md](../../README.md) | Update "The 7 primitives" table (no change to the count yet — spec #2 collapses). Update "Frontmatter schemas" example to show the harness-prefixed metadata pattern. |
| 6.3 | New file: [docs/skill-authoring.md](../../docs/skill-authoring.md) | Authoring guide for spec-clean skills. Cross-link from README. Reference the [Agent Skills best practices](https://agentskills.io/skill-creation/best-practices) and [optimizing descriptions](https://agentskills.io/skill-creation/optimizing-descriptions). |

## 7. Tests

### 7.1 Schema tests

| Test | Asserts |
|---|---|
| `skill frontmatter — valid minimal` | `{ name, description }` only, parses cleanly |
| `skill frontmatter — name regex` | Rejects "PDF-Processing", "-pdf", "pdf--processing", "pdf-"; accepts "pdf-processing", "data-analysis" |
| `skill frontmatter — name length` | Accepts 1-char, 64-char; rejects 0-char, 65-char |
| `skill frontmatter — description length` | Accepts 1-char and 1024-char; rejects 0-char, 1025-char |
| `skill frontmatter — compatibility length` | Accepts up to 500; rejects 501+ |
| `skill frontmatter — allowed-tools shape` | Accepts `"Read Bash"`; rejects `["Read", "Bash"]` |
| `skill frontmatter — metadata strictness` | Accepts string→string; rejects nested objects, arrays |
| `skill frontmatter — extension fields rejected` | `tags`, `status`, `author` at top level fail validation in skill mode (with a helpful error pointing at the migrate command) |
| `non-skill frontmatter — extension fields accepted` | Same fields parse cleanly for rules/playbooks/etc. |

### 7.2 Loader tests

| Test | Asserts |
|---|---|
| `loader — strict mode reports errors` | Malformed skill frontmatter is in `errors`, not `docs` |
| `loader — lenient mode warns on cosmetic` | Name >64 chars warns and loads; missing description still errors and skips |
| `loader — parent-dir match enforced` | `skills/foo/SKILL.md` with `name: bar` errors |
| `loader — flat skill files error in strict mode` | `skills/foo.md` (flat) errors; offers migration message |
| `loader — L0/L1 comments ignored` | `<!-- L0: x -->` in body is preserved as raw text but does not populate any field |
| `loader — normalization layer` | Skill with `metadata.harness-tags: "a,b"` produces `doc.tags === ["a", "b"]` |
| `loader — name slugified from filename` | Flat `rules/foo.md` (no `name` in frontmatter) gets `name: 'foo'` |

### 7.3 Doctor migration tests

| Test | Asserts |
|---|---|
| `migrate — array allowed-tools to string` | `[Read, Bash]` → `"Read Bash"` |
| `migrate — top-level tags to metadata` | `tags: [foo]` in skill → `metadata: { harness-tags: "foo" }` |
| `migrate — flat skill to bundled` | `skills/foo.md` → `skills/foo/SKILL.md`; original deleted |
| `migrate — drop id field` | `id: foo, name: bar` → `name: bar` (id dropped) |
| `migrate — strip L0/L1 comments` | Body comments removed; if frontmatter description was missing, L0 lifted into it |
| `migrate — generate description` | Skill with no description gets one generated via summary_model |
| `migrate — CORE.md → IDENTITY.md` | File renamed; if both exist, IDENTITY wins and warning emitted |
| `migrate — SYSTEM.md deletion` | Custom content extracted to `rules/operations.md`; boilerplate dropped silently |
| `migrate — state.md → memory/state.md` | File moved; memory/ created if missing |
| `migrate — idempotent` | Running migrate twice produces identical output the second time |

### 7.4 End-to-end tests

| Test | Asserts |
|---|---|
| `e2e — old harness loads with deprecation warnings` | Pre-migration harness boots, runs, with stderr warnings about CORE.md and flat skills |
| `e2e — migrated harness loads cleanly` | Post-migration harness boots, runs, no warnings |
| `e2e — vendored superpowers skills load and trigger` | All four vendored skills are discoverable via their description |

## 8. Open questions and risks

### 8.1 Resolved during brainstorming

- **`AGENTS.md` vs `IDENTITY.md`**: resolved — `IDENTITY.md`. AGENTS.md is the coding-tool ecosystem standard; agent-harness is general-purpose. Confusion would code-stamp the project.
- **String-only metadata for skills**: resolved — comma-separated lists are accepted, with the loader splitting on parse. Spec compliance > type fidelity for skills.
- **Strict vs lenient validation**: resolved — strict by default, opt-in lenient mode for cross-client compatibility.
- **Deprecation grace for `CORE.md`**: resolved — yes, with stderr warning. No deprecation grace for `state.md` move (low risk of hand-edits).

### 8.2 Open

- **Should `skills-ref` be vendored or invoked as a subprocess for cross-validation?** Current plan: don't depend on it. The harness's own validator implements the spec. We can document `skills-ref validate <skill-dir>` as an optional external check in skill-authoring docs.
- **Versioning**: this is a breaking change. Bump from 0.8.0 to 0.9.0 (still pre-1.0) or jump to 1.0.0 to mark the alignment? Recommend 0.9.0 for spec #1, then 1.0.0 after spec #2 (the structural collapse). Final call deferred to release-time.

### 8.3 Risks

- **R1**: Auto-generation of `description` via `summary_model` may produce poor descriptions. Mitigation: doctor `--migrate` flags every auto-generated description with `metadata.harness-description-source: auto-generated` so the user can review and rewrite. The description-optimization eval framework in spec #4 is the long-term fix.
- **R2**: Users who have manually edited `state.md` will lose data if they don't migrate before upgrading. Mitigation: doctor performs a backup (`.harness-state-backup-<date>.md`) before any move.
- **R3**: Vendored superpowers skills may have subtle dependencies on superpowers-internal skills not being vendored. Mitigation: phase 5.4 audits each body for unresolved cross-skill references; the test suite in §7.4 verifies the vendored skills load and trigger in isolation.
- **R4**: The codebase has wide reach into `doc.frontmatter.id` and `doc.l0`/`doc.l1`. The audit (`grep -r "\.l0\|\.l1\|\.frontmatter\.id" src/`) is mandatory before merging — every callsite must migrate to the new accessor.

## 9. Backward compatibility & migration path

This is a breaking change. agent-harness is pre-1.0 and the README explicitly notes the format may evolve, so a hard cutover is acceptable. The strategy:

1. **0.9.0 release** (this spec): new schema, deprecation warnings for `CORE.md`, automatic in-place fallback for `state.md`, hard error for malformed skills (with migrate hint).
2. **0.9.x patch releases**: `harness doctor --migrate` matures, defaults migrate, superpowers skills land.
3. **1.0.0 release** (spec #2 complete): drop `CORE.md` deprecation grace, drop `state.md` fallback, collapse primitives.

Users on 0.8.x are expected to:
1. Upgrade the harness CLI: `npm install -g @agntk/agent-harness@0.9.0`
2. Run `harness doctor --check` to see what will change
3. Run `harness doctor --migrate` to apply
4. Commit the result

The migration is mechanical and reversible (the migration log records what changed, and the user has git for actual rollback).

## 10. Definition of done

- All schema and loader tests in §7 pass
- `harness doctor --check` reports clean on the migrated repo's own [defaults/](../../defaults/) and [templates/](../../templates/)
- `harness doctor --migrate` is idempotent (running twice leaves the filesystem unchanged on the second run)
- The four vendored superpowers skills load and trigger successfully against test prompts
- README updated, skill-authoring guide added
- A migration test fixture (an "old-shape" harness committed under `tests/fixtures/old-harness/`) successfully migrates and loads cleanly afterwards
- License audit complete; NOTICE updated; provenance frontmatter on every vendored file
- `npm test` passes
- `npm run lint` passes
- `npm run build` produces a working `dist/cli/index.js`
- A post-publish smoke test (per user's CLAUDE.md §10) verifies `harness --version`, `harness init test-agent`, and `harness doctor --check` on the scaffolded directory all succeed

---

*End of design.*
