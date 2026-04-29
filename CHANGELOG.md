# Changelog

All notable changes to `@agntk/agent-harness` are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

> **Migrating from 0.8.x?** See [Upgrading from 0.8.x](#upgrading-from-08x) at the bottom of this file. The 0.9 → 0.15 series brings substantial breaking changes alongside an automated migration path (`harness doctor --migrate`).

## [0.15.0] — 2026-04-29

Round-3 deep e2e fixes. Thirteen findings (D1–D15) from manual end-to-end testing of v0.14.1 — every fix verified against its exact original failure scenario before merging.

### Added

- `harness mcp test <name>` accepts the server name as a positional argument (D10). The `--server <name>` flag continues to work for backward compat.
- `harness doctor --check-drift` exit path emits the project-root resolution path so users can tell where the export was looked up.
- Trigger-script error messages (`prepare-call`, `prepare-step`, `step-finish`, `run-finish`) now include the absolute path to the skill's `scripts/` directory so users can navigate directly to the failing file (D12).
- New `derivePlaybookDescription()` migration helper auto-generates a skill description from a legacy playbook's first H1 or prose line (D1). Falls back to a `[TODO: review and rewrite] migrated from legacy playbook ...` placeholder when neither is usable, so the file is discoverable in audit and doctor output.
- New `isScriptFile()` helper in `src/runtime/doctor.ts` and `shouldBeExecutable()` helper in `src/cli/scaffold.ts` distinguish actual scripts from templates and assets that happen to live in `scripts/` (D4).

### Changed (Breaking)

- **`harness dev` no longer regenerates `SYSTEM.md`.** Spec #1 (v0.9.0) deleted SYSTEM.md as legacy infrastructure documentation, but dev mode was silently re-creating it on every startup. It is now permanently gone (D5). Users who explicitly want it can still run `harness system` to generate it on demand.
- **`harness dev` no longer starts the web dashboard by default.** Was an opt-out (`--no-web`); is now opt-in (`--web`) (D6). The watcher and scheduler still start as before. Pass `--web` to also boot the dashboard.
- **`harness dev --web` default port is 8080**, matching `harness serve` (was 3000/3001) (D7).
- **`harness init <dir>` now scaffolds into an existing empty (or non-harness) directory.** Was rejected with `Directory already exists` (D2). Init now blocks only when the target already contains a harness (signaled by `IDENTITY.md`, `CORE.md`, or `config.yaml`).
- **Missing `IDENTITY.md` is no longer silent.** `loadIdentity()` emits `[warning] No IDENTITY.md found at ...` to stderr on every command, and `harness info` prints a prominent `⚠ IDENTITY.md is missing` line (D11). A harness with no identity used to boot silently with an empty system prompt — now you'll see it.

### Fixed

- Fresh `harness init` ships with `+x` set on every script under `defaults/skills/<name>/scripts/` (D3). Was producing 16 `NOT_EXECUTABLE` doctor errors on every fresh install because npm tarballs don't preserve POSIX exec bits reliably.
- `harness doctor --check` no longer flags `frame-template.html` (or any other non-script file in `scripts/`) as `NOT_EXECUTABLE` or `HELP_NOT_SUPPORTED` (D4). The lints now apply only to files with executable extensions (`.sh`, `.py`, `.js`, `.ts`, `.rb`, `.pl`, `.bash`, `.zsh`, `.fish`) or files with a shebang.
- `harness serve` POST `/api/run` now wraps the upstream "No API key found" provider error with a hint pointing at the local-Ollama fallback (D9). REST API users no longer get a bare provider error with no remediation path.
- `harness learn` now reads instinct candidates from the journal first via `harvestInstincts`; falls back to a fresh LLM extraction only when the journal has none (D13). Was running the LLM unconditionally and often returning "No candidates found" while the journal had visible candidates.
- `harvestInstincts` and the journal extractor tolerate `- - INSTINCT:` (double-dash) bullets that some synthesizer models emit (D14). Was producing 0 candidates from journals with 3 visible candidates.
- The journal synthesis prompt explicitly forbids double-dash bullets and sub-points (D15) — defense in depth on top of D14's parser tolerance.
- `harness doctor --migrate` filling a description into legacy `playbook → skill` migration so the resulting skill is spec-compliant (D1). Was producing skills with empty descriptions that triggered `DESCRIPTION_TOO_SHORT` warnings.

## [0.14.1] — 2026-04-29

Round-2 polish from manual e2e testing of v0.14.0.

### Added

- `harness scratch` (no positional argument) shows current scratch contents instead of erroring (N1). Same behavior as `harness scratch --show`.
- `harness scratch --show` works without requiring a note argument (N2).
- New `resolveTargetDir(harnessDir, provider, targetPath?)` helper in `src/runtime/export/runner.ts` anchors relative target paths at the project root. Public re-export so external scripts can use it.

### Changed (Breaking)

- **Provider export targets resolve relative to the project root, not `process.cwd()`** (N3+N4). For project-resident installs (`<project>/.harness/`), `harness export agents` now correctly writes skills to `<project>/.agents/skills/` instead of `<project>/.harness/.agents/skills/`. Relative `path:` values in `config.yaml: export.targets` resolve the same way; `harness export` and `harness doctor --check-drift` work identically regardless of cwd.

### Fixed

- `harness scratch` with no args no longer fails with `error: missing required argument 'note'`.

## [0.14.0] — 2026-04-29

Round-1 polish from the post-spec-#5 manual end-to-end (8 fixes B1–B8). Some fixes add new behavior — minor bump.

### Added

- `harness init` now warns when no API key is detected for the default openrouter+anthropic model and points at the local Ollama setup path (B2).
- `harness init` detects existing provider tooling at the project root (`.claude/`, `.cursor/`, `.gemini/`, `.codex/`, `.agents/`, `.github/copilot-instructions.md`, `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`) and prompts to wire `harness export` targets into `config.yaml` (B7). Idempotent and skipped on non-TTY.
- `harness doctor --migrate` and `harness doctor --fix` accept `--dry-run` to preview changes without applying (B3).
- `harness export` recognizes a per-provider default target map: `claude` → `.claude`, `codex` → `.codex`, `cursor` → `.cursor`, `copilot` → **`.github`**, `gemini` → `.gemini`, `agents` → `.agents` (B5).
- New `defaultTargetFor(provider)` and `detectProjectRoot(harnessDir)` exports in `src/runtime/export/runner.ts`.
- `ExportContext` gains a `projectRoot` field (B6) — set by the runner via `detectProjectRoot()`. Adapters that write project-level files (`AGENTS.md`, `GEMINI.md`) use `ctx.projectRoot`; those writing per-provider artifacts (CLAUDE.md, Cursor MDC) use `ctx.targetDir`.
- New `evalsCoverage` doctor lint warns when a default skill lacks `evals/triggers.json`.
- New `scripts/check-default-evals.ts` validator (run via `npm run check:evals`).

### Changed (Breaking)

- **`harness export copilot` now writes to `.github/copilot-instructions.md`** instead of `.copilot/copilot-instructions.md` (B5). Other agent tools look at `.github/`, so the old path was wrong.
- **Provenance markers on exported provider files now report the running CLI's actual version** (e.g. `agent-harness@0.14.0`) instead of `agent-harness@unknown` (B4). Multi-path `package.json` walk per the rules in `CLAUDE.md §10`.
- **Scaffold no longer creates legacy primitive directories.** `harness init` previously created `agents/`, `instincts/`, `playbooks/`, `tools/`, `workflows/` directories (collapsed in spec #2 / v0.10.0). Fresh harnesses now have only `rules/`, `skills/`, `intake/`, `memory/sessions/`, `memory/journal/` (B1). Pre-existing harnesses are unaffected; `harness doctor --migrate` still cleans up empty legacy directories.
- **The `agents` and `gemini` adapters preserve user-authored `AGENTS.md` / `GEMINI.md` via a delimited auto-managed block** instead of clobbering (B8). Re-exports update the block in place; user content outside the block is untracked. Drift detection compares only the block contents.

### Fixed

- A pre-existing test fixture drift in `tests/integration/learning-loop.e2e.test.ts` (it expected 4 default instincts at baseline but `defaults/instincts/` was removed in v0.10.0). Test now uses `existsSync` guard; verifies count-increase rather than absolute baseline.

## [0.13.0] — 2026-04-29

Spec #5 (5 of 5 in the Agent Skills alignment series). Provider integration: `harness export <provider>` and friends.

### Added

- New `harness export [provider]` CLI command supporting six providers:
  - `claude` → `.claude/skills/<name>/SKILL.md` + `.claude/CLAUDE.md`
  - `codex` → `.codex/skills/<name>/SKILL.md` + `.codex/AGENTS.md`
  - `agents` (cross-tool convention) → `.agents/skills/<name>/SKILL.md` + project-root `AGENTS.md`
  - `cursor` → `.cursor/rules/<name>.mdc` (MDC format, lossy with documented warnings)
  - `copilot` → `.github/copilot-instructions.md` (single concatenated file, lossy)
  - `gemini` → `.gemini/extensions/<name>/gemini-extension.json` + `SKILL.md` + project-root `GEMINI.md`
- Flags: `--target <path>`, `--force`, `--dry-run`, `--prune`, `--resync-from <provider> --resync-file <path>` (native adapters only).
- Provenance markers on every generated file (frontmatter or HTML comment) carrying sha256 content hash for drift detection.
- New `harness doctor --check-drift` flag — runs `runDrift` for each configured target and reports drift per finding kind: `modified`, `missing-marker`, `missing-file`, `orphan`.
- `src/runtime/export/`: adapter framework (`types.ts`, `registry.ts`, `runner.ts`, `provenance.ts`, `identity-output.ts`); 6 adapters under `adapters/`; `barrel module index.ts` auto-registers all adapters.
- `ExportConfigSchema` added to `HarnessConfigSchema` — users add an `export:` block to `config.yaml` with `enabled`, `targets`, `on_drift` fields.
- New `detectExistingProviders(projectRoot)` and `decideScaffoldLocation(projectRoot)` helpers in `src/cli/scaffold.ts` (used by v0.14.0's init wiring).
- New `loadProjectContextRule(harnessDir)` helper in `src/runtime/context-loader.ts` — synthetic `project-context` rule that loads project-root `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` for project-resident harnesses.
- New `docs/provider-integration.md` (~516 lines) — full reference for the export system, format mappings, drift detection, troubleshooting.

### Changed (Breaking)

- **The pre-existing `harness export <output.json>` (JSON portability bundle) is renamed to `harness export-bundle <output.json>`** to free up the `export` verb for provider integration. Existing scripts that ran `harness export bundle.json` need to be updated. Same behavior; only the verb changed.

### Verified upstream schemas

- Cursor MDC: `globs` is a comma-separated string (not an array as the design assumed), per [cursor.com/docs/context/rules](https://cursor.com/docs/context/rules).
- Gemini CLI extensions: manifest filename is `gemini-extension.json` (not `manifest.json`), required fields `name` and `version`, per [geminicli.com/docs/extensions](https://geminicli.com/docs/extensions/writing-extensions).

## [0.12.0] — 2026-04-29

Spec #4 (4 of 5). Skill evals — trigger reliability + quality benchmarking + optimization loops + auto-promotion gate.

### Added

- New `harness skill eval-triggers <name>` — runs the skill's `evals/triggers.json` against the model, reports per-query pass/fail, computes a 0.5 trigger-rate threshold per query.
- New `harness skill eval-quality <name>` — runs each `evals/evals.json` test case with-skill vs without-skill, captures outputs and timing, grades via code-checks (file-exists, valid-JSON) or LLM judge fallback, writes `benchmark.json` per iteration.
- New `harness skill optimize-description <name>` — iteration loop that proposes revised descriptions via `summary_model`, picks the iteration with the highest validation pass-rate, applies on success (or `--dry-run`).
- New `harness skill optimize-quality <name>` — iteration loop for refining skill body against quality eval signals.
- New `harness rules promote <candidate-id>` — gates promotion of agent-learned rules through trigger eval + quality eval; `--no-eval-gate` bypasses for power users.
- `evals/triggers.json` schema (Zod) — array of `{ id, query, should_trigger, split, notes? }` entries with 1–500 char queries.
- `evals/evals.json` schema (Zod) — `{ skill_name, evals: [{ id, prompt, expected_output, files?, assertions }] }`.
- Default eval coverage: every default skill ships with `evals/triggers.json` (20 queries: 10 should-trigger + 10 should-not-trigger, 60/40 train/validation split). Three high-effort defaults (`delegate-to-cli`, `daily-reflection`, `ship-feature`) also ship with `evals/evals.json` (3 test cases each).
- New `evalsCoverage` doctor lint warns when a default skill lacks `evals/triggers.json`.
- New `scripts/check-default-evals.ts` validator — runs via `npm run check:evals` to verify every default skill's eval files match the schema.
- New `docs/skill-evals.md` (~483 lines) — full reference for the eval system.
- New `<harness-dir>/.evals-workspace/` directory for eval reports (gitignored automatically on first run).

### Changed (Breaking)

- **`harness rules promote` is now the gated path for agent-learned rules.** It writes `rules/<id>.md` with `author: agent` frontmatter (Agent Skills compatible). The legacy `harness learn --install` flow still writes to `instincts/` (preserved for backward compat); spec #4 added the gated path as a new concept rather than changing the legacy flow.
- **The promotion gate's `runTriggerEval`/`runQualityEval` are deliberately optimistic stubs** in v0.12.0 (always return passing/positive). The framework + CLI + audit trail are real; the live signal is a stub. Documented under "Limitations" in `docs/skill-evals.md`.

## [0.11.0] — 2026-04-29

Spec #3 (3 of 5). Skill content rewrite + script feedback contract + doctor lints.

### Added

- New `harness skill new <name>` — scaffolds a compliant skill bundle (`SKILL.md`, `scripts/run.sh`, `references/REFERENCE.md`, `assets/template.md`).
- New `harness skill validate <name>` — runs all skill+script lints against a single skill, returns exit-code-friendly findings.
- New doctor lint registry with eight lints:
  - **Skill lints (4):** description-quality (≥80 chars + imperative phrasing), body-length (≤2000 lines), referenced-files-exist, required-sections-present.
  - **Script lints (4):** shebang, executable bit, `--help` support, no-interactive-prompt.
- New script feedback contract: scripts return JSON on stdout with `{ status: 'ok'|'error'|'blocked', result?, error?, next_steps?, metrics?, artifacts? }`. Documented in `docs/skill-authoring.md`.
- Templates for `harness skill new` under `templates/skill-bundle/`.
- Default skills rewritten as proper bundles with structured-output scripts: `delegate-to-cli` (canonical), `daily-reflection`, `ship-feature`.

### Changed

- `harness doctor` now runs the full lint registry on every skill bundle and surfaces findings categorized by severity (error/warn/info). `--fix` applies auto-fixable lints (currently NOT_EXECUTABLE chmod).

## [0.10.1] — 2026-04-29

Surgical follow-up to v0.10.0. No new spec.

### Added

- `tests/global-setup.ts` + `vitest.config.ts` — vitest globalSetup builds `dist/` once before any test runs, eliminating the parallel-build race that caused flaky `cli-workflows.test.ts` and `migration.e2e.test.ts` failures.

### Changed

- The harness migrated from `generateText`/`streamText` to AI SDK's `ToolLoopAgent` for full `prepareCall` lifecycle hook wiring. Trigger handlers now flow through all four hooks (`prepareCall`, `prepareStep`, `onStepFinish`, `onFinish`).

## [0.10.0] — 2026-04-29

Spec #2 (2 of 5). Primitive collapse from 7 → 2 primitives + AI SDK trigger mapping.

### Added

- New `activate_skill` AI SDK tool with enum-constrained name. Auto-registered in `createHarness()`. Skills are loaded only when the model invokes this tool — true progressive disclosure.
- Trigger composition framework: skills tagged with `metadata.harness-trigger: prepare-call` (or `prepare-step` / `step-finish` / `run-finish`) fire scripts that integrate into the AI SDK lifecycle. Scripts merge instructions/tools/providerOptions into the call settings.
- Scheduled skills: `metadata.harness-schedule: <cron>` — the runtime scheduler reads schedules from skill metadata directly.
- `harness skill list` (with `--scheduled` and `--trigger <kind>` filters), `harness skill list --type rules`, etc.
- Compaction protection: skill content wrapped in `<skill_content>` tags is exempt from context compaction (per Agent Skills client implementation guide).

### Changed (Breaking — auto-migrated)

- **The 7-primitive model collapses to 2:** `instincts/`, `playbooks/`, `workflows/`, `tools/`, `agents/` directories are no longer primary primitives. Existing content auto-migrates via `harness doctor --migrate`:
  - `instincts/` → `rules/` with `author: agent` frontmatter
  - `playbooks/` → `skills/<name>/SKILL.md` (bundle)
  - `workflows/` → `skills/<name>/SKILL.md` with `metadata.harness-schedule: <cron>`
  - `tools/` → `skills/<name>/SKILL.md` with `metadata.harness-trigger: <kind>` + auto-generated bridge script
  - `agents/` → `skills/<name>/SKILL.md` with `metadata.harness-trigger: subagent`
- `harness delegate <agent>` is **removed.** Replaced by the model invoking `activate_skill` for the matching subagent skill.
- `harness workflow` (singular) is **removed.** Use `harness skill list --scheduled` to inspect scheduled skills, and `harness workflows status/inspect/resume/cleanup` (plural) to manage durable runs.

## [0.9.0] — 2026-04-29

Spec #1 (1 of 5). Skills spec conformance — bring the harness's primitive model in line with the [Agent Skills specification](https://agentskills.io).

### Added

- Strict Agent Skills frontmatter validation for `skills/`: `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools` only. Harness extensions live under `metadata.harness-*`.
- Permissive frontmatter for `rules/` (extends Agent Skills shape with harness-specific fields).
- `harness doctor --migrate` automated migration from legacy harnesses (rename `CORE.md` → `IDENTITY.md`, delete `SYSTEM.md`, move `state.md` → `memory/state.md`, bundle flat skills, rewrite frontmatter, strip L0/L1 comments).
- Vendored four `superpowers` skills (MIT licensed, full provenance preserved): `brainstorming`, `writing-plans`, `executing-plans`, `dispatching-parallel-agents`.
- New `docs/skill-authoring.md` — comprehensive skill-authoring guide.

### Changed (Breaking — auto-migrated)

- **`CORE.md` → `IDENTITY.md`** at the harness root. Auto-migration via `harness doctor --migrate`. The harness still falls back to reading `CORE.md` with a deprecation warning if both are absent.
- **`state.md` (top-level) → `memory/state.md`.** Auto-migrated.
- **`SYSTEM.md` is removed** as part of the harness scaffold. It was infrastructure documentation that duplicated `docs/skill-authoring.md`. The scaffolded `README.md` inside the harness now describes the directory layout.
- Skill frontmatter schema is strict per Agent Skills (`SkillFrontmatterSchema`); rule frontmatter is permissive (`NonSkillFrontmatterSchema`). Schema validation runs on every primitive load.

---

## Upgrading from 0.8.x

If you have a harness directory created with v0.8.0 or earlier, the easiest path is:

```bash
# Inside your harness directory
harness doctor --migrate --dry-run    # preview the changes (added in v0.14.0)
harness doctor --migrate              # apply
```

The migration handles all the renames and structural changes automatically: `CORE.md` → `IDENTITY.md`, `state.md` → `memory/state.md`, `SYSTEM.md` removed, `instincts/`/`playbooks/`/`workflows/`/`tools/`/`agents/` directories collapsed into `rules/`/`skills/`. Run it under version control so you can review the diff before committing.

A few things you'll notice after upgrading from 0.8.x:

### CLI surface changes

| Before | After |
|---|---|
| `harness export <file.json>` (portable bundle) | `harness export-bundle <file.json>` — verb renamed in v0.13.0 to free up `export` for provider integration |
| `harness export <provider>` (didn't exist) | New in v0.13.0 — six providers: claude, codex, agents, cursor, copilot, gemini |
| `harness delegate <agent>` | Removed in v0.10.0 — the model invokes `activate_skill` instead |
| `harness workflow` (singular) | Removed in v0.10.0 — use `harness skill list --scheduled` |
| `harness dev` started a web dashboard automatically | `--web` opt-in as of v0.15.0; default port 8080 |

### File layout changes

| Before | After |
|---|---|
| `CORE.md` | `IDENTITY.md` (auto-migrated) |
| `SYSTEM.md` | removed (auto-migrated) |
| `state.md` (top-level) | `memory/state.md` (auto-migrated) |
| `instincts/<id>.md` | `rules/<id>.md` with `author: agent` (auto-migrated) |
| `playbooks/<name>.md` | `skills/<name>/SKILL.md` (auto-migrated; description auto-derived from body in v0.15.0) |
| `workflows/<name>.md` | `skills/<name>/SKILL.md` with `metadata.harness-schedule` |
| `tools/<name>.md` | `skills/<name>/SKILL.md` with `metadata.harness-trigger` + auto-generated bridge script |
| `agents/<name>.md` | `skills/<name>/SKILL.md` with `metadata.harness-trigger: subagent` |

### Frontmatter changes

Skills now use the strict Agent Skills schema (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`). Harness-specific fields move under `metadata.harness-*`:
- `harness-trigger`, `harness-schedule`, `harness-status`, `harness-author`, `harness-source`, `harness-active-tools`, `harness-model`, `harness-durable`, `harness-max-retries`, `harness-retry-delay-ms`, `harness-channel`, `harness-priority`, `harness-trigger-priority`, `harness-script-source`.

Rules use a permissive schema — they extend the Agent Skills shape with `id`, `tags`, `created`, `updated`, `author`, `status`, `related`, `severity`, `confidence`, `provenance`.

### New things you can use

- **Provider integration** — keep your `.claude/`, `.codex/`, `.cursor/`, `.gemini/`, `.github/copilot-instructions.md` in sync with one source of truth via `harness export`. See [docs/provider-integration.md](docs/provider-integration.md).
- **Skill evals** — `evals/triggers.json` for description tuning, `evals/evals.json` for output quality benchmarks. See [docs/skill-evals.md](docs/skill-evals.md).
- **Scaffolding** — `harness skill new <name>` produces a compliant bundle.
- **Schema validation** — `harness skill validate <name>` and `harness doctor --check` run lints across the whole harness.
- **Drift detection** — `harness doctor --check-drift` compares each generated provider file's hash against the source.

### Things to know about behavior changes

- A harness with no `IDENTITY.md` now warns prominently on every command (was silent in 0.8.x).
- The default model in `harness init`'s scaffolded `config.yaml` is `openrouter` + `anthropic/claude-sonnet-4`. If `OPENROUTER_API_KEY`/`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`CEREBRAS_API_KEY` are all absent at init time, `harness init` prints instructions for switching to the local Ollama setup path (`harness config set model.provider ollama && harness config set model.id qwen3:1.7b`).
- `harness export` defaults are anchored at the project root (parent of `harnessDir` if it has `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`/`package.json`/`.git`). For project-resident installs (`<project>/.harness/`), exports land at `<project>/.<provider>/`, not nested in the harness subdirectory. This is correct cross-tool convention but a behavioral departure from 0.8.x's relative-to-cwd resolution.

### Removed in 0.9.x and beyond

- Top-level `state.md` (renamed to `memory/state.md` in v0.9.0).
- `SYSTEM.md` (removed in v0.9.0; `harness dev` no longer regenerates it as of v0.15.0).
- `harness delegate` (removed in v0.10.0).
- `harness workflow` (singular, removed in v0.10.0).
- The `instincts/`, `playbooks/`, `workflows/`, `tools/`, `agents/` directories from the default scaffold (v0.14.0; existing harnesses that had them are migrated by `harness doctor --migrate`, not deleted).
