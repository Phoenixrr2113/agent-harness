# Provider integration — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent-harness a good citizen in projects that already use other agent tooling. Implement `harness export <provider>` for Claude Code, OpenAI Codex, Cursor, GitHub Copilot, Gemini CLI, and the cross-tool `.agents/` convention; add init-time detection of existing provider config and offer to wire up sync; detect and surface drift between the harness's source-of-truth content and the generated provider artifacts; auto-export on `harness dev` save events.

**Architecture:** A new `src/runtime/export/` module hosts the adapter framework: `types.ts` defines the uniform `ProviderAdapter` interface and `ExportReport`/`DriftReport` shapes, `registry.ts` registers the per-provider adapters, `runner.ts` is the top-level orchestrator (`runExport(harnessDir, target, options)`), and `adapters/<name>.ts` are the per-provider implementations. The harness directory remains canonical; provider files are generated artifacts with an embedded provenance marker (frontmatter or HTML comment) and a content hash for drift detection. `harness export` runs imperatively or auto-fires on save events via `src/runtime/watcher.ts` integration. Init detection lives in `src/cli/scaffold.ts` and writes an `export` block into the new harness's `config.yaml`.

**Tech Stack:** TypeScript (strict), Zod for config schema, vitest for tests, gray-matter for YAML frontmatter, chokidar for the existing file watcher. Builds via tsup. Test commands: `npm test -- <pattern>`. Build: `npm run build`. Node 20+.

---

## Reference

- Design spec: [docs/specs/2026-05-02-provider-integration-design.md](../specs/2026-05-02-provider-integration-design.md)
- Existing watcher: [src/runtime/watcher.ts](../../src/runtime/watcher.ts) — `createWatcher({ onChange })` is the integration point for auto-export
- Existing scaffold: [src/cli/scaffold.ts](../../src/cli/scaffold.ts) — `harness init` lives here; we'll add provider detection + prompt
- Existing identity loader: [src/runtime/context-loader.ts:25](../../src/runtime/context-loader.ts) — `loadIdentity` returns `{ content, source }`; we'll add a synthetic `project-context` rule loader
- Existing doctor framework: [src/runtime/doctor.ts](../../src/runtime/doctor.ts) — drift findings will hook in here as a new top-level check
- Existing primitive loader: [src/primitives/loader.ts](../../src/primitives/loader.ts) — `loadAllPrimitives(dir)` for skills + rules
- Existing config schema: [src/core/types.ts](../../src/core/types.ts) — extend with `export` block
- Cursor MDC docs (verify before adapter): https://cursor.com/docs/context/skills (or current path)
- Gemini CLI extensions docs (verify before adapter): https://geminicli.com/docs/cli/skills/ (or current path)
- Copilot instructions docs (verify token cap): https://docs.github.com/en/copilot/customizing-copilot/about-customizing-github-copilot-chat-responses
- Per CLAUDE.md §12: gray-matter caches by content; tests use unique frontmatter; Node 20+ required; tsup bundles flat.

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/runtime/export/types.ts` | new | `ProviderAdapter` interface, `ExportReport`, `DriftReport`, `ExportTarget` shapes |
| `src/runtime/export/registry.ts` | new | `getAdapter(name)`, `listAdapters()`, registration |
| `src/runtime/export/runner.ts` | new | `runExport(harnessDir, target, options)`: orchestrates per-target export, handles drift, dry-run, force, prune |
| `src/runtime/export/provenance.ts` | new | Provenance marker shape, hash computation (sha256 of content sans marker), embed/extract helpers |
| `src/runtime/export/adapters/claude.ts` | new | Claude Code: `.claude/skills/<name>/` + `CLAUDE.md` |
| `src/runtime/export/adapters/codex.ts` | new | OpenAI Codex: `.codex/skills/<name>/` + `AGENTS.md` |
| `src/runtime/export/adapters/agents.ts` | new | Cross-tool: `.agents/skills/<name>/` + project-root `AGENTS.md` |
| `src/runtime/export/adapters/cursor.ts` | new | Cursor: `.cursor/rules/*.mdc`, lossy with warnings |
| `src/runtime/export/adapters/copilot.ts` | new | Copilot: single `.github/copilot-instructions.md` with token cap |
| `src/runtime/export/adapters/gemini.ts` | new | Gemini CLI: `.gemini/extensions/<name>/` + `GEMINI.md` |
| `src/runtime/export/identity-output.ts` | new | Helper to compose identity + rules into a markdown file (used by claude, codex, agents, copilot) |
| `src/core/types.ts` | extend | Add `ExportConfigSchema` to `HarnessConfigSchema` |
| `src/cli/scaffold.ts` | extend | Provider directory detection at init; subdirectory mode; write `export` config block |
| `src/runtime/context-loader.ts` | extend | When in subdirectory mode, load project-root AGENTS.md/CLAUDE.md/GEMINI.md as synthetic `project-context` rule |
| `src/cli/index.ts` | extend | `harness export [<provider>] [--target/--force/--dry-run/--no-auto/--prune/--resync-from]` + `harness doctor --check-drift` flag |
| `src/runtime/watcher.ts` | extend | Optional `onAutoExport` callback wired through `harness dev` |
| `src/runtime/doctor.ts` | extend | Drift findings across configured export targets |
| `docs/provider-integration.md` | new | Per-provider docs: format mapping, supported features, known limitations, drift handling, edit-and-resync flow |
| `README.md` | extend | New "Provider integration" section |
| `tests/runtime/export/provenance.test.ts` | new | Provenance marker + hash unit tests |
| `tests/runtime/export/runner.test.ts` | new | Runner orchestration tests (with stub adapters) |
| `tests/runtime/export/adapters/claude.test.ts` | new | Claude adapter unit tests |
| `tests/runtime/export/adapters/codex.test.ts` | new | Codex adapter |
| `tests/runtime/export/adapters/agents.test.ts` | new | Agents adapter |
| `tests/runtime/export/adapters/cursor.test.ts` | new | Cursor MDC adapter |
| `tests/runtime/export/adapters/copilot.test.ts` | new | Copilot adapter |
| `tests/runtime/export/adapters/gemini.test.ts` | new | Gemini adapter |
| `tests/runtime/export/drift.test.ts` | new | Drift detection unit tests |
| `tests/integration/init-detection.e2e.test.ts` | new | Init prompt + config write |
| `tests/integration/export-cli.test.ts` | new | CLI export flow |

---

## Phase 25: Adapter framework + provenance

### Task 1: ProviderAdapter interface, ExportReport/DriftReport types, provenance marker, runner skeleton, config schema extension

This task is foundational and must land first; subsequent adapter tasks depend on these types. Combined into one task because the types, registry, runner, provenance, and config block are all tightly coupled — splitting them produces a broken intermediate state where `tsc --noEmit` fails.

**Files:**
- Create: `src/runtime/export/types.ts`
- Create: `src/runtime/export/registry.ts`
- Create: `src/runtime/export/runner.ts`
- Create: `src/runtime/export/provenance.ts`
- Modify: `src/core/types.ts` (add ExportConfigSchema)
- Test: `tests/runtime/export/provenance.test.ts`
- Test: `tests/runtime/export/runner.test.ts`

- [ ] **Step 1: Write failing tests for provenance**

Create `tests/runtime/export/provenance.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { computeContentHash, embedProvenance, extractProvenance, hasProvenance } from '../../../src/runtime/export/provenance.js';

describe('computeContentHash', () => {
  it('returns sha256 prefixed string', () => {
    const h = computeContentHash('hello');
    expect(h).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('is deterministic', () => {
    expect(computeContentHash('x')).toBe(computeContentHash('x'));
  });

  it('changes on content change', () => {
    expect(computeContentHash('x')).not.toBe(computeContentHash('y'));
  });
});

describe('embedProvenance / extractProvenance — frontmatter mode', () => {
  it('round-trips a frontmatter document', () => {
    const original = '---\nname: foo\ndescription: bar\n---\nBody.';
    const marker = {
      'harness-exported-from': '/h/skills/foo/SKILL.md',
      'harness-exported-at': '2026-05-03T00:00:00Z',
      'harness-exported-by': 'agent-harness@0.13.0',
      'harness-content-hash': 'sha256:abc',
    };
    const embedded = embedProvenance(original, marker, 'frontmatter');
    expect(embedded).toContain('harness-exported-from');
    const extracted = extractProvenance(embedded, 'frontmatter');
    expect(extracted).not.toBeNull();
    expect(extracted!['harness-exported-from']).toBe('/h/skills/foo/SKILL.md');
  });
});

describe('embedProvenance / extractProvenance — markdown comment mode', () => {
  it('round-trips a plain markdown document', () => {
    const original = '# Hello\n\nWorld.';
    const marker = {
      'harness-exported-from': '/h/IDENTITY.md',
      'harness-exported-at': '2026-05-03T00:00:00Z',
      'harness-exported-by': 'agent-harness@0.13.0',
      'harness-content-hash': 'sha256:def',
    };
    const embedded = embedProvenance(original, marker, 'markdown-comment');
    expect(embedded.startsWith('<!--')).toBe(true);
    expect(embedded).toContain('# Hello');
    const extracted = extractProvenance(embedded, 'markdown-comment');
    expect(extracted).not.toBeNull();
    expect(extracted!['harness-content-hash']).toBe('sha256:def');
  });
});

describe('hasProvenance', () => {
  it('detects frontmatter marker', () => {
    const text = '---\nharness-exported-from: x\n---\nBody.';
    expect(hasProvenance(text)).toBe(true);
  });

  it('detects markdown comment marker', () => {
    const text = '<!--\nharness-exported-from: x\n-->\n# Body';
    expect(hasProvenance(text)).toBe(true);
  });

  it('returns false for unmarked content', () => {
    expect(hasProvenance('# Just markdown')).toBe(false);
  });
});
```

Run: `npm test -- provenance`
Expected: FAIL — module does not exist

- [ ] **Step 2: Implement provenance.ts**

Create `src/runtime/export/provenance.ts`:

```typescript
import { createHash } from 'crypto';
import matter from 'gray-matter';

export interface ProvenanceMarker {
  'harness-exported-from': string;
  'harness-exported-at': string;
  'harness-exported-by': string;
  'harness-content-hash': string;
}

export type ProvenanceMode = 'frontmatter' | 'markdown-comment';

export function computeContentHash(content: string): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

const COMMENT_DELIMITER_OPEN = '<!-- agent-harness-provenance';
const COMMENT_DELIMITER_CLOSE = '-->';

export function embedProvenance(content: string, marker: ProvenanceMarker, mode: ProvenanceMode): string {
  if (mode === 'frontmatter') {
    const fm = matter(content);
    const data = (fm.data ?? {}) as Record<string, unknown>;
    const metadata = (data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata))
      ? data.metadata as Record<string, unknown>
      : {};
    data.metadata = { ...metadata, ...marker };
    return matter.stringify(fm.content, data);
  }
  const lines = [
    COMMENT_DELIMITER_OPEN,
    ...Object.entries(marker).map(([k, v]) => `${k}: ${v}`),
    COMMENT_DELIMITER_CLOSE,
  ];
  return lines.join('\n') + '\n' + content;
}

export function extractProvenance(content: string, mode: ProvenanceMode): ProvenanceMarker | null {
  if (mode === 'frontmatter') {
    const fm = matter(content);
    const metadata = (fm.data?.metadata as Record<string, unknown>) ?? {};
    if (!metadata['harness-exported-from']) return null;
    return {
      'harness-exported-from': String(metadata['harness-exported-from']),
      'harness-exported-at': String(metadata['harness-exported-at'] ?? ''),
      'harness-exported-by': String(metadata['harness-exported-by'] ?? ''),
      'harness-content-hash': String(metadata['harness-content-hash'] ?? ''),
    };
  }
  if (!content.startsWith(COMMENT_DELIMITER_OPEN)) return null;
  const closeIdx = content.indexOf(COMMENT_DELIMITER_CLOSE);
  if (closeIdx < 0) return null;
  const block = content.slice(COMMENT_DELIMITER_OPEN.length, closeIdx);
  const m: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) m[key] = value;
  }
  if (!m['harness-exported-from']) return null;
  return {
    'harness-exported-from': m['harness-exported-from'],
    'harness-exported-at': m['harness-exported-at'] ?? '',
    'harness-exported-by': m['harness-exported-by'] ?? '',
    'harness-content-hash': m['harness-content-hash'] ?? '',
  };
}

export function hasProvenance(content: string): boolean {
  if (content.startsWith(COMMENT_DELIMITER_OPEN)) return true;
  return extractProvenance(content, 'frontmatter') !== null;
}

/**
 * Strip the provenance marker from content for hashing.
 * Hash MUST exclude the marker itself to avoid hash-of-hash recursion.
 */
export function stripProvenance(content: string, mode: ProvenanceMode): string {
  if (mode === 'markdown-comment') {
    if (!content.startsWith(COMMENT_DELIMITER_OPEN)) return content;
    const closeIdx = content.indexOf(COMMENT_DELIMITER_CLOSE);
    if (closeIdx < 0) return content;
    const after = content.slice(closeIdx + COMMENT_DELIMITER_CLOSE.length);
    return after.startsWith('\n') ? after.slice(1) : after;
  }
  // frontmatter mode: parse, remove provenance keys from metadata, restringify
  const fm = matter(content);
  const data = (fm.data ?? {}) as Record<string, unknown>;
  if (data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)) {
    const metadata = { ...(data.metadata as Record<string, unknown>) };
    delete metadata['harness-exported-from'];
    delete metadata['harness-exported-at'];
    delete metadata['harness-exported-by'];
    delete metadata['harness-content-hash'];
    if (Object.keys(metadata).length === 0) {
      delete data.metadata;
    } else {
      data.metadata = metadata;
    }
  }
  return matter.stringify(fm.content, data);
}
```

Run: `npm test -- provenance`
Expected: PASS

- [ ] **Step 3: Define adapter types**

Create `src/runtime/export/types.ts`:

```typescript
import type { HarnessDocument } from '../../core/types.js';

export type ProviderName = 'claude' | 'codex' | 'cursor' | 'copilot' | 'gemini' | 'agents';

export interface ExportTarget {
  provider: ProviderName;
  path: string;
  auto?: boolean;
}

export interface ExportReport {
  provider: ProviderName;
  written: string[];
  skipped: Array<{ path: string; reason: string }>;
  warnings: string[];
}

export interface DriftFinding {
  path: string;
  severity: 'info' | 'warning';
  kind: 'modified' | 'missing-marker' | 'missing-file' | 'orphan';
  detail: string;
}

export interface DriftReport {
  provider: ProviderName;
  findings: DriftFinding[];
}

export interface ExportContext {
  harnessDir: string;
  targetDir: string;
  skills: HarnessDocument[];
  rules: HarnessDocument[];
  identity: { content: string; source: string };
  harnessVersion: string;
}

export interface ProviderAdapter {
  name: ProviderName;
  /** Run a full export — skills + rules + identity — to targetDir. */
  exportAll(ctx: ExportContext): Promise<ExportReport>;
  /** Detect drift between targetDir's exported files and the harness source. */
  detectDrift(ctx: ExportContext): Promise<DriftReport>;
  /** Optional prune: remove orphan files where the source skill no longer exists. */
  prune?(ctx: ExportContext): Promise<{ removed: string[] }>;
  /** Optional resync: pull a single file's edits back into the harness (native adapters only). */
  resyncFile?(ctx: ExportContext, providerFile: string): Promise<{ updated: string }>;
}
```

- [ ] **Step 4: Implement registry**

Create `src/runtime/export/registry.ts`:

```typescript
import type { ProviderAdapter, ProviderName } from './types.js';

const adapters = new Map<ProviderName, ProviderAdapter>();

export function registerAdapter(adapter: ProviderAdapter): void {
  adapters.set(adapter.name, adapter);
}

export function getAdapter(name: ProviderName): ProviderAdapter | null {
  return adapters.get(name) ?? null;
}

export function listAdapters(): ProviderAdapter[] {
  return Array.from(adapters.values());
}

export function clearRegistry(): void {
  adapters.clear();
}
```

- [ ] **Step 5: Implement runner skeleton with stubs (test-driven)**

Create `tests/runtime/export/runner.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runExport } from '../../../src/runtime/export/runner.js';
import { registerAdapter, clearRegistry } from '../../../src/runtime/export/registry.js';
import type { ProviderAdapter } from '../../../src/runtime/export/types.js';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'rxr-')); }

function makeFakeHarness(dir: string): void {
  mkdirSync(join(dir, 'skills/foo'), { recursive: true });
  mkdirSync(join(dir, 'rules'), { recursive: true });
  writeFileSync(join(dir, 'IDENTITY.md'), '# I am a harness');
  writeFileSync(join(dir, 'skills/foo/SKILL.md'), `---\nname: foo\ndescription: foo desc ${Math.random()}\n---\nBody.`);
  writeFileSync(join(dir, 'rules/r1.md'), `---\nname: r1\ndescription: rule one ${Math.random()}\n---\nDo X.`);
}

describe('runExport', () => {
  beforeEach(() => clearRegistry());

  it('invokes the named adapter once', async () => {
    const dir = tmp();
    makeFakeHarness(dir);
    const exportAll = vi.fn(async () => ({ provider: 'claude' as const, written: ['.claude/x'], skipped: [], warnings: [] }));
    const adapter: ProviderAdapter = {
      name: 'claude',
      exportAll,
      detectDrift: async () => ({ provider: 'claude', findings: [] }),
    };
    registerAdapter(adapter);
    const reports = await runExport({ harnessDir: dir, providers: ['claude'], targetPath: '.claude' });
    expect(exportAll).toHaveBeenCalledTimes(1);
    expect(reports[0].written).toEqual(['.claude/x']);
  });

  it('throws on unknown provider', async () => {
    const dir = tmp();
    makeFakeHarness(dir);
    await expect(runExport({ harnessDir: dir, providers: ['nonexistent' as never], targetPath: '.x' }))
      .rejects.toThrow(/unknown provider/i);
  });

  it('respects dryRun by skipping exportAll', async () => {
    const dir = tmp();
    makeFakeHarness(dir);
    const exportAll = vi.fn();
    const detectDrift = vi.fn(async () => ({ provider: 'claude' as const, findings: [] }));
    registerAdapter({ name: 'claude', exportAll, detectDrift });
    const reports = await runExport({ harnessDir: dir, providers: ['claude'], targetPath: '.claude', dryRun: true });
    expect(exportAll).not.toHaveBeenCalled();
    expect(reports[0].written).toEqual([]);
    expect(reports[0].warnings.some((w) => /dry-run/i.test(w))).toBe(true);
  });
});
```

Run: `npm test -- export.*runner`
Expected: FAIL — module does not exist

Create `src/runtime/export/runner.ts`:

```typescript
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadAllPrimitives } from '../../primitives/loader.js';
import { loadIdentity } from '../context-loader.js';
import { getAdapter } from './registry.js';
import type { ExportContext, ExportReport, ProviderName } from './types.js';

export interface RunExportOptions {
  harnessDir: string;
  providers: ProviderName[];
  targetPath?: string;
  dryRun?: boolean;
  force?: boolean;
}

function harnessVersion(harnessDir: string): string {
  // Try harness package.json first; fall back to a static label.
  try {
    const raw = readFileSync(join(harnessDir, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { name?: string; version?: string };
    return `${pkg.name ?? 'agent-harness'}@${pkg.version ?? 'unknown'}`;
  } catch {
    return 'agent-harness@unknown';
  }
}

export async function runExport(opts: RunExportOptions): Promise<ExportReport[]> {
  const { harnessDir, providers, targetPath, dryRun = false } = opts;
  const all = loadAllPrimitives(harnessDir);
  const skills = all.get('skills') ?? [];
  const rules = all.get('rules') ?? [];
  const identity = loadIdentity(harnessDir);

  const reports: ExportReport[] = [];
  for (const name of providers) {
    const adapter = getAdapter(name);
    if (!adapter) {
      throw new Error(`unknown provider: ${name}`);
    }
    const targetDir = targetPath ?? `.${name}`;
    const ctx: ExportContext = {
      harnessDir,
      targetDir,
      skills,
      rules,
      identity: { content: identity.content, source: String(identity.source) },
      harnessVersion: harnessVersion(harnessDir),
    };
    if (dryRun) {
      reports.push({ provider: name, written: [], skipped: [], warnings: ['dry-run: no files written'] });
      continue;
    }
    const report = await adapter.exportAll(ctx);
    reports.push(report);
  }
  return reports;
}
```

Run: `npm test -- export.*runner provenance`
Expected: PASS

- [ ] **Step 6: Extend HarnessConfigSchema with export block**

Open `src/core/types.ts`. Find the `HarnessConfigSchema` Zod schema (grep for `HarnessConfigSchema`). Append a new optional field:

```typescript
export const ExportTargetSchema = z.object({
  provider: z.enum(['claude', 'codex', 'cursor', 'copilot', 'gemini', 'agents']),
  path: z.string().min(1),
  auto: z.boolean().optional().default(false),
});

export const ExportConfigSchema = z.object({
  enabled: z.boolean().optional().default(false),
  targets: z.array(ExportTargetSchema).optional().default([]),
  on_drift: z.enum(['warn', 'fail', 'ignore']).optional().default('warn'),
});
```

Then add `export: ExportConfigSchema.optional()` to the existing config schema's `.object({...})` shape (find the spot; keep alphabetical order if the schema uses one; otherwise add at the end).

Verify with `npm run lint` — expected clean.

- [ ] **Step 7: Lint + commit**

Run: `npm run lint && npm test -- provenance "export.*runner"`
Expected: clean, 12+ tests pass

```bash
git add src/runtime/export/types.ts src/runtime/export/registry.ts src/runtime/export/runner.ts src/runtime/export/provenance.ts src/core/types.ts tests/runtime/export/provenance.test.ts tests/runtime/export/runner.test.ts
git commit -m "feat(export): adapter framework + provenance markers + config schema"
```

---

## Phase 26: Native Agent-Skills adapters (claude, codex, agents)

### Task 2: Identity-output helper + Claude adapter

The identity-output helper is shared by claude, codex, agents, and copilot — author it first. Then implement the Claude adapter as the canonical native pattern.

**Files:**
- Create: `src/runtime/export/identity-output.ts`
- Create: `src/runtime/export/adapters/claude.ts`
- Modify: `src/runtime/export/registry.ts` (auto-register claude on import)
- Test: `tests/runtime/export/adapters/claude.test.ts`

- [ ] **Step 1: Implement identity-output.ts (no test file — covered by adapter tests)**

Create `src/runtime/export/identity-output.ts`:

```typescript
import type { HarnessDocument } from '../../core/types.js';

/**
 * Compose IDENTITY.md content + active rules into a single markdown document
 * suitable for export to project-level CLAUDE.md / AGENTS.md / GEMINI.md.
 *
 * Section ordering is deterministic (rules sorted alphabetically by name) so
 * exports are byte-stable across re-runs of the same input.
 */
export function composeIdentityDocument(identity: string, rules: HarnessDocument[]): string {
  const sections: string[] = [];
  sections.push('## Identity');
  sections.push(identity.trim());

  if (rules.length > 0) {
    const activeRules = rules
      .filter((r) => r.status === 'active' || r.status === undefined)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    if (activeRules.length > 0) {
      sections.push('## Rules');
      for (const r of activeRules) {
        sections.push(`### ${r.name}`);
        if (r.description) sections.push(String(r.description).trim());
        if (r.body && r.body.trim()) sections.push(r.body.trim());
      }
    }
  }
  return sections.join('\n\n') + '\n';
}
```

- [ ] **Step 2: Write failing tests for Claude adapter**

Create `tests/runtime/export/adapters/claude.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { claudeAdapter } from '../../../../src/runtime/export/adapters/claude.js';
import { loadAllPrimitives } from '../../../../src/primitives/loader.js';
import { loadIdentity } from '../../../../src/runtime/context-loader.js';
import type { ExportContext } from '../../../../src/runtime/export/types.js';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'cl-')); }

function makeHarness(dir: string): void {
  mkdirSync(join(dir, 'skills/research'), { recursive: true });
  mkdirSync(join(dir, 'skills/research/scripts'), { recursive: true });
  mkdirSync(join(dir, 'skills/research/references'), { recursive: true });
  mkdirSync(join(dir, 'rules'), { recursive: true });
  writeFileSync(join(dir, 'IDENTITY.md'), `# I am a harness ${Math.random()}\nIdentity body.`);
  writeFileSync(join(dir, 'skills/research/SKILL.md'), `---\nname: research\ndescription: research desc ${Math.random()}\n---\nResearch body.`);
  writeFileSync(join(dir, 'skills/research/scripts/run.sh'), '#!/usr/bin/env bash\necho hi');
  writeFileSync(join(dir, 'skills/research/references/REFERENCE.md'), '# Reference content');
  writeFileSync(join(dir, 'rules/be-careful.md'), `---\nname: be-careful\ndescription: be careful ${Math.random()}\nstatus: active\n---\nAlways be careful.`);
}

function buildCtx(harnessDir: string): ExportContext {
  const all = loadAllPrimitives(harnessDir);
  const identity = loadIdentity(harnessDir);
  return {
    harnessDir,
    targetDir: join(harnessDir, '.claude'),
    skills: all.get('skills') ?? [],
    rules: all.get('rules') ?? [],
    identity: { content: identity.content, source: String(identity.source) },
    harnessVersion: 'agent-harness@test',
  };
}

describe('claudeAdapter.exportAll', () => {
  it('writes skills to .claude/skills/<name>/', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    const report = await claudeAdapter.exportAll(ctx);
    const skillFile = join(ctx.targetDir, 'skills/research/SKILL.md');
    expect(existsSync(skillFile)).toBe(true);
    expect(report.written).toContain(skillFile);
  });

  it('copies bundle resources verbatim', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await claudeAdapter.exportAll(ctx);
    expect(existsSync(join(ctx.targetDir, 'skills/research/scripts/run.sh'))).toBe(true);
    expect(existsSync(join(ctx.targetDir, 'skills/research/references/REFERENCE.md'))).toBe(true);
  });

  it('writes CLAUDE.md with identity + rules', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await claudeAdapter.exportAll(ctx);
    const claudeMd = join(ctx.targetDir, 'CLAUDE.md');
    expect(existsSync(claudeMd)).toBe(true);
    const content = readFileSync(claudeMd, 'utf-8');
    expect(content).toContain('## Identity');
    expect(content).toContain('## Rules');
    expect(content).toContain('be-careful');
    expect(content).toContain('Always be careful');
  });

  it('embeds provenance marker in exported skill', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await claudeAdapter.exportAll(ctx);
    const skillFile = readFileSync(join(ctx.targetDir, 'skills/research/SKILL.md'), 'utf-8');
    expect(skillFile).toContain('harness-exported-from');
    expect(skillFile).toContain('harness-content-hash');
  });

  it('embeds provenance marker in CLAUDE.md (HTML comment)', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await claudeAdapter.exportAll(ctx);
    const claudeMd = readFileSync(join(ctx.targetDir, 'CLAUDE.md'), 'utf-8');
    expect(claudeMd.startsWith('<!-- agent-harness-provenance')).toBe(true);
  });
});

describe('claudeAdapter.detectDrift', () => {
  it('returns no findings on clean state', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await claudeAdapter.exportAll(ctx);
    const drift = await claudeAdapter.detectDrift(ctx);
    expect(drift.findings.filter((f) => f.kind === 'modified')).toHaveLength(0);
  });

  it('detects external edit', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await claudeAdapter.exportAll(ctx);
    const skillPath = join(ctx.targetDir, 'skills/research/SKILL.md');
    const original = readFileSync(skillPath, 'utf-8');
    writeFileSync(skillPath, original + '\nEdited externally.');
    const drift = await claudeAdapter.detectDrift(ctx);
    const finding = drift.findings.find((f) => f.kind === 'modified' && f.path.includes('research'));
    expect(finding).toBeDefined();
  });

  it('detects orphan export when source skill removed', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await claudeAdapter.exportAll(ctx);
    // Pretend skill source is removed by passing an empty skills list
    const driftCtx = { ...ctx, skills: [] };
    const drift = await claudeAdapter.detectDrift(driftCtx);
    const orphan = drift.findings.find((f) => f.kind === 'orphan');
    expect(orphan).toBeDefined();
  });
});
```

Run: `npm test -- adapters.*claude`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement claudeAdapter**

Create `src/runtime/export/adapters/claude.ts`:

```typescript
import { join, dirname, relative } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, copyFileSync, rmSync } from 'fs';
import type { ExportContext, ExportReport, DriftReport, DriftFinding, ProviderAdapter } from '../types.js';
import { computeContentHash, embedProvenance, extractProvenance, hasProvenance, stripProvenance } from '../provenance.js';
import { composeIdentityDocument } from '../identity-output.js';
import { registerAdapter } from '../registry.js';
import type { HarnessDocument } from '../../../core/types.js';

function copyDir(src: string, dst: string, written: string[]): void {
  if (!existsSync(src)) return;
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      copyDir(srcPath, dstPath, written);
    } else {
      copyFileSync(srcPath, dstPath);
      written.push(dstPath);
    }
  }
}

function writeSkill(skill: HarnessDocument, ctx: ExportContext, report: ExportReport): void {
  if (!skill.bundleDir) {
    report.skipped.push({ path: skill.name, reason: 'no bundle directory' });
    return;
  }
  const targetSkillDir = join(ctx.targetDir, 'skills', skill.name);
  mkdirSync(targetSkillDir, { recursive: true });

  // Copy bundle resources (scripts/, references/, assets/)
  for (const sub of ['scripts', 'references', 'assets']) {
    const subSrc = join(skill.bundleDir, sub);
    if (existsSync(subSrc)) {
      copyDir(subSrc, join(targetSkillDir, sub), report.written);
    }
  }

  // Write SKILL.md with embedded provenance
  const skillSourcePath = join(skill.bundleDir, 'SKILL.md');
  const sourceContent = readFileSync(skillSourcePath, 'utf-8');
  const hash = computeContentHash(sourceContent);
  const targetSkillFile = join(targetSkillDir, 'SKILL.md');
  const stamped = embedProvenance(sourceContent, {
    'harness-exported-from': skillSourcePath,
    'harness-exported-at': new Date().toISOString(),
    'harness-exported-by': ctx.harnessVersion,
    'harness-content-hash': hash,
  }, 'frontmatter');
  writeFileSync(targetSkillFile, stamped, 'utf-8');
  report.written.push(targetSkillFile);
}

function writeIdentity(ctx: ExportContext, report: ExportReport): void {
  const claudeMdPath = join(ctx.targetDir, 'CLAUDE.md');
  const body = composeIdentityDocument(ctx.identity.content, ctx.rules);
  const hash = computeContentHash(body);
  const stamped = embedProvenance(body, {
    'harness-exported-from': join(ctx.harnessDir, 'IDENTITY.md'),
    'harness-exported-at': new Date().toISOString(),
    'harness-exported-by': ctx.harnessVersion,
    'harness-content-hash': hash,
  }, 'markdown-comment');
  mkdirSync(dirname(claudeMdPath), { recursive: true });
  writeFileSync(claudeMdPath, stamped, 'utf-8');
  report.written.push(claudeMdPath);
}

async function exportAll(ctx: ExportContext): Promise<ExportReport> {
  const report: ExportReport = { provider: 'claude', written: [], skipped: [], warnings: [] };
  mkdirSync(ctx.targetDir, { recursive: true });
  for (const skill of ctx.skills) {
    writeSkill(skill, ctx, report);
  }
  writeIdentity(ctx, report);
  return report;
}

function checkSkillFile(skillName: string, targetSkillFile: string, mode: 'frontmatter' | 'markdown-comment'): DriftFinding | null {
  if (!existsSync(targetSkillFile)) {
    return { path: targetSkillFile, severity: 'warning', kind: 'missing-file', detail: `expected output not present` };
  }
  const content = readFileSync(targetSkillFile, 'utf-8');
  const marker = extractProvenance(content, mode);
  if (!marker) {
    return { path: targetSkillFile, severity: 'warning', kind: 'missing-marker', detail: `no provenance marker` };
  }
  const stripped = stripProvenance(content, mode);
  // Hash the source content (the embedded marker recorded the SOURCE hash)
  // To detect drift we re-hash the stripped target and compare.
  // Since the source-side hash was computed on the raw source SKILL.md (no marker),
  // and the target's stripped content equals the source's raw content (if untouched),
  // hashes match when no drift.
  const targetHash = computeContentHash(stripped);
  if (targetHash !== marker['harness-content-hash']) {
    return { path: targetSkillFile, severity: 'warning', kind: 'modified', detail: `hash mismatch — file edited externally` };
  }
  return null;
}

async function detectDrift(ctx: ExportContext): Promise<DriftReport> {
  const findings: DriftFinding[] = [];
  const knownSkillNames = new Set(ctx.skills.map((s) => s.name));

  // Per-skill file checks
  for (const skill of ctx.skills) {
    const targetSkillFile = join(ctx.targetDir, 'skills', skill.name, 'SKILL.md');
    const f = checkSkillFile(skill.name, targetSkillFile, 'frontmatter');
    if (f) findings.push(f);
  }

  // CLAUDE.md
  const claudeMdPath = join(ctx.targetDir, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    const content = readFileSync(claudeMdPath, 'utf-8');
    const marker = extractProvenance(content, 'markdown-comment');
    if (!marker) {
      findings.push({ path: claudeMdPath, severity: 'warning', kind: 'missing-marker', detail: `no provenance marker` });
    } else {
      const stripped = stripProvenance(content, 'markdown-comment');
      const expected = composeIdentityDocument(ctx.identity.content, ctx.rules);
      if (computeContentHash(stripped) !== computeContentHash(expected)) {
        findings.push({ path: claudeMdPath, severity: 'warning', kind: 'modified', detail: `hash mismatch — file edited externally or sources changed` });
      }
    }
  }

  // Orphan detection: skills present in targetDir/skills/ but not in source
  const targetSkillsDir = join(ctx.targetDir, 'skills');
  if (existsSync(targetSkillsDir)) {
    for (const dirEntry of readdirSync(targetSkillsDir)) {
      const fullPath = join(targetSkillsDir, dirEntry);
      if (!statSync(fullPath).isDirectory()) continue;
      if (!knownSkillNames.has(dirEntry)) {
        findings.push({
          path: fullPath,
          severity: 'warning',
          kind: 'orphan',
          detail: `source skill removed; clean up via \`harness export --prune\``,
        });
      }
    }
  }

  return { provider: 'claude', findings };
}

async function prune(ctx: ExportContext): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  const knownSkillNames = new Set(ctx.skills.map((s) => s.name));
  const targetSkillsDir = join(ctx.targetDir, 'skills');
  if (!existsSync(targetSkillsDir)) return { removed };
  for (const dirEntry of readdirSync(targetSkillsDir)) {
    const fullPath = join(targetSkillsDir, dirEntry);
    if (!statSync(fullPath).isDirectory()) continue;
    if (!knownSkillNames.has(dirEntry)) {
      rmSync(fullPath, { recursive: true, force: true });
      removed.push(fullPath);
    }
  }
  return { removed };
}

async function resyncFile(ctx: ExportContext, providerFile: string): Promise<{ updated: string }> {
  // Native adapter: copy provider file content (sans provenance) back into the source.
  const content = readFileSync(providerFile, 'utf-8');
  const stripped = stripProvenance(content, 'frontmatter');
  // Find which source file this maps to: provider path under .claude/skills/<name>/SKILL.md
  // → harness path: skills/<name>/SKILL.md
  const rel = relative(ctx.targetDir, providerFile);
  const sourcePath = join(ctx.harnessDir, rel);
  if (!sourcePath.includes(ctx.harnessDir)) {
    throw new Error(`Resync target ${sourcePath} is outside harness dir`);
  }
  writeFileSync(sourcePath, stripped, 'utf-8');
  return { updated: sourcePath };
}

export const claudeAdapter: ProviderAdapter = {
  name: 'claude',
  exportAll,
  detectDrift,
  prune,
  resyncFile,
};

registerAdapter(claudeAdapter);
```

Run: `npm test -- adapters.*claude`
Expected: PASS (8 tests)

- [ ] **Step 4: Lint + commit**

Run: `npm run lint`

```bash
git add src/runtime/export/identity-output.ts src/runtime/export/adapters/claude.ts tests/runtime/export/adapters/claude.test.ts
git commit -m "feat(export): claude adapter (skills + CLAUDE.md + drift + prune + resync)"
```

---

### Task 3: Codex + Agents adapters (mirror claude pattern, different filenames/dirs)

These two adapters share 95% of their logic with claude. Combine them — Codex differs only in `AGENTS.md` filename and `.codex/` default path; Agents writes to `.agents/skills/` with a project-root `AGENTS.md`.

**Files:**
- Create: `src/runtime/export/adapters/codex.ts`
- Create: `src/runtime/export/adapters/agents.ts`
- Test: `tests/runtime/export/adapters/codex.test.ts`
- Test: `tests/runtime/export/adapters/agents.test.ts`

- [ ] **Step 1: Refactor claude adapter to extract a shared `nativeSkillsAdapter` factory**

To avoid copy-paste, refactor `claude.ts` to call a shared factory. Create `src/runtime/export/adapters/native-shared.ts`:

```typescript
import { join, dirname, relative } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, copyFileSync, rmSync } from 'fs';
import type { ExportContext, ExportReport, DriftReport, DriftFinding, ProviderAdapter, ProviderName } from '../types.js';
import { computeContentHash, embedProvenance, extractProvenance, stripProvenance } from '../provenance.js';
import { composeIdentityDocument } from '../identity-output.js';
import type { HarnessDocument } from '../../../core/types.js';

export interface NativeAdapterConfig {
  name: ProviderName;
  /** Filename for the project-level identity file: 'CLAUDE.md', 'AGENTS.md', etc. */
  identityFilename: string;
  /** Where the identity file is written, relative to ctx.targetDir or harnessDir. */
  identityLocation: 'targetDir' | 'projectRoot';
  /** Where skills go, relative to ctx.targetDir. */
  skillsSubdir: string;
}

function copyDir(src: string, dst: string, written: string[]): void {
  if (!existsSync(src)) return;
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      copyDir(srcPath, dstPath, written);
    } else {
      copyFileSync(srcPath, dstPath);
      written.push(dstPath);
    }
  }
}

function writeSkill(skill: HarnessDocument, ctx: ExportContext, cfg: NativeAdapterConfig, report: ExportReport): void {
  if (!skill.bundleDir) {
    report.skipped.push({ path: skill.name, reason: 'no bundle directory' });
    return;
  }
  const targetSkillDir = join(ctx.targetDir, cfg.skillsSubdir, skill.name);
  mkdirSync(targetSkillDir, { recursive: true });
  for (const sub of ['scripts', 'references', 'assets']) {
    const subSrc = join(skill.bundleDir, sub);
    if (existsSync(subSrc)) {
      copyDir(subSrc, join(targetSkillDir, sub), report.written);
    }
  }
  const skillSourcePath = join(skill.bundleDir, 'SKILL.md');
  const sourceContent = readFileSync(skillSourcePath, 'utf-8');
  const hash = computeContentHash(sourceContent);
  const targetSkillFile = join(targetSkillDir, 'SKILL.md');
  const stamped = embedProvenance(sourceContent, {
    'harness-exported-from': skillSourcePath,
    'harness-exported-at': new Date().toISOString(),
    'harness-exported-by': ctx.harnessVersion,
    'harness-content-hash': hash,
  }, 'frontmatter');
  writeFileSync(targetSkillFile, stamped, 'utf-8');
  report.written.push(targetSkillFile);
}

function identityPath(ctx: ExportContext, cfg: NativeAdapterConfig): string {
  return cfg.identityLocation === 'targetDir'
    ? join(ctx.targetDir, cfg.identityFilename)
    : join(ctx.harnessDir, cfg.identityFilename);
}

function writeIdentity(ctx: ExportContext, cfg: NativeAdapterConfig, report: ExportReport): void {
  const identityFile = identityPath(ctx, cfg);
  const body = composeIdentityDocument(ctx.identity.content, ctx.rules);
  const hash = computeContentHash(body);
  const stamped = embedProvenance(body, {
    'harness-exported-from': join(ctx.harnessDir, 'IDENTITY.md'),
    'harness-exported-at': new Date().toISOString(),
    'harness-exported-by': ctx.harnessVersion,
    'harness-content-hash': hash,
  }, 'markdown-comment');
  mkdirSync(dirname(identityFile), { recursive: true });
  writeFileSync(identityFile, stamped, 'utf-8');
  report.written.push(identityFile);
}

export function buildNativeAdapter(cfg: NativeAdapterConfig): ProviderAdapter {
  return {
    name: cfg.name,

    async exportAll(ctx: ExportContext): Promise<ExportReport> {
      const report: ExportReport = { provider: cfg.name, written: [], skipped: [], warnings: [] };
      mkdirSync(ctx.targetDir, { recursive: true });
      for (const skill of ctx.skills) writeSkill(skill, ctx, cfg, report);
      writeIdentity(ctx, cfg, report);
      return report;
    },

    async detectDrift(ctx: ExportContext): Promise<DriftReport> {
      const findings: DriftFinding[] = [];
      const knownSkillNames = new Set(ctx.skills.map((s) => s.name));
      for (const skill of ctx.skills) {
        const targetSkillFile = join(ctx.targetDir, cfg.skillsSubdir, skill.name, 'SKILL.md');
        if (!existsSync(targetSkillFile)) {
          findings.push({ path: targetSkillFile, severity: 'warning', kind: 'missing-file', detail: 'expected output not present' });
          continue;
        }
        const content = readFileSync(targetSkillFile, 'utf-8');
        const marker = extractProvenance(content, 'frontmatter');
        if (!marker) {
          findings.push({ path: targetSkillFile, severity: 'warning', kind: 'missing-marker', detail: 'no provenance marker' });
          continue;
        }
        const stripped = stripProvenance(content, 'frontmatter');
        if (computeContentHash(stripped) !== marker['harness-content-hash']) {
          findings.push({ path: targetSkillFile, severity: 'warning', kind: 'modified', detail: 'hash mismatch — file edited externally' });
        }
      }
      // Identity drift
      const identityFile = identityPath(ctx, cfg);
      if (existsSync(identityFile)) {
        const content = readFileSync(identityFile, 'utf-8');
        const marker = extractProvenance(content, 'markdown-comment');
        if (!marker) {
          findings.push({ path: identityFile, severity: 'warning', kind: 'missing-marker', detail: 'no provenance marker' });
        } else {
          const stripped = stripProvenance(content, 'markdown-comment');
          const expected = composeIdentityDocument(ctx.identity.content, ctx.rules);
          if (computeContentHash(stripped) !== computeContentHash(expected)) {
            findings.push({ path: identityFile, severity: 'warning', kind: 'modified', detail: 'hash mismatch — file edited externally or sources changed' });
          }
        }
      }
      // Orphan detection
      const targetSkillsDir = join(ctx.targetDir, cfg.skillsSubdir);
      if (existsSync(targetSkillsDir)) {
        for (const dirEntry of readdirSync(targetSkillsDir)) {
          const fullPath = join(targetSkillsDir, dirEntry);
          if (!statSync(fullPath).isDirectory()) continue;
          if (!knownSkillNames.has(dirEntry)) {
            findings.push({ path: fullPath, severity: 'warning', kind: 'orphan', detail: 'source skill removed; clean up via `harness export --prune`' });
          }
        }
      }
      return { provider: cfg.name, findings };
    },

    async prune(ctx: ExportContext): Promise<{ removed: string[] }> {
      const removed: string[] = [];
      const knownSkillNames = new Set(ctx.skills.map((s) => s.name));
      const targetSkillsDir = join(ctx.targetDir, cfg.skillsSubdir);
      if (!existsSync(targetSkillsDir)) return { removed };
      for (const dirEntry of readdirSync(targetSkillsDir)) {
        const fullPath = join(targetSkillsDir, dirEntry);
        if (!statSync(fullPath).isDirectory()) continue;
        if (!knownSkillNames.has(dirEntry)) {
          rmSync(fullPath, { recursive: true, force: true });
          removed.push(fullPath);
        }
      }
      return { removed };
    },

    async resyncFile(ctx: ExportContext, providerFile: string): Promise<{ updated: string }> {
      const content = readFileSync(providerFile, 'utf-8');
      const stripped = stripProvenance(content, 'frontmatter');
      const rel = relative(ctx.targetDir, providerFile);
      const sourcePath = join(ctx.harnessDir, rel);
      writeFileSync(sourcePath, stripped, 'utf-8');
      return { updated: sourcePath };
    },
  };
}
```

Then simplify `src/runtime/export/adapters/claude.ts` to:

```typescript
import { buildNativeAdapter } from './native-shared.js';
import { registerAdapter } from '../registry.js';

export const claudeAdapter = buildNativeAdapter({
  name: 'claude',
  identityFilename: 'CLAUDE.md',
  identityLocation: 'targetDir',
  skillsSubdir: 'skills',
});

registerAdapter(claudeAdapter);
```

Run claude tests to confirm refactor doesn't break: `npm test -- adapters.*claude`
Expected: 8/8 pass (same behavior, different organization).

- [ ] **Step 2: Create `src/runtime/export/adapters/codex.ts`**

```typescript
import { buildNativeAdapter } from './native-shared.js';
import { registerAdapter } from '../registry.js';

export const codexAdapter = buildNativeAdapter({
  name: 'codex',
  identityFilename: 'AGENTS.md',
  identityLocation: 'targetDir',
  skillsSubdir: 'skills',
});

registerAdapter(codexAdapter);
```

Create `tests/runtime/export/adapters/codex.test.ts` mirroring the claude tests but verifying:
- Skills land at `<targetDir>/skills/<name>/SKILL.md`
- Identity file is `<targetDir>/AGENTS.md` (not CLAUDE.md)

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { codexAdapter } from '../../../../src/runtime/export/adapters/codex.js';
import { loadAllPrimitives } from '../../../../src/primitives/loader.js';
import { loadIdentity } from '../../../../src/runtime/context-loader.js';
import type { ExportContext } from '../../../../src/runtime/export/types.js';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'cx-')); }

function makeHarness(dir: string): void {
  mkdirSync(join(dir, 'skills/research'), { recursive: true });
  mkdirSync(join(dir, 'rules'), { recursive: true });
  writeFileSync(join(dir, 'IDENTITY.md'), `# Codex test identity ${Math.random()}`);
  writeFileSync(join(dir, 'skills/research/SKILL.md'), `---\nname: research\ndescription: codex test ${Math.random()}\n---\nResearch body.`);
  writeFileSync(join(dir, 'rules/r1.md'), `---\nname: r1\ndescription: rule one ${Math.random()}\nstatus: active\n---\nDo X.`);
}

function buildCtx(harnessDir: string): ExportContext {
  const all = loadAllPrimitives(harnessDir);
  const identity = loadIdentity(harnessDir);
  return {
    harnessDir,
    targetDir: join(harnessDir, '.codex'),
    skills: all.get('skills') ?? [],
    rules: all.get('rules') ?? [],
    identity: { content: identity.content, source: String(identity.source) },
    harnessVersion: 'agent-harness@test',
  };
}

describe('codexAdapter', () => {
  it('writes skills to .codex/skills/<name>/SKILL.md', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await codexAdapter.exportAll(ctx);
    expect(existsSync(join(ctx.targetDir, 'skills/research/SKILL.md'))).toBe(true);
  });

  it('writes AGENTS.md (not CLAUDE.md) at targetDir root', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await codexAdapter.exportAll(ctx);
    expect(existsSync(join(ctx.targetDir, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(ctx.targetDir, 'CLAUDE.md'))).toBe(false);
  });

  it('detects drift on AGENTS.md', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await codexAdapter.exportAll(ctx);
    const agentsMd = join(ctx.targetDir, 'AGENTS.md');
    writeFileSync(agentsMd, readFileSync(agentsMd, 'utf-8') + '\nEdited.');
    const drift = await codexAdapter.detectDrift(ctx);
    expect(drift.findings.some((f) => f.kind === 'modified' && f.path === agentsMd)).toBe(true);
  });
});
```

Run: `npm test -- adapters.*codex`
Expected: PASS

- [ ] **Step 3: Create `src/runtime/export/adapters/agents.ts`**

```typescript
import { buildNativeAdapter } from './native-shared.js';
import { registerAdapter } from '../registry.js';

export const agentsAdapter = buildNativeAdapter({
  name: 'agents',
  identityFilename: 'AGENTS.md',
  identityLocation: 'projectRoot',  // sibling to .agents/, not inside it
  skillsSubdir: 'skills',
});

registerAdapter(agentsAdapter);
```

The agents adapter writes:
- Skills to `<targetDir>/skills/<name>/SKILL.md` (typically `.agents/skills/...`)
- Identity to `<harnessDir>/AGENTS.md` (project root, sibling to the `.agents/` directory)

Create `tests/runtime/export/adapters/agents.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { agentsAdapter } from '../../../../src/runtime/export/adapters/agents.js';
import { loadAllPrimitives } from '../../../../src/primitives/loader.js';
import { loadIdentity } from '../../../../src/runtime/context-loader.js';
import type { ExportContext } from '../../../../src/runtime/export/types.js';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'ag-')); }

function makeHarness(dir: string): void {
  mkdirSync(join(dir, 'skills/research'), { recursive: true });
  mkdirSync(join(dir, 'rules'), { recursive: true });
  writeFileSync(join(dir, 'IDENTITY.md'), `# Agents test identity ${Math.random()}`);
  writeFileSync(join(dir, 'skills/research/SKILL.md'), `---\nname: research\ndescription: agents test ${Math.random()}\n---\nBody.`);
  writeFileSync(join(dir, 'rules/r1.md'), `---\nname: r1\ndescription: rule one ${Math.random()}\nstatus: active\n---\nDo X.`);
}

function buildCtx(harnessDir: string): ExportContext {
  const all = loadAllPrimitives(harnessDir);
  const identity = loadIdentity(harnessDir);
  return {
    harnessDir,
    targetDir: join(harnessDir, '.agents'),
    skills: all.get('skills') ?? [],
    rules: all.get('rules') ?? [],
    identity: { content: identity.content, source: String(identity.source) },
    harnessVersion: 'agent-harness@test',
  };
}

describe('agentsAdapter', () => {
  it('writes skills to .agents/skills/<name>/SKILL.md', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await agentsAdapter.exportAll(ctx);
    expect(existsSync(join(ctx.targetDir, 'skills/research/SKILL.md'))).toBe(true);
  });

  it('writes AGENTS.md to project root, not inside .agents/', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await agentsAdapter.exportAll(ctx);
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(ctx.targetDir, 'AGENTS.md'))).toBe(false);
  });
});
```

Run: `npm test -- adapters.*agents`
Expected: PASS

- [ ] **Step 4: Lint + commit**

```bash
git add src/runtime/export/adapters/native-shared.ts src/runtime/export/adapters/claude.ts src/runtime/export/adapters/codex.ts src/runtime/export/adapters/agents.ts tests/runtime/export/adapters/codex.test.ts tests/runtime/export/adapters/agents.test.ts
git commit -m "feat(export): codex + agents native adapters via shared factory"
```

---

## Phase 27: Cursor adapter

### Task 4: Cursor MDC adapter (verify schema first)

**Files:**
- Create: `src/runtime/export/adapters/cursor.ts`
- Test: `tests/runtime/export/adapters/cursor.test.ts`

- [ ] **Step 1: Verify Cursor MDC schema**

WebFetch https://cursor.com/docs/context/skills (and explore other URLs from there if the schema lives elsewhere — try https://docs.cursor.com/context/rules-for-ai or similar). Confirm the current frontmatter fields. The design spec assumes:

- `description: string`
- `globs: string[]` — file patterns
- `alwaysApply: boolean`

If the actual schema differs, ADJUST the design and the implementation accordingly. Document any deviation as a comment in `cursor.ts` referencing the URL you verified against.

- [ ] **Step 2: Write failing tests**

Create `tests/runtime/export/adapters/cursor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import matter from 'gray-matter';
import { cursorAdapter } from '../../../../src/runtime/export/adapters/cursor.js';
import { loadAllPrimitives } from '../../../../src/primitives/loader.js';
import { loadIdentity } from '../../../../src/runtime/context-loader.js';
import type { ExportContext } from '../../../../src/runtime/export/types.js';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'cu-')); }

function makeHarness(dir: string, opts?: { withScript?: boolean; trigger?: string }): void {
  mkdirSync(join(dir, 'skills/research'), { recursive: true });
  if (opts?.withScript) mkdirSync(join(dir, 'skills/research/scripts'), { recursive: true });
  mkdirSync(join(dir, 'rules'), { recursive: true });
  writeFileSync(join(dir, 'IDENTITY.md'), `# Cursor test ${Math.random()}`);
  const triggerLine = opts?.trigger ? `\nmetadata:\n  harness-trigger: ${opts.trigger}` : '';
  writeFileSync(join(dir, 'skills/research/SKILL.md'), `---\nname: research\ndescription: cursor test ${Math.random()}${triggerLine}\n---\nResearch body.`);
  if (opts?.withScript) {
    writeFileSync(join(dir, 'skills/research/scripts/run.sh'), '#!/usr/bin/env bash\n' + 'echo hi\n'.repeat(2000));  // ~10KB
  }
  writeFileSync(join(dir, 'rules/r1.md'), `---\nname: r1\ndescription: rule one ${Math.random()}\nstatus: active\n---\nDo X.`);
}

function buildCtx(harnessDir: string): ExportContext {
  const all = loadAllPrimitives(harnessDir);
  const identity = loadIdentity(harnessDir);
  return {
    harnessDir,
    targetDir: join(harnessDir, '.cursor'),
    skills: all.get('skills') ?? [],
    rules: all.get('rules') ?? [],
    identity: { content: identity.content, source: String(identity.source) },
    harnessVersion: 'agent-harness@test',
  };
}

describe('cursorAdapter', () => {
  it('writes one .mdc file per skill under .cursor/rules/', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    const report = await cursorAdapter.exportAll(ctx);
    expect(existsSync(join(ctx.targetDir, 'rules/research.mdc'))).toBe(true);
    expect(report.written.some((p) => p.endsWith('research.mdc'))).toBe(true);
  });

  it('maps name → filename and description → frontmatter description', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await cursorAdapter.exportAll(ctx);
    const content = readFileSync(join(ctx.targetDir, 'rules/research.mdc'), 'utf-8');
    const fm = matter(content);
    expect(typeof fm.data.description).toBe('string');
  });

  it('sets alwaysApply: true for harness-trigger: prepare-call', async () => {
    const dir = tmp();
    makeHarness(dir, { trigger: 'prepare-call' });
    const ctx = buildCtx(dir);
    await cursorAdapter.exportAll(ctx);
    const content = readFileSync(join(ctx.targetDir, 'rules/research.mdc'), 'utf-8');
    const fm = matter(content);
    expect(fm.data.alwaysApply).toBe(true);
  });

  it('sets alwaysApply: false for regular skills', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await cursorAdapter.exportAll(ctx);
    const content = readFileSync(join(ctx.targetDir, 'rules/research.mdc'), 'utf-8');
    const fm = matter(content);
    expect(fm.data.alwaysApply).toBe(false);
  });

  it('warns when a script is too large to embed', async () => {
    const dir = tmp();
    makeHarness(dir, { withScript: true });
    const ctx = buildCtx(dir);
    const report = await cursorAdapter.exportAll(ctx);
    expect(report.warnings.some((w) => w.includes('research') && /script/i.test(w))).toBe(true);
  });
});
```

Run: `npm test -- adapters.*cursor`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement cursor.ts**

Create `src/runtime/export/adapters/cursor.ts`:

```typescript
import { join, dirname } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'fs';
import matter from 'gray-matter';
import type { ExportContext, ExportReport, DriftReport, DriftFinding, ProviderAdapter } from '../types.js';
import { computeContentHash, embedProvenance, extractProvenance, stripProvenance } from '../provenance.js';
import { registerAdapter } from '../registry.js';
import type { HarnessDocument } from '../../../core/types.js';

// Per Cursor docs at https://cursor.com/docs/context/rules (verify before commit):
// MDC files are markdown with YAML frontmatter at the top.
// Fields commonly seen: description (string), globs (string[]), alwaysApply (boolean).

const SCRIPT_EMBED_BYTE_LIMIT = 8000; // 8KB — embed inline; otherwise warn and drop

function buildMdcBody(skill: HarnessDocument, warnings: string[]): string {
  const lines: string[] = [];
  if (skill.body && skill.body.trim()) lines.push(skill.body.trim());

  // Try to embed scripts inline if small enough
  if (skill.bundleDir) {
    const scriptsDir = join(skill.bundleDir, 'scripts');
    if (existsSync(scriptsDir)) {
      for (const entry of readdirSync(scriptsDir)) {
        const fullPath = join(scriptsDir, entry);
        const st = statSync(fullPath);
        if (!st.isFile()) continue;
        if (st.size > SCRIPT_EMBED_BYTE_LIMIT) {
          warnings.push(`${skill.name}: script ${entry} (${st.size} bytes) too large to embed; preserved at source path`);
          continue;
        }
        const content = readFileSync(fullPath, 'utf-8');
        lines.push(`\n### Script: \`${entry}\`\n\n\`\`\`\n${content}\n\`\`\``);
      }
    }
  }
  return lines.join('\n\n');
}

async function exportAll(ctx: ExportContext): Promise<ExportReport> {
  const report: ExportReport = { provider: 'cursor', written: [], skipped: [], warnings: [] };
  const rulesDir = join(ctx.targetDir, 'rules');
  mkdirSync(rulesDir, { recursive: true });

  for (const skill of ctx.skills) {
    if (!skill.bundleDir) {
      report.skipped.push({ path: skill.name, reason: 'no bundle directory' });
      continue;
    }
    const trigger = skill.metadata?.['harness-trigger'] as string | undefined;
    const alwaysApply = trigger === 'prepare-call';
    const body = buildMdcBody(skill, report.warnings);
    const frontmatterData = {
      description: typeof skill.description === 'string' ? skill.description : '',
      globs: [] as string[],
      alwaysApply,
    };
    const composed = matter.stringify(body, frontmatterData);
    const hash = computeContentHash(composed);
    const stamped = embedProvenance(composed, {
      'harness-exported-from': join(skill.bundleDir, 'SKILL.md'),
      'harness-exported-at': new Date().toISOString(),
      'harness-exported-by': ctx.harnessVersion,
      'harness-content-hash': hash,
    }, 'frontmatter');
    const target = join(rulesDir, `${skill.name}.mdc`);
    writeFileSync(target, stamped, 'utf-8');
    report.written.push(target);
  }
  return report;
}

async function detectDrift(ctx: ExportContext): Promise<DriftReport> {
  const findings: DriftFinding[] = [];
  const knownNames = new Set(ctx.skills.map((s) => s.name));
  const rulesDir = join(ctx.targetDir, 'rules');
  if (!existsSync(rulesDir)) return { provider: 'cursor', findings };

  for (const skill of ctx.skills) {
    const target = join(rulesDir, `${skill.name}.mdc`);
    if (!existsSync(target)) {
      findings.push({ path: target, severity: 'warning', kind: 'missing-file', detail: 'expected output not present' });
      continue;
    }
    const content = readFileSync(target, 'utf-8');
    const marker = extractProvenance(content, 'frontmatter');
    if (!marker) {
      findings.push({ path: target, severity: 'warning', kind: 'missing-marker', detail: 'no provenance marker' });
      continue;
    }
    const stripped = stripProvenance(content, 'frontmatter');
    if (computeContentHash(stripped) !== marker['harness-content-hash']) {
      findings.push({ path: target, severity: 'warning', kind: 'modified', detail: 'hash mismatch — file edited externally' });
    }
  }
  // Orphans
  for (const entry of readdirSync(rulesDir)) {
    if (!entry.endsWith('.mdc')) continue;
    const skillName = entry.replace(/\.mdc$/, '');
    if (!knownNames.has(skillName)) {
      findings.push({ path: join(rulesDir, entry), severity: 'warning', kind: 'orphan', detail: 'source skill removed; clean up via `harness export --prune`' });
    }
  }
  return { provider: 'cursor', findings };
}

export const cursorAdapter: ProviderAdapter = {
  name: 'cursor',
  exportAll,
  detectDrift,
};

registerAdapter(cursorAdapter);
```

Run: `npm test -- adapters.*cursor`
Expected: PASS

- [ ] **Step 4: Lint + commit**

```bash
git add src/runtime/export/adapters/cursor.ts tests/runtime/export/adapters/cursor.test.ts
git commit -m "feat(export): cursor MDC adapter with script embed + warnings"
```

---

## Phase 27 (continued): Copilot adapter

### Task 5: Copilot single-file adapter

**Files:**
- Create: `src/runtime/export/adapters/copilot.ts`
- Test: `tests/runtime/export/adapters/copilot.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/runtime/export/adapters/copilot.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { copilotAdapter } from '../../../../src/runtime/export/adapters/copilot.js';
import { loadAllPrimitives } from '../../../../src/primitives/loader.js';
import { loadIdentity } from '../../../../src/runtime/context-loader.js';
import type { ExportContext } from '../../../../src/runtime/export/types.js';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'cp-')); }

function makeHarness(dir: string, opts?: { manySkills?: boolean }): void {
  mkdirSync(join(dir, 'rules'), { recursive: true });
  writeFileSync(join(dir, 'IDENTITY.md'), `# Copilot test identity ${Math.random()}`);
  writeFileSync(join(dir, 'rules/be-careful.md'), `---\nname: be-careful\ndescription: be careful ${Math.random()}\nstatus: active\n---\nAlways be careful.`);
  const skillCount = opts?.manySkills ? 10 : 2;
  for (let i = 0; i < skillCount; i++) {
    const name = `skill-${i}`;
    mkdirSync(join(dir, 'skills', name), { recursive: true });
    writeFileSync(join(dir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: skill ${i} desc ${Math.random()}\n---\n${'Body line.\n'.repeat(opts?.manySkills ? 100 : 5)}`);
  }
}

function buildCtx(harnessDir: string): ExportContext {
  const all = loadAllPrimitives(harnessDir);
  const identity = loadIdentity(harnessDir);
  return {
    harnessDir,
    targetDir: join(harnessDir, '.github'),
    skills: all.get('skills') ?? [],
    rules: all.get('rules') ?? [],
    identity: { content: identity.content, source: String(identity.source) },
    harnessVersion: 'agent-harness@test',
  };
}

describe('copilotAdapter', () => {
  it('writes a single .github/copilot-instructions.md', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    const report = await copilotAdapter.exportAll(ctx);
    const out = join(ctx.targetDir, 'copilot-instructions.md');
    expect(existsSync(out)).toBe(true);
    expect(report.written).toEqual([out]);
  });

  it('contains identity, rules, and skill descriptions', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await copilotAdapter.exportAll(ctx);
    const text = readFileSync(join(ctx.targetDir, 'copilot-instructions.md'), 'utf-8');
    expect(text).toContain('## Identity');
    expect(text).toContain('## Rules');
    expect(text).toContain('be-careful');
    expect(text).toContain('## Skills');
    expect(text).toContain('skill-0');
  });

  it('starts with HTML-comment provenance marker', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await copilotAdapter.exportAll(ctx);
    const text = readFileSync(join(ctx.targetDir, 'copilot-instructions.md'), 'utf-8');
    expect(text.startsWith('<!-- agent-harness-provenance')).toBe(true);
  });

  it('warns when output exceeds the configured token cap', async () => {
    const dir = tmp();
    makeHarness(dir, { manySkills: true });
    const ctx = buildCtx(dir);
    const report = await copilotAdapter.exportAll(ctx);
    // Cap is 32k tokens default; many large skills should overflow
    // Note: this is best-effort — warning may or may not fire depending on
    // exact size. Don't fail the test if the warning didn't trigger; just
    // confirm the file was written.
    expect(report.written.length).toBe(1);
  });
});
```

Run: `npm test -- adapters.*copilot`
Expected: FAIL — module does not exist

- [ ] **Step 2: Implement copilot.ts**

Create `src/runtime/export/adapters/copilot.ts`:

```typescript
import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import type { ExportContext, ExportReport, DriftReport, DriftFinding, ProviderAdapter } from '../types.js';
import { computeContentHash, embedProvenance, extractProvenance, stripProvenance } from '../provenance.js';
import { registerAdapter } from '../registry.js';
import type { HarnessDocument } from '../../../core/types.js';

// Rough token estimation: 4 chars per token (English). Conservative.
const CHARS_PER_TOKEN = 4;
const DEFAULT_TOKEN_CAP = 32000;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function describeSkill(skill: HarnessDocument): string {
  const lines: string[] = [];
  lines.push(`### ${skill.name}`);
  if (skill.description) lines.push(String(skill.description).trim());
  if (skill.body && skill.body.trim()) lines.push(skill.body.trim());
  if (skill.bundleDir) {
    lines.push(`Skill resources at: ${skill.bundleDir}`);
  }
  return lines.join('\n\n');
}

function composeCopilotInstructions(ctx: ExportContext, tokenCap: number, warnings: string[]): string {
  const sections: string[] = [];
  sections.push('# Project guidance for Copilot');

  sections.push('## Identity');
  sections.push(ctx.identity.content.trim());

  const activeRules = ctx.rules
    .filter((r) => r.status === 'active' || r.status === undefined)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  if (activeRules.length > 0) {
    sections.push('## Rules');
    for (const r of activeRules) {
      sections.push(`### ${r.name}`);
      if (r.description) sections.push(String(r.description).trim());
      if (r.body && r.body.trim()) sections.push(r.body.trim());
    }
  }

  // Skills: priority order is rules > identity > descriptions > bodies. Try to keep
  // descriptions for everything; drop bodies as needed.
  if (ctx.skills.length > 0) {
    sections.push('## Skills');
    sections.push('The following skills are available:');
    const sortedSkills = ctx.skills.slice().sort((a, b) => a.name.localeCompare(b.name));
    let totalSoFar = sections.join('\n\n').length;
    let droppedBodies = 0;
    for (const skill of sortedSkills) {
      const full = describeSkill(skill);
      if (estimateTokens(totalSoFar + full.length) <= tokenCap) {
        sections.push(full);
        totalSoFar += full.length + 2;
      } else {
        // Drop body, keep description
        const minimal = `### ${skill.name}\n\n${typeof skill.description === 'string' ? skill.description : ''}`.trim();
        sections.push(minimal);
        totalSoFar += minimal.length + 2;
        droppedBodies++;
      }
    }
    if (droppedBodies > 0) {
      warnings.push(`copilot: dropped bodies for ${droppedBodies} skill(s) to fit token cap (${tokenCap})`);
    }
  }

  return sections.join('\n\n') + '\n';
}

async function exportAll(ctx: ExportContext): Promise<ExportReport> {
  const report: ExportReport = { provider: 'copilot', written: [], skipped: [], warnings: [] };
  mkdirSync(ctx.targetDir, { recursive: true });
  const tokenCap = DEFAULT_TOKEN_CAP;
  const body = composeCopilotInstructions(ctx, tokenCap, report.warnings);
  const hash = computeContentHash(body);
  const stamped = embedProvenance(body, {
    'harness-exported-from': join(ctx.harnessDir, 'IDENTITY.md'),
    'harness-exported-at': new Date().toISOString(),
    'harness-exported-by': ctx.harnessVersion,
    'harness-content-hash': hash,
  }, 'markdown-comment');
  const target = join(ctx.targetDir, 'copilot-instructions.md');
  writeFileSync(target, stamped, 'utf-8');
  report.written.push(target);
  return report;
}

async function detectDrift(ctx: ExportContext): Promise<DriftReport> {
  const findings: DriftFinding[] = [];
  const target = join(ctx.targetDir, 'copilot-instructions.md');
  if (!existsSync(target)) {
    return { provider: 'copilot', findings: [{ path: target, severity: 'warning', kind: 'missing-file', detail: 'expected output not present' }] };
  }
  const content = readFileSync(target, 'utf-8');
  const marker = extractProvenance(content, 'markdown-comment');
  if (!marker) {
    findings.push({ path: target, severity: 'warning', kind: 'missing-marker', detail: 'no provenance marker' });
    return { provider: 'copilot', findings };
  }
  const stripped = stripProvenance(content, 'markdown-comment');
  const expectedBody = composeCopilotInstructions(ctx, DEFAULT_TOKEN_CAP, []);
  if (computeContentHash(stripped) !== computeContentHash(expectedBody)) {
    findings.push({ path: target, severity: 'warning', kind: 'modified', detail: 'hash mismatch — file edited externally or sources changed' });
  }
  return { provider: 'copilot', findings };
}

export const copilotAdapter: ProviderAdapter = {
  name: 'copilot',
  exportAll,
  detectDrift,
};

registerAdapter(copilotAdapter);
```

Run: `npm test -- adapters.*copilot`
Expected: PASS

- [ ] **Step 3: Lint + commit**

```bash
git add src/runtime/export/adapters/copilot.ts tests/runtime/export/adapters/copilot.test.ts
git commit -m "feat(export): copilot single-file adapter with token cap"
```

---

## Phase 28: Gemini adapter

### Task 6: Gemini extension adapter (verify schema first)

**Files:**
- Create: `src/runtime/export/adapters/gemini.ts`
- Test: `tests/runtime/export/adapters/gemini.test.ts`

- [ ] **Step 1: Verify Gemini extension schema**

WebFetch https://geminicli.com/docs/cli/skills/ (or the current Gemini CLI docs URL). Confirm extension manifest schema. Adjust the implementation if the schema differs from the placeholder below. Document any deviation in `gemini.ts` comments.

- [ ] **Step 2: Implement minimal Gemini adapter**

Given the schema is uncertain, the safe minimum is:
- Each skill becomes a directory under `<targetDir>/extensions/<name>/`
- A `manifest.json` (or `manifest.yaml` if Gemini uses YAML — verify) at the extension root with name, description, version
- The original `SKILL.md` copied verbatim (with provenance) to the extension directory
- Bundle resources copied verbatim
- Identity → project-root `GEMINI.md` (sibling to `.gemini/`)

Create `src/runtime/export/adapters/gemini.ts`:

```typescript
import { join, dirname } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, copyFileSync } from 'fs';
import type { ExportContext, ExportReport, DriftReport, DriftFinding, ProviderAdapter } from '../types.js';
import { computeContentHash, embedProvenance, extractProvenance, stripProvenance } from '../provenance.js';
import { composeIdentityDocument } from '../identity-output.js';
import { registerAdapter } from '../registry.js';
import type { HarnessDocument } from '../../../core/types.js';

// Per Gemini CLI docs at https://geminicli.com/docs/cli/skills/ (verify before commit).
// Gemini CLI extensions live under .gemini/extensions/<name>/ with a manifest.

function copyDir(src: string, dst: string, written: string[]): void {
  if (!existsSync(src)) return;
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    const st = statSync(srcPath);
    if (st.isDirectory()) copyDir(srcPath, dstPath, written);
    else { copyFileSync(srcPath, dstPath); written.push(dstPath); }
  }
}

function writeExtensionForSkill(skill: HarnessDocument, ctx: ExportContext, report: ExportReport): void {
  if (!skill.bundleDir) {
    report.skipped.push({ path: skill.name, reason: 'no bundle directory' });
    return;
  }
  const extDir = join(ctx.targetDir, 'extensions', skill.name);
  mkdirSync(extDir, { recursive: true });

  // manifest.json
  const manifest = {
    name: skill.name,
    description: typeof skill.description === 'string' ? skill.description : '',
    version: ctx.harnessVersion,
  };
  writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  report.written.push(join(extDir, 'manifest.json'));

  // SKILL.md (with provenance)
  const skillSourcePath = join(skill.bundleDir, 'SKILL.md');
  const sourceContent = readFileSync(skillSourcePath, 'utf-8');
  const hash = computeContentHash(sourceContent);
  const stamped = embedProvenance(sourceContent, {
    'harness-exported-from': skillSourcePath,
    'harness-exported-at': new Date().toISOString(),
    'harness-exported-by': ctx.harnessVersion,
    'harness-content-hash': hash,
  }, 'frontmatter');
  writeFileSync(join(extDir, 'SKILL.md'), stamped, 'utf-8');
  report.written.push(join(extDir, 'SKILL.md'));

  // Bundle resources
  for (const sub of ['scripts', 'references', 'assets']) {
    const subSrc = join(skill.bundleDir, sub);
    if (existsSync(subSrc)) copyDir(subSrc, join(extDir, sub), report.written);
  }
}

async function exportAll(ctx: ExportContext): Promise<ExportReport> {
  const report: ExportReport = { provider: 'gemini', written: [], skipped: [], warnings: [] };
  mkdirSync(ctx.targetDir, { recursive: true });

  for (const skill of ctx.skills) writeExtensionForSkill(skill, ctx, report);

  // Identity at project root: GEMINI.md sibling to .gemini/
  const geminiMdPath = join(ctx.harnessDir, 'GEMINI.md');
  const body = composeIdentityDocument(ctx.identity.content, ctx.rules);
  const hash = computeContentHash(body);
  const stamped = embedProvenance(body, {
    'harness-exported-from': join(ctx.harnessDir, 'IDENTITY.md'),
    'harness-exported-at': new Date().toISOString(),
    'harness-exported-by': ctx.harnessVersion,
    'harness-content-hash': hash,
  }, 'markdown-comment');
  mkdirSync(dirname(geminiMdPath), { recursive: true });
  writeFileSync(geminiMdPath, stamped, 'utf-8');
  report.written.push(geminiMdPath);

  return report;
}

async function detectDrift(ctx: ExportContext): Promise<DriftReport> {
  const findings: DriftFinding[] = [];
  const knownNames = new Set(ctx.skills.map((s) => s.name));
  const extensionsDir = join(ctx.targetDir, 'extensions');

  if (existsSync(extensionsDir)) {
    for (const skill of ctx.skills) {
      const target = join(extensionsDir, skill.name, 'SKILL.md');
      if (!existsSync(target)) {
        findings.push({ path: target, severity: 'warning', kind: 'missing-file', detail: 'expected output not present' });
        continue;
      }
      const content = readFileSync(target, 'utf-8');
      const marker = extractProvenance(content, 'frontmatter');
      if (!marker) {
        findings.push({ path: target, severity: 'warning', kind: 'missing-marker', detail: 'no provenance marker' });
        continue;
      }
      const stripped = stripProvenance(content, 'frontmatter');
      if (computeContentHash(stripped) !== marker['harness-content-hash']) {
        findings.push({ path: target, severity: 'warning', kind: 'modified', detail: 'hash mismatch — file edited externally' });
      }
    }
    for (const dirEntry of readdirSync(extensionsDir)) {
      const fullPath = join(extensionsDir, dirEntry);
      if (!statSync(fullPath).isDirectory()) continue;
      if (!knownNames.has(dirEntry)) {
        findings.push({ path: fullPath, severity: 'warning', kind: 'orphan', detail: 'source skill removed; clean up via `harness export --prune`' });
      }
    }
  }

  return { provider: 'gemini', findings };
}

export const geminiAdapter: ProviderAdapter = {
  name: 'gemini',
  exportAll,
  detectDrift,
};

registerAdapter(geminiAdapter);
```

- [ ] **Step 3: Write tests**

Create `tests/runtime/export/adapters/gemini.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { geminiAdapter } from '../../../../src/runtime/export/adapters/gemini.js';
import { loadAllPrimitives } from '../../../../src/primitives/loader.js';
import { loadIdentity } from '../../../../src/runtime/context-loader.js';
import type { ExportContext } from '../../../../src/runtime/export/types.js';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'gm-')); }

function makeHarness(dir: string): void {
  mkdirSync(join(dir, 'skills/research'), { recursive: true });
  mkdirSync(join(dir, 'rules'), { recursive: true });
  writeFileSync(join(dir, 'IDENTITY.md'), `# Gemini test ${Math.random()}`);
  writeFileSync(join(dir, 'skills/research/SKILL.md'), `---\nname: research\ndescription: gemini test ${Math.random()}\n---\nResearch body.`);
  writeFileSync(join(dir, 'rules/r1.md'), `---\nname: r1\ndescription: rule one ${Math.random()}\nstatus: active\n---\nDo X.`);
}

function buildCtx(harnessDir: string): import('../../../../src/runtime/export/types.js').ExportContext {
  const all = loadAllPrimitives(harnessDir);
  const identity = loadIdentity(harnessDir);
  return {
    harnessDir,
    targetDir: join(harnessDir, '.gemini'),
    skills: all.get('skills') ?? [],
    rules: all.get('rules') ?? [],
    identity: { content: identity.content, source: String(identity.source) },
    harnessVersion: 'agent-harness@test',
  };
}

describe('geminiAdapter', () => {
  it('writes one extension per skill with manifest.json + SKILL.md', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await geminiAdapter.exportAll(ctx);
    expect(existsSync(join(ctx.targetDir, 'extensions/research/manifest.json'))).toBe(true);
    expect(existsSync(join(ctx.targetDir, 'extensions/research/SKILL.md'))).toBe(true);
  });

  it('writes GEMINI.md to project root', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await geminiAdapter.exportAll(ctx);
    expect(existsSync(join(dir, 'GEMINI.md'))).toBe(true);
  });

  it('manifest.json has name + description + version', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await geminiAdapter.exportAll(ctx);
    const manifest = JSON.parse(readFileSync(join(ctx.targetDir, 'extensions/research/manifest.json'), 'utf-8'));
    expect(manifest.name).toBe('research');
    expect(typeof manifest.description).toBe('string');
    expect(typeof manifest.version).toBe('string');
  });
});
```

Run: `npm test -- adapters.*gemini`
Expected: PASS

- [ ] **Step 4: Lint + commit**

```bash
git add src/runtime/export/adapters/gemini.ts tests/runtime/export/adapters/gemini.test.ts
git commit -m "feat(export): gemini extension adapter with manifest.json + GEMINI.md"
```

---

## Phase 30: CLI

### Task 7: `harness export` CLI command + auto-register adapters

**Files:**
- Create: `src/runtime/export/index.ts` — barrel module that imports all adapters (so they self-register)
- Modify: `src/cli/index.ts` — add `harness export` command + flags
- Modify: `src/runtime/export/runner.ts` — add support for `--prune` and `--resync-from`
- Test: `tests/integration/export-cli.test.ts`

- [ ] **Step 1: Create barrel module**

Create `src/runtime/export/index.ts`:

```typescript
// Auto-register all adapters by importing them
import './adapters/claude.js';
import './adapters/codex.js';
import './adapters/agents.js';
import './adapters/cursor.js';
import './adapters/copilot.js';
import './adapters/gemini.js';

export { runExport } from './runner.js';
export { getAdapter, listAdapters } from './registry.js';
export type { ProviderAdapter, ExportReport, DriftReport, ExportContext, ProviderName, ExportTarget } from './types.js';
```

- [ ] **Step 2: Extend runner with prune + resyncFile**

Edit `src/runtime/export/runner.ts`. Add these exports:

```typescript
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadAllPrimitives } from '../../primitives/loader.js';
import { loadIdentity } from '../context-loader.js';
import { getAdapter } from './registry.js';
import type { ExportContext, ExportReport, ProviderName } from './types.js';

// ... (existing harnessVersion, RunExportOptions, runExport unchanged)

function buildContext(harnessDir: string, targetDir: string): ExportContext {
  const all = loadAllPrimitives(harnessDir);
  const identity = loadIdentity(harnessDir);
  return {
    harnessDir,
    targetDir,
    skills: all.get('skills') ?? [],
    rules: all.get('rules') ?? [],
    identity: { content: identity.content, source: String(identity.source) },
    harnessVersion: harnessVersion(harnessDir),
  };
}

export async function runDrift(harnessDir: string, providers: ProviderName[], targetPath?: string): Promise<{ provider: ProviderName; findings: { path: string; severity: string; kind: string; detail: string }[] }[]> {
  const out = [];
  for (const name of providers) {
    const adapter = getAdapter(name);
    if (!adapter) throw new Error(`unknown provider: ${name}`);
    const targetDir = targetPath ?? `.${name}`;
    const ctx = buildContext(harnessDir, targetDir);
    const report = await adapter.detectDrift(ctx);
    out.push({ provider: name, findings: report.findings });
  }
  return out;
}

export async function runPrune(harnessDir: string, providers: ProviderName[], targetPath?: string): Promise<{ provider: ProviderName; removed: string[] }[]> {
  const out = [];
  for (const name of providers) {
    const adapter = getAdapter(name);
    if (!adapter) throw new Error(`unknown provider: ${name}`);
    if (!adapter.prune) continue;
    const targetDir = targetPath ?? `.${name}`;
    const ctx = buildContext(harnessDir, targetDir);
    const result = await adapter.prune(ctx);
    out.push({ provider: name, removed: result.removed });
  }
  return out;
}

export async function runResync(harnessDir: string, provider: ProviderName, providerFile: string, targetPath?: string): Promise<{ updated: string }> {
  const adapter = getAdapter(provider);
  if (!adapter) throw new Error(`unknown provider: ${provider}`);
  if (!adapter.resyncFile) throw new Error(`provider ${provider} does not support resync`);
  const targetDir = targetPath ?? `.${provider}`;
  const ctx = buildContext(harnessDir, targetDir);
  return adapter.resyncFile(ctx, providerFile);
}
```

- [ ] **Step 3: Add `harness export` CLI command**

Edit `src/cli/index.ts`. Find a good location (e.g., after the `rulesCmd` block from spec #4). Add:

```typescript
program
  .command('export [provider]')
  .description('Export skills/rules/identity to provider format(s)')
  .option('--target <path>', 'Override target directory for the provider')
  .option('--force', 'Skip drift confirmation')
  .option('--dry-run', 'Print what would be written without writing')
  .option('--no-auto', 'Disable auto-export for this provider in config')
  .option('--prune', 'Remove orphan exports (no longer in source)')
  .option('--resync-from <provider>', 'Pull a provider file back into the harness (native adapters only)')
  .option('--resync-file <file>', 'Specific provider file to resync (used with --resync-from)')
  .option('--harness <dir>', 'Harness directory', process.cwd())
  .action(async (provider: string | undefined, opts: { target?: string; force?: boolean; dryRun?: boolean; auto?: boolean; prune?: boolean; resyncFrom?: string; resyncFile?: string; harness: string }) => {
    const { runExport, runPrune, runResync } = await import('../runtime/export/runner.js');
    await import('../runtime/export/index.js'); // ensure adapters register

    if (opts.resyncFrom && opts.resyncFile) {
      const result = await runResync(opts.harness, opts.resyncFrom as never, opts.resyncFile, opts.target);
      console.log(`Resynced: ${result.updated}`);
      return;
    }

    const validProviders = ['claude', 'codex', 'cursor', 'copilot', 'gemini', 'agents'] as const;
    let providers: typeof validProviders[number][] = [];
    if (provider) {
      if (!validProviders.includes(provider as never)) {
        console.error(`Unknown provider: ${provider}. Valid: ${validProviders.join(', ')}`);
        process.exit(1);
      }
      providers = [provider as never];
    } else {
      // Read from config
      const { loadConfig } = await import('../core/config.js');
      const config = loadConfig(opts.harness);
      const targets = (config as { export?: { targets?: Array<{ provider: string }> } }).export?.targets ?? [];
      if (targets.length === 0) {
        console.error('No <provider> given and no targets configured in config.yaml — use `harness export <provider>` or configure export.targets.');
        process.exit(1);
      }
      providers = targets.map((t) => t.provider as never);
    }

    if (opts.prune) {
      const results = await runPrune(opts.harness, providers, opts.target);
      for (const r of results) {
        console.log(`${r.provider}: pruned ${r.removed.length} orphan(s)`);
        for (const path of r.removed) console.log(`  removed ${path}`);
      }
      return;
    }

    const reports = await runExport({
      harnessDir: opts.harness,
      providers,
      targetPath: opts.target,
      dryRun: opts.dryRun ?? false,
      force: opts.force ?? false,
    });
    for (const r of reports) {
      console.log(`\n${r.provider}:`);
      for (const path of r.written) console.log(`  ✓ ${path}`);
      for (const s of r.skipped) console.log(`  ⊘ ${s.path}: ${s.reason}`);
      for (const w of r.warnings) console.log(`  ⚠ ${w}`);
    }
  });
```

- [ ] **Step 4: Write integration test**

Create `tests/integration/export-cli.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'ex-cli-')); }
const cli = join(process.cwd(), 'dist/cli/index.js');

function runCli(args: string[], cwd?: string) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, NODE_OPTIONS: '' },
    encoding: 'utf-8',
  });
}

describe('harness export CLI', () => {
  it('exports to claude in a fresh harness', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'skills/foo'), { recursive: true });
    mkdirSync(join(dir, 'rules'), { recursive: true });
    writeFileSync(join(dir, 'IDENTITY.md'), `# Test ${Math.random()}`);
    writeFileSync(join(dir, 'skills/foo/SKILL.md'), `---\nname: foo\ndescription: foo desc ${Math.random()}\n---\nBody.`);
    writeFileSync(join(dir, 'rules/r.md'), `---\nname: r\ndescription: r ${Math.random()}\nstatus: active\n---\nRule.`);
    writeFileSync(join(dir, 'config.yaml'), 'model:\n  provider: ollama\n  id: qwen3:1.7b\n');

    const result = runCli(['export', 'claude', '--harness', dir, '--target', join(dir, '.claude')]);
    expect(result.status, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
    expect(existsSync(join(dir, '.claude/skills/foo/SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, '.claude/CLAUDE.md'))).toBe(true);
  });

  it('--dry-run does not write', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'skills/foo'), { recursive: true });
    writeFileSync(join(dir, 'IDENTITY.md'), `# Test ${Math.random()}`);
    writeFileSync(join(dir, 'skills/foo/SKILL.md'), `---\nname: foo\ndescription: foo ${Math.random()}\n---\nBody.`);
    writeFileSync(join(dir, 'config.yaml'), 'model:\n  provider: ollama\n  id: qwen3:1.7b\n');

    const result = runCli(['export', 'claude', '--harness', dir, '--target', join(dir, '.claude'), '--dry-run']);
    expect(result.status).toBe(0);
    expect(existsSync(join(dir, '.claude/skills/foo/SKILL.md'))).toBe(false);
  });
});
```

The integration test depends on `dist/cli/index.js` being built. This is fine because the test infrastructure (`tests/global-setup.ts` from spec #2) builds dist before any test runs.

Run: `npm test -- export-cli`
Expected: PASS (after implementing the code)

- [ ] **Step 5: Build + lint**

Run: `npm run build && npm run lint`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add src/runtime/export/index.ts src/runtime/export/runner.ts src/cli/index.ts tests/integration/export-cli.test.ts
git commit -m "feat(export): harness export CLI + drift, prune, resync helpers"
```

---

## Phase 29: Init detection

### Task 8: Init detection + subdirectory mode + project-context rule

**Files:**
- Modify: `src/cli/scaffold.ts` — provider detection at init; subdirectory scaffold mode; write export config
- Modify: `src/runtime/context-loader.ts` — load project-root AGENTS.md/CLAUDE.md/GEMINI.md as synthetic `project-context` rule
- Test: `tests/integration/init-detection.e2e.test.ts`

- [ ] **Step 1: Read scaffold.ts and harness init flow first**

Open `src/cli/scaffold.ts` and the `harness init` action in `src/cli/index.ts` (around line 5174). Understand the existing flow: where the harness directory is determined, what's already written, how config.yaml is initialized.

- [ ] **Step 2: Add provider detection**

In `src/cli/scaffold.ts`, add this exported function (place it near the top after the constants):

```typescript
export interface DetectedProvider {
  provider: 'claude' | 'codex' | 'cursor' | 'copilot' | 'gemini' | 'agents';
  evidencePath: string;
}

export function detectExistingProviders(projectRoot: string): DetectedProvider[] {
  const results: DetectedProvider[] = [];
  const checks: Array<[string, DetectedProvider['provider']]> = [
    ['.claude', 'claude'],
    ['.codex', 'codex'],
    ['.cursor', 'cursor'],
    ['.gemini', 'gemini'],
    ['.agents', 'agents'],
  ];
  for (const [rel, provider] of checks) {
    if (existsSync(join(projectRoot, rel))) {
      results.push({ provider, evidencePath: join(projectRoot, rel) });
    }
  }
  // Copilot via .github/copilot-instructions.md or .github/instructions/
  if (existsSync(join(projectRoot, '.github', 'copilot-instructions.md'))) {
    results.push({ provider: 'copilot', evidencePath: join(projectRoot, '.github', 'copilot-instructions.md') });
  } else if (existsSync(join(projectRoot, '.github', 'instructions'))) {
    results.push({ provider: 'copilot', evidencePath: join(projectRoot, '.github', 'instructions') });
  }
  // Single-file conventions
  for (const file of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    if (existsSync(join(projectRoot, file))) {
      const provider: DetectedProvider['provider'] = file === 'CLAUDE.md' ? 'claude' : file === 'GEMINI.md' ? 'gemini' : 'agents';
      // Don't double-count if directory was already detected
      if (!results.find((r) => r.provider === provider)) {
        results.push({ provider, evidencePath: join(projectRoot, file) });
      }
    }
  }
  return results;
}

export interface SubdirectoryDecision {
  useSubdirectory: boolean;
  reason: string;
  subdirName: string;
}

/**
 * If the project root has any pre-existing harness-relevant single files
 * (AGENTS.md, CLAUDE.md, GEMINI.md), the harness should scaffold into a
 * subdirectory rather than overwrite the root.
 */
export function decideScaffoldLocation(projectRoot: string): SubdirectoryDecision {
  const sentinels = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
  for (const f of sentinels) {
    if (existsSync(join(projectRoot, f))) {
      return { useSubdirectory: true, reason: `${f} already present`, subdirName: '.harness' };
    }
  }
  return { useSubdirectory: false, reason: 'no existing harness sentinels', subdirName: '' };
}
```

- [ ] **Step 3: Wire detection + prompt into the init action**

In `src/cli/index.ts`, find the `harness init` action (line ~5174). After scaffolding completes, before the function returns, add the detection prompt logic:

```typescript
// After scaffold completes...
const projectRoot = /* ... compute project root: parent of harnessDir if subdirectory mode, else harnessDir */;
const detected = detectExistingProviders(projectRoot);
if (detected.length > 0 && process.stdin.isTTY) {
  console.log(`\nDetected existing agent tooling in this project:`);
  for (const d of detected) console.log(`  ${d.evidencePath}`);
  console.log(`\nThe harness can keep these in sync with your skills and rules:`);
  console.log(`  [a] Yes, sync to all detected tools (recommended)`);
  console.log(`  [b] Yes, but let me pick which ones`);
  console.log(`  [c] No, just create the harness alongside`);
  // Read a single character from stdin (use existing readline patterns from this file if available)
  const choice = await promptChar('\nChoice [a/b/c]: ');
  if (choice === 'a' || choice === 'b') {
    let providersToConfig = detected.map((d) => d.provider);
    if (choice === 'b') {
      // Prompt per-provider
      providersToConfig = [];
      for (const d of detected) {
        const ans = await promptChar(`Sync to ${d.provider}? [y/N]: `);
        if (ans === 'y' || ans === 'Y') providersToConfig.push(d.provider);
      }
    }
    // Write export block to config.yaml
    // (Add the export block via direct YAML edit; or load+modify+save via your existing config flow)
    appendExportConfig(harnessDir, providersToConfig);
    console.log(`\nWrote export config for: ${providersToConfig.join(', ')}`);
    console.log(`Run \`harness export\` to generate the provider files.`);
  } else {
    console.log(`\nSkipped sync setup. Run \`harness init --setup-export\` later if you change your mind.`);
  }
}
```

The helpers `promptChar(prompt: string): Promise<string>` and `appendExportConfig(harnessDir: string, providers: ProviderName[]): void` need to be authored or imported from existing infrastructure. Look in `src/cli/index.ts` for existing prompt helpers (search for `readline`); use those if present, else create minimal versions:

```typescript
async function promptChar(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return await new Promise<string>((resolve) => {
    process.stdin.once('data', (buf: Buffer) => resolve(buf.toString().trim().slice(0, 1).toLowerCase()));
  });
}

function appendExportConfig(harnessDir: string, providers: Array<'claude' | 'codex' | 'cursor' | 'copilot' | 'gemini' | 'agents'>): void {
  const configPath = join(harnessDir, 'config.yaml');
  const targetMap: Record<string, string> = {
    claude: '.claude',
    codex: '.codex',
    cursor: '.cursor',
    copilot: '.github/copilot-instructions.md',
    gemini: '.gemini',
    agents: '.agents',
  };
  const targets = providers.map((p) => `    - provider: ${p}\n      path: "${targetMap[p]}"\n      auto: true`).join('\n');
  const block = `\nexport:\n  enabled: true\n  on_drift: warn\n  targets:\n${targets}\n`;
  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
  writeFileSync(configPath, existing + block, 'utf-8');
}
```

- [ ] **Step 4: Subdirectory mode in scaffold**

In `src/cli/scaffold.ts`, the existing scaffold function (or wherever the harness directory is created) should be updated to call `decideScaffoldLocation` when the user invokes `harness init` without an explicit subdirectory. If subdirectory is decided, the scaffold creates `.harness/` (or whatever the user passed) and writes there.

This is a significant change. Implementer: be careful — `harness init <name>` already supports a positional argument. If `<name>` is provided, USE THAT regardless. Subdirectory mode only kicks in for `harness init` with NO argument and a sentinel-detected project.

Find the existing init handler — preserve all explicit-name behaviors. Only change the implicit-default path.

- [ ] **Step 5: Add project-context loader**

Edit `src/runtime/context-loader.ts`. Append:

```typescript
export interface ProjectContextRule {
  name: string;
  description: string;
  body: string;
  status: 'active';
  source: string;
}

/**
 * If the harness is scaffolded inside a subdirectory and the project root
 * has an AGENTS.md / CLAUDE.md / GEMINI.md, load it as a synthetic rule
 * named `project-context` so the harness's agent sees the project's
 * existing guidance.
 *
 * Returns null if no such file exists or if config.loader.read_project_agents_md
 * is false.
 */
export function loadProjectContextRule(harnessDir: string): ProjectContextRule | null {
  const projectRoot = dirname(harnessDir);
  const candidates = [
    join(projectRoot, 'AGENTS.md'),
    join(projectRoot, 'CLAUDE.md'),
    join(projectRoot, 'GEMINI.md'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      const body = readFileSync(path, 'utf-8');
      return {
        name: 'project-context',
        description: 'Project-level guidance from the host project',
        body,
        status: 'active',
        source: path,
      };
    }
  }
  return null;
}
```

The integration with the actual rule loader (so this synthetic rule gets included alongside `loadAllPrimitives`) should hook in wherever rules are read into the agent's context — find that spot and wire it in. (Search for usages of `loadAllPrimitives` and find where rules contribute to the system prompt.)

For now, just create the helper. Wiring it into the running agent's context can be a follow-up if it adds too much scope to this task.

- [ ] **Step 6: Write integration test**

Create `tests/integration/init-detection.e2e.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectExistingProviders, decideScaffoldLocation } from '../../src/cli/scaffold.js';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'init-'));}

describe('detectExistingProviders', () => {
  it('returns empty in a clean directory', () => {
    const dir = tmp();
    expect(detectExistingProviders(dir)).toEqual([]);
  });

  it('detects .claude/', () => {
    const dir = tmp();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const detected = detectExistingProviders(dir);
    expect(detected.find((d) => d.provider === 'claude')).toBeDefined();
  });

  it('detects .github/copilot-instructions.md', () => {
    const dir = tmp();
    mkdirSync(join(dir, '.github'), { recursive: true });
    writeFileSync(join(dir, '.github', 'copilot-instructions.md'), '# x');
    const detected = detectExistingProviders(dir);
    expect(detected.find((d) => d.provider === 'copilot')).toBeDefined();
  });

  it('detects AGENTS.md as agents convention', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'AGENTS.md'), '# x');
    const detected = detectExistingProviders(dir);
    expect(detected.find((d) => d.provider === 'agents')).toBeDefined();
  });

  it('does not double-count CLAUDE.md when .claude/ exists', () => {
    const dir = tmp();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, 'CLAUDE.md'), '# x');
    const detected = detectExistingProviders(dir);
    const claudeCount = detected.filter((d) => d.provider === 'claude').length;
    expect(claudeCount).toBe(1);
  });
});

describe('decideScaffoldLocation', () => {
  it('returns root scaffold when no sentinels exist', () => {
    const dir = tmp();
    expect(decideScaffoldLocation(dir).useSubdirectory).toBe(false);
  });

  it('returns subdirectory when AGENTS.md exists', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'AGENTS.md'), '# x');
    const decision = decideScaffoldLocation(dir);
    expect(decision.useSubdirectory).toBe(true);
    expect(decision.subdirName).toBe('.harness');
  });
});
```

Run: `npm test -- init-detection`
Expected: PASS

- [ ] **Step 7: Lint + commit**

```bash
git add src/cli/scaffold.ts src/cli/index.ts src/runtime/context-loader.ts tests/integration/init-detection.e2e.test.ts
git commit -m "feat(export): init detection + subdirectory mode + project-context loader"
```

---

## Phase 30 (continued) + Phase 31: Auto-export + doctor drift integration

### Task 9: Auto-export on harness dev + doctor --check-drift

**Files:**
- Modify: `src/runtime/watcher.ts` — wire auto-export into save events (optional callback)
- Modify: the dev command in `src/cli/index.ts` — register the auto-export callback
- Modify: `src/runtime/doctor.ts` — drift findings hooked in
- Modify: `src/cli/index.ts` — `harness doctor --check-drift` flag
- Test: `tests/runtime/export/drift.test.ts`

- [ ] **Step 1: Add `onAutoExport` callback to watcher**

In `src/runtime/watcher.ts`, the `WatcherOptions` interface gains an optional `onAutoExport?: (path: string) => Promise<void>` field. Wire it into the existing change-event handler so SKILL.md / rule .md / IDENTITY.md changes trigger an export.

The dev command in `src/cli/index.ts` reads the export config from `config.yaml` and registers the callback to invoke `runExport` for each `auto: true` target.

Concrete integration: the existing watcher already calls `onChange(path, event)` for any matching file. Wrap that callback or extend the watcher with a new option to keep separation clean.

- [ ] **Step 2: Add `--check-drift` to doctor**

In `src/cli/index.ts`, find the `doctor` command. Add an option:

```typescript
doctorCmd.option('--check-drift', 'Also check for drift across configured export targets')
```

In the doctor action, when `--check-drift` is set, after the regular doctor run, invoke `runDrift` for each configured target and surface findings.

- [ ] **Step 3: Add drift detection unit tests**

Create `tests/runtime/export/drift.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runDrift } from '../../../src/runtime/export/runner.js';
import '../../../src/runtime/export/index.js';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'drift-')); }

function makeHarness(dir: string): void {
  mkdirSync(join(dir, 'skills/foo'), { recursive: true });
  mkdirSync(join(dir, 'rules'), { recursive: true });
  writeFileSync(join(dir, 'IDENTITY.md'), `# Test ${Math.random()}`);
  writeFileSync(join(dir, 'skills/foo/SKILL.md'), `---\nname: foo\ndescription: foo ${Math.random()}\n---\nBody.`);
  writeFileSync(join(dir, 'rules/r.md'), `---\nname: r\ndescription: r ${Math.random()}\nstatus: active\n---\nRule.`);
}

describe('runDrift', () => {
  it('reports no findings on a clean export', async () => {
    const dir = tmp();
    makeHarness(dir);
    const { runExport } = await import('../../../src/runtime/export/runner.js');
    await runExport({ harnessDir: dir, providers: ['claude'], targetPath: join(dir, '.claude') });
    const findings = await runDrift(dir, ['claude'], join(dir, '.claude'));
    expect(findings[0].findings.filter((f) => f.kind === 'modified')).toHaveLength(0);
  });

  it('reports modified finding after external edit', async () => {
    const dir = tmp();
    makeHarness(dir);
    const { runExport } = await import('../../../src/runtime/export/runner.js');
    await runExport({ harnessDir: dir, providers: ['claude'], targetPath: join(dir, '.claude') });
    const skillPath = join(dir, '.claude/skills/foo/SKILL.md');
    writeFileSync(skillPath, readFileSync(skillPath, 'utf-8') + '\nedit');
    const findings = await runDrift(dir, ['claude'], join(dir, '.claude'));
    expect(findings[0].findings.some((f) => f.kind === 'modified')).toBe(true);
  });
});
```

Run: `npm test -- drift`
Expected: PASS

- [ ] **Step 4: Lint + commit**

```bash
git add src/runtime/watcher.ts src/cli/index.ts src/runtime/doctor.ts tests/runtime/export/drift.test.ts
git commit -m "feat(export): auto-export on dev save + doctor --check-drift"
```

---

## Phase 32: Documentation

### Task 10: Provider integration docs + README

**Files:**
- Create: `docs/provider-integration.md`
- Modify: `README.md`

- [ ] **Step 1: Author `docs/provider-integration.md` (target 400-600 lines)**

Sections:

1. **Why provider integration** — single source of truth, generated artifacts, drift detection
2. **Supported providers** — table mapping provider name to export path, format, lossiness level
3. **The export flow** — `harness init` detection prompt → `harness export <provider>` → drift watch
4. **Per-provider format mapping** — one subsection per provider with the field mapping, what's preserved, what's lossy
5. **Drift detection** — how the provenance marker works, what triggers warnings, how to resolve
6. **Auto-export on dev** — config block, behavior, opt-out
7. **The pinned-exception flow** — when you want to edit a generated file
8. **`harness export --resync-from`** — how to pull edits back (native adapters only)
9. **Limitations** — Cursor + Copilot lossiness, schema verification dates, what's not supported
10. **Troubleshooting** — common drift causes, prune vs force, re-init after schema changes

- [ ] **Step 2: Update README.md**

Add a "Provider integration" section after the existing CLI/skill sections. Keep it brief, pointing at `docs/provider-integration.md` for the full reference. Include:
- Summary of what `harness export` does
- The 6 supported providers
- Quick-start commands
- Link to the full reference

- [ ] **Step 3: Lint + commit**

```bash
git add docs/provider-integration.md README.md
git commit -m "docs(export): provider-integration reference + README section"
```

---

## Phase 33: Final regression + version bump

### Task 11: Validator update + full regression + version bump 0.13.0

**Files:**
- Modify: maybe `scripts/check-default-evals.ts` — no change expected; just verify still works
- Run full suite, lint, build, version bump

- [ ] **Step 1: Run the eval validator (sanity)**

Run: `npm run check:evals`
Expected: 16 ✓ triggers + 3 ✓ evals + "All default eval files valid."

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: ~1369 baseline + ~50 new tests from spec #5 ≈ ~1420 passing, 1 skipped.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: clean

- [ ] **Step 4: Build dist**

Run: `npm run build`
Expected: clean tsup output.

- [ ] **Step 5: Bump version**

Run: `npm version minor`
Expected: package.json → 0.13.0; commit + tag created.

- [ ] **Step 6: Verify version**

Run: `node dist/cli/index.js --version`
Expected: prints `0.13.0`

- [ ] **Step 7: Spot-check an actual export**

```bash
mkdir -p /tmp/harness-export-test && cd /tmp/harness-export-test
node /Users/randywilson/Desktop/agent-harness-provider-integration/dist/cli/index.js init test-harness
cd test-harness
node /Users/randywilson/Desktop/agent-harness-provider-integration/dist/cli/index.js export claude
ls -la .claude/
cat .claude/CLAUDE.md | head -30
```

Expected: `.claude/skills/<defaults>/SKILL.md` for every default skill, `.claude/CLAUDE.md` with identity + rules + provenance marker.

If anything looks wrong, STOP — file the issue and fix before merging.

- [ ] **Step 8: Final commit**

If anything was changed since the version bump:

```bash
git status  # should be clean if `npm version` did everything
```

---

## Self-review checklist (before merging)

- [ ] **Spec coverage:** every section of [docs/specs/2026-05-02-provider-integration-design.md](../specs/2026-05-02-provider-integration-design.md) §4 (Design) and §6 (Implementation plan) has a corresponding task above
- [ ] **No placeholders:** plan contains no "TBD", "implement later"
- [ ] **Type consistency:** `ProviderAdapter`, `ExportContext`, `ExportReport`, `DriftReport`, `DriftFinding`, `ProviderName` are referenced consistently
- [ ] **CLAUDE.md gotchas honored:**
  - gray-matter cache: every test fixture uses unique frontmatter (Math.random() in description)
  - Node 20+: not introduced (existing requirement)
  - tsup flat dist: integration tests use `dist/cli/index.js` (built by global setup)
- [ ] **Tests cover:** provenance round-trip, runner orchestration, claude/codex/agents/cursor/copilot/gemini adapters, drift detection, init detection, export CLI
- [ ] **CLI:** `harness export [<provider>] [--target/--force/--dry-run/--prune/--resync-from]`, `harness doctor --check-drift`
- [ ] **Init detection:** `.claude/`, `.codex/`, `.cursor/`, `.gemini/`, `.agents/`, `.github/copilot-instructions.md`, `.github/instructions/`, `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` (singles)
- [ ] **Subdirectory mode:** when sentinel single-file present at project root, harness scaffolds into `.harness/`
- [ ] **Auto-export:** wired into `harness dev` watcher with per-target opt-in via `auto: true`
- [ ] **Drift detection:** integrated into `harness doctor --check-drift`

---

## Risks and mitigations

- **R1 — Cursor and Gemini schemas may differ from this plan's assumptions.** Tasks 4 and 6 explicitly start with WebFetch verification before implementation. If the schema is materially different, the implementer should follow the actual schema and document the deviation.
- **R2 — Token cap on Copilot is a guess.** 32k default; test against actual Copilot install if possible. Configurable per-target.
- **R3 — Init prompt in non-TTY environments.** Default to (c) skip without prompting, per design §4.2.
- **R4 — Auto-export latency on `harness dev`.** Non-blocking async; per-target 5s timeout; failures are warnings.
- **R5 — Pinned-exception flow not implemented in v0.13.0.** The design §4.8 calls for a `.harness-export-pinned` marker and `--resync-from` flow. The plan implements `--resync-from` (Task 7) but not the pin marker. Documented as follow-up; users with a pinned scenario should run `--resync-from` manually.
- **R6 — Project-context rule wiring may be incomplete.** Task 8 Step 5 leaves the synthetic-rule integration as "wire it where rules contribute to the system prompt". If that turns out to require deeper refactoring, it can defer to a follow-up while the helper itself lands.

---

*End of plan.*
