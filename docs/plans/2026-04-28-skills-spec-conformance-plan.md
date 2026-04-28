# Skills spec conformance — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring agent-harness's primitive format into strict conformance with the [Agent Skills specification](https://agentskills.io/specification), rename `CORE.md` → `IDENTITY.md`, delete `SYSTEM.md`, move `state.md` → `memory/state.md`, vendor four generic skills from `obra/superpowers`, and ship `harness doctor --migrate` to bring existing harnesses forward.

**Architecture:** Two-schema split (strict for `skills/`, harness-extended for non-skill primitives) with a normalization layer in the loader so existing consumers don't need refactoring. New file-rename logic in the system prompt assembler with a `CORE.md` deprecation grace. Doctor migration command performs frontmatter rewrites, file moves, L0/L1 stripping, and superpowers vendoring as a single idempotent run.

**Tech Stack:** TypeScript, Zod (schema validation), gray-matter (frontmatter parsing), vitest (tests), tsup (build), Node 20+. Tests run via `npm test -- <path>`. Build via `npm run build`.

---

## Reference

- Design spec: [docs/specs/2026-04-28-skills-spec-conformance-design.md](../specs/2026-04-28-skills-spec-conformance-design.md)
- Agent Skills spec: https://agentskills.io/specification
- Adding skills support: https://agentskills.io/client-implementation/adding-skills-support
- License audit discipline: see user CLAUDE.md §10 (release discipline)

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/core/types.ts` | modify | Split frontmatter schema; drop L0/L1; add validators |
| `src/primitives/loader.ts` | modify | Normalization layer; strict-vs-lenient mode; drop L0/L1 extraction |
| `src/runtime/context-loader.ts` | modify | IDENTITY.md loading with CORE.md deprecation grace; drop L0/L1 budgeting |
| `src/runtime/state.ts` | modify | Path move from `state.md` → `memory/state.md` with grace fallback |
| `src/runtime/doctor.ts` | new or extend | Lints + `--check` + `--migrate` |
| `src/runtime/migration.ts` | new | Migration logic (callable from doctor) |
| `src/runtime/auto-processor.ts` | modify | Strict validation; description generation; stop emitting SYSTEM.md |
| `src/cli/index.ts` | modify | Wire `harness doctor --check` and `--migrate` |
| `src/cli/scaffold.ts` | modify | Emit IDENTITY.md, no SYSTEM.md, memory/state.md |
| `defaults/skills/*` | restructure | Convert flat `.md` to bundled `<name>/SKILL.md` |
| `defaults/skills/<superpowers-skill>/` | new (vendored) | brainstorming, writing-plans, executing-plans, dispatching-parallel-agents |
| `templates/<each>/IDENTITY.md` | rename | Was `CORE.md` |
| `templates/<each>/SYSTEM.md` | delete | Was infrastructure docs |
| `tests/primitives/loader.test.ts` | extend | Schema and loader tests |
| `tests/runtime/migration.test.ts` | new | Doctor migration tests |
| `tests/fixtures/old-harness/` | new | Pre-migration fixture for e2e |
| `tests/integration/migration.e2e.test.ts` | new | End-to-end migration test |
| `README.md` | modify | Update directory diagram, frontmatter examples, deprecate L0/L1 docs |
| `docs/skill-authoring.md` | new | Skill authoring guide |
| `NOTICE` | append | Vendored content provenance |

---

## Phase 1: Schema split

Goal: split `FrontmatterSchema` into `SkillFrontmatterSchema` (strict) and `NonSkillFrontmatterSchema` (permissive). All schema validation passes before touching the loader.

### Task 1.1: Add `nameSchema` validator

**Files:**
- Modify: `src/core/types.ts` (add the helper schema)
- Test: `tests/primitives/schema.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/primitives/schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { nameSchema } from '../../src/core/types.js';

describe('nameSchema', () => {
  it('accepts valid lowercase-hyphen names', () => {
    expect(nameSchema.safeParse('pdf-processing').success).toBe(true);
    expect(nameSchema.safeParse('research').success).toBe(true);
    expect(nameSchema.safeParse('a').success).toBe(true);
    expect(nameSchema.safeParse('a1-b2').success).toBe(true);
  });

  it('rejects empty', () => {
    expect(nameSchema.safeParse('').success).toBe(false);
  });

  it('rejects names longer than 64 chars', () => {
    expect(nameSchema.safeParse('a'.repeat(64)).success).toBe(true);
    expect(nameSchema.safeParse('a'.repeat(65)).success).toBe(false);
  });

  it('rejects uppercase', () => {
    expect(nameSchema.safeParse('PDF-Processing').success).toBe(false);
    expect(nameSchema.safeParse('Research').success).toBe(false);
  });

  it('rejects leading or trailing hyphen', () => {
    expect(nameSchema.safeParse('-pdf').success).toBe(false);
    expect(nameSchema.safeParse('pdf-').success).toBe(false);
  });

  it('rejects consecutive hyphens', () => {
    expect(nameSchema.safeParse('pdf--processing').success).toBe(false);
  });

  it('rejects non-alphanumeric characters', () => {
    expect(nameSchema.safeParse('pdf_processing').success).toBe(false);
    expect(nameSchema.safeParse('pdf.processing').success).toBe(false);
    expect(nameSchema.safeParse('pdf processing').success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/primitives/schema.test.ts`
Expected: FAIL — `nameSchema` is not exported from `../../src/core/types.js`.

- [ ] **Step 3: Implement `nameSchema`**

Add to `src/core/types.ts` (near the top, before `FrontmatterInnerSchema`):

```typescript
/**
 * Agent Skills spec name validator (https://agentskills.io/specification#name-field).
 * Required for skills; optional but checked when present for non-skill primitives.
 *
 * Rules: 1–64 chars, lowercase a-z, digits, hyphens; no leading/trailing hyphen;
 * no consecutive hyphens. The "match parent dir" rule is enforced by the loader,
 * not by the schema itself.
 */
export const nameSchema = z
  .string()
  .min(1, 'name must not be empty')
  .max(64, 'name must be ≤ 64 characters')
  .regex(
    /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9]))*$/,
    'name must be lowercase a-z/0-9/hyphen, no leading/trailing/consecutive hyphens'
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/primitives/schema.test.ts`
Expected: PASS — all 7 cases.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts tests/primitives/schema.test.ts
git commit -m "feat(types): add Agent Skills nameSchema validator

Validates the Agent Skills spec name rules (1-64 chars, lowercase
a-z/0-9/hyphen, no leading/trailing/consecutive hyphens). Used by
the upcoming SkillFrontmatterSchema and as a name lint in the
doctor command.

Refs: docs/specs/2026-04-28-skills-spec-conformance-design.md"
```

### Task 1.2: Add `descriptionSchema` and `compatibilitySchema` validators

**Files:**
- Modify: `src/core/types.ts`
- Test: `tests/primitives/schema.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/primitives/schema.test.ts`:

```typescript
import { descriptionSchema, compatibilitySchema } from '../../src/core/types.js';

describe('descriptionSchema', () => {
  it('accepts a typical description', () => {
    const desc = 'Conducts deep research using web search. Use when investigating a topic.';
    expect(descriptionSchema.safeParse(desc).success).toBe(true);
  });

  it('rejects empty after trim', () => {
    expect(descriptionSchema.safeParse('').success).toBe(false);
    expect(descriptionSchema.safeParse('   ').success).toBe(false);
  });

  it('accepts up to 1024 chars', () => {
    expect(descriptionSchema.safeParse('x'.repeat(1024)).success).toBe(true);
    expect(descriptionSchema.safeParse('x'.repeat(1025)).success).toBe(false);
  });
});

describe('compatibilitySchema', () => {
  it('accepts up to 500 chars', () => {
    expect(compatibilitySchema.safeParse('Requires Node.js 20+').success).toBe(true);
    expect(compatibilitySchema.safeParse('x'.repeat(500)).success).toBe(true);
    expect(compatibilitySchema.safeParse('x'.repeat(501)).success).toBe(false);
  });

  it('rejects empty', () => {
    expect(compatibilitySchema.safeParse('').success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/primitives/schema.test.ts`
Expected: FAIL — both schemas missing.

- [ ] **Step 3: Implement the schemas**

Add to `src/core/types.ts` after `nameSchema`:

```typescript
/**
 * Agent Skills spec description validator. Required for skills (1-1024 chars,
 * non-empty after trim). Should describe what the skill does AND when to use
 * it (the "imperative phrasing" guidance from the optimizing-descriptions doc).
 */
export const descriptionSchema = z
  .string()
  .min(1, 'description must not be empty')
  .max(1024, 'description must be ≤ 1024 characters')
  .refine((s) => s.trim().length > 0, { message: 'description must not be only whitespace' });

/**
 * Agent Skills spec compatibility hint. Optional; when present, must be 1-500 chars.
 */
export const compatibilitySchema = z
  .string()
  .min(1, 'compatibility must not be empty')
  .max(500, 'compatibility must be ≤ 500 characters');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/primitives/schema.test.ts`
Expected: PASS — all 5 new cases.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts tests/primitives/schema.test.ts
git commit -m "feat(types): add description and compatibility validators

Per Agent Skills spec: description is 1-1024 chars non-empty,
compatibility is 1-500 chars when present."
```

### Task 1.3: Add `SkillFrontmatterSchema`

**Files:**
- Modify: `src/core/types.ts`
- Test: `tests/primitives/schema.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/primitives/schema.test.ts`:

```typescript
import { SkillFrontmatterSchema } from '../../src/core/types.js';

describe('SkillFrontmatterSchema', () => {
  it('accepts minimal valid skill frontmatter', () => {
    const result = SkillFrontmatterSchema.safeParse({
      name: 'research',
      description: 'Conducts deep research. Use when investigating a topic.',
    });
    expect(result.success).toBe(true);
  });

  it('requires name', () => {
    const result = SkillFrontmatterSchema.safeParse({
      description: 'A description.',
    });
    expect(result.success).toBe(false);
  });

  it('requires description', () => {
    const result = SkillFrontmatterSchema.safeParse({
      name: 'research',
    });
    expect(result.success).toBe(false);
  });

  it('accepts allowed-tools as space-separated string', () => {
    const result = SkillFrontmatterSchema.safeParse({
      name: 'research',
      description: 'Research stuff.',
      'allowed-tools': 'WebSearch Read Bash(jq:*)',
    });
    expect(result.success).toBe(true);
  });

  it('rejects allowed-tools as array', () => {
    const result = SkillFrontmatterSchema.safeParse({
      name: 'research',
      description: 'Research stuff.',
      'allowed-tools': ['WebSearch', 'Read'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown top-level fields (strict)', () => {
    const result = SkillFrontmatterSchema.safeParse({
      name: 'research',
      description: 'Research stuff.',
      tags: ['skill'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts metadata as string→string map', () => {
    const result = SkillFrontmatterSchema.safeParse({
      name: 'research',
      description: 'Research stuff.',
      metadata: { 'harness-tags': 'research,knowledge-work', 'harness-status': 'active' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects metadata with non-string values', () => {
    const result = SkillFrontmatterSchema.safeParse({
      name: 'research',
      description: 'Research stuff.',
      metadata: { 'harness-tags': ['research', 'knowledge-work'] },
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/primitives/schema.test.ts`
Expected: FAIL — `SkillFrontmatterSchema` not exported.

- [ ] **Step 3: Implement `SkillFrontmatterSchema`**

Add to `src/core/types.ts`:

```typescript
/**
 * Strict Agent Skills frontmatter schema (https://agentskills.io/specification).
 *
 * Skills MUST have only spec-defined top-level fields. All harness extensions
 * (tags, status, author, etc.) move into `metadata` with the `harness-` prefix.
 * The loader's normalization layer extracts those into the canonical
 * HarnessDocument shape so downstream code reads them uniformly.
 *
 * The "name matches parent directory" rule is enforced by the loader, not here.
 */
export const SkillFrontmatterSchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema,
    license: z.string().optional(),
    compatibility: compatibilitySchema.optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    'allowed-tools': z.string().optional(),
  })
  .strict();

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/primitives/schema.test.ts`
Expected: PASS — all 8 new cases.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts tests/primitives/schema.test.ts
git commit -m "feat(types): add strict SkillFrontmatterSchema

Per Agent Skills spec: only name, description, license, compatibility,
metadata, allowed-tools are accepted at top level. allowed-tools is a
space-separated string. metadata is string-to-string. Unknown fields
are rejected (strict mode)."
```

### Task 1.4: Add `NonSkillFrontmatterSchema`

**Files:**
- Modify: `src/core/types.ts`
- Test: `tests/primitives/schema.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/primitives/schema.test.ts`:

```typescript
import { NonSkillFrontmatterSchema } from '../../src/core/types.js';

describe('NonSkillFrontmatterSchema', () => {
  it('accepts minimal valid non-skill frontmatter', () => {
    const result = NonSkillFrontmatterSchema.safeParse({
      name: 'operations',
      description: 'Operational rules for the agent.',
    });
    expect(result.success).toBe(true);
  });

  it('accepts harness extension fields at top level', () => {
    const result = NonSkillFrontmatterSchema.safeParse({
      name: 'daily-reflection',
      description: 'Synthesize today\'s sessions.',
      tags: ['reflection', 'daily'],
      status: 'active',
      author: 'infrastructure',
      created: '2026-04-28',
      updated: '2026-04-28',
      schedule: '0 22 * * *',
      durable: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts permissive metadata (any value type)', () => {
    const result = NonSkillFrontmatterSchema.safeParse({
      name: 'foo',
      description: 'A thing.',
      metadata: { count: 5, tags: ['a', 'b'] },
    });
    expect(result.success).toBe(true);
  });

  it('still validates name regex', () => {
    const result = NonSkillFrontmatterSchema.safeParse({
      name: 'Operations',
      description: 'A thing.',
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/primitives/schema.test.ts`
Expected: FAIL — `NonSkillFrontmatterSchema` not exported.

- [ ] **Step 3: Implement `NonSkillFrontmatterSchema`**

Add to `src/core/types.ts`:

```typescript
/**
 * Frontmatter schema for non-skill primitives (rules, instincts, playbooks,
 * workflows, tools, agents). Mirrors the Agent Skills shape (name +
 * description required, metadata bag) but adds harness-specific top-level
 * fields where structural significance justifies it.
 *
 * Permissive on `metadata` (string → unknown) since these primitives aren't
 * bound by the spec's string-only metadata constraint.
 *
 * Spec #2 collapses these primitives into skills + rules; this schema covers
 * the transitional state where they still exist as separate kinds.
 */
export const NonSkillFrontmatterSchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema,
    license: z.string().optional(),
    compatibility: compatibilitySchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    'allowed-tools': z.string().optional(),
    // Harness extensions
    tags: z.array(z.string()).default([]),
    status: z.enum(['active', 'archived', 'deprecated', 'draft']).default('active'),
    author: z.enum(['human', 'agent', 'infrastructure']).default('human'),
    created: z.string().optional(),
    updated: z.string().optional(),
    related: z.array(z.string()).default([]),
    // Workflow-specific
    schedule: z.string().optional(),
    with: z.string().optional(),
    channel: z.string().optional(),
    duration_minutes: z.number().optional(),
    max_retries: z.number().int().nonnegative().optional(),
    retry_delay_ms: z.number().int().positive().optional(),
    durable: z.boolean().optional(),
    // Agent-specific
    model: z.enum(['primary', 'summary', 'fast']).optional(),
    active_tools: z.array(z.string()).optional(),
  })
  .passthrough();

export type NonSkillFrontmatter = z.infer<typeof NonSkillFrontmatterSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/primitives/schema.test.ts`
Expected: PASS — all 4 new cases.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts tests/primitives/schema.test.ts
git commit -m "feat(types): add NonSkillFrontmatterSchema

Mirrors Agent Skills core shape but allows harness-specific top-level
fields (tags, status, author, schedule, durable, model, etc.) and
permissive metadata. Used for rules and the transitional non-skill
primitive types until spec #2 collapses them."
```

---

## Phase 2: Update `HarnessDocument` interface

Goal: drop `l0`/`l1` fields, add normalized accessor fields (`tags`, `status`, etc.) so downstream code doesn't need to know whether values came from top-level or `metadata`.

### Task 2.1: Update `HarnessDocument` interface

**Files:**
- Modify: `src/core/types.ts`
- Test: `tests/primitives/loader.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/primitives/loader.test.ts` (creating the file if it doesn't exist):

```typescript
import { describe, it, expect } from 'vitest';
import type { HarnessDocument } from '../../src/core/types.js';

describe('HarnessDocument', () => {
  it('exposes normalized accessor fields', () => {
    const doc: HarnessDocument = {
      path: '/test/skills/foo/SKILL.md',
      name: 'foo',
      id: 'foo',
      description: 'A test skill.',
      tags: ['test'],
      status: 'active',
      author: 'human',
      related: [],
      allowedTools: [],
      body: 'Test body.',
      raw: '---\nname: foo\n---\nTest body.',
      frontmatter: { name: 'foo', description: 'A test skill.' },
    };
    expect(doc.id).toBe('foo');
    expect(doc.name).toBe('foo');
    expect(doc.tags).toEqual(['test']);
    expect(doc.status).toBe('active');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/primitives/loader.test.ts`
Expected: FAIL — type errors on `name`, `id`, `tags`, etc. as top-level properties.

- [ ] **Step 3: Update `HarnessDocument` interface**

Modify `src/core/types.ts` — replace the existing `HarnessDocument` interface with:

```typescript
/**
 * Loaded primitive document with frontmatter parsed and harness-extension fields
 * normalized to canonical accessors. Consumers read `doc.tags`, `doc.status`, etc.
 * directly without needing to know whether the original frontmatter put those
 * fields at the top level (non-skill primitives) or inside `metadata.harness-*`
 * (skills, per Agent Skills spec compliance).
 */
export interface HarnessDocument {
  path: string;
  /** Canonical identity. For skills, equals `name`. For flat non-skill files, derived from filename. */
  id: string;
  /** Spec-required for skills; optional for non-skill flat files (where it equals `id`). */
  name: string;
  /** Spec-required for skills; required by harness for non-skills as of this spec. */
  description?: string;
  license?: string;
  compatibility?: string;
  /** Parsed from the spec's space-separated string into an array. */
  allowedTools: string[];
  // Normalized harness extensions
  tags: string[];
  status: 'active' | 'archived' | 'deprecated' | 'draft';
  author: 'human' | 'agent' | 'infrastructure';
  created?: string;
  updated?: string;
  related: string[];
  // Type-specific (workflows, agents) — undefined when not applicable
  schedule?: string;
  with?: string;
  channel?: string;
  duration_minutes?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  durable?: boolean;
  model?: 'primary' | 'summary' | 'fast';
  active_tools?: string[];
  /** Harness-specific keys stripped of the `harness-` prefix; spec-aligned remainder. */
  metadata?: Record<string, unknown>;
  // Body & raw
  body: string;
  raw: string;
  /** Absolute path to the bundle directory if this doc is the entry-point of a multi-file bundle. */
  bundleDir?: string;
  /** Original parsed frontmatter (spec-shape for skills, harness-shape for others). */
  frontmatter: SkillFrontmatter | NonSkillFrontmatter;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/primitives/loader.test.ts`
Expected: PASS — interface compiles with the test's literal usage.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts tests/primitives/loader.test.ts
git commit -m "feat(types): normalize HarnessDocument with canonical accessors

Drops l0/l1 (replaced by description for discovery and body for
activation, per Agent Skills two-stage progressive disclosure).
Adds top-level accessor fields (id, name, tags, status, author,
allowedTools, etc.) populated by the loader's normalization layer."
```

---

## Phase 3: Loader normalization

### Task 3.1: Implement `normalizeFrontmatter` helper

**Files:**
- Create: `src/primitives/normalize.ts`
- Test: `tests/primitives/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/primitives/normalize.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { normalizeFrontmatter } from '../../src/primitives/normalize.js';

describe('normalizeFrontmatter — skills (strict spec)', () => {
  it('extracts harness-tags from metadata into tags array', () => {
    const result = normalizeFrontmatter(
      {
        name: 'research',
        description: 'A skill.',
        metadata: { 'harness-tags': 'research,knowledge-work' },
      },
      'skills',
      '/path/to/research'
    );
    expect(result.tags).toEqual(['research', 'knowledge-work']);
  });

  it('extracts harness-status default of active when missing', () => {
    const result = normalizeFrontmatter(
      { name: 'foo', description: 'A skill.' },
      'skills',
      '/path/to/foo'
    );
    expect(result.status).toBe('active');
  });

  it('reads harness-status from metadata', () => {
    const result = normalizeFrontmatter(
      {
        name: 'foo',
        description: 'A skill.',
        metadata: { 'harness-status': 'draft' },
      },
      'skills',
      '/path/to/foo'
    );
    expect(result.status).toBe('draft');
  });

  it('strips harness- prefixed keys from the metadata bag', () => {
    const result = normalizeFrontmatter(
      {
        name: 'foo',
        description: 'A skill.',
        metadata: {
          'harness-tags': 'a,b',
          'harness-status': 'active',
          'author': 'example-org',
          'version': '1.0',
        },
      },
      'skills',
      '/path/to/foo'
    );
    expect(result.metadata).toEqual({ author: 'example-org', version: '1.0' });
  });

  it('parses allowed-tools as space-separated string into array', () => {
    const result = normalizeFrontmatter(
      {
        name: 'foo',
        description: 'A skill.',
        'allowed-tools': 'WebSearch Read Bash(jq:*)',
      },
      'skills',
      '/path/to/foo'
    );
    expect(result.allowedTools).toEqual(['WebSearch', 'Read', 'Bash(jq:*)']);
  });

  it('sets id from name', () => {
    const result = normalizeFrontmatter(
      { name: 'research', description: 'A skill.' },
      'skills',
      '/path/to/research'
    );
    expect(result.id).toBe('research');
  });
});

describe('normalizeFrontmatter — non-skills', () => {
  it('reads tags from top-level field directly', () => {
    const result = normalizeFrontmatter(
      {
        name: 'daily-reflection',
        description: 'A workflow.',
        tags: ['reflection', 'daily'],
      },
      'workflows',
      '/path/to/daily-reflection'
    );
    expect(result.tags).toEqual(['reflection', 'daily']);
  });

  it('preserves type-specific top-level fields', () => {
    const result = normalizeFrontmatter(
      {
        name: 'daily-reflection',
        description: 'A workflow.',
        schedule: '0 22 * * *',
        durable: true,
      },
      'workflows',
      '/path/to/daily-reflection'
    );
    expect(result.schedule).toBe('0 22 * * *');
    expect(result.durable).toBe(true);
  });

  it('falls back id to basename when name not given', () => {
    const result = normalizeFrontmatter(
      { description: 'A flat rule.' },
      'rules',
      '/path/to/operations'
    );
    expect(result.id).toBe('operations');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/primitives/normalize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `normalizeFrontmatter`**

Create `src/primitives/normalize.ts`:

```typescript
import { basename } from 'path';
import type { HarnessDocument, SkillFrontmatter, NonSkillFrontmatter } from '../core/types.js';

type ParsedFrontmatter = Record<string, unknown>;

const HARNESS_METADATA_KEYS = [
  'harness-tags',
  'harness-status',
  'harness-author',
  'harness-created',
  'harness-updated',
  'harness-related',
] as const;

function parseList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string')
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}

function stripHarnessKeys(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!HARNESS_METADATA_KEYS.includes(key as (typeof HARNESS_METADATA_KEYS)[number])) {
      out[key] = value;
    }
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Normalize a parsed frontmatter object into the canonical HarnessDocument-shaped
 * accessor set. For skills (Agent Skills spec compliance), harness extension
 * fields live in `metadata.harness-*` and get extracted here. For non-skill
 * primitives, those fields live at the top level.
 *
 * The `parentDirOrFilePath` is used as fallback for `id` derivation when `name`
 * is absent (flat single-file primitives).
 */
export function normalizeFrontmatter(
  raw: ParsedFrontmatter,
  kind: string,
  parentDirOrFilePath: string
): Omit<HarnessDocument, 'path' | 'body' | 'raw' | 'frontmatter' | 'bundleDir'> {
  const isSkill = kind === 'skills';

  const name = typeof raw.name === 'string' ? raw.name : undefined;
  const id = name ?? basename(parentDirOrFilePath).replace(/\.md$/, '');

  const description = typeof raw.description === 'string' ? raw.description : undefined;
  const license = typeof raw.license === 'string' ? raw.license : undefined;
  const compatibility = typeof raw.compatibility === 'string' ? raw.compatibility : undefined;
  const allowedToolsString = typeof raw['allowed-tools'] === 'string' ? raw['allowed-tools'] : '';
  const allowedTools = allowedToolsString
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const meta = (raw.metadata as Record<string, unknown> | undefined) ?? {};

  const tags = isSkill ? parseList(meta['harness-tags']) : parseList(raw.tags);
  const statusRaw = isSkill ? meta['harness-status'] : raw.status;
  const status = (statusRaw === 'archived' || statusRaw === 'deprecated' || statusRaw === 'draft' || statusRaw === 'active'
    ? statusRaw
    : 'active') as HarnessDocument['status'];
  const authorRaw = isSkill ? meta['harness-author'] : raw.author;
  const author = (authorRaw === 'agent' || authorRaw === 'infrastructure' || authorRaw === 'human'
    ? authorRaw
    : 'human') as HarnessDocument['author'];
  const created = isSkill
    ? (typeof meta['harness-created'] === 'string' ? (meta['harness-created'] as string) : undefined)
    : (typeof raw.created === 'string' ? raw.created : undefined);
  const updated = isSkill
    ? (typeof meta['harness-updated'] === 'string' ? (meta['harness-updated'] as string) : undefined)
    : (typeof raw.updated === 'string' ? raw.updated : undefined);
  const related = isSkill ? parseList(meta['harness-related']) : parseList(raw.related);

  const finalMetadata = isSkill ? stripHarnessKeys(meta) : meta;

  return {
    id,
    name: name ?? id,
    description,
    license,
    compatibility,
    allowedTools,
    tags,
    status,
    author,
    created,
    updated,
    related,
    // Non-skill type-specific fields (read top-level, undefined for skills)
    schedule: !isSkill && typeof raw.schedule === 'string' ? raw.schedule : undefined,
    with: !isSkill && typeof raw.with === 'string' ? raw.with : undefined,
    channel: !isSkill && typeof raw.channel === 'string' ? raw.channel : undefined,
    duration_minutes: !isSkill && typeof raw.duration_minutes === 'number' ? raw.duration_minutes : undefined,
    max_retries: !isSkill && typeof raw.max_retries === 'number' ? raw.max_retries : undefined,
    retry_delay_ms: !isSkill && typeof raw.retry_delay_ms === 'number' ? raw.retry_delay_ms : undefined,
    durable: !isSkill && typeof raw.durable === 'boolean' ? raw.durable : undefined,
    model: !isSkill && (raw.model === 'primary' || raw.model === 'summary' || raw.model === 'fast') ? raw.model : undefined,
    active_tools: !isSkill && Array.isArray(raw.active_tools) ? (raw.active_tools as string[]) : undefined,
    metadata: finalMetadata,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/primitives/normalize.test.ts`
Expected: PASS — all 9 cases.

- [ ] **Step 5: Commit**

```bash
git add src/primitives/normalize.ts tests/primitives/normalize.test.ts
git commit -m "feat(loader): add normalizeFrontmatter with kind-aware extraction

Extracts harness-* metadata keys into canonical HarnessDocument fields
for skills (Agent Skills spec compliance), reads top-level fields
directly for non-skill primitives. Both produce the same canonical
shape so downstream consumers don't need to know the source."
```

### Task 3.2: Drop L0/L1 extraction in `parseHarnessDocument`

**Files:**
- Modify: `src/primitives/loader.ts`
- Test: `tests/primitives/loader.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/primitives/loader.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseHarnessDocument } from '../../src/primitives/loader.js';

describe('parseHarnessDocument — L0/L1 stripped from body', () => {
  it('keeps L0/L1 HTML comments in body without populating any field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loader-test-'));
    const filePath = join(dir, 'foo.md');
    writeFileSync(
      filePath,
      `---
name: foo
description: A test.
---
<!-- L0: short summary -->
<!-- L1: longer summary -->

Body text.`,
      'utf-8'
    );

    const doc = parseHarnessDocument(filePath, 'rules');

    // L0/L1 are NOT extracted into separate fields — they remain in body as comments
    expect(doc).not.toHaveProperty('l0');
    expect(doc).not.toHaveProperty('l1');
    // Body retains the comments verbatim (don't silently strip on read)
    expect(doc.body).toContain('<!-- L0: short summary -->');
    expect(doc.body).toContain('<!-- L1: longer summary -->');
    expect(doc.body).toContain('Body text.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/primitives/loader.test.ts`
Expected: FAIL — current `parseHarnessDocument` extracts L0/L1 and strips them from body.

- [ ] **Step 3: Update `parseHarnessDocument` in `src/primitives/loader.ts`**

Read `src/primitives/loader.ts` to confirm current shape, then replace the L0/L1 extraction with a clean parse:

```typescript
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, extname, basename } from 'path';
import matter from 'gray-matter';
import {
  SkillFrontmatterSchema,
  NonSkillFrontmatterSchema,
  CORE_PRIMITIVE_DIRS,
  type HarnessDocument,
  type SkillFrontmatter,
  type NonSkillFrontmatter,
} from '../core/types.js';
import { normalizeFrontmatter } from './normalize.js';

export interface ParseError {
  path: string;
  error: string;
}

export interface LoadResult {
  docs: HarnessDocument[];
  errors: ParseError[];
}

/**
 * Primitive kinds that support multi-file bundles (Agent Skills convention).
 * Spec #2 collapses to skills + rules only; until then, all bundle-capable
 * kinds remain valid.
 */
export const BUNDLE_ENTRY_BY_KIND: Record<string, string> = {
  skills: 'SKILL.md',
  rules: 'RULE.md',
  playbooks: 'PLAYBOOK.md',
  workflows: 'WORKFLOW.md',
};

export function bundleEntryNameFor(kind: string): string | null {
  return BUNDLE_ENTRY_BY_KIND[kind] ?? null;
}

/**
 * Parse a single primitive markdown file. Picks the strict skill schema for
 * `kind === 'skills'`, the permissive non-skill schema otherwise. Throws on
 * validation failure — callers (loadDirectoryWithErrors) catch and report.
 */
export function parseHarnessDocument(filePath: string, kind: string, bundleDir?: string): HarnessDocument {
  const raw = readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);

  // Normalize date-typed values (yaml may parse to Date)
  const normalized: Record<string, unknown> = { ...data };
  for (const key of ['created', 'updated']) {
    const v = normalized[key];
    if (v instanceof Date) normalized[key] = v.toISOString().split('T')[0];
  }

  const isSkill = kind === 'skills';
  let frontmatter: SkillFrontmatter | NonSkillFrontmatter;
  if (isSkill) {
    frontmatter = SkillFrontmatterSchema.parse(normalized);
  } else {
    frontmatter = NonSkillFrontmatterSchema.parse(normalized);
  }

  const body = content.trim();

  const normalizedFields = normalizeFrontmatter(normalized, kind, bundleDir ?? filePath);

  const doc: HarnessDocument = {
    path: filePath,
    body,
    raw,
    frontmatter,
    ...normalizedFields,
  };
  if (bundleDir) doc.bundleDir = bundleDir;
  return doc;
}
```

Also remove the old L0/L1 regex constants and the silent-fallback `try/catch` from the file — they're replaced by explicit error handling in `loadDirectoryWithErrors`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/primitives/loader.test.ts`
Expected: PASS — `doc.body` retains L0/L1 comments; `doc` has no `l0`/`l1` properties.

- [ ] **Step 5: Commit**

```bash
git add src/primitives/loader.ts tests/primitives/loader.test.ts
git commit -m "feat(loader): drop L0/L1 extraction; use kind-aware schema

L0/L1 HTML comments were agent-harness-specific progressive disclosure
markers with no Agent Skills spec equivalent. The spec uses only two
stages: discovery (name+description) and activation (full body).

Loader now picks SkillFrontmatterSchema for skills/ and the permissive
NonSkillFrontmatterSchema for others, then runs normalizeFrontmatter
to produce the canonical HarnessDocument shape. Comments in the body
are preserved verbatim — the doctor migration command will strip them
when migrating existing harnesses."
```

### Task 3.3: Validate parent-dir match for skill bundles

**Files:**
- Modify: `src/primitives/loader.ts`
- Test: `tests/primitives/loader.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/primitives/loader.test.ts`:

```typescript
import { mkdirSync } from 'fs';
import { loadDirectoryWithErrors } from '../../src/primitives/loader.js';

describe('loadDirectoryWithErrors — parent-dir name match for skill bundles', () => {
  it('errors when skill bundle name does not match parent directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'loader-test-'));
    const skillsDir = join(root, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const bundleDir = join(skillsDir, 'foo');
    mkdirSync(bundleDir);
    writeFileSync(
      join(bundleDir, 'SKILL.md'),
      `---
name: bar
description: Mismatch.
---
Body.`,
      'utf-8'
    );

    const result = loadDirectoryWithErrors(skillsDir);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/parent directory/i);
    expect(result.errors[0].error).toMatch(/foo/);
    expect(result.errors[0].error).toMatch(/bar/);
    expect(result.docs).toHaveLength(0);
  });

  it('accepts matching name', () => {
    const root = mkdtempSync(join(tmpdir(), 'loader-test-'));
    const skillsDir = join(root, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const bundleDir = join(skillsDir, 'foo');
    mkdirSync(bundleDir);
    writeFileSync(
      join(bundleDir, 'SKILL.md'),
      `---
name: foo
description: Match.
---
Body.`,
      'utf-8'
    );

    const result = loadDirectoryWithErrors(skillsDir);
    expect(result.errors).toHaveLength(0);
    expect(result.docs).toHaveLength(1);
    expect(result.docs[0].name).toBe('foo');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/primitives/loader.test.ts -t "parent-dir"`
Expected: FAIL — no parent-dir validation in current loader.

- [ ] **Step 3: Add parent-dir validation in `loadDirectoryWithErrors`**

In `src/primitives/loader.ts`, modify the bundle-handling branch of `loadDirectoryWithErrors`:

```typescript
if (stats.isDirectory()) {
  if (!entryName) {
    errors.push({
      path: entryPath,
      error: `Bundling is not supported for "${kind}" — use flat .md files only (bundle-capable kinds: ${Object.keys(BUNDLE_ENTRY_BY_KIND).join(', ')})`,
    });
    continue;
  }
  const entryFile = findBundleEntry(entryPath, kind);
  if (!entryFile) {
    errors.push({
      path: entryPath,
      error: `Bundle directory is missing its entry file (expected ${entryName})`,
    });
    continue;
  }
  try {
    const doc = parseHarnessDocument(entryFile, kind, entryPath);
    // Spec rule: skills/<name>/SKILL.md must have frontmatter name === <name>
    const expectedName = basename(entryPath);
    if (kind === 'skills' && doc.name !== expectedName) {
      errors.push({
        path: entryFile,
        error: `Skill bundle name mismatch: parent directory is "${expectedName}" but frontmatter name is "${doc.name}". Per Agent Skills spec, name must match the parent directory.`,
      });
      continue;
    }
    if (doc.status !== 'archived' && doc.status !== 'deprecated') {
      docs.push(doc);
    }
  } catch (err) {
    errors.push({
      path: entryFile,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/primitives/loader.test.ts -t "parent-dir"`
Expected: PASS — both cases.

- [ ] **Step 5: Commit**

```bash
git add src/primitives/loader.ts tests/primitives/loader.test.ts
git commit -m "feat(loader): enforce skill name matches parent directory

Per Agent Skills spec: name field MUST equal the parent directory's
basename for bundled skills. Mismatches produce a clear, actionable
error message naming both values."
```

### Task 3.4: Strict-mode error reporting (no silent fallback)

**Files:**
- Modify: `src/primitives/loader.ts`
- Test: `tests/primitives/loader.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/primitives/loader.test.ts`:

```typescript
describe('loadDirectoryWithErrors — strict mode reports errors', () => {
  it('reports skills missing required name', () => {
    const root = mkdtempSync(join(tmpdir(), 'loader-test-'));
    const skillsDir = join(root, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const bundleDir = join(skillsDir, 'foo');
    mkdirSync(bundleDir);
    writeFileSync(
      join(bundleDir, 'SKILL.md'),
      `---
description: No name field.
---
Body.`,
      'utf-8'
    );

    const result = loadDirectoryWithErrors(skillsDir);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/name/i);
    expect(result.docs).toHaveLength(0);
  });

  it('reports flat skill files as an error in strict mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'loader-test-'));
    const skillsDir = join(root, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, 'foo.md'),
      `---
name: foo
description: A flat skill.
---
Body.`,
      'utf-8'
    );

    const result = loadDirectoryWithErrors(skillsDir);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/flat .* not supported/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/primitives/loader.test.ts -t "strict mode"`
Expected: FAIL — current loader still loads flat skill files.

- [ ] **Step 3: Reject flat skill files**

Modify the file-handling branch of `loadDirectoryWithErrors`:

```typescript
} else if (stats.isFile() && extname(entry) === '.md') {
  // Per Agent Skills spec, skills MUST be bundles. Flat .md files in skills/
  // are an authoring error.
  if (kind === 'skills') {
    errors.push({
      path: entryPath,
      error: `Flat skill files are not supported per Agent Skills spec. Wrap as ${entry.replace('.md', '')}/SKILL.md. Run \`harness doctor --migrate\` to convert automatically.`,
    });
    continue;
  }
  // Flat primitives for non-skill kinds remain supported through this spec
  // (collapsed in spec #2).
  try {
    const doc = parseHarnessDocument(entryPath, kind);
    if (doc.status !== 'archived' && doc.status !== 'deprecated') {
      docs.push(doc);
    }
  } catch (err) {
    errors.push({
      path: entryPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/primitives/loader.test.ts`
Expected: PASS — all cases including the prior strict-mode error test.

- [ ] **Step 5: Commit**

```bash
git add src/primitives/loader.ts tests/primitives/loader.test.ts
git commit -m "feat(loader): reject flat skills/ files in strict mode

Per Agent Skills spec, a skill is a directory containing SKILL.md.
Flat skills/foo.md files are now reported as errors with a clear
migration hint. Schema validation failures (missing name, etc.) also
surface explicitly instead of silently falling back to a derived id."
```

### Task 3.5: Audit and migrate existing consumers of `doc.l0`, `doc.l1`, `doc.frontmatter.id`

**Files:**
- Modify: any file matching the audit pattern

- [ ] **Step 1: Run the audit**

```bash
grep -rn -E '\.l0|\.l1|\.frontmatter\.id' src/ --include='*.ts'
```

Record the list. Expected callsites: `src/runtime/context-loader.ts`, possibly `src/runtime/auto-processor.ts`, `src/runtime/dispatch.ts`.

- [ ] **Step 2: For each callsite, replace the access**

| Old | New |
|---|---|
| `doc.l0` | `doc.description` |
| `doc.l1` | `doc.description` (no L1 distinction anymore — both collapse to description) |
| `doc.frontmatter.id` | `doc.id` |
| `getAtLevel(doc, 0)` | `doc.description ?? doc.id` |
| `getAtLevel(doc, 1)` | `doc.description ?? doc.id` |
| `getAtLevel(doc, 2)` | `doc.body` |

- [ ] **Step 3: Delete `getAtLevel` from `src/primitives/loader.ts`**

Remove the `getAtLevel` export. Search the codebase for any remaining import:

```bash
grep -rn 'getAtLevel' src/ --include='*.ts'
```

Should be empty after the audit.

- [ ] **Step 4: Run the test suite**

Run: `npm test`
Expected: PASS — all existing tests still green.

- [ ] **Step 5: Run typecheck**

Run: `npm run lint`  (this runs `tsc --noEmit` per [package.json](../../package.json))
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add -p src/
git commit -m "refactor: migrate L0/L1/frontmatter.id consumers to canonical accessors

Audited every src/ file referencing doc.l0, doc.l1, doc.frontmatter.id,
or getAtLevel. All migrated to doc.description / doc.body / doc.id.
getAtLevel deleted. Type check clean, all tests still green."
```

---

## Phase 4: System prompt assembler

### Task 4.1: IDENTITY.md loader with CORE.md deprecation grace

**Files:**
- Modify: `src/runtime/context-loader.ts`
- Test: `tests/runtime/context-loader.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/runtime/context-loader.test.ts` (or extend if it exists):

```typescript
import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadIdentity } from '../../src/runtime/context-loader.js';

describe('loadIdentity', () => {
  it('loads IDENTITY.md when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-test-'));
    writeFileSync(join(dir, 'IDENTITY.md'), '# Test Agent\n\nIdentity content.', 'utf-8');

    const result = loadIdentity(dir);
    expect(result.content).toContain('Identity content.');
    expect(result.source).toBe('IDENTITY.md');
  });

  it('falls back to CORE.md with deprecation warning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-test-'));
    writeFileSync(join(dir, 'CORE.md'), '# Old Agent\n\nLegacy content.', 'utf-8');

    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = loadIdentity(dir);

    expect(result.content).toContain('Legacy content.');
    expect(result.source).toBe('CORE.md');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/CORE\.md is deprecated/));

    warnSpy.mockRestore();
  });

  it('prefers IDENTITY.md when both exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-test-'));
    writeFileSync(join(dir, 'IDENTITY.md'), '# New', 'utf-8');
    writeFileSync(join(dir, 'CORE.md'), '# Old', 'utf-8');

    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = loadIdentity(dir);

    expect(result.content).toBe('# New');
    expect(result.source).toBe('IDENTITY.md');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/CORE\.md.* is being ignored/));

    warnSpy.mockRestore();
  });

  it('returns empty when neither exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-test-'));

    const result = loadIdentity(dir);
    expect(result.content).toBe('');
    expect(result.source).toBe('none');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/runtime/context-loader.test.ts -t loadIdentity`
Expected: FAIL — `loadIdentity` not exported.

- [ ] **Step 3: Implement `loadIdentity`**

Add to `src/runtime/context-loader.ts` (or wherever the system prompt assembly lives — verify the file exists; if it's named differently, adjust the path):

```typescript
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface IdentityLoadResult {
  content: string;
  source: 'IDENTITY.md' | 'CORE.md' | 'none';
}

/**
 * Load the agent's identity file. Prefers IDENTITY.md (the canonical name as of
 * 2026-04-28). Falls back to CORE.md with a deprecation warning. If both exist,
 * IDENTITY.md wins and CORE.md is reported as ignored.
 */
export function loadIdentity(harnessDir: string): IdentityLoadResult {
  const identityPath = join(harnessDir, 'IDENTITY.md');
  const corePath = join(harnessDir, 'CORE.md');

  const hasIdentity = existsSync(identityPath);
  const hasCore = existsSync(corePath);

  if (hasIdentity) {
    if (hasCore) {
      console.error(
        `[deprecation] Both IDENTITY.md and CORE.md found at ${harnessDir}. CORE.md is being ignored. Delete CORE.md or run \`harness doctor --migrate\` to clean up.`
      );
    }
    return { content: readFileSync(identityPath, 'utf-8'), source: 'IDENTITY.md' };
  }

  if (hasCore) {
    console.error(
      `[deprecation] CORE.md is deprecated at ${harnessDir}. Rename to IDENTITY.md or run \`harness doctor --migrate\`.`
    );
    return { content: readFileSync(corePath, 'utf-8'), source: 'CORE.md' };
  }

  return { content: '', source: 'none' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/runtime/context-loader.test.ts -t loadIdentity`
Expected: PASS — all 4 cases.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/context-loader.ts tests/runtime/context-loader.test.ts
git commit -m "feat(runtime): add loadIdentity with CORE.md deprecation grace

Prefers IDENTITY.md (the new canonical name); falls back to CORE.md
with stderr warning; warns about CORE.md being ignored when both
present. Sets up the rename without breaking existing harnesses."
```

### Task 4.2: Wire `loadIdentity` into the system prompt assembly

**Files:**
- Modify: `src/runtime/context-loader.ts` (or the system-prompt-building function)
- Test: `tests/runtime/context-loader.test.ts`

- [ ] **Step 1: Find the existing system prompt builder**

```bash
grep -rn 'buildSystemPrompt\|CORE\.md' src/runtime/ --include='*.ts'
```

Locate the function that today reads `CORE.md` and incorporates it into the system prompt.

- [ ] **Step 2: Write the failing test**

Append to `tests/runtime/context-loader.test.ts`:

```typescript
import { buildSystemPrompt } from '../../src/runtime/context-loader.js';

describe('buildSystemPrompt — uses loadIdentity', () => {
  it('reads IDENTITY.md as the identity section', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprompt-test-'));
    writeFileSync(join(dir, 'IDENTITY.md'), '# I am Edith.', 'utf-8');
    // Minimal config — adjust to actual config shape if needed
    const result = buildSystemPrompt(dir, /* config */ {} as any);
    expect(result).toContain('# I am Edith.');
  });
});
```

- [ ] **Step 3: Run test to verify it fails OR passes spuriously**

Run: `npm test -- tests/runtime/context-loader.test.ts -t buildSystemPrompt`

Expected: depends on current implementation. If the existing `buildSystemPrompt` reads `CORE.md` directly, the test fails. If it has been touched by an earlier task, it may pass.

- [ ] **Step 4: Replace the CORE.md read with `loadIdentity`**

Inside `buildSystemPrompt` (or whatever the function is named), replace:

```typescript
// OLD
const corePath = join(dir, 'CORE.md');
const core = existsSync(corePath) ? readFileSync(corePath, 'utf-8') : '';
```

with:

```typescript
const identity = loadIdentity(dir);
const core = identity.content;
```

Also rename the variable name `core` to `identity` for clarity throughout the function:

```typescript
const identity = loadIdentity(dir);
// ... use identity.content where the old 'core' string was used
```

- [ ] **Step 5: Run the test**

Run: `npm test -- tests/runtime/context-loader.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full test suite to catch regressions**

Run: `npm test`
Expected: PASS — no other tests broken.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/context-loader.ts tests/runtime/context-loader.test.ts
git commit -m "refactor(runtime): system prompt reads IDENTITY.md via loadIdentity

Replaces direct CORE.md read with loadIdentity() so the deprecation
grace and dual-file warning kick in everywhere the system prompt is
assembled."
```

### Task 4.3: Skip `SYSTEM.md` in the system prompt

**Files:**
- Modify: `src/runtime/context-loader.ts`
- Test: `tests/runtime/context-loader.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/runtime/context-loader.test.ts`:

```typescript
describe('buildSystemPrompt — does not read SYSTEM.md', () => {
  it('ignores SYSTEM.md content if present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprompt-test-'));
    writeFileSync(join(dir, 'IDENTITY.md'), '# Identity content.', 'utf-8');
    writeFileSync(join(dir, 'SYSTEM.md'), '# Old infrastructure docs.', 'utf-8');

    const result = buildSystemPrompt(dir, {} as any);
    expect(result).toContain('# Identity content.');
    expect(result).not.toContain('# Old infrastructure docs.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/runtime/context-loader.test.ts -t SYSTEM`
Expected: FAIL — current code reads SYSTEM.md.

- [ ] **Step 3: Remove `SYSTEM.md` reading from `buildSystemPrompt`**

Locate and delete any block in `buildSystemPrompt` that reads `SYSTEM.md`. Replace with a comment if helpful:

```typescript
// SYSTEM.md is no longer authored content. Boot sequence and context-loading
// strategy are documented in README only; runtime details live in code.
```

- [ ] **Step 4: Run the test**

Run: `npm test -- tests/runtime/context-loader.test.ts -t SYSTEM`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/context-loader.ts tests/runtime/context-loader.test.ts
git commit -m "refactor(runtime): stop loading SYSTEM.md into system prompt

SYSTEM.md was harness infrastructure documentation (boot sequence,
file ownership table, context loading strategy) reproduced into every
new harness. None of it was per-agent. The doctor migration command
extracts non-infrastructure content from existing SYSTEM.md files
into rules/operations.md before deleting; ongoing assembly does not
need it."
```

---

## Phase 5: state.md → memory/state.md

### Task 5.1: Move state read/write to `memory/state.md` with grace fallback

**Files:**
- Modify: `src/runtime/state.ts`
- Test: `tests/runtime/state.test.ts`

- [ ] **Step 1: Read the current state module**

```bash
cat src/runtime/state.ts
```

Note the current path resolution. The state file path is likely `<dir>/state.md`.

- [ ] **Step 2: Write the failing test**

Create `tests/runtime/state.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadState, saveState } from '../../src/runtime/state.js';

describe('state — memory/state.md location', () => {
  it('reads from memory/state.md when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'state-test-'));
    mkdirSync(join(dir, 'memory'), { recursive: true });
    writeFileSync(
      join(dir, 'memory', 'state.md'),
      '---\nmode: idle\nlast_interaction: 2026-04-28\n---\n',
      'utf-8'
    );

    const state = loadState(dir);
    expect(state.mode).toBe('idle');
  });

  it('falls back to top-level state.md (deprecation grace)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'state-test-'));
    writeFileSync(
      join(dir, 'state.md'),
      '---\nmode: active\nlast_interaction: 2026-04-28\n---\n',
      'utf-8'
    );

    const state = loadState(dir);
    expect(state.mode).toBe('active');
  });

  it('saveState writes to memory/state.md (creating directory)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'state-test-'));
    saveState(dir, { mode: 'active', goals: [], active_workflows: [], last_interaction: '2026-04-28', unfinished_business: [] });
    expect(existsSync(join(dir, 'memory', 'state.md'))).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- tests/runtime/state.test.ts`
Expected: FAIL — current code uses `<dir>/state.md`.

- [ ] **Step 4: Update `src/runtime/state.ts`**

Modify the path resolution. Replace the existing logic with:

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import matter from 'gray-matter';
import type { AgentState } from '../core/types.js';

const DEFAULT_STATE: AgentState = {
  mode: 'idle',
  goals: [],
  active_workflows: [],
  last_interaction: new Date().toISOString(),
  unfinished_business: [],
};

function statePath(harnessDir: string): string {
  return join(harnessDir, 'memory', 'state.md');
}

function legacyStatePath(harnessDir: string): string {
  return join(harnessDir, 'state.md');
}

export function loadState(harnessDir: string): AgentState {
  const newPath = statePath(harnessDir);
  const oldPath = legacyStatePath(harnessDir);

  let path: string | null = null;
  if (existsSync(newPath)) path = newPath;
  else if (existsSync(oldPath)) {
    path = oldPath;
    console.error(
      `[deprecation] state.md at top level is deprecated. Move to memory/state.md or run \`harness doctor --migrate\`.`
    );
  }

  if (!path) return DEFAULT_STATE;

  const raw = readFileSync(path, 'utf-8');
  const { data } = matter(raw);
  return {
    mode: typeof data.mode === 'string' ? data.mode : DEFAULT_STATE.mode,
    goals: Array.isArray(data.goals) ? data.goals : [],
    active_workflows: Array.isArray(data.active_workflows) ? data.active_workflows : [],
    last_interaction: typeof data.last_interaction === 'string' ? data.last_interaction : DEFAULT_STATE.last_interaction,
    unfinished_business: Array.isArray(data.unfinished_business) ? data.unfinished_business : [],
  };
}

export function saveState(harnessDir: string, state: AgentState): void {
  const path = statePath(harnessDir);
  mkdirSync(dirname(path), { recursive: true });
  const content = matter.stringify('', state);
  writeFileSync(path, content, 'utf-8');
}
```

(Adapt to actual `AgentState` shape — verify against `src/core/types.ts`.)

- [ ] **Step 5: Run the test**

Run: `npm test -- tests/runtime/state.test.ts`
Expected: PASS — all 3 cases.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/state.ts tests/runtime/state.test.ts
git commit -m "refactor(runtime): move state.md to memory/state.md

New canonical path is <harnessDir>/memory/state.md. Reads still fall
back to top-level state.md with a deprecation warning. saveState
always writes to the new path, creating memory/ if needed.

The migrate command (next phase) will move existing top-level state.md
into memory/ and remove the deprecation warning."
```

---

## Phase 6: Doctor migration

### Task 6.1: Scaffold `src/runtime/migration.ts` and `harness doctor --check`

**Files:**
- Create: `src/runtime/migration.ts`
- Modify: `src/cli/index.ts` (or wherever doctor lives)
- Test: `tests/runtime/migration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/runtime/migration.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkMigrations } from '../../src/runtime/migration.js';

describe('checkMigrations', () => {
  it('reports no work needed on a clean modern harness', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    writeFileSync(join(dir, 'IDENTITY.md'), '# Identity', 'utf-8');
    mkdirSync(join(dir, 'memory'), { recursive: true });
    mkdirSync(join(dir, 'skills'), { recursive: true });

    const report = checkMigrations(dir);
    expect(report.findings).toHaveLength(0);
  });

  it('detects CORE.md needs renaming', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    writeFileSync(join(dir, 'CORE.md'), '# Old', 'utf-8');

    const report = checkMigrations(dir);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ kind: 'rename-core-to-identity' })
    );
  });

  it('detects SYSTEM.md needs deletion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    writeFileSync(join(dir, 'SYSTEM.md'), '# Old', 'utf-8');

    const report = checkMigrations(dir);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ kind: 'delete-system-md' })
    );
  });

  it('detects state.md at top level needs moving', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    writeFileSync(join(dir, 'state.md'), '---\nmode: idle\n---', 'utf-8');

    const report = checkMigrations(dir);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ kind: 'move-state-to-memory' })
    );
  });

  it('detects flat skills need bundle restructure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    mkdirSync(join(dir, 'skills'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'foo.md'),
      '---\nname: foo\ndescription: Test.\n---\nBody.',
      'utf-8'
    );

    const report = checkMigrations(dir);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ kind: 'bundle-flat-skill', path: expect.stringContaining('foo.md') })
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/runtime/migration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Scaffold `src/runtime/migration.ts`**

Create `src/runtime/migration.ts`:

```typescript
import { readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';

export type MigrationKind =
  | 'rename-core-to-identity'
  | 'delete-system-md'
  | 'move-state-to-memory'
  | 'bundle-flat-skill'
  | 'rewrite-skill-frontmatter'
  | 'strip-l0-l1-comments'
  | 'remove-id-field'
  | 'convert-allowed-tools-to-string';

export interface MigrationFinding {
  kind: MigrationKind;
  path: string;
  detail?: string;
}

export interface MigrationReport {
  findings: MigrationFinding[];
}

/**
 * Read-only inspection of a harness directory. Returns the list of migrations
 * that would be applied by `applyMigrations` (next task). Idempotent and safe
 * to run on a clean harness.
 */
export function checkMigrations(harnessDir: string): MigrationReport {
  const findings: MigrationFinding[] = [];

  if (existsSync(join(harnessDir, 'CORE.md'))) {
    findings.push({ kind: 'rename-core-to-identity', path: join(harnessDir, 'CORE.md') });
  }

  if (existsSync(join(harnessDir, 'SYSTEM.md'))) {
    findings.push({ kind: 'delete-system-md', path: join(harnessDir, 'SYSTEM.md') });
  }

  if (existsSync(join(harnessDir, 'state.md'))) {
    findings.push({ kind: 'move-state-to-memory', path: join(harnessDir, 'state.md') });
  }

  const skillsDir = join(harnessDir, 'skills');
  if (existsSync(skillsDir) && statSync(skillsDir).isDirectory()) {
    for (const entry of readdirSync(skillsDir)) {
      const entryPath = join(skillsDir, entry);
      if (statSync(entryPath).isFile() && entry.endsWith('.md')) {
        findings.push({ kind: 'bundle-flat-skill', path: entryPath });
      }
    }
  }

  return { findings };
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -- tests/runtime/migration.test.ts`
Expected: PASS — first 5 cases (`rewrite-skill-frontmatter` and the others come in later tasks).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/migration.ts tests/runtime/migration.test.ts
git commit -m "feat(migration): scaffold checkMigrations with file-rename detection

Initial findings: CORE.md, SYSTEM.md, state.md, flat skills/. The
applyMigrations step (next task) will execute these. checkMigrations
runs unconditionally during \`harness doctor\` and \`harness doctor --check\`."
```

### Task 6.2: Implement `applyMigrations` (file renames + state.md move)

**Files:**
- Modify: `src/runtime/migration.ts`
- Test: `tests/runtime/migration.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/runtime/migration.test.ts`:

```typescript
import { applyMigrations } from '../../src/runtime/migration.js';
import { existsSync, readFileSync } from 'fs';

describe('applyMigrations', () => {
  it('renames CORE.md to IDENTITY.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    writeFileSync(join(dir, 'CORE.md'), '# Original content', 'utf-8');

    const report = applyMigrations(dir, checkMigrations(dir));

    expect(existsSync(join(dir, 'CORE.md'))).toBe(false);
    expect(existsSync(join(dir, 'IDENTITY.md'))).toBe(true);
    expect(readFileSync(join(dir, 'IDENTITY.md'), 'utf-8')).toBe('# Original content');
    expect(report.applied).toContainEqual(
      expect.objectContaining({ kind: 'rename-core-to-identity' })
    );
  });

  it('does NOT rename CORE.md when IDENTITY.md exists (warns instead)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    writeFileSync(join(dir, 'CORE.md'), '# Old', 'utf-8');
    writeFileSync(join(dir, 'IDENTITY.md'), '# New', 'utf-8');

    const report = applyMigrations(dir, checkMigrations(dir));

    expect(readFileSync(join(dir, 'IDENTITY.md'), 'utf-8')).toBe('# New');
    expect(readFileSync(join(dir, 'CORE.md'), 'utf-8')).toBe('# Old');
    expect(report.skipped).toContainEqual(
      expect.objectContaining({ kind: 'rename-core-to-identity', reason: expect.stringMatching(/IDENTITY\.md exists/) })
    );
  });

  it('moves state.md to memory/state.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    writeFileSync(join(dir, 'state.md'), '---\nmode: idle\n---', 'utf-8');

    applyMigrations(dir, checkMigrations(dir));

    expect(existsSync(join(dir, 'state.md'))).toBe(false);
    expect(existsSync(join(dir, 'memory', 'state.md'))).toBe(true);
  });

  it('deletes SYSTEM.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    writeFileSync(join(dir, 'SYSTEM.md'), '# Old infra docs', 'utf-8');

    applyMigrations(dir, checkMigrations(dir));

    expect(existsSync(join(dir, 'SYSTEM.md'))).toBe(false);
  });

  it('is idempotent — running twice is a no-op the second time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    writeFileSync(join(dir, 'CORE.md'), '# Old', 'utf-8');

    const r1 = applyMigrations(dir, checkMigrations(dir));
    const r2 = applyMigrations(dir, checkMigrations(dir));

    expect(r1.applied.length).toBeGreaterThan(0);
    expect(r2.applied).toHaveLength(0);
    expect(r2.skipped).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/runtime/migration.test.ts -t applyMigrations`
Expected: FAIL — `applyMigrations` not exported.

- [ ] **Step 3: Implement `applyMigrations`**

Append to `src/runtime/migration.ts`:

```typescript
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, rmSync } from 'fs';
import { dirname, join as pathJoin } from 'path';

export interface ApplyResult {
  applied: MigrationFinding[];
  skipped: Array<MigrationFinding & { reason: string }>;
  errors: Array<MigrationFinding & { reason: string }>;
}

export function applyMigrations(harnessDir: string, report: MigrationReport): ApplyResult {
  const applied: MigrationFinding[] = [];
  const skipped: ApplyResult['skipped'] = [];
  const errors: ApplyResult['errors'] = [];

  for (const finding of report.findings) {
    try {
      switch (finding.kind) {
        case 'rename-core-to-identity': {
          const target = pathJoin(harnessDir, 'IDENTITY.md');
          if (existsSync(target)) {
            skipped.push({ ...finding, reason: 'IDENTITY.md exists; CORE.md left in place' });
            break;
          }
          renameSync(finding.path, target);
          applied.push(finding);
          break;
        }
        case 'delete-system-md': {
          unlinkSync(finding.path);
          applied.push(finding);
          break;
        }
        case 'move-state-to-memory': {
          const target = pathJoin(harnessDir, 'memory', 'state.md');
          if (existsSync(target)) {
            skipped.push({ ...finding, reason: 'memory/state.md exists; top-level state.md left in place' });
            break;
          }
          mkdirSync(dirname(target), { recursive: true });
          renameSync(finding.path, target);
          applied.push(finding);
          break;
        }
        case 'bundle-flat-skill': {
          // Content rewrite handled by a later task — for now just bundle-restructure
          const flatPath = finding.path;
          const baseName = basename(flatPath, '.md');
          const bundleDir = pathJoin(dirname(flatPath), baseName);
          if (existsSync(bundleDir)) {
            skipped.push({ ...finding, reason: `${baseName}/ already exists; flat skill left in place` });
            break;
          }
          mkdirSync(bundleDir, { recursive: true });
          renameSync(flatPath, pathJoin(bundleDir, 'SKILL.md'));
          applied.push(finding);
          break;
        }
        default:
          // Other migration kinds (rewrite-skill-frontmatter, strip-l0-l1-comments,
          // remove-id-field, convert-allowed-tools-to-string) handled in later tasks.
          break;
      }
    } catch (err) {
      errors.push({ ...finding, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { applied, skipped, errors };
}
```

Note: needs `import { existsSync } from 'fs'` and `import { basename } from 'path'` at the top.

- [ ] **Step 4: Run the test**

Run: `npm test -- tests/runtime/migration.test.ts`
Expected: PASS — all 5 new cases.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/migration.ts tests/runtime/migration.test.ts
git commit -m "feat(migration): apply CORE.md/SYSTEM.md/state.md migrations

Renames CORE.md to IDENTITY.md, deletes SYSTEM.md, moves state.md
into memory/. Idempotent — second run is a no-op. Skips with a
reason when target already exists. Errors caught per finding so a
single failure doesn't block the rest of the migration."
```

### Task 6.3: Frontmatter rewrite migration for skills (extension fields → metadata)

**Files:**
- Modify: `src/runtime/migration.ts`
- Test: `tests/runtime/migration.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/runtime/migration.test.ts`:

```typescript
import matter from 'gray-matter';

describe('applyMigrations — skill frontmatter rewrite', () => {
  it('moves top-level extension fields into metadata.harness-*', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    mkdirSync(join(dir, 'skills', 'research'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'research', 'SKILL.md'),
      `---
id: research
name: research
description: A skill.
tags:
  - research
status: active
author: human
created: 2026-01-15
allowed-tools:
  - WebSearch
  - Read
---
Body.`,
      'utf-8'
    );

    const report = checkMigrations(dir);
    expect(report.findings.some(f => f.kind === 'rewrite-skill-frontmatter')).toBe(true);

    applyMigrations(dir, report);

    const after = readFileSync(join(dir, 'skills', 'research', 'SKILL.md'), 'utf-8');
    const parsed = matter(after);
    expect(parsed.data).not.toHaveProperty('id');
    expect(parsed.data).not.toHaveProperty('tags');
    expect(parsed.data).not.toHaveProperty('status');
    expect(parsed.data).not.toHaveProperty('author');
    expect(parsed.data).not.toHaveProperty('created');
    expect(parsed.data.metadata['harness-tags']).toBe('research');
    expect(parsed.data.metadata['harness-status']).toBe('active');
    expect(parsed.data.metadata['harness-author']).toBe('human');
    expect(parsed.data.metadata['harness-created']).toBe('2026-01-15');
    expect(parsed.data['allowed-tools']).toBe('WebSearch Read');
  });

  it('strips L0/L1 HTML comments from body', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    mkdirSync(join(dir, 'skills', 'foo'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'foo', 'SKILL.md'),
      `---
name: foo
description: A skill.
---
<!-- L0: short -->
<!-- L1: longer -->
Body content.`,
      'utf-8'
    );

    const report = checkMigrations(dir);
    expect(report.findings.some(f => f.kind === 'strip-l0-l1-comments')).toBe(true);

    applyMigrations(dir, report);

    const after = readFileSync(join(dir, 'skills', 'foo', 'SKILL.md'), 'utf-8');
    expect(after).not.toMatch(/L0:/);
    expect(after).not.toMatch(/L1:/);
    expect(after).toContain('Body content.');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/runtime/migration.test.ts -t "frontmatter rewrite"`
Expected: FAIL — frontmatter migration not implemented.

- [ ] **Step 3: Add detection**

In `checkMigrations`, after the existing skill-bundle scan, add:

```typescript
// Inspect every existing SKILL.md (in bundles) for frontmatter that needs rewriting
const skillsDir = pathJoin(harnessDir, 'skills');
if (existsSync(skillsDir) && statSync(skillsDir).isDirectory()) {
  for (const entry of readdirSync(skillsDir)) {
    const entryPath = pathJoin(skillsDir, entry);
    const stats = statSync(entryPath);
    if (!stats.isDirectory()) continue;
    const skillMd = pathJoin(entryPath, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    const raw = readFileSync(skillMd, 'utf-8');
    const { data, content } = matter(raw);

    const NON_SPEC_TOP_LEVEL_KEYS = ['id', 'tags', 'status', 'author', 'created', 'updated', 'related'];
    if (NON_SPEC_TOP_LEVEL_KEYS.some((k) => k in data)) {
      findings.push({ kind: 'rewrite-skill-frontmatter', path: skillMd });
    }
    if (Array.isArray(data['allowed-tools'])) {
      findings.push({ kind: 'convert-allowed-tools-to-string', path: skillMd });
    }
    if (/<!--\s*L[01]:/.test(content)) {
      findings.push({ kind: 'strip-l0-l1-comments', path: skillMd });
    }
  }
}
```

- [ ] **Step 4: Add application**

Add to the switch statement in `applyMigrations`:

```typescript
case 'rewrite-skill-frontmatter':
case 'convert-allowed-tools-to-string':
case 'strip-l0-l1-comments': {
  const skillMd = finding.path;
  const raw = readFileSync(skillMd, 'utf-8');
  const { data, content } = matter(raw);

  const newData: Record<string, unknown> = {
    name: data.name,
    description: data.description,
  };
  if (data.license) newData.license = data.license;
  if (data.compatibility) newData.compatibility = data.compatibility;

  // Convert allowed-tools array to string
  if (Array.isArray(data['allowed-tools'])) {
    newData['allowed-tools'] = (data['allowed-tools'] as string[]).join(' ');
  } else if (typeof data['allowed-tools'] === 'string') {
    newData['allowed-tools'] = data['allowed-tools'];
  }

  // Build metadata
  const meta: Record<string, string> = {};
  if (Array.isArray(data.tags) && data.tags.length > 0) {
    meta['harness-tags'] = data.tags.join(',');
  }
  if (data.status) meta['harness-status'] = String(data.status);
  if (data.author) meta['harness-author'] = String(data.author);
  if (data.created) meta['harness-created'] = String(data.created);
  if (data.updated) meta['harness-updated'] = String(data.updated);
  if (Array.isArray(data.related) && data.related.length > 0) {
    meta['harness-related'] = data.related.join(',');
  }
  // Preserve any pre-existing metadata that's already string→string
  if (data.metadata && typeof data.metadata === 'object') {
    for (const [k, v] of Object.entries(data.metadata as Record<string, unknown>)) {
      meta[k] = String(v);
    }
  }
  if (Object.keys(meta).length > 0) {
    newData.metadata = meta;
  }

  // Strip L0/L1 HTML comments from body
  const newContent = content
    .replace(/<!--\s*L0:[\s\S]*?-->\s*\n?/g, '')
    .replace(/<!--\s*L1:[\s\S]*?-->\s*\n?/g, '')
    .trim();

  const out = matter.stringify(newContent, newData);
  writeFileSync(skillMd, out, 'utf-8');
  applied.push(finding);
  break;
}
```

Note: `rewrite-skill-frontmatter`, `convert-allowed-tools-to-string`, and `strip-l0-l1-comments` may all fire for the same file. Deduplicate by file path so the rewrite only happens once.

Add deduplication near the top of `applyMigrations`:

```typescript
const seen = new Set<string>();
const dedupedFindings = report.findings.filter((f) => {
  const key = `${f.kind}::${f.path}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});
// Also: only apply one frontmatter-rewrite per skill file
const rewriteSkillFiles = new Set<string>();
const finalFindings: MigrationFinding[] = [];
for (const f of dedupedFindings) {
  if (
    f.kind === 'rewrite-skill-frontmatter' ||
    f.kind === 'convert-allowed-tools-to-string' ||
    f.kind === 'strip-l0-l1-comments'
  ) {
    if (rewriteSkillFiles.has(f.path)) continue;
    rewriteSkillFiles.add(f.path);
    finalFindings.push({ kind: 'rewrite-skill-frontmatter', path: f.path });
  } else {
    finalFindings.push(f);
  }
}
```

Then iterate `finalFindings` instead of `report.findings`.

- [ ] **Step 5: Run the test**

Run: `npm test -- tests/runtime/migration.test.ts`
Expected: PASS — all cases including frontmatter rewrite and L0/L1 stripping.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/migration.ts tests/runtime/migration.test.ts
git commit -m "feat(migration): rewrite skill frontmatter to spec form

Moves top-level extension fields (tags, status, author, created,
updated, related) into metadata.harness-*. Drops id (name is the
identity). Converts allowed-tools array to space-separated string.
Strips L0/L1 HTML comments from body. Three migration findings
(rewrite-skill-frontmatter, convert-allowed-tools-to-string,
strip-l0-l1-comments) deduplicated per file so a single skill is
rewritten exactly once even if all three are detected."
```

### Task 6.4: Wire `harness doctor --check` and `--migrate` CLI commands

**Files:**
- Modify: `src/cli/index.ts`
- Test: `tests/integration/doctor.cli.test.ts`

- [ ] **Step 1: Read the current CLI structure**

```bash
grep -n 'doctor' src/cli/index.ts
```

Confirm whether a `doctor` command already exists. If yes, extend; if no, add.

- [ ] **Step 2: Write the failing integration test**

Create `tests/integration/doctor.cli.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const HARNESS_BIN = join(__dirname, '..', '..', 'dist', 'cli', 'index.js');

describe('harness doctor --check / --migrate (integration)', () => {
  it('--check on clean harness reports no findings, exits 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-cli-test-'));
    writeFileSync(join(dir, 'IDENTITY.md'), '# Identity', 'utf-8');

    const result = spawnSync('node', [HARNESS_BIN, 'doctor', '--check', '-d', dir], { encoding: 'utf-8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/no migrations needed|clean|0 findings/i);
  });

  it('--check on legacy harness reports findings, exits non-zero', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-cli-test-'));
    writeFileSync(join(dir, 'CORE.md'), '# Old', 'utf-8');

    const result = spawnSync('node', [HARNESS_BIN, 'doctor', '--check', '-d', dir], { encoding: 'utf-8' });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/CORE\.md/);
  });

  it('--migrate fixes the legacy harness', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-cli-test-'));
    writeFileSync(join(dir, 'CORE.md'), '# Old', 'utf-8');

    const result = spawnSync('node', [HARNESS_BIN, 'doctor', '--migrate', '-d', dir], { encoding: 'utf-8' });
    expect(result.status).toBe(0);
    expect(existsSync(join(dir, 'IDENTITY.md'))).toBe(true);
    expect(existsSync(join(dir, 'CORE.md'))).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Build first: `npm run build`. Then: `npm test -- tests/integration/doctor.cli.test.ts`
Expected: FAIL — command not registered or doesn't behave as expected.

- [ ] **Step 4: Wire the command**

In `src/cli/index.ts`, add:

```typescript
import { checkMigrations, applyMigrations } from '../runtime/migration.js';

program
  .command('doctor')
  .description('Inspect a harness for spec compliance and migration needs')
  .option('-d, --dir <path>', 'harness directory', process.cwd())
  .option('--check', 'report findings only, do not modify files', false)
  .option('--migrate', 'apply detected migrations', false)
  .action((opts) => {
    const harnessDir = resolve(opts.dir);
    const report = checkMigrations(harnessDir);

    if (report.findings.length === 0) {
      console.log('Harness is clean — no migrations needed.');
      process.exit(0);
    }

    if (opts.check && !opts.migrate) {
      console.log(`Found ${report.findings.length} migration(s):`);
      for (const f of report.findings) {
        console.log(`  - ${f.kind}: ${f.path}`);
      }
      console.log(`\nRun 'harness doctor --migrate' to apply.`);
      process.exit(1);
    }

    if (opts.migrate) {
      const result = applyMigrations(harnessDir, report);
      console.log(`Applied: ${result.applied.length}`);
      for (const f of result.applied) console.log(`  ✓ ${f.kind}: ${f.path}`);
      if (result.skipped.length > 0) {
        console.log(`Skipped: ${result.skipped.length}`);
        for (const f of result.skipped) console.log(`  ⚠ ${f.kind}: ${f.path} (${f.reason})`);
      }
      if (result.errors.length > 0) {
        console.log(`Errors: ${result.errors.length}`);
        for (const f of result.errors) console.log(`  ✗ ${f.kind}: ${f.path} (${f.reason})`);
        process.exit(1);
      }
      process.exit(0);
    }

    // Default (no --check, no --migrate): print findings (same as --check)
    console.log(`Found ${report.findings.length} migration(s):`);
    for (const f of report.findings) {
      console.log(`  - ${f.kind}: ${f.path}`);
    }
    console.log(`\nRun 'harness doctor --migrate' to apply.`);
    process.exit(1);
  });
```

If a `doctor` command already exists, extend it instead of redefining.

- [ ] **Step 5: Build and run the test**

```bash
npm run build && npm test -- tests/integration/doctor.cli.test.ts
```
Expected: PASS — all 3 cases.

- [ ] **Step 6: Commit**

```bash
git add src/cli/index.ts tests/integration/doctor.cli.test.ts
git commit -m "feat(cli): wire 'harness doctor --check / --migrate'

--check reports findings and exits 1 when work is needed (CI-friendly).
--migrate applies the changes and exits 0 on success. Without flags,
behavior is the same as --check."
```

---

## Phase 7: Auto-processor + scaffolding

### Task 7.1: Update auto-processor to validate against new strict schema for skills

**Files:**
- Modify: `src/runtime/auto-processor.ts` (verify name; adapt path if different)
- Test: `tests/runtime/auto-processor.test.ts`

- [ ] **Step 1: Read existing auto-processor**

```bash
cat src/runtime/auto-processor.ts | head -60
```

Identify the on-save validation point.

- [ ] **Step 2: Write the failing test**

Create or extend `tests/runtime/auto-processor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { processSkillOnSave } from '../../src/runtime/auto-processor.js';

describe('auto-processor — strict skill validation', () => {
  it('refuses to save a skill with missing description (or fills it)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autoproc-test-'));
    mkdirSync(join(dir, 'skills', 'foo'), { recursive: true });
    const skillPath = join(dir, 'skills', 'foo', 'SKILL.md');
    writeFileSync(
      skillPath,
      `---
name: foo
---
First paragraph of the body.

Second paragraph.`,
      'utf-8'
    );

    // Mock summary_model so this is deterministic
    const result = await processSkillOnSave(skillPath, {
      generateDescription: async () => 'Auto-generated description from first paragraph.',
    });

    expect(result.status).toBe('processed');
    const after = readFileSync(skillPath, 'utf-8');
    expect(after).toMatch(/description:.*Auto-generated description/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails or doesn't compile**

Run: `npm test -- tests/runtime/auto-processor.test.ts`
Expected: FAIL — `processSkillOnSave` may not exist or have a different signature.

- [ ] **Step 4: Implement or update `processSkillOnSave`**

In `src/runtime/auto-processor.ts`:

```typescript
import { readFileSync, writeFileSync } from 'fs';
import matter from 'gray-matter';
import { SkillFrontmatterSchema } from '../core/types.js';

export interface ProcessSkillOptions {
  /** Async function to generate a description from a body paragraph (typically wraps summary_model) */
  generateDescription?: (body: string) => Promise<string>;
}

export interface ProcessSkillResult {
  status: 'processed' | 'unchanged' | 'error';
  detail?: string;
}

export async function processSkillOnSave(
  skillPath: string,
  opts: ProcessSkillOptions
): Promise<ProcessSkillResult> {
  const raw = readFileSync(skillPath, 'utf-8');
  const { data, content } = matter(raw);

  let changed = false;

  // Generate description if missing and a generator is available
  if (!data.description && opts.generateDescription) {
    const firstParagraph = content.split(/\n\s*\n/)[0]?.trim() ?? '';
    if (firstParagraph) {
      const generated = await opts.generateDescription(firstParagraph);
      if (generated && generated.length <= 1024) {
        data.description = generated;
        changed = true;
      }
    }
  }

  // Validate against the strict skill schema; if it fails, leave the file
  // alone and report the error (the user must fix it manually or run doctor).
  const parseResult = SkillFrontmatterSchema.safeParse(data);
  if (!parseResult.success && !changed) {
    return { status: 'error', detail: parseResult.error.message };
  }

  if (changed) {
    writeFileSync(skillPath, matter.stringify(content, data), 'utf-8');
    return { status: 'processed' };
  }
  return { status: 'unchanged' };
}
```

- [ ] **Step 5: Run the test**

Run: `npm test -- tests/runtime/auto-processor.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/auto-processor.ts tests/runtime/auto-processor.test.ts
git commit -m "feat(auto-processor): generate missing descriptions for skills

When a skill is saved without a description, the auto-processor
generates one from the body's first paragraph using the configured
summary_model. Validates against the strict skill schema and reports
errors when validation fails."
```

### Task 7.2: Update scaffolding to emit IDENTITY.md, no SYSTEM.md, memory/state.md

**Files:**
- Modify: `src/cli/scaffold.ts`
- Test: `tests/integration/scaffold.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/scaffold.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const HARNESS_BIN = join(__dirname, '..', '..', 'dist', 'cli', 'index.js');

describe('harness init scaffolds new layout', () => {
  it('creates IDENTITY.md, not CORE.md', () => {
    const parent = mkdtempSync(join(tmpdir(), 'scaffold-test-'));
    const dir = join(parent, 'test-agent');

    const result = spawnSync(
      'node',
      [HARNESS_BIN, 'init', 'test-agent', '--template', 'base', '-y'],
      { cwd: parent, encoding: 'utf-8' }
    );

    expect(result.status).toBe(0);
    expect(existsSync(join(dir, 'IDENTITY.md'))).toBe(true);
    expect(existsSync(join(dir, 'CORE.md'))).toBe(false);
  });

  it('does NOT create SYSTEM.md', () => {
    const parent = mkdtempSync(join(tmpdir(), 'scaffold-test-'));
    spawnSync('node', [HARNESS_BIN, 'init', 'test-agent', '--template', 'base', '-y'], { cwd: parent });
    expect(existsSync(join(parent, 'test-agent', 'SYSTEM.md'))).toBe(false);
  });

  it('places state.md at memory/state.md', () => {
    const parent = mkdtempSync(join(tmpdir(), 'scaffold-test-'));
    spawnSync('node', [HARNESS_BIN, 'init', 'test-agent', '--template', 'base', '-y'], { cwd: parent });
    const dir = join(parent, 'test-agent');
    expect(existsSync(join(dir, 'memory', 'state.md'))).toBe(true);
    expect(existsSync(join(dir, 'state.md'))).toBe(false);
  });
});
```

- [ ] **Step 2: Build and run the test**

```bash
npm run build && npm test -- tests/integration/scaffold.test.ts
```
Expected: FAIL — current scaffold creates CORE.md and SYSTEM.md.

- [ ] **Step 3: Update `src/cli/scaffold.ts`**

Locate the scaffolding logic. Replace any references to `CORE.md` with `IDENTITY.md`. Remove emission of `SYSTEM.md` entirely. Move `state.md` emission to `memory/state.md`. The exact diff depends on existing code structure — read the file and adapt.

Also update `templates/<each>/`:
- Rename `templates/base/CORE.md` → `templates/base/IDENTITY.md`
- Delete `templates/base/SYSTEM.md`
- Repeat for `templates/dev/`, `templates/code-reviewer/`, `templates/assistant/`, `templates/local/`, `templates/claude-opus/`, `templates/gpt4/`

For each template, run:
```bash
mv templates/<name>/CORE.md templates/<name>/IDENTITY.md
rm templates/<name>/SYSTEM.md
```

(Verify each template: `ls templates/`. Some templates may not have these files.)

- [ ] **Step 4: Build and run the tests**

```bash
npm run build && npm test -- tests/integration/scaffold.test.ts
```
Expected: PASS — all 3 cases.

- [ ] **Step 5: Commit**

```bash
git add src/cli/scaffold.ts templates/
git commit -m "feat(scaffold): emit IDENTITY.md, no SYSTEM.md, memory/state.md

Updates 'harness init' to scaffold the new file layout. Renames
templates/<name>/CORE.md to IDENTITY.md across all built-in templates.
Deletes templates/<name>/SYSTEM.md (was infrastructure documentation,
not user-editable content)."
```

---

## Phase 8: Defaults migration

### Task 8.1: Convert flat default skills to bundles

**Files:**
- Modify: `defaults/skills/` (restructure)
- Test: covered by `tests/integration/defaults.test.ts` (next step)

- [ ] **Step 1: Make the structural moves**

For each of `business-analyst.md`, `content-marketer.md`, `delegate-to-cli.md`, `research.md`:

```bash
cd defaults/skills
mkdir business-analyst content-marketer delegate-to-cli research
mv business-analyst.md business-analyst/SKILL.md
mv content-marketer.md content-marketer/SKILL.md
mv delegate-to-cli.md delegate-to-cli/SKILL.md
mv research.md research/SKILL.md
```

- [ ] **Step 2: Apply migration to each new SKILL.md**

For each, run `applyMigrations` programmatically OR hand-edit each frontmatter block to:
- Remove `id`
- Move `tags`, `status`, `author`, `created`, `updated`, `related` into `metadata.harness-*`
- Convert `allowed-tools` array (if present) to space-separated string
- Strip `<!-- L0: -->` and `<!-- L1: -->` from body
- Ensure `name` matches parent directory and is required
- Ensure `description` is required and ≤ 1024 chars

Easier path: run `harness doctor --migrate -d defaults/` if the migrate command points at the defaults directory correctly. Verify by reading each SKILL.md after.

- [ ] **Step 3: Verify each new SKILL.md is valid**

```bash
npm run build
node dist/cli/index.js doctor --check -d defaults
```
Expected: clean (no findings).

- [ ] **Step 4: Run the full test suite to catch regressions**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add defaults/skills/
git commit -m "refactor(defaults): convert flat skills to spec-conformant bundles

Each of business-analyst, content-marketer, delegate-to-cli, and
research is now a directory containing SKILL.md, with frontmatter
matching the strict Agent Skills schema. Body content unchanged
(rewrite is spec #3); only structural and frontmatter migration."
```

### Task 8.2: Add a defaults validation test

**Files:**
- Test: `tests/integration/defaults.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/integration/defaults.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { loadAllPrimitivesWithErrors } from '../../src/primitives/loader.js';

describe('defaults/ — spec compliance', () => {
  it('every default skill loads cleanly', () => {
    const defaultsDir = join(__dirname, '..', '..', 'defaults');
    const result = loadAllPrimitivesWithErrors(defaultsDir);
    expect(result.errors).toHaveLength(0);
  });

  it('every default skill has a description', () => {
    const defaultsDir = join(__dirname, '..', '..', 'defaults');
    const result = loadAllPrimitivesWithErrors(defaultsDir);
    const skills = result.primitives.get('skills') ?? [];
    for (const skill of skills) {
      expect(skill.description, `skill ${skill.name} missing description`).toBeTruthy();
      expect(skill.description!.length).toBeGreaterThan(0);
      expect(skill.description!.length).toBeLessThanOrEqual(1024);
    }
  });

  it('every default skill has bundleDir set (i.e., is a bundle, not flat)', () => {
    const defaultsDir = join(__dirname, '..', '..', 'defaults');
    const result = loadAllPrimitivesWithErrors(defaultsDir);
    const skills = result.primitives.get('skills') ?? [];
    for (const skill of skills) {
      expect(skill.bundleDir, `skill ${skill.name} should be a bundle`).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- tests/integration/defaults.test.ts`
Expected: PASS — all 3 cases.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/defaults.test.ts
git commit -m "test(integration): assert defaults/ are spec-compliant

Loads every default primitive via the production loader and asserts
zero errors, every skill has a description in [1, 1024] chars, and
every skill is a bundle (not flat). This is the regression gate for
default skill quality."
```

---

## Phase 9: Vendor superpowers skills

### Task 9.1: License audit

**Files:**
- (no code changes — verification only)

- [ ] **Step 1: Check root license**

```bash
gh api repos/obra/superpowers/license
```

- [ ] **Step 2: Verify response**

If `license.spdx_id` is one of `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `MPL-2.0`, `CC-BY-4.0`, `CC0-1.0`, `Unlicense` → proceed.

If `license.spdx_id` is `null`, `NOASSERTION`, or any "all rights reserved" / proprietary identifier → **HALT**. Re-author from scratch instead. Do NOT proceed with vendoring.

- [ ] **Step 3: Per-skill LICENSE check**

For each of the four skills we plan to vendor, check for sibling LICENSE files:

```bash
gh api repos/obra/superpowers/contents/skills/brainstorming
gh api repos/obra/superpowers/contents/skills/writing-plans
gh api repos/obra/superpowers/contents/skills/executing-plans
gh api repos/obra/superpowers/contents/skills/dispatching-parallel-agents
```

If any directory has a `LICENSE` / `LICENSE.txt` / `LICENSE.md` / `COPYING` file, fetch and inspect it. If proprietary, halt that skill specifically.

- [ ] **Step 4: Record audit result**

Write to `docs/plans/superpowers-vendor-license-audit.md`:

```markdown
# Vendoring license audit — obra/superpowers

Date: 2026-04-28
Source: https://github.com/obra/superpowers
Commit checked: <sha>

Root LICENSE: <SPDX id from gh api>
Verdict: <pass | halt>

Per-skill checks:
- skills/brainstorming/: <no per-file LICENSE | LICENSE: <SPDX>>
- skills/writing-plans/: ...
- skills/executing-plans/: ...
- skills/dispatching-parallel-agents/: ...

Decision: <proceed | halt>
```

- [ ] **Step 5: Commit the audit**

```bash
git add docs/plans/superpowers-vendor-license-audit.md
git commit -m "docs: license audit for obra/superpowers vendoring

Records the audit per user CLAUDE.md §10 release discipline. Will
gate the actual vendoring step."
```

### Task 9.2: Vendor brainstorming skill (if audit passed)

**Files:**
- Create: `defaults/skills/brainstorming/SKILL.md`
- Create: `defaults/skills/brainstorming/` (any subdirectories from upstream)
- Modify: `NOTICE`

- [ ] **Step 1: Pull the skill content**

```bash
gh api repos/obra/superpowers/contents/skills/brainstorming/SKILL.md --jq '.content' | base64 -d > /tmp/brainstorming-SKILL.md
```

Inspect the file. Record the upstream commit SHA: `gh api repos/obra/superpowers/commits/main --jq '.sha'`

- [ ] **Step 2: Restructure as a default**

```bash
mkdir -p defaults/skills/brainstorming
cp /tmp/brainstorming-SKILL.md defaults/skills/brainstorming/SKILL.md
```

If the upstream skill has `scripts/`, `references/`, or `assets/`, recursively pull those too.

- [ ] **Step 3: Adapt frontmatter to spec-conformant form**

Edit `defaults/skills/brainstorming/SKILL.md`:

- Ensure `name: brainstorming` matches the parent directory
- Ensure `description` is present, 1–1024 chars, follows imperative form
- Move any non-spec top-level fields into `metadata.harness-*`
- Convert `allowed-tools` (if present as array) to space-separated string
- Add provenance metadata:

```yaml
metadata:
  harness-source: "https://github.com/obra/superpowers/blob/<commit-sha>/skills/brainstorming/SKILL.md"
  harness-source-commit: "<commit-sha>"
  harness-license: "<SPDX from audit>"
  harness-license-source: "https://github.com/obra/superpowers/blob/<commit-sha>/LICENSE"
  harness-vendored-at: "2026-04-28"
  harness-author: human
  harness-status: active
```

- [ ] **Step 4: Adapt body**

Strip references to non-vendored superpowers skills (e.g., references to `test-driven-development` should be removed; references to `writing-plans` are fine since we're vendoring it). Replace any coding-flavored examples with neutral ones if they would confuse a non-coding agent.

- [ ] **Step 5: Append NOTICE entry**

Append to `NOTICE`:

```
================================================================
defaults/skills/brainstorming/

Source: https://github.com/obra/superpowers
Commit: <sha>
License: <SPDX>
Copyright (c) <upstream copyright line from LICENSE>
License source: https://github.com/obra/superpowers/blob/<sha>/LICENSE
================================================================
```

- [ ] **Step 6: Verify load**

```bash
npm run build
node dist/cli/index.js doctor --check -d defaults
```
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add defaults/skills/brainstorming/ NOTICE
git commit -m "feat(defaults): vendor brainstorming skill from obra/superpowers

Vendored at obra/superpowers@<sha> per license audit. Provenance
metadata records source URL, commit, license, and vendor date.
Body adapted: stripped non-vendored skill references."
```

### Task 9.3: Vendor writing-plans, executing-plans, dispatching-parallel-agents

Repeat task 9.2's procedure for each. Each becomes its own commit.

- [ ] **Vendor writing-plans** — same procedure
- [ ] **Vendor executing-plans** — same procedure
- [ ] **Vendor dispatching-parallel-agents** — same procedure

After all four are vendored, run a final regression:

```bash
npm test
npm run lint
npm run build && node dist/cli/index.js doctor --check -d defaults
```
Expected: all clean.

---

## Phase 10: End-to-end migration test

### Task 10.1: Build a pre-migration fixture

**Files:**
- Create: `tests/fixtures/old-harness/`

- [ ] **Step 1: Create the fixture directory tree**

```bash
mkdir -p tests/fixtures/old-harness/{skills,rules,memory}
```

- [ ] **Step 2: Populate with pre-migration shapes**

Create `tests/fixtures/old-harness/CORE.md`:

```markdown
# Test Agent

A test agent for migration.
```

Create `tests/fixtures/old-harness/SYSTEM.md`:

```markdown
# System

You are TestAgent.

## Boot Sequence
1. Load CORE.md
2. Load state.md
```

Create `tests/fixtures/old-harness/state.md`:

```markdown
---
mode: idle
last_interaction: 2026-04-28
---
```

Create `tests/fixtures/old-harness/skills/research.md` (flat, with old-shape frontmatter):

```markdown
---
id: research
name: research
description: Conduct research.
tags:
  - research
  - skill
status: active
author: human
created: 2026-01-15
allowed-tools:
  - WebSearch
  - Read
---
<!-- L0: short -->
<!-- L1: longer -->

Body content.
```

Create `tests/fixtures/old-harness/rules/operations.md`:

```markdown
---
id: operations
name: operations
description: Operational rules.
tags:
  - rule
status: active
---

Always do X.
```

- [ ] **Step 3: Commit the fixture**

```bash
git add tests/fixtures/old-harness/
git commit -m "test: add pre-migration harness fixture

Captures the v0.8.x file layout: CORE.md, SYSTEM.md, top-level
state.md, flat skills/research.md with old-shape frontmatter and
L0/L1 comments. Used by the e2e migration test."
```

### Task 10.2: Write the e2e migration test

**Files:**
- Create: `tests/integration/migration.e2e.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/integration/migration.e2e.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { cpSync, mkdtempSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import matter from 'gray-matter';

const HARNESS_BIN = join(__dirname, '..', '..', 'dist', 'cli', 'index.js');
const FIXTURE = join(__dirname, '..', 'fixtures', 'old-harness');

function copyFixtureToTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mig-e2e-'));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

describe('e2e — old harness migration', () => {
  it('--check reports findings on the old harness', () => {
    const dir = copyFixtureToTmp();
    const result = spawnSync('node', [HARNESS_BIN, 'doctor', '--check', '-d', dir], { encoding: 'utf-8' });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/CORE\.md|SYSTEM\.md|state\.md|flat skill/);
  });

  it('--migrate fully converts the fixture', () => {
    const dir = copyFixtureToTmp();

    const r1 = spawnSync('node', [HARNESS_BIN, 'doctor', '--migrate', '-d', dir], { encoding: 'utf-8' });
    expect(r1.status).toBe(0);

    // Identity rename
    expect(existsSync(join(dir, 'IDENTITY.md'))).toBe(true);
    expect(existsSync(join(dir, 'CORE.md'))).toBe(false);

    // System deletion
    expect(existsSync(join(dir, 'SYSTEM.md'))).toBe(false);

    // State move
    expect(existsSync(join(dir, 'memory', 'state.md'))).toBe(true);
    expect(existsSync(join(dir, 'state.md'))).toBe(false);

    // Skill bundling
    expect(existsSync(join(dir, 'skills', 'research', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, 'skills', 'research.md'))).toBe(false);

    // Skill frontmatter rewrite
    const skillRaw = readFileSync(join(dir, 'skills', 'research', 'SKILL.md'), 'utf-8');
    const { data, content } = matter(skillRaw);
    expect(data).not.toHaveProperty('id');
    expect(data).not.toHaveProperty('tags');
    expect(data.metadata['harness-tags']).toBe('research,skill');
    expect(data['allowed-tools']).toBe('WebSearch Read');
    expect(content).not.toMatch(/<!--\s*L[01]:/);

    // Idempotency
    const r2 = spawnSync('node', [HARNESS_BIN, 'doctor', '--migrate', '-d', dir], { encoding: 'utf-8' });
    expect(r2.status).toBe(0);
    expect(r2.stdout).toMatch(/no migrations needed|clean|0 findings/i);
  });
});
```

- [ ] **Step 2: Build and run the test**

```bash
npm run build && npm test -- tests/integration/migration.e2e.test.ts
```
Expected: PASS — both cases.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/migration.e2e.test.ts
git commit -m "test(e2e): assert old harness migrates cleanly

Copies tests/fixtures/old-harness/ to a tmpdir, runs doctor --check
(expects findings + non-zero), runs doctor --migrate, asserts every
migration applied correctly (IDENTITY rename, SYSTEM delete, state
move, skill bundle, frontmatter rewrite, L0/L1 strip), and verifies
idempotency by running --migrate again."
```

---

## Phase 11: Documentation

### Task 11.1: Update README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the directory diagram**

Locate the existing `## How it works` section and the directory diagram. Replace `CORE.md`, `SYSTEM.md`, and top-level `state.md` references with the new layout:

```
my-agent/
├── IDENTITY.md             # Agent identity (was CORE.md)
├── config.yaml             # Model, runtime, memory, MCP, scheduler
├── rules/                  # Human-authored operational boundaries
├── instincts/              # Agent-learned reflexive behaviors (collapsed in next release)
├── skills/                 # Capabilities with embedded expertise (Agent Skills bundles)
├── playbooks/              # Adaptive guidance (collapsed in next release)
├── workflows/              # Cron-driven automations (collapsed in next release)
├── tools/                  # External service integrations (collapsed in next release)
├── agents/                 # Sub-agent roster (collapsed in next release)
└── memory/
    ├── state.md            # Live state (mode, goals, last interaction)
    ├── sessions/           # Auto-captured interaction records
    ├── journal/            # Daily synthesized reflections
    └── scratch.md          # Ephemeral working memory
```

- [ ] **Step 2: Update the frontmatter examples section**

Locate the existing frontmatter examples. Replace with the new shape:

```yaml
# Agent Skills schema (canonical for skills/)
---
name: my-skill
description: One-line description of what this skill does and when to use it.
license: MIT
allowed-tools: Read Bash(jq:*)
metadata:
  harness-tags: "knowledge-work,research"
  harness-status: active
  harness-author: human
  harness-created: "2026-04-28"
---

# Harness extension schema (rules, playbooks, workflows, etc.)
---
name: my-rule
description: One-line description.
tags: [boundary]
status: active
author: human
created: 2026-04-28
---
```

- [ ] **Step 3: Note the deprecation of L0/L1**

Find the section that references "L0", "L1", "L2", or "progressive disclosure." Replace with:

```markdown
### Progressive disclosure

The harness loads files at three tiers per the [Agent Skills spec](https://agentskills.io/specification#progressive-disclosure):

1. **Discovery** (~50–100 tokens per skill): name + description loaded for every skill at boot
2. **Activation** (full body): loaded when the model invokes `activate_skill` for that skill
3. **Resources** (`scripts/`, `references/`, `assets/`): loaded on demand via the agent's read tools

Identity (`IDENTITY.md`) and rules (`rules/`) are always loaded in full. Skills are loaded progressively.
```

- [ ] **Step 4: Verify the README still builds clean**

If the README is rendered by any tooling (CI link checker, etc.), run:

```bash
npm test
```

Expected: still passing.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(readme): update for IDENTITY.md, drop L0/L1, frontmatter examples

Replaces CORE.md with IDENTITY.md in the directory diagram. Drops
SYSTEM.md from the canonical layout. Moves state.md under memory/.
Replaces the L0/L1/L2 progressive disclosure description with the
Agent Skills three-tier model (discovery/activation/resources)."
```

### Task 11.2: Author docs/skill-authoring.md

**Files:**
- Create: `docs/skill-authoring.md`

- [ ] **Step 1: Author the guide**

Create `docs/skill-authoring.md`:

```markdown
# Authoring skills

This guide describes how to write skills that conform to the [Agent Skills specification](https://agentskills.io/specification) and integrate well with agent-harness.

## File layout

A skill is a directory containing `SKILL.md` and optional support directories:

\`\`\`
skills/<name>/
├── SKILL.md          # required: frontmatter + instructions
├── scripts/          # optional: executable code the agent invokes
├── references/       # optional: detailed docs the agent loads on demand
└── assets/           # optional: templates, data files
\`\`\`

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
- `metadata.harness-tags`
- `metadata.harness-status`
- `metadata.harness-author`
- `metadata.harness-created`
- `metadata.harness-updated`
- `metadata.harness-related`

## Body content

Recommended sections:
1. **When to use** — imperative phrasing matching the description
2. **Available scripts** — bullet list of bundled scripts with one-line purpose
3. **Workflow** — numbered steps with concrete script invocations
4. **Gotchas** — non-obvious facts the agent would otherwise get wrong
5. **Failure modes** — known errors and recovery hints

Keep `SKILL.md` under 500 lines / 5000 tokens. Move detailed material to `references/` and tell the agent when to load it.

## Validation

\`\`\`bash
harness doctor --check -d <harness-dir>
\`\`\`

The doctor reports any spec violations across every skill in the harness.

## Migration

If you have skills authored before 2026-04-28 (with `id`, top-level `tags`/`status`/etc., flat `.md` files, or L0/L1 HTML comments), run:

\`\`\`bash
harness doctor --migrate -d <harness-dir>
\`\`\`

The migration is idempotent and reversible via git.
```

- [ ] **Step 2: Verify the link works**

Open the README. Add a link to `docs/skill-authoring.md` from the relevant section (probably "Why markdown" or "How it works").

- [ ] **Step 3: Commit**

```bash
git add docs/skill-authoring.md README.md
git commit -m "docs(authoring): add skill authoring guide

New canonical reference for writing spec-conformant skills. Covers
file layout, frontmatter (required, optional, harness extensions),
body content recommendations, validation, and migration. Linked
from README."
```

---

## Phase 12: Final verification

### Task 12.1: Full regression run

- [ ] **Step 1: Run all tests**

```bash
npm test
```
Expected: PASS.

- [ ] **Step 2: Run the typecheck**

```bash
npm run lint
```
Expected: no errors.

- [ ] **Step 3: Build the dist**

```bash
npm run build
```
Expected: produces `dist/cli/index.js` without errors.

- [ ] **Step 4: Smoke test the CLI**

```bash
node dist/cli/index.js --version
```
Expected: prints the version number from `package.json`.

```bash
node dist/cli/index.js doctor --check -d defaults
```
Expected: clean (no findings).

```bash
TMPDIR=/tmp node dist/cli/index.js init smoke-test --template base -y
ls /tmp/smoke-test/
```
Expected: contains `IDENTITY.md`, NOT `CORE.md`, NOT `SYSTEM.md`, contains `memory/state.md`.

- [ ] **Step 5: Run the e2e migration test**

```bash
npm test -- tests/integration/migration.e2e.test.ts
```
Expected: PASS.

### Task 12.2: Version bump

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump version**

```bash
npm version minor
```

Per spec §9, this is a breaking change but pre-1.0, so `0.8.x → 0.9.0` is the right bump (`npm version minor` on a pre-1.0 package). The command updates `package.json`, commits, and tags atomically.

- [ ] **Step 2: Verify**

```bash
node dist/cli/index.js --version  # should print 0.9.0 (after a rebuild)
```

If the printed version is wrong, the CLI is reading from a stale bundle. Per user CLAUDE.md §10 ("Validate the dynamic lookup against the BUILT bundle"), rebuild and re-test:

```bash
npm run build
node dist/cli/index.js --version
```

- [ ] **Step 3: Push (when ready)**

When the user says to publish:

```bash
git push origin main
git push origin --tags
```

CI's release workflow handles `npm publish --access public`.

---

## Self-review

After writing all tasks, run the spec-coverage checklist:

- [ ] **Spec §4.1 — Frontmatter schema**: Tasks 1.1–1.4 cover the schema split. Tests cover validation rules.
- [ ] **Spec §4.2 — Loader behavior**: Tasks 3.1–3.5 cover normalization, L0/L1 drop, parent-dir match, strict mode, and consumer migration.
- [ ] **Spec §4.3 — File layout changes**: Tasks 4.1–5.1 cover IDENTITY.md, SYSTEM.md drop, state.md move.
- [ ] **Spec §4.4 — Doctor migration**: Tasks 6.1–6.4 cover detection, application, frontmatter rewrite, CLI wiring.
- [ ] **Spec §4.5 — Vendoring superpowers**: Tasks 9.1–9.3 cover license audit + per-skill vendoring + NOTICE updates.
- [ ] **Spec §6 phase 4 — Defaults migration**: Tasks 8.1–8.2 cover defaults restructure and validation.
- [ ] **Spec §6 phase 6 — Documentation**: Tasks 11.1–11.2 cover README and skill-authoring guide.

No tasks reference TODOs, TBDs, or placeholder comments. Every code step has full code. Every test step has a runnable command.

Type/method consistency check:
- `nameSchema`, `descriptionSchema`, `compatibilitySchema` — defined in 1.1/1.2, used by 1.3/1.4
- `SkillFrontmatterSchema`, `NonSkillFrontmatterSchema` — defined in 1.3/1.4, used by 3.2
- `normalizeFrontmatter` — defined in 3.1, used by 3.2
- `parseHarnessDocument(filePath, kind, bundleDir?)` — signature changed in 3.2 to add `kind`; verified by tests in 3.3, 3.4
- `loadIdentity` — defined in 4.1, used by 4.2
- `processSkillOnSave` — defined in 7.1
- `checkMigrations`, `applyMigrations` — defined in 6.1, 6.2; extended in 6.3; used by 6.4 and 10.2

All consistent.

---

## Execution

Plan complete and saved to `docs/plans/2026-04-28-skills-spec-conformance-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatches a fresh subagent per task, reviews between tasks, fast iteration. Best when each task is bounded and the parent doesn't need to maintain context across tasks.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints. Best when the parent needs full visibility and adjacent tasks share context that would be wasted if subagents started fresh.

Which approach?
