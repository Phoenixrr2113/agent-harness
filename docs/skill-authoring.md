# Authoring skills

This guide describes how to write skills that conform to the [Agent Skills specification](https://agentskills.io/specification) and integrate well with agent-harness.

## File layout

A skill is a directory containing `SKILL.md` and optional support directories:

```
skills/<name>/
├── SKILL.md          # required: frontmatter + instructions
├── scripts/          # optional: executable code the agent invokes
├── references/       # optional: detailed docs the agent loads on demand
└── assets/           # optional: templates, data files
```

The directory name MUST equal the `name` field in the frontmatter.

## Frontmatter

Required:
- `name` — 1–64 chars, lowercase a–z and 0–9 and hyphens, no leading/trailing/consecutive hyphens
- `description` — 1–1024 chars, describes what the skill does AND when to use it (per the [optimizing-descriptions guide](https://agentskills.io/skill-creation/optimizing-descriptions))

Optional spec fields:
- `license`
- `compatibility` — ≤500 chars, e.g., "Requires Node.js 20+"
- `metadata` — string→string map for tool-specific extensions
- `allowed-tools` — space-separated string, e.g., `"Read Bash(jq:*)"`

Harness-specific extensions are stored in `metadata` with the `harness-` prefix:
- `metadata.harness-tags` — comma-separated string of tag names
- `metadata.harness-status` — `active` | `archived` | `deprecated` | `draft`
- `metadata.harness-author` — `human` | `agent` | `infrastructure`
- `metadata.harness-created` — ISO date string
- `metadata.harness-updated` — ISO date string
- `metadata.harness-related` — comma-separated string of related skill names

Example:

```yaml
---
name: research-synthesis
description: Synthesize information from multiple sources into a structured report. Use when given a research question and access to source material.
license: MIT
allowed-tools: Read Bash(jq:*)
metadata:
  harness-tags: "knowledge-work,research"
  harness-status: active
  harness-author: human
  harness-created: "2026-04-28"
---
```

## Body content

Recommended sections:
1. **When to use** — imperative phrasing matching the description
2. **Available scripts** — bullet list of bundled scripts with one-line purpose
3. **Workflow** — numbered steps with concrete script invocations
4. **Gotchas** — non-obvious facts the agent would otherwise get wrong
5. **Failure modes** — known errors and recovery hints

Keep `SKILL.md` under 500 lines / 5000 tokens. Move detailed material to `references/` and tell the agent when to load it.

## Validation

```bash
harness doctor --check -d <harness-dir>
```

The doctor reports any spec violations across every skill in the harness.

## Migration

If you have skills authored before 2026-04-28 (with `id`, top-level `tags`/`status`/etc., flat `.md` files, or L0/L1 HTML comments), run:

```bash
harness doctor --migrate -d <harness-dir>
```

The migration is idempotent and reversible via git.

## See also

- [Agent Skills specification](https://agentskills.io/specification)
- [Best practices for skill creators](https://agentskills.io/skill-creation/best-practices)
- [Optimizing skill descriptions](https://agentskills.io/skill-creation/optimizing-descriptions)
- [Using scripts in skills](https://agentskills.io/skill-creation/using-scripts)
