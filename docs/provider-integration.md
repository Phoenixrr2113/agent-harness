# Provider integration

This is the canonical reference for exporting harness content to other agent tools (Claude Code, OpenAI Codex, Cursor, GitHub Copilot, Gemini CLI, and the cross-tool `.agents/` convention). Use it when wiring up `harness export` for the first time, configuring per-target paths, or diagnosing drift warnings.

For the design rationale, see [docs/specs/2026-05-02-provider-integration-design.md](specs/2026-05-02-provider-integration-design.md). For overall skill authoring, see [skill-authoring.md](skill-authoring.md).

## Why provider integration

Most projects that use one agent tool eventually try a second. A repo with `.claude/skills/` adds Cursor; a Codex user shares the project with a Copilot teammate; a Gemini CLI workflow gets ported to Claude Code. The canonical content — identity, rules, skills — is the same. The on-disk format is different in each tool.

agent-harness treats the harness directory as **the single source of truth** and provider directories (`.claude/`, `.cursor/`, `.github/copilot-instructions.md`, etc.) as **generated artifacts**, similar to a `dist/` build output. You author once in the harness and run `harness export` to produce each provider's flavor.

Three principles follow from "harness is canonical, providers are generated":

1. **Generated files include a provenance marker.** Each exported file embeds frontmatter (or a top-of-file HTML comment, for formats that don't support frontmatter) recording where it came from, when it was exported, by which harness version, and a sha256 hash of the content. Drift detection compares the hash on subsequent reads.

2. **Round-trip sync is explicitly out of scope.** Editing a provider's file does NOT propagate back into the harness automatically. That's an unbounded merge problem: the harness would have to arbitrate between conflicting tools' edits with no canonical resolution. Instead, drift is surfaced as a warning, and you choose: re-export with `--force` to overwrite the provider edit, or `--resync-from <provider>` to pull a specific provider edit back into the harness (native adapters only — see below).

3. **Build-artifact discipline applies.** Some teams commit provider directories so non-harness teammates can use them; others gitignore them and rely on `harness export` in CI. Both are valid. The harness doesn't dictate either.

If you've used CI-driven artifact directories (`dist/`, `build/`, generated client SDKs), the mental model is identical: edit the source, regenerate the output, and let your VCS choose whether to track the output.

## Supported providers

Six providers ship in v0.13.0:

| Provider | Output paths | Format | Lossiness | Resync support |
|---|---|---|---|---|
| `claude` | `<target>/skills/<name>/SKILL.md` + `<target>/CLAUDE.md` | Agent Skills (native) | Lossless | Yes |
| `codex` | `<target>/skills/<name>/SKILL.md` + `<target>/AGENTS.md` | Agent Skills (native) | Lossless | Yes |
| `agents` | `<target>/skills/<name>/SKILL.md` + project-root `AGENTS.md` | Agent Skills (native, cross-tool) | Lossless | Yes |
| `cursor` | `<target>/rules/<name>.mdc` | Cursor MDC | Partially lossy | No |
| `copilot` | `<target>/copilot-instructions.md` | Single concatenated file | Highly lossy | No |
| `gemini` | `<target>/extensions/<name>/gemini-extension.json` + `<target>/extensions/<name>/SKILL.md` + project-root `GEMINI.md` | Gemini extension | Lossless | No |

"Lossless" means the export preserves frontmatter, body, scripts, references, and assets verbatim. "Partially lossy" means scripts are inlined as code blocks when they fit a size cap and warned-and-dropped otherwise. "Highly lossy" means scripts can't run at all in the target runtime; the exported file describes them as text only.

`<target>` is the directory you point a provider at — typically `.claude/` for Claude Code, `.cursor/` for Cursor, etc. It's set per-target in `config.yaml` or overridden with `--target <path>`.

## The export flow

The end-to-end loop:

1. **Configure targets** in `config.yaml` (one-time setup).
2. **Author skills and rules** in the harness directory (the source of truth).
3. **Run `harness export`** to materialize each provider's format.
4. **Run `harness doctor --check-drift`** before commits to catch external edits.
5. **Decide**: overwrite (`--force`), pull edit back into harness (`--resync-from`, native only), or hand-merge.

Steps 2 and 3 are the inner loop. Steps 4 and 5 are the cleanup loop you run once in a while.

## Per-provider format mapping

This section lays out exactly what each adapter writes and what's preserved versus lossy. Schema verification dates and source URLs are noted where the adapter deviates from the design spec.

### Claude Code (`claude`)

**Output paths:**
- `<target>/skills/<name>/SKILL.md` — one per skill, frontmatter copied verbatim
- `<target>/skills/<name>/scripts/`, `references/`, `assets/` — copied verbatim
- `<target>/CLAUDE.md` — IDENTITY.md content under `## Identity`, all active rules under `## Rules`

**Field mapping:**

| Harness | Claude output |
|---|---|
| `skills/<name>/SKILL.md` (full bundle) | `<target>/skills/<name>/SKILL.md` + sibling resources |
| `skills/<name>/scripts/*` | `<target>/skills/<name>/scripts/*` |
| `IDENTITY.md` body | `<target>/CLAUDE.md` `## Identity` section |
| `rules/*` (active) | `<target>/CLAUDE.md` `## Rules` section, alphabetical |

**Preserved:** frontmatter (with provenance metadata appended), body, all bundle resources, exec bits via `cp` semantics.

**Lossy:** none. Claude Code is a native Agent Skills consumer.

**Schema reference:** [Agent Skills specification](https://agentskills.io/specification).

### OpenAI Codex (`codex`)

**Output paths:**
- `<target>/skills/<name>/SKILL.md` + bundle resources (same shape as `claude`)
- `<target>/AGENTS.md` — IDENTITY.md content + active rules

**Field mapping:** identical to `claude` except the project-level identity file is named `AGENTS.md`.

**Preserved / Lossy:** identical to `claude` — native Agent Skills.

**Schema reference:** [Agent Skills specification](https://agentskills.io/specification). Codex uses `AGENTS.md` per its own conventions.

### Cross-tool (`agents`)

**Output paths:**
- `<target>/skills/<name>/SKILL.md` + bundle resources
- **Project-root `AGENTS.md`** (sibling to the harness directory, NOT inside `<target>`)

The `agents` provider exists because the [Agent Skills client showcase](https://agentskills.io/home#where-can-i-use-agent-skills) lists 40+ tools, most of which check the `.agents/` directory or a sibling `AGENTS.md`. Targeting `.agents/` gives the broadest reach with one export.

**Field mapping:** the `AGENTS.md` location is the only difference from `codex`. The `agents` adapter writes it at the *project root* (parent of the harness directory), so the file is visible to every tool that reads project-level guidance from the same level as `.agents/`.

**Preserved / Lossy:** same as the native adapters.

### Cursor (`cursor`)

**Output paths:**
- `<target>/rules/<name>.mdc` — one MDC file per skill

**Field mapping:**

| Harness | Cursor MDC |
|---|---|
| `name` | derived from the filename `<name>.mdc` |
| `description` | `description` (frontmatter) |
| skill body | MDC body |
| `metadata.harness-trigger: prepare-call` | `alwaysApply: true` |
| (regular skill, no trigger) | `alwaysApply: false` |
| `globs` | empty string (Cursor's globs concept doesn't map cleanly from skill activation) |
| `scripts/*` (≤8KB) | inlined as `### Script: <name>` fenced code blocks at the end of the body |
| `scripts/*` (>8KB) | warned and dropped from the output |

**Preserved:** description, body, small scripts inlined, `alwaysApply` semantics.

**Lossy:** large scripts, references, assets. The export report enumerates which scripts couldn't be embedded so you know what's not in the Cursor copy.

**Schema reference:** [Cursor docs](https://cursor.com/docs/context/rules), verified 2026-04-29. Notable deviation from the design spec: `globs` is a **comma-separated string**, not an array. The adapter emits it as an empty string when there are no patterns.

### GitHub Copilot (`copilot`)

**Output paths:**
- `<target>/copilot-instructions.md` — a single concatenated file

**Field mapping:** the entire harness — IDENTITY.md, all active rules, every skill — is concatenated into one file under section headings:

```markdown
# Project guidance for Copilot

## Identity
[IDENTITY.md body]

## Rules
### <rule-name>
[rule description]
[rule body]
...

## Skills
The following skills are available:

### <skill-name>
[skill description]
[skill body]
Skill resources at: <bundle-path-on-disk>
...
```

**Preserved:** identity body, all active rule bodies, skill descriptions and bodies (subject to a token cap).

**Lossy:** scripts can't run from inside Copilot's runtime — they're only mentioned by path. References and assets are not inlined. When the concatenated body exceeds the 32k-token cap (rough char/4 estimate), the exporter prefers identity > rules > skill descriptions and *drops* skill bodies that don't fit; the export report counts how many were dropped so you can prune or split.

**Schema reference:** GitHub's [Copilot custom instructions docs](https://docs.github.com/en/copilot/customizing-copilot/about-customizing-github-copilot-chat-responses). The single-file shape is fixed by Copilot.

### Gemini CLI (`gemini`)

**Output paths:**
- `<target>/extensions/<name>/gemini-extension.json` — extension manifest, one per skill
- `<target>/extensions/<name>/SKILL.md` — the skill body, with provenance frontmatter
- `<target>/extensions/<name>/scripts/`, `references/`, `assets/` — bundle resources copied verbatim
- **Project-root `GEMINI.md`** — IDENTITY.md content + active rules

**Manifest shape:**

```json
{
  "name": "<skill-name>",
  "version": "<harness-version>",
  "description": "<skill-description>"
}
```

**Field mapping:**

| Harness | Gemini output |
|---|---|
| `skills/<name>/SKILL.md` | `<target>/extensions/<name>/SKILL.md` |
| `skills/<name>/scripts/`, `references/`, `assets/` | `<target>/extensions/<name>/<sub>/` |
| `IDENTITY.md` + active rules | project-root `GEMINI.md` |
| `name`, `description` | manifest fields |
| `version` | derived from `agent-harness@<version>` |

**Preserved:** SKILL.md, all bundle resources, identity, rules.

**Lossy:** none structurally; the manifest is minimal but the per-skill content is intact.

**Schema reference:** [Gemini extensions writing guide](https://geminicli.com/docs/extensions/writing-extensions) and [extensions reference](https://geminicli.com/docs/extensions/reference), verified 2026-04-29. Notable deviation from the design spec: the manifest filename is **`gemini-extension.json`** (not `manifest.json` as the spec assumed). Required manifest fields are `name` and `version`; `description` is optional but the adapter always includes it.

## Drift detection

Every export embeds a provenance marker on the generated file. For frontmatter-supporting formats, the marker lives under `metadata`:

```yaml
metadata:
  harness-exported-from: "/path/to/harness/skills/research/SKILL.md"
  harness-exported-at: "2026-05-02T14:32:00Z"
  harness-exported-by: "agent-harness@0.13.0"
  harness-content-hash: "sha256:abc123..."
```

For markdown-only formats (Copilot's single file, project-level CLAUDE.md / AGENTS.md / GEMINI.md), an HTML comment block at the top of the file holds the same fields:

```markdown
<!-- agent-harness-provenance
harness-exported-from: /path/to/harness/IDENTITY.md
harness-exported-at: 2026-05-02T14:32:00Z
harness-exported-by: agent-harness@0.13.0
harness-content-hash: sha256:def456...
-->

# Project guidance for Copilot
...
```

### How the hash is computed

The `harness-content-hash` is a sha256 of the file content **with the provenance marker stripped first**. Hashing the file as-written would create an unsolvable cycle (the hash is part of the file). Instead, the adapter strips the marker, normalizes through gray-matter (so YAML key ordering is canonical), then hashes the result.

`stripProvenance(content, mode)` and `computeContentHash(content)` are the load-bearing functions; both live in [src/runtime/export/provenance.ts](../src/runtime/export/provenance.ts).

### Drift findings

Running `harness doctor --check-drift` (or `harness export` against an already-exported target) walks every configured target and produces findings:

| Finding kind | When | Severity |
|---|---|---|
| `modified` | Provider file's recomputed hash differs from the stored hash | warning |
| `missing-marker` | Provider file exists but has no provenance marker (pre-existing or hand-authored) | warning |
| `missing-file` | Source skill exists but the expected provider file isn't there | warning |
| `orphan` | Provider file exists for a skill no longer in the harness directory | warning |

A clean export run produces no findings. Any finding deserves a decision before you re-export blind.

### How to resolve drift

| Goal | Command |
|---|---|
| Discard the provider edit and re-export from harness | `harness export --force` |
| Pull the provider edit back into the harness (native adapters only) | `harness export --resync-from <provider> --resync-file <path>` |
| Remove orphan provider files for deleted skills | `harness export --prune` |
| Hand-merge | edit both files, then `harness export --force` |

`--resync-from` is supported only for `claude`, `codex`, and `agents` (the lossless native adapters). Cursor, Copilot, and Gemini are too lossy or too synthetic to resync automatically — script bodies are inlined, multiple skills are concatenated into one file, manifests are derived from harness state — so a back-port can't unambiguously reverse the export.

> **Note (v0.13.0).** A pinned-exception flow (`.harness-export-pinned` sibling marker, allowing one-off provider edits to survive `--force`) was specified in the design doc but is not implemented yet. Today, drift is binary: either the file matches the hash or it doesn't. Pinned exceptions land in a follow-up release.

## The `harness export` CLI

Full reference for every flag.

### Synopsis

```bash
harness export [<provider>] [options]
```

Without `<provider>`: exports to every target listed in `config.yaml: export.targets`.

With `<provider>`: exports only to that provider, regardless of config.

### Flags

| Flag | Default | Notes |
|---|---|---|
| `--target <path>` | per-provider default (`.<provider>`) | Override the target directory |
| `--force` | off | Skip drift confirmation; overwrite externally-edited provider files |
| `--dry-run` | off | Print what would be written without writing |
| `--prune` | off | Remove orphan exports (provider files whose source skill is gone) |
| `--resync-from <provider>` | (none) | Pull a provider file back into the harness; requires `--resync-file`; native adapters only |
| `--resync-file <file>` | (none) | The specific provider file to resync from |
| `--harness <dir>` | `process.cwd()` | Harness directory |

### Examples

**Export to a single provider:**

```bash
harness export claude
```

Reads `<harness>/IDENTITY.md`, `<harness>/rules/`, `<harness>/skills/`, and writes `.claude/skills/<name>/SKILL.md` (one per skill) plus `.claude/CLAUDE.md`.

**Export to all configured targets:**

```bash
harness export
```

Reads `config.yaml: export.targets`, runs each provider in turn. Useful as a single command before commits.

**Override the target directory:**

```bash
harness export claude --target .my-claude-overlay
```

Writes to `.my-claude-overlay/skills/...` and `.my-claude-overlay/CLAUDE.md` instead of the default `.claude/`. Most useful for one-off exports outside the configured target.

**Preview without writing:**

```bash
harness export --dry-run
```

Walks every configured target, reports what would be written, but writes nothing. Output looks like a regular export but each provider's report says "dry-run: no files written".

**Remove orphan exports:**

```bash
harness export --prune
```

For each configured target, removes any provider file whose source skill no longer exists in the harness directory. Use after deleting a skill: the `.claude/skills/<deleted>/` directory hangs around until pruned.

**Resync a Claude edit back into the harness:**

```bash
harness export --resync-from claude --resync-file .claude/skills/research/SKILL.md
```

Reads the provider file, strips its provenance marker, and overwrites the harness's `skills/research/SKILL.md` with the canonicalized content. Native adapters only (claude, codex, agents). Use this when you edited the provider file in your editor (because that's what your IDE was open on) and want the harness to adopt the change.

**Force-overwrite an externally-edited provider file:**

```bash
harness export claude --force
```

Re-exports without prompting on drift. Use when you intentionally changed the harness side and want the provider file to follow.

## Configuring export targets in `config.yaml`

The `export:` block configures which providers receive exports when you run `harness export` with no provider argument.

```yaml
export:
  enabled: true
  targets:
    - provider: claude
      path: ".claude"
      auto: true
    - provider: codex
      path: ".codex"
    - provider: agents
      path: ".agents"
    - provider: cursor
      path: ".cursor"
    - provider: copilot
      path: ".github"
    - provider: gemini
      path: ".gemini"
  on_drift: warn
```

### Field reference

| Field | Type | Notes |
|---|---|---|
| `enabled` | boolean | Master switch. `false` disables all configured exports. |
| `targets[]` | array | One entry per provider you export to. |
| `targets[].provider` | string | One of `claude`, `codex`, `agents`, `cursor`, `copilot`, `gemini`. |
| `targets[].path` | string | Target directory, relative to the harness directory. |
| `targets[].auto` | boolean | Auto-export on `harness dev` save events. **No effect in v0.13.0** — see Limitations. |
| `on_drift` | string | `warn` (default) \| `fail` \| `ignore`. Controls drift-warning severity in `harness doctor --check-drift`. |

> **Note (v0.13.0).** The `auto: true` flag is accepted by the config parser but has no effect — the `harness dev` watcher does not currently invoke exports on save. Auto-export is a noted follow-up; until it lands, run `harness export` manually after edits.

## `harness doctor --check-drift`

`harness doctor --check-drift` walks every target listed in `config.yaml: export.targets` and reports any drift.

```bash
harness doctor --check-drift
```

**When to use:**
- Before commits, to catch unintended external edits.
- After a teammate edits a provider file in their IDE — the drift report tells you what changed.
- In CI, to fail the build if a generated artifact has been edited out-of-band.

**Sample output:**

```
Drift check:
  claude: clean
  cursor:
    modified: .cursor/rules/research.mdc — hash mismatch — file edited externally
  copilot:
    missing-marker: .github/copilot-instructions.md — no provenance marker
```

If no targets are configured in `config.yaml`, the command logs `No export targets configured — skipping drift check.` and exits cleanly.

`--check-drift` composes with the other `doctor` flags (`--check`, `--migrate`, `--fix`); the drift report is appended after migration and lint findings, so a single `harness doctor --check-drift` run can be your end-of-day sweep.

## `harness export-bundle` (renamed)

The old `harness export <output.json>` command — which produced a portable JSON bundle of the entire harness for `harness import` on another machine — has been **renamed to `harness export-bundle`**. Same behavior; only the verb changed.

```bash
# Old (pre-v0.13.0):
# harness export my-agent.json

# New:
harness export-bundle my-agent.json
```

The rename was necessary to free up `harness export` for provider integration. If you have scripts that call the old verb, update them to `export-bundle`.

The full bundle command remains:

```bash
harness export-bundle [output]
  -d, --dir <path>     Harness directory
  --no-sessions        Exclude session files
  --no-journals        Exclude journal files
  --no-metrics         Exclude metrics
  --no-state           Exclude state and scratch
```

`harness import <bundle>` is unchanged — it accepts the JSON bundle produced by `export-bundle`.

## Limitations and known issues

This section tracks where provider integration is still maturing in v0.13.0. Some are deliberate scope cuts; others are gaps that close in future releases.

- **Cursor `globs` is a comma-separated string, not an array** (verified 2026-04-29 against [cursor.com/docs/context/rules](https://cursor.com/docs/context/rules)). The design spec assumed an array. The adapter follows the upstream schema and emits an empty string when there are no patterns. A note at the top of `src/runtime/export/adapters/cursor.ts` records this deviation.

- **Gemini extension manifest filename is `gemini-extension.json`, not `manifest.json`** (verified 2026-04-29 against the [Gemini extensions reference](https://geminicli.com/docs/extensions/reference)). The adapter writes the verified filename. A note at the top of `src/runtime/export/adapters/gemini.ts` records this deviation.

- **`harness init` does NOT auto-detect existing providers yet.** The `detectExistingProviders` helper in [src/cli/scaffold.ts](../src/cli/scaffold.ts) exists and can be called manually, but the live `harness init` flow doesn't invoke it. Users who want export configured at init time set up `export:` in `config.yaml` by hand. Auto-wiring `detectExistingProviders` into `init` is a noted follow-up.

- **Project-context rule loader exists but is not wired into runtime context.** [src/runtime/context-loader.ts](../src/runtime/context-loader.ts) implements `loadProjectContextRule(harnessDir)` for subdirectory-mode harnesses (where the project root has its own `AGENTS.md` / `CLAUDE.md` / `GEMINI.md`). The function returns the synthetic `project-context` rule, but the runtime does not yet include it in the assembled system prompt. Wiring is a follow-up.

- **Auto-export on `harness dev` save events is deferred.** The `auto: true` flag in `config.yaml` is accepted but has no effect in v0.13.0. Watcher integration is a noted follow-up.

- **Pinned-exception flow (`.harness-export-pinned`) is not implemented.** The design called for a sibling marker file that would let users pin specific provider files to survive `--force`. Today, drift is binary: matching hash or not. Pinning is a noted follow-up.

- **`--resync-from` works for native adapters only.** Cursor, Copilot, and Gemini are too lossy or too synthetic to resync automatically. Edit those provider files for one-off tweaks and accept that `--force` will overwrite them, or rebuild the harness side from the provider edit by hand.

- **CI does not run real exports against real providers.** The unit tests cover adapter logic, drift detection, hash stability, and prune semantics, but no CI step exports to a temporary directory and asserts that Claude Code or Cursor would actually load the result. Those tests would require GUI tools or proprietary CLIs in CI; verification is local-only for now.

- **No conflict resolution for multi-tool projects.** If you target `.claude/`, `.cursor/`, and `.gemini/` from the same harness and a user edits two provider files differently, drift is reported on each but the harness has no opinion on which is canonical. The resolution model is "pick one, resync, force-export the others" — explicit and manual by design.

## Troubleshooting

### `drift detected on .cursor/rules/foo.mdc — hash mismatch`

Someone edited the provider file directly. Decide:
- The harness should win: `harness export cursor --force`.
- The provider edit should win: native adapter? Use `--resync-from`. Cursor? Hand-port the change into `skills/foo/SKILL.md`, then `harness export cursor`.
- Hand-merge: open both files, reconcile, then `harness export cursor --force`.

### `no provenance marker — pre-existing or hand-authored`

The file exists in the provider directory but has no `harness-exported-*` metadata. Common causes:
- The file existed before you adopted agent-harness. The harness can't tell whether it should overwrite, so it warns. To take ownership: `harness export <provider> --force`.
- Someone removed the marker by editing the file. Same fix.

### `expected output not present — re-export to restore`

Source skill exists; provider file is missing. Run `harness export <provider>` to regenerate.

### `orphan export — source skill removed`

You deleted a skill from the harness but the provider artifact lingers. Run `harness export --prune` (per-provider) to clean up.

### `--resync-from <provider> doesn't work for cursor`

Resync is supported only for `claude`, `codex`, and `agents`. For lossy adapters, the provider file can't be unambiguously reversed back to a SKILL.md. Hand-port the change.

### A provider's schema changed upstream

This is the trickiest case. If Cursor changes the MDC frontmatter shape, or Gemini renames a manifest field, the harness's adapter still emits the old shape until the adapter is updated. Symptoms:

- Provider tool warns or rejects the exported file.
- `harness export` succeeds but the result isn't loaded by the provider.

Fix path:
1. Verify the new schema against the provider's docs.
2. Update the adapter in `src/runtime/export/adapters/<provider>.ts`.
3. Add a verification comment at the top of the adapter file (see the `cursor.ts` and `gemini.ts` examples for the format: source URL + verification date).
4. Bump the harness version and re-export.

The verification-date comments in adapter files are how we make this self-auditing — when an export starts failing, the first thing to do is re-check the provider's docs and update the date.

### Drift on Copilot's `copilot-instructions.md` keeps reappearing

Copilot's adapter regenerates the entire file on every export; any change to your IDENTITY.md, any rule, or any skill description will produce a new hash. That's working-as-intended drift, not a bug. If `harness doctor --check-drift` reports drift on Copilot after every harness edit, run `harness export copilot` to re-sync.

## Future work

The design spec ([docs/specs/2026-05-02-provider-integration-design.md](specs/2026-05-02-provider-integration-design.md)) lays out the full roadmap. v0.13.0 ships the export framework, six adapters, drift detection, prune, and resync for native adapters. Items deferred to future releases:

- **`harness init` auto-detection.** `detectExistingProviders` runs at init time, prompts the user to choose which providers to sync, and writes the `export:` block to `config.yaml` automatically.
- **Project-context rule wiring.** `loadProjectContextRule` is included in the runtime system prompt for subdirectory-mode harnesses.
- **Auto-export on save.** `harness dev`'s file watcher invokes the configured exports when a skill or rule file is saved, with `auto: true` controlling per-target opt-in.
- **Pinned-exception flow.** `.harness-export-pinned` sibling files preserve specific provider edits across `--force` runs, with explicit unpinning required to discard.
- **More adapters.** OpenHands, Goose, OpenCode, and the long tail of [Agent Skills clients](https://agentskills.io/home#where-can-i-use-agent-skills) — all natively support Agent Skills, so each is largely a `cp -r` plus identity composition.
- **Resync support for lossy adapters.** Bidirectional sync for Cursor / Copilot / Gemini is a research problem (the lossy export can't be unambiguously reversed); a useful first step would be diff-driven manual ports.

## See also

- [docs/specs/2026-05-02-provider-integration-design.md](specs/2026-05-02-provider-integration-design.md) — design rationale, trade-offs, phase plan
- [docs/skill-authoring.md](skill-authoring.md) — how to write skills the harness can export
- [Agent Skills specification](https://agentskills.io/specification) — the format Claude / Codex / Agents / Gemini all consume
- [Agent Skills client showcase](https://agentskills.io/home#where-can-i-use-agent-skills) — the 40+ tools that adopt the spec
- [Cursor rules docs](https://cursor.com/docs/context/rules) — MDC frontmatter schema
- [Gemini extensions reference](https://geminicli.com/docs/extensions/reference) — extension manifest schema
- [GitHub Copilot custom instructions](https://docs.github.com/en/copilot/customizing-copilot/about-customizing-github-copilot-chat-responses) — single-file format
