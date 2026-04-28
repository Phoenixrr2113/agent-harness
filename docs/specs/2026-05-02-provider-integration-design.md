# Provider integration — design

**Date:** 2026-05-02
**Status:** Draft (pending review)
**Spec:** 5 of 5 in the Agent Skills alignment series
**Depends on:** 1, 2, 3, 4 (no further specs follow)

## 1. Goal

Make agent-harness a good citizen in projects that already use other agent tooling (Claude Code, OpenAI Codex, Cursor, GitHub Copilot, Gemini CLI). When `harness init` runs in a directory that contains those tools' configuration, detect them and offer to keep them in sync with the harness's content. Provide `harness export <provider>` as the canonical mechanism for adapting harness skills/rules into each provider's format. Treat the harness directory as the single source of truth and provider directories as generated artifacts; detect and surface drift when users edit the artifacts.

## 2. Non-goals

- Round-trip sync. Editing a provider's file does NOT propagate back into the harness — that's an unbounded merge problem and would put the harness in the position of arbitrating between conflicting tools' edits.
- Real-time bidirectional file watchers. Export runs on `harness dev` save events or on `harness export` invocations.
- Provider-specific runtime integration (e.g., having the harness's agent talk to Cursor's agent). This is content sync, not runtime interop.
- Authoring of provider-specific extensions or non-portable features. Export is best-effort; some skills won't translate to single-file Copilot or to Cursor's MDC, and the export reports what was lost in translation.

## 3. Background

### 3.1 The provider landscape

The Agent Skills [client showcase](https://agentskills.io/home#where-can-i-use-agent-skills) lists 40+ tools that adopt the spec. Most coding-focused tools converge on either the native Agent Skills format (Codex, Claude, OpenHands, Goose, OpenCode, etc.) or their own preexisting format (Cursor MDC, Copilot single-file). The five we target in this spec cover the meaningful surface area for most users:

| Provider | Skills directory | Skills format | Rules concept | Single-file fallback |
|---|---|---|---|---|
| Claude Code | `.claude/skills/<name>/SKILL.md` | Agent Skills (native) | None — uses CLAUDE.md | `CLAUDE.md` (project) |
| OpenAI Codex | `.codex/skills/<name>/SKILL.md` | Agent Skills (native) | None — uses AGENTS.md | `AGENTS.md` (project) |
| Cursor | `.cursor/rules/<name>.mdc` | Cursor MDC (frontmatter + body, different fields) | Rules ARE the format | n/a |
| GitHub Copilot | n/a | n/a | n/a | `.github/copilot-instructions.md` (single file) |
| Gemini CLI | `.gemini/extensions/<name>/` | Extension manifest + Skills | Mixed | `GEMINI.md` (project) |

Cross-tool convention: `.agents/skills/<name>/SKILL.md` is recognized by most Agent-Skills-aware tools per the [Adding skills support guide](https://agentskills.io/client-implementation/adding-skills-support#step-1-discover-skills). Exporting there gives broadest reach with single-format adaptation.

### 3.2 What we have today

`harness init` doesn't detect existing provider directories. There's no export mechanism. A user with `.claude/skills/` and a harness directory ends up maintaining two parallel sources of truth manually.

## 4. Design

### 4.1 Source-of-truth principle

The harness directory is the single canonical source. Provider directories are *generated artifacts*, similar to a `dist/` build output. Three rules follow:

1. **Generated files include a provenance marker.** Every exported file has a frontmatter or top-line marker:
   ```yaml
   metadata:
     harness-exported-from: "/path/to/harness/skills/research/SKILL.md"
     harness-exported-at: "2026-05-02T14:32:00Z"
     harness-exported-by: "agent-harness@<version>"
     harness-content-hash: "sha256:..."
   ```
   For provider formats that don't support frontmatter (`.github/copilot-instructions.md`), a comment block at the top serves the same purpose.

2. **Drift detection compares hash on read.** When `harness doctor` or `harness export` runs, it recomputes the hash of the generated content (excluding the provenance marker) and compares to the stored hash. Mismatches surface as drift warnings.

3. **Re-export overwrites silently when no drift is detected.** If drift is detected, the user is prompted before overwriting (or `--force` skips the prompt).

This is a CI-style "build artifacts in source control" pattern. Some users will commit `.claude/skills/` (so the directory works for non-harness-using teammates); others will gitignore it. Both are valid; the harness doesn't dictate.

### 4.2 Init detection

`harness init [<dir>]` scans the chosen directory for existing provider configuration:

- `.claude/` (Claude Code or general Anthropic tooling)
- `.codex/` (OpenAI Codex)
- `.cursor/` (Cursor)
- `.github/copilot-instructions.md` or `.github/instructions/` (GitHub Copilot)
- `.gemini/` (Gemini CLI)
- `.agents/` (cross-tool convention)
- `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` at the project root (single-file conventions)

If any are found, the user sees a prompt:

```
Detected existing agent tooling in this project:
  .claude/
  .github/copilot-instructions.md
  AGENTS.md (project root)

The harness can keep these in sync with your skills and rules:
  [a] Yes, sync to all detected tools (recommended)
  [b] Yes, but let me pick which ones
  [c] No, just create the harness alongside

Choice [a/b/c]: _
```

**Default**: prompted; non-TTY init defaults to (c) (skip sync to avoid surprises).

Affirmative answers write a `harness.export` block to [config.yaml](../../config.yaml):

```yaml
export:
  enabled: true
  targets:
    - provider: claude
      path: ".claude"
      auto: true        # re-export on harness dev save events
    - provider: copilot
      path: ".github/copilot-instructions.md"
      auto: true
  on_drift: warn         # 'warn' | 'fail' | 'ignore'
```

### 4.2.1 Subdirectory mode

If the chosen directory already has an `AGENTS.md` (or any of the project-level conventions), `harness init` defaults to scaffolding into a subdirectory (`.harness/` by default, configurable). The harness is then a *guest* in the project, not the project itself. The harness's IDENTITY.md is its own; the project's AGENTS.md is read at boot as additional context (loaded as if it were a rule named `project-context`).

If the chosen directory has none of those signals, the harness scaffolds at the root (current behavior).

### 4.3 Provider format adapters

Each provider has an adapter in [src/runtime/export/](../../src/runtime/export/) implementing a uniform interface:

```typescript
interface ProviderAdapter {
  name: 'claude' | 'codex' | 'cursor' | 'copilot' | 'gemini' | 'agents';
  exportSkill(skill: HarnessDocument, bundleDir: string, targetDir: string): Promise<ExportReport>;
  exportRule(rule: HarnessDocument, targetDir: string): Promise<ExportReport>;
  exportIdentity(identity: string, state: AgentState, rules: HarnessDocument[], targetDir: string): Promise<ExportReport>;
  detectDrift(targetDir: string): Promise<DriftReport>;
}

interface ExportReport {
  written: string[];           // file paths created/updated
  skipped: { path: string; reason: string }[];  // not applicable / not supported
  warnings: string[];          // lossy translations
}
```

#### 4.3.1 Claude / Codex / Agents (native)

These providers natively support Agent Skills. Export is essentially `cp -r`:

- Skills: `cp skills/<name>/ <target>/skills/<name>/`
- Frontmatter: copy verbatim; provenance metadata added to the `metadata` block
- Bundle resources (`scripts/`, `references/`, `assets/`): copy verbatim
- Identity: write a project-level `CLAUDE.md` / `AGENTS.md` containing IDENTITY.md content + a "## Rules" section concatenating all active rules

For `.agents/skills/`, identity goes into a sibling `AGENTS.md` at the project root.

#### 4.3.2 Cursor

Cursor uses `.cursor/rules/*.mdc` files. Format ([Cursor docs](https://cursor.com/docs/context/skills) — verify at implementation):

```
---
description: When to use this rule
globs: ["**/*.ts"]
alwaysApply: false
---

[body]
```

Adapter mapping:

| harness | cursor mdc |
|---|---|
| `name` | derived from filename |
| `description` | `description` |
| skill body | body |
| `metadata.harness-trigger: prepare-call` | rule with `alwaysApply: true` |
| (regular skill, no trigger) | rule with `alwaysApply: false` |
| `scripts/` | not directly supported; included as code blocks in body when small enough; otherwise warned and dropped from the export |

Lossy. The export report enumerates which scripts couldn't be embedded.

#### 4.3.3 Copilot

GitHub Copilot uses `.github/copilot-instructions.md` (single file, the entire instructions concatenated). Adapter strategy:

```markdown
<!--
This file is auto-generated by agent-harness@<version>.
Source: <harness-path>
Generated at: <timestamp>
Hash: sha256:...
-->

# Project guidance for Copilot

## Identity

[IDENTITY.md content]

## Rules

[concatenated rule bodies]

## Skills

The following skills are available:

### research
[research SKILL.md description and body]

### delegate-to-cli
[delegate-to-cli SKILL.md description and body]

...
```

This is highly lossy. Scripts can't run from inside Copilot. The exporter notes script availability ("This skill includes scripts at <path>; run them via your shell when needed") but Copilot's runtime won't invoke them.

Body length is the main constraint — Copilot has limits on instruction file size. The exporter enforces a configurable cap (default 32k tokens) and warns on overflow, prioritizing rules > IDENTITY > skill descriptions > skill bodies.

#### 4.3.4 Gemini

Gemini CLI uses `.gemini/extensions/<name>/` with a manifest format ([Gemini docs](https://geminicli.com/docs/cli/skills/) — verify at implementation). Adapter likely:

- Each skill becomes an extension with a manifest pointing to the SKILL.md
- Bundle resources copied
- Identity: written to `GEMINI.md` at project root

Implementation requires verifying the current Gemini extension schema; the spec leaves the exact mapping as a phase-29 task with verification of the schema as the first step.

### 4.4 The `harness export` command

```
harness export [<provider>] [options]
```

Without `<provider>`: exports to every target listed in `config.yaml: export.targets`.

With `<provider>`: exports only to that provider, regardless of config.

Options:
- `--target <path>`: override target directory
- `--force`: skip drift confirmation
- `--dry-run`: print what would be written without writing
- `--no-auto`: disable auto-export for this provider in config (for one-time exports)

Output format:

```
Exporting to claude (.claude/):
  ✓ skills/research/ (12 files)
  ✓ skills/delegate-to-cli/ (5 files)
  ⚠ skills/dispatching-parallel-agents/: scripts/run.sh referenced but unsupported by claude format (script preserved in skills/dispatching-parallel-agents/scripts/, available via shell)
  ✓ CLAUDE.md (rules + identity)

Drift detected on:
  .claude/skills/research/SKILL.md (hash mismatch — was edited externally)

Use --force to overwrite, or run `harness export --dry-run` to see the diff.
```

### 4.5 Auto-export on `harness dev`

When `harness dev` is running and a skill or rule is saved, the file watcher invokes the configured exports. The user sees a one-line per export in the dev mode output:

```
[file] skills/research/SKILL.md changed
[export] claude: 1 file written
[export] copilot: 1 instructions file regenerated
```

If `auto: true` is not set on a target, the watcher does not export there even when the source changes; `harness export` runs that target manually.

Auto-export respects drift: if a drift is detected, the auto-export pauses for that target and surfaces a notification. The user runs `harness export --force` (or hand-resolves the drift) to resume.

### 4.6 Drift detection

`harness doctor --check-drift` (or as part of regular `harness doctor`) walks every configured target, recomputes hashes of generated files (excluding the provenance markers themselves), and compares to the stored hash.

Possible findings:

| Finding | Doctor output |
|---|---|
| Provider file matches stored hash | (silent — no message) |
| Provider file differs but provenance marker is intact | Warn: "drift detected — file edited externally" |
| Provider file lacks provenance marker entirely | Warn: "no provenance marker — pre-existing or hand-authored; cannot detect drift" |
| Provider file is missing | Warn: "expected output not present — re-export to restore" |
| Source file (in harness dir) is missing but export exists | Warn: "orphan export — source skill removed; clean up via `harness export --prune`" |

`harness export --prune` removes orphan exports (provider files whose source skill no longer exists in the harness dir).

### 4.7 Identity export specifics

When exporting identity files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`):

1. The harness's [IDENTITY.md](../../IDENTITY.md) content goes at the top under `## Identity`.
2. All active rules go under `## Rules`, alphabetical by name, concatenated bodies.
3. Skills are NOT inlined here for `CLAUDE.md` / `AGENTS.md` — they live in `.claude/skills/` / `.agents/skills/` as separate files.
4. For `copilot-instructions.md`, skills ARE inlined since there's no separate file mechanism.
5. The provenance marker is the first thing in the file (HTML comment for markdown).

If a project-root `AGENTS.md` already exists and the user's harness is in a subdirectory (per §4.2.1), the harness does NOT overwrite it. Instead, it offers to APPEND a section: `## Auto-managed by agent-harness` containing a delimited block. Re-exports update the delimited block in place. The user retains full control of the rest of the file.

### 4.8 Handling external edits gracefully

When a user explicitly wants to edit an exported file (because the provider's runtime is showing them the file and they want to tweak it for that provider only):

1. The exporter writes a `.harness-export-pinned` sibling marker file with the original hash.
2. The user edits the provider file.
3. On next `harness export`, the harness detects: file modified, marker present.
4. Doctor message: "Pinned exception detected on `.claude/skills/research/SKILL.md`. Run `harness export --force` to discard, or `harness export --resync-from <provider>` to pull the changes back into the harness."
5. `--resync-from` is an opt-in mechanism that the user invokes manually for a single file, with a clear diff preview before applying. We do this only for skills with native frontmatter (Claude/Codex/Agents); for Cursor MDC and Copilot we don't resync (the format translation is too lossy).

## 5. Behavior changes (user-visible)

| Before | After |
|---|---|
| Users with `.claude/skills/` and a harness maintain two parallel sources | `harness export` syncs the harness as canonical to provider dirs |
| `harness init` ignores existing tooling | Detects `.claude/`, `.cursor/`, `.gemini/`, `.github/copilot-instructions.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`; offers sync setup |
| No way to maintain Copilot instructions from harness skills | `harness export copilot` produces a single concatenated `.github/copilot-instructions.md` |
| No way to ship harness-authored skills to Cursor | `harness export cursor` produces `.cursor/rules/*.mdc` (with format-loss warnings where applicable) |
| Editing an exported file silently re-overwritten on next export | Drift detection warns; user opts in to overwrite |

## 6. Implementation plan

Phase numbers continue from spec #4.

### Phase 25: Adapter framework

| # | File | Change |
|---|---|---|
| 25.1 | [src/runtime/export/types.ts](../../src/runtime/export/types.ts) (new) | `ProviderAdapter` interface, `ExportReport`, `DriftReport` |
| 25.2 | [src/runtime/export/registry.ts](../../src/runtime/export/registry.ts) (new) | Adapter registration; `getAdapter(name)`, `listAdapters()` |
| 25.3 | [src/runtime/export/runner.ts](../../src/runtime/export/runner.ts) (new) | Top-level `runExport(harnessDir, target, options)` orchestrator |
| 25.4 | [src/core/types.ts](../../src/core/types.ts) | Add `export` config block schema to `HarnessConfigSchema` |

### Phase 26: Native Agent-Skills adapters

| # | File | Change |
|---|---|---|
| 26.1 | [src/runtime/export/adapters/claude.ts](../../src/runtime/export/adapters/claude.ts) (new) | Skills copy + CLAUDE.md generation + provenance markers + drift detection |
| 26.2 | [src/runtime/export/adapters/codex.ts](../../src/runtime/export/adapters/codex.ts) (new) | Same pattern, AGENTS.md instead of CLAUDE.md |
| 26.3 | [src/runtime/export/adapters/agents.ts](../../src/runtime/export/adapters/agents.ts) (new) | `.agents/skills/` cross-tool convention |

### Phase 27: Lossy adapters

| # | File | Change |
|---|---|---|
| 27.1 | [src/runtime/export/adapters/cursor.ts](../../src/runtime/export/adapters/cursor.ts) (new) | MDC format conversion; verify Cursor's current schema first |
| 27.2 | [src/runtime/export/adapters/copilot.ts](../../src/runtime/export/adapters/copilot.ts) (new) | Single-file concatenation; configurable token cap; ordering policy |
| 27.3 | [src/runtime/export/adapters/copilot.ts](../../src/runtime/export/adapters/copilot.ts) | Test against actual `.github/copilot-instructions.md` size limits |

### Phase 28: Gemini

| # | File | Change |
|---|---|---|
| 28.1 | Verification | Read current Gemini CLI extension schema documentation; confirm format before designing the adapter |
| 28.2 | [src/runtime/export/adapters/gemini.ts](../../src/runtime/export/adapters/gemini.ts) (new) | Adapter per the verified schema |

### Phase 29: Init detection

| # | File | Change |
|---|---|---|
| 29.1 | [src/cli/scaffold.ts](../../src/cli/scaffold.ts) | Detect provider directories at init time; prompt for sync setup; write `export` config block to config.yaml |
| 29.2 | [src/cli/scaffold.ts](../../src/cli/scaffold.ts) | Subdirectory mode when project root has existing `AGENTS.md`/`CLAUDE.md`/etc. |
| 29.3 | [src/runtime/context-loader.ts](../../src/runtime/context-loader.ts) | When in subdirectory mode, load project-root `AGENTS.md` as a synthetic rule named `project-context` |

### Phase 30: CLI

| # | File | Change |
|---|---|---|
| 30.1 | [src/cli/index.ts](../../src/cli/index.ts) | `harness export [<provider>] [options]` command |
| 30.2 | [src/cli/index.ts](../../src/cli/index.ts) | `harness export --prune` for orphan cleanup |
| 30.3 | [src/cli/index.ts](../../src/cli/index.ts) | `harness export --resync-from <provider>` for pinned exceptions (native adapters only) |
| 30.4 | [src/runtime/dev.ts](../../src/runtime/dev.ts) (or wherever `harness dev` lives) | Wire auto-export into the file watcher; surface per-export status |

### Phase 31: Doctor integration

| # | File | Change |
|---|---|---|
| 31.1 | [src/runtime/doctor.ts](../../src/runtime/doctor.ts) | Add drift detection across all configured export targets; report findings per §4.6 |
| 31.2 | [src/runtime/doctor.ts](../../src/runtime/doctor.ts) | `harness doctor --check-drift` standalone subcommand |

### Phase 32: Documentation

| # | File | Change |
|---|---|---|
| 32.1 | [README.md](../../README.md) | New "Provider integration" section |
| 32.2 | [docs/provider-integration.md](../../docs/provider-integration.md) (new) | Per-provider docs: format mapping, supported features, known limitations, drift handling |

## 7. Tests

### 7.1 Adapter tests (per provider)

| Test | Asserts |
|---|---|
| `claude — skill copy roundtrip` | Skill written to `.claude/skills/<name>/SKILL.md` matches source byte-for-byte (modulo provenance metadata) |
| `claude — CLAUDE.md generation` | Identity + rules concatenated correctly with provenance header |
| `codex — same as claude with AGENTS.md` | Same shape, different filename |
| `cursor — MDC frontmatter mapping` | Skill description maps to MDC `description`; harness-trigger maps to `alwaysApply` |
| `cursor — large-script warning` | Skill with a 10KB script produces a warning that the script wasn't embedded |
| `copilot — concatenated single file` | Output contains identity + rules + skill descriptions in priority order |
| `copilot — token cap respected` | When skills exceed cap, ordering policy applied; warning emitted |
| `agents — cross-tool convention` | Output goes to `.agents/skills/` and project-root `AGENTS.md` |

### 7.2 Init detection

| Test | Asserts |
|---|---|
| `init — detects existing .claude/` | Prompt offered; affirmative answer writes config |
| `init — detects multiple providers` | All listed in prompt; user can pick subset |
| `init — non-TTY skips sync` | Non-interactive init doesn't prompt; defaults to no sync |
| `init — subdirectory mode when AGENTS.md exists` | Harness scaffolds into `.harness/` subdirectory; project AGENTS.md untouched |

### 7.3 Drift detection

| Test | Asserts |
|---|---|
| `drift — clean state silent` | No drift, no message |
| `drift — external edit detected` | Edit to a generated file surfaces warning |
| `drift — missing provenance marker` | File without marker reported as "cannot detect drift" |
| `drift — orphan export found` | Source removed but export remains; reported and prunable |
| `drift — pinned exception path` | After `--harness-export-pinned`, hash mismatch is silent until force/resync |

### 7.4 Auto-export

| Test | Asserts |
|---|---|
| `auto-export — fires on save` | Saving a SKILL.md with auto: true triggers export |
| `auto-export — pauses on drift` | Drift on target halts auto-export; manual resolve required |
| `auto-export — auto: false skipped` | Target without auto flag isn't touched on save |

### 7.5 End-to-end

| Test | Asserts |
|---|---|
| `e2e — init in fresh project, no existing tools` | Standard scaffold; no prompt |
| `e2e — init in project with .claude/, .github/, AGENTS.md` | Prompt; affirmative; config written; first export populates all three |
| `e2e — edit-and-resync flow` | User edits `.claude/skills/research/SKILL.md`; pin marker written; `--resync-from claude` pulls changes back; subsequent exports succeed |

## 8. Open questions and risks

### 8.1 Resolved during brainstorming

- **Round-trip vs. one-way**: resolved — one-way (harness → providers). `--resync-from <provider>` is the explicit, opt-in escape hatch for native adapters only.
- **Subdirectory vs. root scaffolding when project has existing AGENTS.md**: resolved — subdirectory; harness reads project AGENTS.md as a synthetic project-context rule.
- **Should provider files be gitignored**: not dictated; user choice. Harness doesn't write `.gitignore` entries for them.

### 8.2 Open

- **Cursor MDC schema verification**: their docs at [cursor.com/docs/context/skills](https://cursor.com/docs/context/skills) are the authoritative source. Phase 27.1 starts with reading the current schema. The mapping in §4.3.2 may need adjustment.
- **Gemini extension schema verification**: same — phase 28.1 verifies before designing the adapter. The mapping in §4.3.4 is a placeholder.
- **Copilot token cap default**: 32k tokens is a guess. Verify against current Copilot limits at implementation time. Configurable per-target so users can tighten if their Copilot instance enforces less.
- **Should the harness offer to read non-export-source AGENTS.md content automatically?**: i.e., when a user has a hand-authored project-root `AGENTS.md` that contains build commands, should the harness inject that into its agent's context? Currently we read it as a synthetic rule (per §4.2.1 / §29.3). Some users may not want that. Add a config flag: `loader.read_project_agents_md: true` (default) | `false`. Surface in init prompt.

### 8.3 Risks

- **R1**: Cursor and Gemini schemas evolve. Mitigation: adapters are versioned (`adapter.schemaVersion`); doctor warns when an adapter's stored schemaVersion lags the upstream provider's current version (manual check, not auto-fetched).
- **R2**: Copilot's single-file concatenation may produce a file the user can't read or edit cleanly. Mitigation: ordering is deterministic, sections are clearly delimited, the provenance comment is prominent, and `harness export copilot --dry-run` prints a preview.
- **R3**: Auto-export adds latency to `harness dev` save events. Mitigation: exports run async and don't block the save; per-target timeout (default 5s); failures are warnings, not fatal.
- **R4**: Pinned-exception flow is subtle. Users may forget they pinned a file and be confused when changes don't propagate. Mitigation: doctor lists all pinned files prominently; weekly reminder if pinned files exist; `harness export --list-pinned`.
- **R5**: Some users will commit provider files to git, others won't. The repo will see merge conflicts on auto-generated files. Mitigation: document the choice clearly; recommend gitignore; provide `--prune` to clean up after teammates with different setups; provide a deterministic, byte-stable export so identical sources produce identical outputs (no timestamp churn, no ordering instability).

## 9. Backward compatibility

This spec adds new functionality. Existing harnesses without `export` config in `config.yaml` are unaffected. `harness init` behavior changes for users in projects with existing tooling, but the prompt makes the change opt-in.

## 10. Definition of done

- All adapter tests in §7 pass
- `harness export claude` round-trips a default skill cleanly
- `harness export copilot` produces a working `.github/copilot-instructions.md` for a fresh harness
- `harness export cursor` translates skill bundles to MDC with documented warnings on lossy parts
- `harness init` in a project with `.claude/` correctly detects, prompts, and configures sync
- `harness doctor --check-drift` correctly reports modified, missing, and orphan exports
- Auto-export fires on `harness dev` save events without blocking
- Pinned-exception flow tested end-to-end (edit, pin, resync, force-overwrite)
- README and provider-integration docs updated
- `npm test` passes
- `npm run lint` passes
- Post-publish smoke test verifies `harness init test-agent`, `harness export claude`, `harness doctor --check-drift` all run cleanly on a freshly-installed package

---

*End of design.*
