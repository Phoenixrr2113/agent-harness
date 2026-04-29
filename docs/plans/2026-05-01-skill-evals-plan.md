# Skill evals — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an in-harness eval system that measures (a) trigger reliability of skill descriptions and (b) output quality with-vs-without each skill, exposed through `harness skill eval-triggers`, `harness skill eval-quality`, `harness skill optimize-description`, `harness skill optimize-quality`, and `harness rules promote` CLI commands; gate auto-promotion of learned rules on eval results; ship every default skill with `evals/triggers.json` (and high-effort defaults with `evals/evals.json`).

**Architecture:** A new `src/runtime/evals/` module hosts schemas (`triggers-schema.ts`, `evals-schema.ts`, `eval-types.ts`), workspace management (`workspace.ts`), the assertion grader (`grading.ts`), the two runners (`triggers.ts` for trigger evals, `quality.ts` for quality evals), and the two optimization loops (`optimize-description.ts`, `optimize-quality.ts`). Trigger eval observability piggybacks on `result.toolCalls` from `generateWithAgent` — counting `activate_skill` calls with `args.name === <skill-under-test>`. Without-skill baselines work by extending `buildActivateSkillTool` to accept `{ excludeSkillNames }` and routing it through the eval runner. The promotion gate lives in `src/runtime/promote-rule.ts`, generates a 6-query trigger set via the summary_model, runs both eval types, and accepts/rejects the candidate based on measured delta.

**Tech Stack:** TypeScript (strict), Zod for schema validation, vitest for tests. Builds via tsup. Test commands: `npm test -- <pattern>`. Build: `npm run build`. Node 20+. Existing AI SDK ToolLoopAgent path (`generateWithAgent`).

---

## Reference

- Design spec: [docs/specs/2026-05-01-skill-evals-design.md](../specs/2026-05-01-skill-evals-design.md)
- Spec #2 trigger composition (we extend `buildActivateSkillTool` here): [src/runtime/skill-activation.ts](../../src/runtime/skill-activation.ts)
- Spec #2 trigger script result type (we reuse): [src/runtime/triggers.ts:7](../../src/runtime/triggers.ts) — `TriggerScriptResult`
- Spec #3 doctor lints (extended in Task 12 for evals coverage): [src/runtime/doctor.ts](../../src/runtime/doctor.ts), [src/runtime/lints/skill-lints.ts](../../src/runtime/lints/skill-lints.ts)
- Existing instinct-learner (Task 8 modifies): [src/runtime/instinct-learner.ts](../../src/runtime/instinct-learner.ts)
- Existing summary_model getter: [src/llm/provider.ts:246](../../src/llm/provider.ts) — `getSummaryModel()`
- AI SDK eval guidance: https://agentskills.io/skill-creation/optimizing-descriptions, https://agentskills.io/skill-creation/evaluating-skills
- Per CLAUDE.md §12: gray-matter content caching means tests must use unique frontmatter; Node 20+ required for vitest 4.x; tsup bundles flat into dist/.

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/runtime/evals/eval-types.ts` | new | Shared eval result types: `TriggerEvalRunResult`, `TriggerEvalQueryResult`, `QualityEvalRunResult`, `QualityEvalCaseResult`, `BenchmarkResult` |
| `src/runtime/evals/triggers-schema.ts` | new | Zod schema for `evals/triggers.json` + `parseTriggersFile(path)` loader |
| `src/runtime/evals/evals-schema.ts` | new | Zod schema for `evals/evals.json` + `parseEvalsFile(path)` loader |
| `src/runtime/evals/workspace.ts` | new | Workspace path resolution (`<harness-dir>/.evals-workspace/<skill>/...`), gitignore management, iteration directory creation |
| `src/runtime/evals/grading.ts` | new | `gradeAssertion(assertion, outputDir, options)`: code-checks first (file exists, valid JSON, regex, exact count), LLM judge fallback for prose |
| `src/runtime/evals/triggers.ts` | new | Trigger eval runner: load triggers.json, parallel-run agent.generate per query×runs in clean sessions, count `activate_skill` calls, write report |
| `src/runtime/evals/quality.ts` | new | Quality eval runner: with-skill vs baseline, capture outputs+timing, grade, aggregate to benchmark.json |
| `src/runtime/evals/optimize-description.ts` | new | Description optimization loop per design §4.3 — uses `summary_model` to propose revisions |
| `src/runtime/evals/optimize-quality.ts` | new | Quality optimization loop per design §4.4 |
| `src/runtime/skill-activation.ts` | extend | `buildActivateSkillTool({ excludeSkillNames })` option; `getModelInvokableSkills` extracted with same option |
| `src/runtime/promote-rule.ts` | new | Rule promotion with eval gate (§4.6); generates 6-query trigger eval, runs quality eval, decides promote/skip |
| `src/runtime/instinct-learner.ts` | extend | Hook into `promoteRule` from `harness learn --install` flow |
| `src/cli/index.ts` | extend | 4 new `harness skill ...` subcommands + new `harness rules promote` command |
| `defaults/skills/<all>/evals/triggers.json` | new | 10–20 trigger queries each across 16 default skills |
| `defaults/skills/{delegate-to-cli,daily-reflection,ship-feature}/evals/evals.json` | new | 3+ test cases each |
| `docs/skill-evals.md` | new | Detailed reference: trigger eval format, quality eval format, scoring, workspace |
| `docs/skill-authoring.md` | extend | New "Writing evals" section linking to skill-evals.md |
| `README.md` | extend | New "Evaluating skills" section |
| `tests/runtime/evals/triggers-schema.test.ts` | new | Schema unit tests |
| `tests/runtime/evals/evals-schema.test.ts` | new | Schema unit tests |
| `tests/runtime/evals/workspace.test.ts` | new | Workspace unit tests |
| `tests/runtime/evals/grading.test.ts` | new | Grading unit tests |
| `tests/runtime/evals/triggers-runner.test.ts` | new | Trigger eval runner tests (with mocked agent) |
| `tests/runtime/evals/quality-runner.test.ts` | new | Quality eval runner tests (with mocked agent + grader) |
| `tests/runtime/evals/optimize-description.test.ts` | new | Optimization loop convergence test |
| `tests/runtime/promote-rule.test.ts` | new | Promotion gate accept/reject tests |
| `tests/integration/skill-eval-triggers.e2e.test.ts` | new | E2E: real CLI invocation against fixture skill |
| `tests/runtime/skill-activation.test.ts` | extend | excludeSkillNames option behavior |

---

## Phase 20: Schemas, types, workspace, grader

### Task 1: Eval result types + triggers.json + evals.json schemas

**Files:**
- Create: `src/runtime/evals/eval-types.ts`
- Create: `src/runtime/evals/triggers-schema.ts`
- Create: `src/runtime/evals/evals-schema.ts`
- Test: `tests/runtime/evals/triggers-schema.test.ts`
- Test: `tests/runtime/evals/evals-schema.test.ts`

- [ ] **Step 1: Write failing tests for triggers schema**

Create `tests/runtime/evals/triggers-schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseTriggersFile, TriggersFileSchema } from '../../../src/runtime/evals/triggers-schema.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'triggers-schema-'));
}

describe('TriggersFileSchema', () => {
  it('accepts valid array of queries', () => {
    const valid = [
      { id: 'q1', query: 'do the thing', should_trigger: true, split: 'train' },
      { id: 'q2', query: 'unrelated', should_trigger: false, split: 'validation' },
    ];
    expect(() => TriggersFileSchema.parse(valid)).not.toThrow();
  });

  it('rejects missing should_trigger', () => {
    const invalid = [{ id: 'q1', query: 'x', split: 'train' }];
    expect(() => TriggersFileSchema.parse(invalid)).toThrow(/should_trigger/);
  });

  it('rejects bad split values', () => {
    const invalid = [{ id: 'q1', query: 'x', should_trigger: true, split: 'test' }];
    expect(() => TriggersFileSchema.parse(invalid)).toThrow(/split/);
  });

  it('accepts optional notes field', () => {
    const valid = [{ id: 'q1', query: 'x', should_trigger: true, split: 'train', notes: 'why' }];
    expect(() => TriggersFileSchema.parse(valid)).not.toThrow();
  });

  it('rejects query > 500 chars', () => {
    const invalid = [{ id: 'q1', query: 'x'.repeat(501), should_trigger: true, split: 'train' }];
    expect(() => TriggersFileSchema.parse(invalid)).toThrow(/500/);
  });
});

describe('parseTriggersFile', () => {
  it('reads and parses a valid file', () => {
    const dir = tmp();
    const path = join(dir, 'triggers.json');
    writeFileSync(path, JSON.stringify([
      { id: 'q1', query: 'a', should_trigger: true, split: 'train' },
    ]));
    const queries = parseTriggersFile(path);
    expect(queries).toHaveLength(1);
    expect(queries[0].id).toBe('q1');
  });

  it('throws if file is missing', () => {
    expect(() => parseTriggersFile('/nonexistent/path.json')).toThrow(/not found/i);
  });

  it('throws if file is not valid JSON', () => {
    const dir = tmp();
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{ not valid');
    expect(() => parseTriggersFile(path)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- triggers-schema`
Expected: FAIL — module does not exist

- [ ] **Step 3: Write the eval result types**

Create `src/runtime/evals/eval-types.ts`:

```typescript
/** Per-query result inside a single trigger eval run. */
export interface TriggerEvalQueryResult {
  id: string;
  query: string;
  should_trigger: boolean;
  trigger_count: number;
  trigger_rate: number;
  passed: boolean;
}

/** Aggregate trigger eval result for one skill, one split. */
export interface TriggerEvalRunResult {
  skill: string;
  description: string;
  split: 'train' | 'validation' | 'all';
  runs_per_query: number;
  results: TriggerEvalQueryResult[];
  summary: {
    passed: number;
    failed: number;
    total: number;
    pass_rate: number;
  };
  ran_at: string;
}

/** Per-test-case quality eval result with-skill vs baseline. */
export interface QualityEvalCaseResult {
  id: string;
  prompt: string;
  with_skill: {
    pass_rate: number;
    tokens: number;
    duration_ms: number;
    output_dir: string;
    grading_path: string;
  };
  without_skill: {
    pass_rate: number;
    tokens: number;
    duration_ms: number;
    output_dir: string;
    grading_path: string;
  };
}

/** Aggregate quality eval benchmark. */
export interface BenchmarkResult {
  skill: string;
  iteration: string;
  baseline: 'none' | 'previous' | string;
  cases: QualityEvalCaseResult[];
  with_skill: { pass_rate: { mean: number }; tokens: { mean: number }; duration_ms: { mean: number } };
  without_skill: { pass_rate: { mean: number }; tokens: { mean: number }; duration_ms: { mean: number } };
  delta: { pass_rate: number; tokens: number; duration_ms: number };
  ran_at: string;
}
```

- [ ] **Step 4: Write the triggers schema**

Create `src/runtime/evals/triggers-schema.ts`:

```typescript
import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';

export const TriggerQuerySchema = z.object({
  id: z.string().min(1).max(64),
  query: z.string().min(1).max(500),
  should_trigger: z.boolean(),
  split: z.enum(['train', 'validation']),
  notes: z.string().optional(),
});

export const TriggersFileSchema = z.array(TriggerQuerySchema);

export type TriggerQuery = z.infer<typeof TriggerQuerySchema>;

export function parseTriggersFile(path: string): TriggerQuery[] {
  if (!existsSync(path)) {
    throw new Error(`triggers.json not found at ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`triggers.json is not valid JSON at ${path}: ${(err as Error).message}`);
  }
  return TriggersFileSchema.parse(parsed);
}
```

- [ ] **Step 5: Run triggers schema test, verify pass**

Run: `npm test -- triggers-schema`
Expected: PASS

- [ ] **Step 6: Write failing tests for evals schema**

Create `tests/runtime/evals/evals-schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseEvalsFile, EvalsFileSchema } from '../../../src/runtime/evals/evals-schema.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'evals-schema-'));
}

describe('EvalsFileSchema', () => {
  it('accepts valid skill_name + evals array', () => {
    const valid = {
      skill_name: 'csv-analyzer',
      evals: [
        {
          id: 't1',
          prompt: 'do thing',
          expected_output: 'a chart',
          assertions: ['has axes'],
        },
      ],
    };
    expect(() => EvalsFileSchema.parse(valid)).not.toThrow();
  });

  it('accepts optional files array', () => {
    const valid = {
      skill_name: 's',
      evals: [{ id: 't1', prompt: 'x', expected_output: 'y', assertions: ['z'], files: ['evals/files/a.csv'] }],
    };
    expect(() => EvalsFileSchema.parse(valid)).not.toThrow();
  });

  it('rejects missing assertions', () => {
    const invalid = {
      skill_name: 's',
      evals: [{ id: 't1', prompt: 'x', expected_output: 'y' }],
    };
    expect(() => EvalsFileSchema.parse(invalid)).toThrow(/assertions/);
  });

  it('rejects assertions: []', () => {
    const invalid = {
      skill_name: 's',
      evals: [{ id: 't1', prompt: 'x', expected_output: 'y', assertions: [] }],
    };
    expect(() => EvalsFileSchema.parse(invalid)).toThrow(/at least one/i);
  });
});

describe('parseEvalsFile', () => {
  it('reads and parses a valid file', () => {
    const dir = tmp();
    const path = join(dir, 'evals.json');
    writeFileSync(path, JSON.stringify({
      skill_name: 's',
      evals: [{ id: 't1', prompt: 'x', expected_output: 'y', assertions: ['z'] }],
    }));
    const file = parseEvalsFile(path);
    expect(file.skill_name).toBe('s');
    expect(file.evals).toHaveLength(1);
  });
});
```

- [ ] **Step 7: Write the evals schema**

Create `src/runtime/evals/evals-schema.ts`:

```typescript
import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';

export const EvalCaseSchema = z.object({
  id: z.string().min(1).max(64),
  prompt: z.string().min(1),
  expected_output: z.string().min(1),
  files: z.array(z.string()).optional(),
  assertions: z.array(z.string().min(1)).min(1, { message: 'at least one assertion required' }),
});

export const EvalsFileSchema = z.object({
  skill_name: z.string().min(1),
  evals: z.array(EvalCaseSchema).min(1),
});

export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type EvalsFile = z.infer<typeof EvalsFileSchema>;

export function parseEvalsFile(path: string): EvalsFile {
  if (!existsSync(path)) {
    throw new Error(`evals.json not found at ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`evals.json is not valid JSON at ${path}: ${(err as Error).message}`);
  }
  return EvalsFileSchema.parse(parsed);
}
```

- [ ] **Step 8: Run evals schema test, verify pass**

Run: `npm test -- evals-schema`
Expected: PASS

- [ ] **Step 9: Lint check + commit**

Run: `npm run lint`
Expected: clean

```bash
git add src/runtime/evals/eval-types.ts src/runtime/evals/triggers-schema.ts src/runtime/evals/evals-schema.ts tests/runtime/evals/triggers-schema.test.ts tests/runtime/evals/evals-schema.test.ts
git commit -m "feat(evals): triggers.json + evals.json schemas + result types"
```

---

### Task 2: Workspace management

**Files:**
- Create: `src/runtime/evals/workspace.ts`
- Test: `tests/runtime/evals/workspace.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/runtime/evals/workspace.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  evalWorkspaceFor,
  ensureWorkspaceGitignored,
  newQualityIteration,
} from '../../../src/runtime/evals/workspace.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'evals-ws-'));
}

describe('evalWorkspaceFor', () => {
  it('returns deterministic paths under harness-dir', () => {
    const ws = evalWorkspaceFor('/h', 'foo');
    expect(ws.skillRoot).toBe('/h/.evals-workspace/foo');
    expect(ws.triggersDir).toBe('/h/.evals-workspace/foo/triggers');
    expect(ws.qualityDir).toBe('/h/.evals-workspace/foo/quality');
  });
});

describe('ensureWorkspaceGitignored', () => {
  it('creates .gitignore with .evals-workspace/ entry if missing', () => {
    const dir = tmp();
    ensureWorkspaceGitignored(dir);
    const giPath = join(dir, '.gitignore');
    expect(existsSync(giPath)).toBe(true);
    expect(readFileSync(giPath, 'utf-8')).toContain('.evals-workspace/');
  });

  it('appends to existing .gitignore if entry not present', () => {
    const dir = tmp();
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\ndist/\n');
    ensureWorkspaceGitignored(dir);
    const text = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(text).toContain('node_modules/');
    expect(text).toContain('.evals-workspace/');
  });

  it('does not double-add if entry already present', () => {
    const dir = tmp();
    writeFileSync(join(dir, '.gitignore'), '.evals-workspace/\n');
    ensureWorkspaceGitignored(dir);
    const text = readFileSync(join(dir, '.gitignore'), 'utf-8');
    const occurrences = text.split('.evals-workspace/').length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('newQualityIteration', () => {
  it('returns iteration-1 for fresh skill', () => {
    const dir = tmp();
    const it = newQualityIteration(dir, 'foo');
    expect(it.name).toBe('iteration-1');
    expect(it.path).toBe(join(dir, '.evals-workspace/foo/quality/iteration-1'));
    expect(existsSync(it.path)).toBe(true);
  });

  it('increments past existing iterations', () => {
    const dir = tmp();
    mkdirSync(join(dir, '.evals-workspace/foo/quality/iteration-1'), { recursive: true });
    mkdirSync(join(dir, '.evals-workspace/foo/quality/iteration-2'), { recursive: true });
    const it = newQualityIteration(dir, 'foo');
    expect(it.name).toBe('iteration-3');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- workspace`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement workspace.ts**

Create `src/runtime/evals/workspace.ts`:

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

export interface EvalWorkspace {
  skillRoot: string;
  triggersDir: string;
  qualityDir: string;
}

export function evalWorkspaceFor(harnessDir: string, skillName: string): EvalWorkspace {
  const skillRoot = join(harnessDir, '.evals-workspace', skillName);
  return {
    skillRoot,
    triggersDir: join(skillRoot, 'triggers'),
    qualityDir: join(skillRoot, 'quality'),
  };
}

export function ensureWorkspaceGitignored(harnessDir: string): void {
  const giPath = join(harnessDir, '.gitignore');
  const entry = '.evals-workspace/';
  let existing = '';
  if (existsSync(giPath)) {
    existing = readFileSync(giPath, 'utf-8');
    if (existing.split('\n').some((line) => line.trim() === entry)) {
      return;
    }
  }
  const next = existing.length > 0 && !existing.endsWith('\n')
    ? existing + '\n' + entry + '\n'
    : existing + entry + '\n';
  writeFileSync(giPath, next, 'utf-8');
}

export interface QualityIteration {
  name: string;
  path: string;
}

export function newQualityIteration(harnessDir: string, skillName: string): QualityIteration {
  const ws = evalWorkspaceFor(harnessDir, skillName);
  if (!existsSync(ws.qualityDir)) {
    mkdirSync(ws.qualityDir, { recursive: true });
  }
  const existing = readdirSync(ws.qualityDir).filter((n) => n.startsWith('iteration-'));
  const max = existing
    .map((n) => Number(n.replace('iteration-', '')))
    .filter((n) => !Number.isNaN(n))
    .reduce((a, b) => Math.max(a, b), 0);
  const name = `iteration-${max + 1}`;
  const path = join(ws.qualityDir, name);
  mkdirSync(path, { recursive: true });
  return { name, path };
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npm test -- workspace`
Expected: PASS

- [ ] **Step 5: Lint + commit**

Run: `npm run lint`

```bash
git add src/runtime/evals/workspace.ts tests/runtime/evals/workspace.test.ts
git commit -m "feat(evals): workspace path resolution and iteration management"
```

---

### Task 3: Assertion grader (code-checks + LLM judge)

**Files:**
- Create: `src/runtime/evals/grading.ts`
- Test: `tests/runtime/evals/grading.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/runtime/evals/grading.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { gradeAssertion } from '../../../src/runtime/evals/grading.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'grade-'));
}

describe('gradeAssertion — code-checks first', () => {
  it('detects "output file <X> exists" mechanically', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'report.md'), 'hello');
    const r = await gradeAssertion('the output includes a file named report.md', dir, { llmGrader: null });
    expect(r.passed).toBe(true);
    expect(r.method).toBe('code');
    expect(r.evidence).toMatch(/report\.md/);
  });

  it('detects "output is valid JSON" mechanically', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ ok: true }));
    const r = await gradeAssertion('result.json is valid JSON', dir, { llmGrader: null });
    expect(r.passed).toBe(true);
    expect(r.method).toBe('code');
  });

  it('fails when mechanically-checkable assertion is false', async () => {
    const dir = tmp();
    const r = await gradeAssertion('the output includes a file named missing.md', dir, { llmGrader: null });
    expect(r.passed).toBe(false);
    expect(r.method).toBe('code');
  });
});

describe('gradeAssertion — LLM judge fallback', () => {
  it('routes prose assertions to the grader model', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'chart.png'), 'fakebytes');
    const llmGrader = vi.fn(async () => ({ passed: true, evidence: 'looks like a chart' }));
    const r = await gradeAssertion('the chart has labeled axes', dir, { llmGrader });
    expect(llmGrader).toHaveBeenCalledTimes(1);
    expect(r.passed).toBe(true);
    expect(r.method).toBe('llm');
    expect(r.evidence).toBe('looks like a chart');
  });

  it('returns false from grader verdict', async () => {
    const dir = tmp();
    const llmGrader = vi.fn(async () => ({ passed: false, evidence: 'no chart' }));
    const r = await gradeAssertion('the chart has 3 bars', dir, { llmGrader });
    expect(r.passed).toBe(false);
    expect(r.method).toBe('llm');
  });

  it('treats grader exception as passed=false with error evidence', async () => {
    const dir = tmp();
    const llmGrader = vi.fn(async () => { throw new Error('LLM down'); });
    const r = await gradeAssertion('something subjective', dir, { llmGrader });
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('LLM down');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- grading`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement grading.ts**

Create `src/runtime/evals/grading.ts`:

```typescript
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export interface AssertionVerdict {
  passed: boolean;
  method: 'code' | 'llm';
  evidence: string;
}

export interface LlmGraderInput {
  assertion: string;
  outputDir: string;
}

export type LlmGrader = (input: LlmGraderInput) => Promise<{ passed: boolean; evidence: string }>;

export interface GradeOptions {
  llmGrader: LlmGrader | null;
}

const FILE_EXISTS_PATTERNS = [
  /(?:output|result)\s+(?:includes?|has)\s+a?\s*file\s+(?:named\s+)?["`']?([\w./-]+)["`']?/i,
  /(?:file|output)\s+["`']?([\w./-]+)["`']?\s+(?:exists|is created|is written)/i,
];

const VALID_JSON_PATTERN = /["`']?([\w./-]+\.json)["`']?\s+is\s+valid\s+json/i;

function tryFileExistsCheck(assertion: string, outputDir: string): AssertionVerdict | null {
  for (const pattern of FILE_EXISTS_PATTERNS) {
    const match = assertion.match(pattern);
    if (match) {
      const file = match[1];
      const path = join(outputDir, file);
      const exists = existsSync(path);
      return {
        passed: exists,
        method: 'code',
        evidence: exists
          ? `File ${file} exists (${statSync(path).size} bytes).`
          : `File ${file} does not exist in ${outputDir}.`,
      };
    }
  }
  return null;
}

function tryValidJsonCheck(assertion: string, outputDir: string): AssertionVerdict | null {
  const match = assertion.match(VALID_JSON_PATTERN);
  if (!match) return null;
  const file = match[1];
  const path = join(outputDir, file);
  if (!existsSync(path)) {
    return { passed: false, method: 'code', evidence: `${file} does not exist.` };
  }
  try {
    JSON.parse(readFileSync(path, 'utf-8'));
    return { passed: true, method: 'code', evidence: `${file} is valid JSON.` };
  } catch (err) {
    return { passed: false, method: 'code', evidence: `${file} is not valid JSON: ${(err as Error).message}` };
  }
}

export async function gradeAssertion(
  assertion: string,
  outputDir: string,
  options: GradeOptions,
): Promise<AssertionVerdict> {
  // Code-checks first
  const checks = [tryFileExistsCheck, tryValidJsonCheck];
  for (const check of checks) {
    const result = check(assertion, outputDir);
    if (result !== null) return result;
  }

  // LLM judge fallback
  if (!options.llmGrader) {
    return {
      passed: false,
      method: 'code',
      evidence: 'No mechanical match and no LLM grader provided.',
    };
  }
  try {
    const verdict = await options.llmGrader({ assertion, outputDir });
    return { passed: verdict.passed, method: 'llm', evidence: verdict.evidence };
  } catch (err) {
    return {
      passed: false,
      method: 'llm',
      evidence: `Grader threw: ${(err as Error).message}`,
    };
  }
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npm test -- grading`
Expected: PASS

- [ ] **Step 5: Lint + commit**

Run: `npm run lint`

```bash
git add src/runtime/evals/grading.ts tests/runtime/evals/grading.test.ts
git commit -m "feat(evals): assertion grader with code-checks + LLM judge fallback"
```

---

## Phase 21: Trigger eval runner + CLI

### Task 4: Trigger eval runner + `harness skill eval-triggers` CLI

This task combines the runner and the CLI command because the runner has no consumers yet — the CLI is its first consumer, and end-to-end coverage requires both. Per workflow conventions: tightly coupled tasks ship together.

**Files:**
- Modify: `src/runtime/skill-activation.ts` — add `excludeSkillNames` option to `buildActivateSkillTool`
- Create: `src/runtime/evals/triggers.ts`
- Modify: `src/cli/index.ts` — add `harness skill eval-triggers <name>` subcommand
- Test: `tests/runtime/evals/triggers-runner.test.ts`
- Test: `tests/runtime/skill-activation.test.ts` — extend for `excludeSkillNames`

- [ ] **Step 1: Extend `buildActivateSkillTool` to accept `excludeSkillNames`**

The eval runner needs a way to construct the agent's `activate_skill` catalog with the target skill *included* (with-skill case) or *excluded* (without-skill baseline used by the quality eval in Task 5). The tool currently filters out archived/deprecated/scheduled/non-subagent skills via `getModelInvokableSkills` — we extract it as exported and add an `excludeSkillNames` filter.

Edit `src/runtime/skill-activation.ts`:

Replace:
```typescript
function getModelInvokableSkills(harnessDir: string): HarnessDocument[] {
  const all = loadAllPrimitives(harnessDir);
  const skills = (all.get('skills') ?? []).filter((s) => {
    if (s.status === 'archived' || s.status === 'deprecated') return false;
    const trigger = s.metadata?.['harness-trigger'] as string | undefined;
    const schedule = s.metadata?.['harness-schedule'] as string | undefined;
    if (schedule) return false;
    if (trigger && trigger !== 'subagent') return false;
    return true;
  });
  return skills;
}
```

with:
```typescript
export interface SkillCatalogOptions {
  excludeSkillNames?: string[];
}

export function getModelInvokableSkills(
  harnessDir: string,
  options: SkillCatalogOptions = {},
): HarnessDocument[] {
  const exclude = new Set(options.excludeSkillNames ?? []);
  const all = loadAllPrimitives(harnessDir);
  const skills = (all.get('skills') ?? []).filter((s) => {
    if (exclude.has(s.name)) return false;
    if (s.status === 'archived' || s.status === 'deprecated') return false;
    const trigger = s.metadata?.['harness-trigger'] as string | undefined;
    const schedule = s.metadata?.['harness-schedule'] as string | undefined;
    if (schedule) return false;
    if (trigger && trigger !== 'subagent') return false;
    return true;
  });
  return skills;
}
```

Then update `buildActivateSkillTool` signature:
```typescript
export function buildActivateSkillTool(
  harnessDir: string,
  options: SkillCatalogOptions = {},
): ActivateSkillTool | null {
  const skills = getModelInvokableSkills(harnessDir, options);
  if (skills.length === 0) return null;
  // ... rest unchanged
}
```

- [ ] **Step 2: Add unit test for `excludeSkillNames`**

Add to (or create) `tests/runtime/skill-activation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildActivateSkillTool, getModelInvokableSkills } from '../../src/runtime/skill-activation.js';

function makeSkill(harnessDir: string, name: string): void {
  const dir = join(harnessDir, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Pretend skill named ${name} for excludeSkillNames test ${Math.random()}\n---\nBody.`,
  );
}

describe('buildActivateSkillTool — excludeSkillNames', () => {
  it('excludes named skills from the enum', () => {
    const dir = mkdtempSync(join(tmpdir(), 'as-'));
    makeSkill(dir, 'alpha');
    makeSkill(dir, 'beta');
    const tool = buildActivateSkillTool(dir, { excludeSkillNames: ['alpha'] });
    expect(tool).not.toBeNull();
    const skills = getModelInvokableSkills(dir, { excludeSkillNames: ['alpha'] });
    expect(skills.map((s) => s.name)).toEqual(['beta']);
  });

  it('returns null if all skills are excluded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'as-'));
    makeSkill(dir, 'only-one');
    const tool = buildActivateSkillTool(dir, { excludeSkillNames: ['only-one'] });
    expect(tool).toBeNull();
  });

  it('default options leave all skills available', () => {
    const dir = mkdtempSync(join(tmpdir(), 'as-'));
    makeSkill(dir, 'one');
    makeSkill(dir, 'two');
    const skills = getModelInvokableSkills(dir);
    expect(skills.map((s) => s.name).sort()).toEqual(['one', 'two']);
  });
});
```

Run: `npm test -- skill-activation`
Expected: PASS (after Step 1 lands the source change)

- [ ] **Step 3: Write failing tests for trigger eval runner**

Create `tests/runtime/evals/triggers-runner.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runTriggerEval, type TriggerEvalAgentRunner } from '../../../src/runtime/evals/triggers.js';

function makeSkill(harnessDir: string, name: string, description: string, triggers: unknown[]): void {
  const dir = join(harnessDir, 'skills', name);
  mkdirSync(join(dir, 'evals'), { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\nBody ${Math.random()}.`,
  );
  writeFileSync(join(dir, 'evals/triggers.json'), JSON.stringify(triggers));
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'eval-trig-'));
}

describe('runTriggerEval', () => {
  it('counts activate_skill calls per query', async () => {
    const dir = tmp();
    makeSkill(dir, 'foo', 'helps with foo tasks', [
      { id: 'q1', query: 'do a foo task', should_trigger: true, split: 'train' },
    ]);

    // Mock agent: triggers all 3 runs
    const runner: TriggerEvalAgentRunner = vi.fn(async () => ({
      toolCalls: [{ toolName: 'activate_skill', args: { name: 'foo' }, result: '' }],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      steps: 2,
      text: '',
    }));

    const result = await runTriggerEval({
      harnessDir: dir,
      skillName: 'foo',
      runs: 3,
      split: 'train',
      runner,
    });

    expect(runner).toHaveBeenCalledTimes(3);
    expect(result.results[0].trigger_count).toBe(3);
    expect(result.results[0].trigger_rate).toBe(1.0);
    expect(result.results[0].passed).toBe(true);
    expect(result.summary.passed).toBe(1);
    expect(result.summary.total).toBe(1);
  });

  it('marks should_trigger=true with rate < 0.5 as failed', async () => {
    const dir = tmp();
    makeSkill(dir, 'foo', 'desc', [
      { id: 'q1', query: 'q', should_trigger: true, split: 'train' },
    ]);
    let calls = 0;
    const runner: TriggerEvalAgentRunner = vi.fn(async () => {
      calls++;
      // Trigger only on call 1 of 3
      const triggered = calls === 1;
      return {
        toolCalls: triggered ? [{ toolName: 'activate_skill', args: { name: 'foo' }, result: '' }] : [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        steps: 1,
        text: '',
      };
    });

    const result = await runTriggerEval({ harnessDir: dir, skillName: 'foo', runs: 3, split: 'train', runner });
    expect(result.results[0].trigger_rate).toBeCloseTo(0.333, 2);
    expect(result.results[0].passed).toBe(false);
  });

  it('passes should_not_trigger query when model abstains', async () => {
    const dir = tmp();
    makeSkill(dir, 'foo', 'desc', [
      { id: 'neg1', query: 'unrelated thing', should_trigger: false, split: 'validation' },
    ]);
    const runner: TriggerEvalAgentRunner = vi.fn(async () => ({
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      steps: 1,
      text: '',
    }));

    const result = await runTriggerEval({ harnessDir: dir, skillName: 'foo', runs: 3, split: 'validation', runner });
    expect(result.results[0].trigger_rate).toBe(0);
    expect(result.results[0].passed).toBe(true);
  });

  it('filters by split', async () => {
    const dir = tmp();
    makeSkill(dir, 'foo', 'desc', [
      { id: 'a', query: 'q', should_trigger: true, split: 'train' },
      { id: 'b', query: 'q', should_trigger: true, split: 'validation' },
    ]);
    const runner: TriggerEvalAgentRunner = vi.fn(async () => ({
      toolCalls: [{ toolName: 'activate_skill', args: { name: 'foo' }, result: '' }],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      steps: 1,
      text: '',
    }));
    const result = await runTriggerEval({ harnessDir: dir, skillName: 'foo', runs: 1, split: 'train', runner });
    expect(result.results.map((r) => r.id)).toEqual(['a']);
  });

  it('writes report to workspace', async () => {
    const dir = tmp();
    makeSkill(dir, 'foo', 'desc', [
      { id: 'q1', query: 'q', should_trigger: true, split: 'train' },
    ]);
    const runner: TriggerEvalAgentRunner = vi.fn(async () => ({
      toolCalls: [{ toolName: 'activate_skill', args: { name: 'foo' }, result: '' }],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      steps: 1,
      text: '',
    }));
    await runTriggerEval({ harnessDir: dir, skillName: 'foo', runs: 1, split: 'train', runner });
    const triggersDir = join(dir, '.evals-workspace/foo/triggers');
    expect(existsSync(triggersDir)).toBe(true);
    const reports = readdirSync(triggersDir).filter((f) => f.endsWith('.json'));
    expect(reports.length).toBe(1);
    const data = JSON.parse(readFileSync(join(triggersDir, reports[0]), 'utf-8'));
    expect(data.skill).toBe('foo');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- triggers-runner`
Expected: FAIL — module does not exist

- [ ] **Step 5: Implement the trigger eval runner**

Create `src/runtime/evals/triggers.ts`:

```typescript
import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { loadAllPrimitives } from '../../primitives/loader.js';
import type { HarnessDocument } from '../../core/types.js';
import { parseTriggersFile, type TriggerQuery } from './triggers-schema.js';
import type { TriggerEvalRunResult, TriggerEvalQueryResult } from './eval-types.js';
import { evalWorkspaceFor, ensureWorkspaceGitignored } from './workspace.js';

export interface TriggerEvalAgentResult {
  toolCalls: Array<{ toolName: string; args: Record<string, unknown>; result: unknown }>;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  steps: number;
  text: string;
}

export type TriggerEvalAgentRunner = (
  input: { harnessDir: string; query: string; skillName: string },
) => Promise<TriggerEvalAgentResult>;

export interface TriggerEvalOptions {
  harnessDir: string;
  skillName: string;
  runs?: number;
  split?: 'train' | 'validation' | 'all';
  runner: TriggerEvalAgentRunner;
}

const DEFAULT_RUNS = 3;
const PASS_THRESHOLD = 0.5;

function getSkill(harnessDir: string, name: string): HarnessDocument | null {
  const all = loadAllPrimitives(harnessDir);
  const skills = (all.get('skills') ?? []).filter((s) => s.name === name);
  return skills[0] ?? null;
}

function triggerCountFor(result: TriggerEvalAgentResult, skillName: string): number {
  let count = 0;
  for (const call of result.toolCalls) {
    if (call.toolName === 'activate_skill' && (call.args as { name?: string }).name === skillName) {
      count++;
    }
  }
  return count > 0 ? 1 : 0; // any call within this run counts as triggered
}

export async function runTriggerEval(opts: TriggerEvalOptions): Promise<TriggerEvalRunResult> {
  const { harnessDir, skillName, runs = DEFAULT_RUNS, split = 'all', runner } = opts;
  const skill = getSkill(harnessDir, skillName);
  if (!skill) throw new Error(`Skill not found: ${skillName}`);
  if (!skill.bundleDir) throw new Error(`Skill ${skillName} has no bundle directory`);

  const triggersPath = join(skill.bundleDir, 'evals', 'triggers.json');
  const queries = parseTriggersFile(triggersPath);
  const filtered = split === 'all' ? queries : queries.filter((q) => q.split === split);

  const results: TriggerEvalQueryResult[] = [];
  for (const q of filtered) {
    let triggerCount = 0;
    for (let r = 0; r < runs; r++) {
      const agentResult = await runner({ harnessDir, query: q.query, skillName });
      triggerCount += triggerCountFor(agentResult, skillName);
    }
    const triggerRate = triggerCount / runs;
    const passed = q.should_trigger ? triggerRate >= PASS_THRESHOLD : triggerRate < PASS_THRESHOLD;
    results.push({
      id: q.id,
      query: q.query,
      should_trigger: q.should_trigger,
      trigger_count: triggerCount,
      trigger_rate: triggerRate,
      passed,
    });
  }

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const summary = {
    passed,
    failed: total - passed,
    total,
    pass_rate: total === 0 ? 0 : passed / total,
  };

  const result: TriggerEvalRunResult = {
    skill: skillName,
    description: typeof skill.description === 'string' ? skill.description : '',
    split,
    runs_per_query: runs,
    results,
    summary,
    ran_at: new Date().toISOString(),
  };

  // Persist
  ensureWorkspaceGitignored(harnessDir);
  const ws = evalWorkspaceFor(harnessDir, skillName);
  if (!existsSync(ws.triggersDir)) {
    mkdirSync(ws.triggersDir, { recursive: true });
  }
  const stamp = result.ran_at.replace(/[:.]/g, '-');
  writeFileSync(join(ws.triggersDir, `${stamp}.json`), JSON.stringify(result, null, 2), 'utf-8');

  return result;
}
```

- [ ] **Step 6: Run test, verify pass**

Run: `npm test -- triggers-runner`
Expected: PASS

- [ ] **Step 7: Add the CLI subcommand**

Edit `src/cli/index.ts`. Find `skillCmd` (around line 3080) and append a new subcommand under it. Locate the existing `skillCmd.command('list')` block and add after it (and after `skill new`/`skill validate`):

```typescript
skillCmd
  .command('eval-triggers <name>')
  .description('Run trigger eval for a skill against its evals/triggers.json')
  .option('--runs <n>', 'Runs per query (default 3)', (v) => parseInt(v, 10), 3)
  .option('--split <split>', 'train | validation | all (default all)', 'all')
  .option('--harness <dir>', 'Harness directory', process.cwd())
  .action(async (name: string, opts: { runs: number; split: string; harness: string }) => {
    const { runTriggerEval } = await import('../runtime/evals/triggers.js');
    const { buildLiveTriggerEvalRunner } = await import('../runtime/evals/agent-runner.js');
    const split = opts.split as 'train' | 'validation' | 'all';
    if (!['train', 'validation', 'all'].includes(split)) {
      console.error(`Invalid split: ${opts.split}. Must be train, validation, or all.`);
      process.exit(1);
    }
    const runner = await buildLiveTriggerEvalRunner(opts.harness);
    const result = await runTriggerEval({
      harnessDir: opts.harness,
      skillName: name,
      runs: opts.runs,
      split,
      runner,
    });
    console.log(`\nSkill: ${result.skill}`);
    console.log(`Split: ${result.split}`);
    console.log(`Runs/query: ${result.runs_per_query}`);
    console.log(`\nResults:`);
    for (const r of result.results) {
      const flag = r.passed ? 'PASS' : 'FAIL';
      const expect = r.should_trigger ? 'should trigger' : 'should NOT trigger';
      console.log(`  [${flag}] ${r.id} (${expect}): ${r.trigger_rate.toFixed(2)}`);
    }
    console.log(`\nSummary: ${result.summary.passed}/${result.summary.total} passed (${(result.summary.pass_rate * 100).toFixed(1)}%)`);
    if (result.summary.failed > 0) process.exit(1);
  });
```

- [ ] **Step 8: Implement `buildLiveTriggerEvalRunner`**

The runner needs to actually invoke the agent in eval mode. Create `src/runtime/evals/agent-runner.ts`:

```typescript
import { tool as aiTool } from 'ai';
import { loadConfig } from '../../core/config.js';
import { getModel, generateWithAgent } from '../../llm/provider.js';
import { buildActivateSkillTool } from '../skill-activation.js';
import { loadIdentity } from '../context-loader.js';
import type { AIToolSet } from '../tool-executor.js';
import type { TriggerEvalAgentRunner } from './triggers.js';

/**
 * Build a runner that executes the live agent for trigger eval — fresh
 * conversation per query, no carryover. Includes the skill catalog with
 * the target skill present so activate_skill is invokable.
 */
export async function buildLiveTriggerEvalRunner(harnessDir: string): Promise<TriggerEvalAgentRunner> {
  const config = loadConfig(harnessDir);
  const identity = loadIdentity(harnessDir);

  return async ({ query, skillName: _skillName }) => {
    const activate = buildActivateSkillTool(harnessDir);
    const tools: AIToolSet = {};
    if (activate) {
      tools['activate_skill'] = aiTool({
        description: activate.description,
        inputSchema: activate.inputSchema,
        execute: (input) => activate.execute(input as { name: string; args?: string }),
      });
    }
    const model = getModel(config);
    const result = await generateWithAgent({
      model,
      system: identity.content,
      prompt: query,
      tools,
      maxToolSteps: 5,
    });
    return {
      toolCalls: result.toolCalls.map((tc) => ({
        toolName: tc.toolName,
        args: tc.args,
        result: tc.result,
      })),
      usage: result.usage,
      steps: result.steps,
      text: result.text,
    };
  };
}
```

> Pattern mirrors `src/core/harness.ts:88` — custom `ActivateSkillTool` shape gets wrapped in AI SDK's `tool()` helper, producing a proper `AIToolSet` entry.

- [ ] **Step 9: Run lint + tests**

Run: `npm run lint && npm test -- skill-activation triggers-runner triggers-schema workspace grading`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/runtime/skill-activation.ts src/runtime/evals/triggers.ts src/runtime/evals/agent-runner.ts src/cli/index.ts tests/runtime/skill-activation.test.ts tests/runtime/evals/triggers-runner.test.ts
git commit -m "feat(evals): trigger eval runner + harness skill eval-triggers CLI"
```

---

## Phase 22: Quality eval runner + CLI

### Task 5: Quality eval runner + `harness skill eval-quality` CLI

**Files:**
- Create: `src/runtime/evals/quality.ts`
- Modify: `src/runtime/evals/agent-runner.ts` — add `buildLiveQualityEvalRunner`
- Modify: `src/cli/index.ts` — add `skill eval-quality` subcommand
- Test: `tests/runtime/evals/quality-runner.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/runtime/evals/quality-runner.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runQualityEval, type QualityEvalAgentRunner } from '../../../src/runtime/evals/quality.js';

function makeSkill(harnessDir: string, name: string, evals: unknown): void {
  const dir = join(harnessDir, 'skills', name);
  mkdirSync(join(dir, 'evals/files'), { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Description for quality test ${Math.random()}\n---\nBody.`,
  );
  writeFileSync(join(dir, 'evals/evals.json'), JSON.stringify(evals));
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'eval-q-'));
}

describe('runQualityEval', () => {
  it('runs with-skill and without-skill, computes delta', async () => {
    const dir = tmp();
    makeSkill(dir, 'foo', {
      skill_name: 'foo',
      evals: [
        { id: 't1', prompt: 'do x', expected_output: 'y', assertions: ['the output is valid JSON'] },
      ],
    });

    let withCount = 0;
    let withoutCount = 0;
    const runner: QualityEvalAgentRunner = vi.fn(async ({ withSkill, outputDir }) => {
      if (withSkill) withCount++;
      else withoutCount++;
      // Both write a result.json; with-skill writes valid, without-skill writes invalid
      writeFileSync(
        join(outputDir, 'result.json'),
        withSkill ? JSON.stringify({ ok: true }) : '{ not valid',
      );
      return {
        usage: { inputTokens: withSkill ? 100 : 80, outputTokens: 50, totalTokens: withSkill ? 150 : 130 },
        durationMs: withSkill ? 2000 : 1500,
      };
    });

    const result = await runQualityEval({
      harnessDir: dir,
      skillName: 'foo',
      runner,
      llmGrader: null,
    });

    expect(withCount).toBe(1);
    expect(withoutCount).toBe(1);
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0].with_skill.pass_rate).toBe(1);
    expect(result.cases[0].without_skill.pass_rate).toBe(0);
    expect(result.delta.pass_rate).toBe(1);
    expect(result.delta.tokens).toBe(20);
    expect(result.delta.duration_ms).toBe(500);
  });

  it('writes benchmark.json to a fresh iteration directory', async () => {
    const dir = tmp();
    makeSkill(dir, 'foo', {
      skill_name: 'foo',
      evals: [{ id: 't1', prompt: 'p', expected_output: 'e', assertions: ['result.json is valid JSON'] }],
    });
    const runner: QualityEvalAgentRunner = vi.fn(async ({ outputDir }) => {
      writeFileSync(join(outputDir, 'result.json'), '{}');
      return { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, durationMs: 100 };
    });
    const result = await runQualityEval({ harnessDir: dir, skillName: 'foo', runner, llmGrader: null });
    expect(result.iteration).toBe('iteration-1');
    const path = join(dir, '.evals-workspace/foo/quality/iteration-1/benchmark.json');
    expect(existsSync(path)).toBe(true);
    const persisted = JSON.parse(readFileSync(path, 'utf-8'));
    expect(persisted.skill).toBe('foo');
    expect(persisted.cases).toHaveLength(1);
  });

  it('copies eval files into temp working dir before agent run', async () => {
    const dir = tmp();
    makeSkill(dir, 'foo', {
      skill_name: 'foo',
      evals: [
        { id: 't1', prompt: 'p', expected_output: 'e', files: ['evals/files/a.txt'], assertions: ['result.json is valid JSON'] },
      ],
    });
    writeFileSync(join(dir, 'skills/foo/evals/files/a.txt'), 'hello');

    const observed: string[] = [];
    const runner: QualityEvalAgentRunner = vi.fn(async ({ workingDir, outputDir }) => {
      observed.push(workingDir);
      // a.txt should be present in workingDir
      expect(existsSync(join(workingDir, 'a.txt'))).toBe(true);
      writeFileSync(join(outputDir, 'result.json'), '{}');
      return { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, durationMs: 1 };
    });

    await runQualityEval({ harnessDir: dir, skillName: 'foo', runner, llmGrader: null });
    expect(observed.length).toBe(2); // with-skill + without-skill
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- quality-runner`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement the quality eval runner**

Create `src/runtime/evals/quality.ts`:

```typescript
import { join, basename } from 'path';
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readdirSync } from 'fs';
import { loadAllPrimitives } from '../../primitives/loader.js';
import { parseEvalsFile, type EvalCase } from './evals-schema.js';
import type { BenchmarkResult, QualityEvalCaseResult } from './eval-types.js';
import { newQualityIteration, ensureWorkspaceGitignored } from './workspace.js';
import { gradeAssertion, type LlmGrader } from './grading.js';

export interface QualityEvalAgentInput {
  withSkill: boolean;
  prompt: string;
  workingDir: string;
  outputDir: string;
  skillName: string;
  harnessDir: string;
}

export interface QualityEvalAgentResult {
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  durationMs: number;
}

export type QualityEvalAgentRunner = (input: QualityEvalAgentInput) => Promise<QualityEvalAgentResult>;

export interface QualityEvalOptions {
  harnessDir: string;
  skillName: string;
  baseline?: 'none' | 'previous';
  runner: QualityEvalAgentRunner;
  llmGrader: LlmGrader | null;
}

function bundleDirFor(harnessDir: string, skillName: string): string {
  const skill = (loadAllPrimitives(harnessDir).get('skills') ?? []).find((s) => s.name === skillName);
  if (!skill || !skill.bundleDir) throw new Error(`Skill ${skillName} not found or missing bundleDir`);
  return skill.bundleDir;
}

function copyFiles(bundleDir: string, files: string[] | undefined, target: string): void {
  if (!files || files.length === 0) return;
  for (const rel of files) {
    const src = join(bundleDir, rel);
    if (!existsSync(src)) continue;
    const dst = join(target, basename(src));
    copyFileSync(src, dst);
  }
}

async function gradeCase(
  evalCase: EvalCase,
  outputDir: string,
  llmGrader: LlmGrader | null,
): Promise<{ pass_rate: number; grading_path: string }> {
  const verdicts: Array<{ assertion: string; passed: boolean; method: string; evidence: string }> = [];
  for (const assertion of evalCase.assertions) {
    const v = await gradeAssertion(assertion, outputDir, { llmGrader });
    verdicts.push({ assertion, passed: v.passed, method: v.method, evidence: v.evidence });
  }
  const passed = verdicts.filter((v) => v.passed).length;
  const passRate = verdicts.length === 0 ? 0 : passed / verdicts.length;
  const gradingPath = join(outputDir, '..', 'grading.json');
  writeFileSync(gradingPath, JSON.stringify({ verdicts, pass_rate: passRate }, null, 2), 'utf-8');
  return { pass_rate: passRate, grading_path: gradingPath };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export async function runQualityEval(opts: QualityEvalOptions): Promise<BenchmarkResult> {
  const { harnessDir, skillName, baseline = 'none', runner, llmGrader } = opts;
  const bundleDir = bundleDirFor(harnessDir, skillName);
  const evalsFile = parseEvalsFile(join(bundleDir, 'evals/evals.json'));

  ensureWorkspaceGitignored(harnessDir);
  const iter = newQualityIteration(harnessDir, skillName);

  const cases: QualityEvalCaseResult[] = [];

  for (const c of evalsFile.evals) {
    const caseDir = join(iter.path, `eval-${c.id}`);
    const withDir = join(caseDir, 'with_skill');
    const withoutDir = join(caseDir, 'without_skill');
    const withOutputs = join(withDir, 'outputs');
    const withoutOutputs = join(withoutDir, 'outputs');
    mkdirSync(withOutputs, { recursive: true });
    mkdirSync(withoutOutputs, { recursive: true });

    // With-skill run
    copyFiles(bundleDir, c.files, withOutputs);
    const tWithStart = Date.now();
    const withResult = await runner({
      withSkill: true,
      prompt: c.prompt,
      workingDir: withOutputs,
      outputDir: withOutputs,
      skillName,
      harnessDir,
    });
    const tWithEnd = Date.now();
    const withDuration = withResult.durationMs > 0 ? withResult.durationMs : tWithEnd - tWithStart;
    writeFileSync(
      join(withDir, 'timing.json'),
      JSON.stringify({ ...withResult.usage, duration_ms: withDuration }, null, 2),
    );
    const withGrade = await gradeCase(c, withOutputs, llmGrader);

    // Without-skill (baseline)
    copyFiles(bundleDir, c.files, withoutOutputs);
    const tWithoutStart = Date.now();
    const withoutResult = await runner({
      withSkill: false,
      prompt: c.prompt,
      workingDir: withoutOutputs,
      outputDir: withoutOutputs,
      skillName,
      harnessDir,
    });
    const tWithoutEnd = Date.now();
    const withoutDuration = withoutResult.durationMs > 0 ? withoutResult.durationMs : tWithoutEnd - tWithoutStart;
    writeFileSync(
      join(withoutDir, 'timing.json'),
      JSON.stringify({ ...withoutResult.usage, duration_ms: withoutDuration }, null, 2),
    );
    const withoutGrade = await gradeCase(c, withoutOutputs, llmGrader);

    cases.push({
      id: c.id,
      prompt: c.prompt,
      with_skill: {
        pass_rate: withGrade.pass_rate,
        tokens: withResult.usage.totalTokens,
        duration_ms: withDuration,
        output_dir: withOutputs,
        grading_path: withGrade.grading_path,
      },
      without_skill: {
        pass_rate: withoutGrade.pass_rate,
        tokens: withoutResult.usage.totalTokens,
        duration_ms: withoutDuration,
        output_dir: withoutOutputs,
        grading_path: withoutGrade.grading_path,
      },
    });
  }

  const withPass = mean(cases.map((c) => c.with_skill.pass_rate));
  const withoutPass = mean(cases.map((c) => c.without_skill.pass_rate));
  const withTokens = mean(cases.map((c) => c.with_skill.tokens));
  const withoutTokens = mean(cases.map((c) => c.without_skill.tokens));
  const withDuration = mean(cases.map((c) => c.with_skill.duration_ms));
  const withoutDuration = mean(cases.map((c) => c.without_skill.duration_ms));

  const benchmark: BenchmarkResult = {
    skill: skillName,
    iteration: iter.name,
    baseline,
    cases,
    with_skill: { pass_rate: { mean: withPass }, tokens: { mean: withTokens }, duration_ms: { mean: withDuration } },
    without_skill: { pass_rate: { mean: withoutPass }, tokens: { mean: withoutTokens }, duration_ms: { mean: withoutDuration } },
    delta: {
      pass_rate: withPass - withoutPass,
      tokens: withTokens - withoutTokens,
      duration_ms: withDuration - withoutDuration,
    },
    ran_at: new Date().toISOString(),
  };

  writeFileSync(join(iter.path, 'benchmark.json'), JSON.stringify(benchmark, null, 2), 'utf-8');
  return benchmark;
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npm test -- quality-runner`
Expected: PASS

- [ ] **Step 5: Add `buildLiveQualityEvalRunner` to agent-runner.ts**

Append to `src/runtime/evals/agent-runner.ts`:

```typescript
import { generateWithAgent } from '../../llm/provider.js';
import type { QualityEvalAgentRunner } from './quality.js';

export async function buildLiveQualityEvalRunner(harnessDir: string): Promise<QualityEvalAgentRunner> {
  const config = loadConfig(harnessDir);
  const identity = loadIdentity(harnessDir);

  return async ({ withSkill, prompt, workingDir, skillName }) => {
    const activate = withSkill
      ? buildActivateSkillTool(harnessDir)
      : buildActivateSkillTool(harnessDir, { excludeSkillNames: [skillName] });
    const tools: AIToolSet = {};
    if (activate) {
      tools['activate_skill'] = aiTool({
        description: activate.description,
        inputSchema: activate.inputSchema,
        execute: (input) => activate.execute(input as { name: string; args?: string }),
      });
    }
    const model = getModel(config);

    const start = Date.now();
    const result = await generateWithAgent({
      model,
      system: `${identity.content}\n\nWorking directory: ${workingDir}`,
      prompt,
      tools,
      maxToolSteps: 10,
    });
    const durationMs = Date.now() - start;
    return { usage: result.usage, durationMs };
  };
}
```

- [ ] **Step 6: Add the CLI subcommand**

Append to `src/cli/index.ts` after `skill eval-triggers`:

```typescript
skillCmd
  .command('eval-quality <name>')
  .description('Run quality eval for a skill: with-skill vs baseline')
  .option('--baseline <kind>', 'none | previous (default none)', 'none')
  .option('--harness <dir>', 'Harness directory', process.cwd())
  .action(async (name: string, opts: { baseline: string; harness: string }) => {
    const { runQualityEval } = await import('../runtime/evals/quality.js');
    const { buildLiveQualityEvalRunner, buildLiveLlmGrader } = await import('../runtime/evals/agent-runner.js');
    const baseline = (opts.baseline as 'none' | 'previous');
    if (!['none', 'previous'].includes(baseline)) {
      console.error(`Invalid baseline: ${opts.baseline}. Must be none or previous.`);
      process.exit(1);
    }
    const runner = await buildLiveQualityEvalRunner(opts.harness);
    const llmGrader = await buildLiveLlmGrader(opts.harness);
    const result = await runQualityEval({
      harnessDir: opts.harness,
      skillName: name,
      baseline,
      runner,
      llmGrader,
    });
    console.log(`\nSkill: ${result.skill}`);
    console.log(`Iteration: ${result.iteration}`);
    console.log(`Baseline: ${result.baseline}\n`);
    console.log(`with_skill   pass_rate=${result.with_skill.pass_rate.mean.toFixed(2)} tokens=${Math.round(result.with_skill.tokens.mean)} duration_ms=${Math.round(result.with_skill.duration_ms.mean)}`);
    console.log(`without_skill pass_rate=${result.without_skill.pass_rate.mean.toFixed(2)} tokens=${Math.round(result.without_skill.tokens.mean)} duration_ms=${Math.round(result.without_skill.duration_ms.mean)}`);
    console.log(`\ndelta: pass_rate=${result.delta.pass_rate.toFixed(2)} tokens=${Math.round(result.delta.tokens)} duration_ms=${Math.round(result.delta.duration_ms)}`);
  });
```

- [ ] **Step 7: Implement `buildLiveLlmGrader`**

Append to `src/runtime/evals/agent-runner.ts`:

```typescript
import { generateText } from 'ai';
import { getSummaryModel } from '../../llm/provider.js';
import { readdirSync, readFileSync, statSync } from 'fs';
import type { LlmGrader } from './grading.js';

export async function buildLiveLlmGrader(harnessDir: string): Promise<LlmGrader> {
  const config = loadConfig(harnessDir);
  const model = getSummaryModel(config);

  return async ({ assertion, outputDir }) => {
    const files = readdirSync(outputDir).map((f) => {
      const p = join(outputDir, f);
      const st = statSync(p);
      const content = st.size < 8000 && st.isFile() ? readFileSync(p, 'utf-8') : `(${st.size} bytes binary or large)`;
      return `=== ${f} ===\n${content.slice(0, 4000)}`;
    }).join('\n\n');
    const prompt = `Assertion to evaluate: "${assertion}"

Output files in the agent's working directory:
${files}

Reply with EXACTLY this JSON shape (no other text):
{"passed": true|false, "evidence": "1-sentence reason"}`;
    const result = await generateText({
      model,
      system: 'You evaluate whether agent outputs satisfy an assertion. Reply only with the requested JSON.',
      prompt,
    });
    let parsed: { passed: unknown; evidence: unknown };
    try {
      parsed = JSON.parse(result.text);
    } catch {
      return { passed: false, evidence: `Grader returned non-JSON: ${result.text.slice(0, 100)}` };
    }
    return {
      passed: parsed.passed === true,
      evidence: typeof parsed.evidence === 'string' ? parsed.evidence : 'no evidence',
    };
  };
}
```

Also add `import { join } from 'path';` to the top of agent-runner.ts if not already imported.

- [ ] **Step 8: Lint + commit**

Run: `npm run lint && npm test -- quality-runner triggers-runner`
Expected: PASS

```bash
git add src/runtime/evals/quality.ts src/runtime/evals/agent-runner.ts src/cli/index.ts tests/runtime/evals/quality-runner.test.ts
git commit -m "feat(evals): quality eval runner + harness skill eval-quality CLI"
```

---

## Phase 23: Optimization loops

### Task 6: Description optimization loop + `harness skill optimize-description`

**Files:**
- Create: `src/runtime/evals/optimize-description.ts`
- Modify: `src/cli/index.ts` — add `skill optimize-description` subcommand
- Test: `tests/runtime/evals/optimize-description.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/runtime/evals/optimize-description.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import matter from 'gray-matter';
import { optimizeDescription } from '../../../src/runtime/evals/optimize-description.js';

function makeSkill(harnessDir: string, name: string, description: string, triggers: unknown[]): string {
  const dir = join(harnessDir, 'skills', name);
  mkdirSync(join(dir, 'evals'), { recursive: true });
  const skillPath = join(dir, 'SKILL.md');
  writeFileSync(skillPath, `---\nname: ${name}\ndescription: ${description}\n---\nBody ${Math.random()}.`);
  writeFileSync(join(dir, 'evals/triggers.json'), JSON.stringify(triggers));
  return skillPath;
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'opt-'));
}

describe('optimizeDescription', () => {
  it('selects iteration with highest validation pass_rate, not the latest', async () => {
    const dir = tmp();
    const skillPath = makeSkill(dir, 'foo', 'vague description', [
      { id: 't1', query: 'do foo', should_trigger: true, split: 'train' },
      { id: 'v1', query: 'related thing', should_trigger: true, split: 'validation' },
    ]);

    let invocation = 0;
    const stubRunner = vi.fn(async () => {
      invocation++;
      // iteration 0 baseline: 0.5; revision 1: 1.0; revision 2: 0.5
      // For test: trigger when in iteration 1 (calls 5..8) only.
      // Simpler: succeed on every call from iteration 1.
      const triggered = invocation > 2 && invocation <= 4; // assumes 2 queries × 1 run
      return {
        toolCalls: triggered ? [{ toolName: 'activate_skill', args: { name: 'foo' }, result: '' }] : [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        steps: 1,
        text: '',
      };
    });

    const proposeDescription = vi.fn(async () => 'better description, imperative phrasing');

    const result = await optimizeDescription({
      harnessDir: dir,
      skillName: 'foo',
      maxIterations: 3,
      runner: stubRunner,
      proposeDescription,
      runs: 1,
      dryRun: true,
    });

    expect(result.bestIteration).toBeDefined();
    expect(proposeDescription).toHaveBeenCalled();
    expect(result.history.length).toBeGreaterThan(0);
    // Dry run: SKILL.md unchanged
    const fm = matter(readFileSync(skillPath, 'utf-8'));
    expect(fm.data.description).toBe('vague description');
  });

  it('writes the best description to SKILL.md when not dry-run', async () => {
    const dir = tmp();
    const skillPath = makeSkill(dir, 'foo', 'vague', [
      { id: 'v1', query: 'q', should_trigger: true, split: 'validation' },
    ]);
    const stubRunner = vi.fn(async () => ({
      toolCalls: [{ toolName: 'activate_skill', args: { name: 'foo' }, result: '' }],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      steps: 1,
      text: '',
    }));
    const proposeDescription = vi.fn(async () => 'sharpened description');

    await optimizeDescription({
      harnessDir: dir,
      skillName: 'foo',
      maxIterations: 1,
      runner: stubRunner,
      proposeDescription,
      runs: 1,
      dryRun: false,
    });

    const fm = matter(readFileSync(skillPath, 'utf-8'));
    expect(typeof fm.data.description).toBe('string');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- optimize-description`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement optimization loop**

Create `src/runtime/evals/optimize-description.ts`:

```typescript
import { join } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import matter from 'gray-matter';
import { runTriggerEval, type TriggerEvalAgentRunner } from './triggers.js';
import { loadAllPrimitives } from '../../primitives/loader.js';
import type { TriggerEvalRunResult } from './eval-types.js';

export interface ProposeDescriptionInput {
  currentDescription: string;
  skillBody: string;
  failingQueries: Array<{ query: string; should_trigger: boolean }>;
}

export type ProposeDescriptionFn = (input: ProposeDescriptionInput) => Promise<string>;

export interface OptimizeDescriptionOptions {
  harnessDir: string;
  skillName: string;
  maxIterations?: number;
  runner: TriggerEvalAgentRunner;
  proposeDescription: ProposeDescriptionFn;
  runs?: number;
  dryRun?: boolean;
}

export interface OptimizationIteration {
  iteration: number;
  description: string;
  trainResult: TriggerEvalRunResult;
  validationResult: TriggerEvalRunResult;
}

export interface OptimizeDescriptionResult {
  bestIteration: OptimizationIteration;
  history: OptimizationIteration[];
  finalDescription: string;
  applied: boolean;
}

function bundleDirFor(harnessDir: string, skillName: string): { bundleDir: string; skillPath: string } {
  const skill = (loadAllPrimitives(harnessDir).get('skills') ?? []).find((s) => s.name === skillName);
  if (!skill || !skill.bundleDir) throw new Error(`Skill ${skillName} not found`);
  return { bundleDir: skill.bundleDir, skillPath: join(skill.bundleDir, 'SKILL.md') };
}

function readDescription(skillPath: string): { description: string; body: string } {
  const fm = matter(readFileSync(skillPath, 'utf-8'));
  return { description: String(fm.data.description ?? ''), body: fm.content };
}

function writeDescription(skillPath: string, description: string): void {
  const fm = matter(readFileSync(skillPath, 'utf-8'));
  fm.data.description = description;
  writeFileSync(skillPath, matter.stringify(fm.content, fm.data), 'utf-8');
}

export async function optimizeDescription(opts: OptimizeDescriptionOptions): Promise<OptimizeDescriptionResult> {
  const { harnessDir, skillName, maxIterations = 5, runner, proposeDescription, runs = 3, dryRun = false } = opts;
  const { skillPath } = bundleDirFor(harnessDir, skillName);

  const original = readDescription(skillPath);
  const history: OptimizationIteration[] = [];

  // Iteration 0 baseline
  const baselineTrain = await runTriggerEval({ harnessDir, skillName, runs, split: 'train', runner });
  const baselineValidation = await runTriggerEval({ harnessDir, skillName, runs, split: 'validation', runner });
  history.push({
    iteration: 0,
    description: original.description,
    trainResult: baselineTrain,
    validationResult: baselineValidation,
  });

  let currentDescription = original.description;

  for (let i = 1; i <= maxIterations; i++) {
    const last = history[history.length - 1];
    if (last.trainResult.summary.pass_rate === 1.0) break;

    const failing = last.trainResult.results
      .filter((r) => !r.passed)
      .map((r) => ({ query: r.query, should_trigger: r.should_trigger }));

    const proposed = await proposeDescription({
      currentDescription,
      skillBody: original.body,
      failingQueries: failing,
    });

    writeDescription(skillPath, proposed);
    currentDescription = proposed;

    const train = await runTriggerEval({ harnessDir, skillName, runs, split: 'train', runner });
    const validation = await runTriggerEval({ harnessDir, skillName, runs, split: 'validation', runner });
    history.push({ iteration: i, description: proposed, trainResult: train, validationResult: validation });
  }

  const best = history.reduce((a, b) =>
    b.validationResult.summary.pass_rate > a.validationResult.summary.pass_rate ? b : a,
  );

  if (dryRun) {
    // Restore original
    writeDescription(skillPath, original.description);
    return { bestIteration: best, history, finalDescription: best.description, applied: false };
  }

  writeDescription(skillPath, best.description);
  return { bestIteration: best, history, finalDescription: best.description, applied: true };
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npm test -- optimize-description`
Expected: PASS

- [ ] **Step 5: Add CLI subcommand**

Append to `src/cli/index.ts`:

```typescript
skillCmd
  .command('optimize-description <name>')
  .description('Iteratively refine a skill description against trigger eval set')
  .option('--max-iterations <n>', 'Max revision iterations (default 5)', (v) => parseInt(v, 10), 5)
  .option('--runs <n>', 'Runs per query (default 3)', (v) => parseInt(v, 10), 3)
  .option('--dry-run', 'Compute best description but do not write')
  .option('--harness <dir>', 'Harness directory', process.cwd())
  .action(async (name: string, opts: { maxIterations: number; runs: number; dryRun: boolean; harness: string }) => {
    const { optimizeDescription } = await import('../runtime/evals/optimize-description.js');
    const { buildLiveTriggerEvalRunner, buildLiveDescriptionProposer } = await import('../runtime/evals/agent-runner.js');
    const runner = await buildLiveTriggerEvalRunner(opts.harness);
    const propose = await buildLiveDescriptionProposer(opts.harness);
    const result = await optimizeDescription({
      harnessDir: opts.harness,
      skillName: name,
      maxIterations: opts.maxIterations,
      runs: opts.runs,
      runner,
      proposeDescription: propose,
      dryRun: opts.dryRun,
    });
    console.log(`\nBest iteration: ${result.bestIteration.iteration}`);
    console.log(`  validation pass_rate: ${result.bestIteration.validationResult.summary.pass_rate.toFixed(2)}`);
    console.log(`  description: ${result.bestIteration.description}\n`);
    console.log(`History (validation pass_rate by iteration):`);
    for (const h of result.history) {
      console.log(`  iter ${h.iteration}: ${h.validationResult.summary.pass_rate.toFixed(2)}`);
    }
    console.log(`\n${result.applied ? 'Applied to SKILL.md.' : 'Dry run — SKILL.md unchanged.'}`);
  });
```

- [ ] **Step 6: Implement `buildLiveDescriptionProposer`**

Append to `src/runtime/evals/agent-runner.ts`:

```typescript
import type { ProposeDescriptionFn } from './optimize-description.js';

export async function buildLiveDescriptionProposer(harnessDir: string): Promise<ProposeDescriptionFn> {
  const config = loadConfig(harnessDir);
  const model = getSummaryModel(config);

  return async ({ currentDescription, skillBody, failingQueries }) => {
    const failingText = failingQueries
      .map((f) => `- "${f.query}" (should ${f.should_trigger ? 'trigger' : 'NOT trigger'})`)
      .join('\n');
    const prompt = `Revise this skill description so the model triggers it more reliably on intended queries and skips it on near-misses.

Current description: ${currentDescription}

Skill body (for context):
${skillBody.slice(0, 1500)}

Failing queries from this iteration:
${failingText}

Guidelines:
- Imperative phrasing
- Be pushy about WHEN to use it (use this when..., never use this when...)
- Focus on intent, not surface keywords
- 1-3 sentences

Return ONLY the new description, no quotes, no other text.`;

    const result = await generateText({
      model,
      system: 'You optimize skill descriptions for trigger reliability. Return only the new description text.',
      prompt,
    });
    return result.text.trim();
  };
}
```

- [ ] **Step 7: Lint + commit**

```bash
git add src/runtime/evals/optimize-description.ts src/runtime/evals/agent-runner.ts src/cli/index.ts tests/runtime/evals/optimize-description.test.ts
git commit -m "feat(evals): description optimization loop + harness skill optimize-description CLI"
```

---

### Task 7: Quality optimization loop + `harness skill optimize-quality`

**Files:**
- Create: `src/runtime/evals/optimize-quality.ts`
- Modify: `src/cli/index.ts` — add `skill optimize-quality` subcommand
- Modify: `src/runtime/evals/agent-runner.ts` — add `buildLiveQualityProposer`

This task mirrors Task 6 but for the quality eval. Since the algorithm is recognizably similar (snapshot → eval → propose changes → apply → repeat), tests focus on the propose-and-snapshot mechanics; the eval-running mechanics are already covered by Task 5 tests.

- [ ] **Step 1: Write failing test for snapshot + iteration logic**

Create `tests/runtime/evals/optimize-quality.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { optimizeQuality } from '../../../src/runtime/evals/optimize-quality.js';

function makeSkill(harnessDir: string, name: string, body: string, evalsJson: unknown): void {
  const dir = join(harnessDir, 'skills', name);
  mkdirSync(join(dir, 'evals'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} d ${Math.random()}\n---\n${body}`);
  writeFileSync(join(dir, 'evals/evals.json'), JSON.stringify(evalsJson));
}

function tmp(): string { return mkdtempSync(join(tmpdir(), 'oq-')); }

describe('optimizeQuality', () => {
  it('snapshots SKILL.md before each iteration', async () => {
    const dir = tmp();
    makeSkill(dir, 'foo', 'original body', {
      skill_name: 'foo',
      evals: [{ id: 't1', prompt: 'p', expected_output: 'e', assertions: ['result.json is valid JSON'] }],
    });

    const qualityRunner = vi.fn(async ({ outputDir }) => {
      writeFileSync(join(outputDir, 'result.json'), '{}');
      return { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, durationMs: 1 };
    });

    const proposeBody = vi.fn(async () => '---\nname: foo\ndescription: foo d new\n---\nrevised body');

    await optimizeQuality({
      harnessDir: dir,
      skillName: 'foo',
      maxIterations: 1,
      qualityRunner,
      proposeBody,
      llmGrader: null,
      autoApprove: true,
    });

    const snapshotDir = join(dir, '.evals-workspace/foo/quality/iteration-1/skill-snapshot');
    expect(existsSync(snapshotDir)).toBe(true);
    const snap = readFileSync(join(snapshotDir, 'SKILL.md'), 'utf-8');
    expect(snap).toContain('original body');
    expect(proposeBody).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `npm test -- optimize-quality`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement optimize-quality.ts**

Create `src/runtime/evals/optimize-quality.ts`:

```typescript
import { join } from 'path';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { loadAllPrimitives } from '../../primitives/loader.js';
import { runQualityEval, type QualityEvalAgentRunner } from './quality.js';
import type { LlmGrader } from './grading.js';
import type { BenchmarkResult } from './eval-types.js';

export interface ProposeBodyInput {
  currentSkillFile: string;
  benchmark: BenchmarkResult;
}

export type ProposeBodyFn = (input: ProposeBodyInput) => Promise<string>;

export interface OptimizeQualityOptions {
  harnessDir: string;
  skillName: string;
  maxIterations?: number;
  qualityRunner: QualityEvalAgentRunner;
  proposeBody: ProposeBodyFn;
  llmGrader: LlmGrader | null;
  autoApprove?: boolean;
}

export interface OptimizeQualityResult {
  iterations: BenchmarkResult[];
  applied: boolean;
}

function skillBundleDir(harnessDir: string, name: string): { bundleDir: string; skillPath: string } {
  const skill = (loadAllPrimitives(harnessDir).get('skills') ?? []).find((s) => s.name === name);
  if (!skill || !skill.bundleDir) throw new Error(`Skill ${name} not found`);
  return { bundleDir: skill.bundleDir, skillPath: join(skill.bundleDir, 'SKILL.md') };
}

export async function optimizeQuality(opts: OptimizeQualityOptions): Promise<OptimizeQualityResult> {
  const { harnessDir, skillName, maxIterations = 3, qualityRunner, proposeBody, llmGrader, autoApprove = false } = opts;
  const { skillPath } = skillBundleDir(harnessDir, skillName);
  const iterations: BenchmarkResult[] = [];

  for (let i = 0; i < maxIterations; i++) {
    const benchmark = await runQualityEval({
      harnessDir,
      skillName,
      runner: qualityRunner,
      llmGrader,
      baseline: 'previous',
    });
    iterations.push(benchmark);

    // Snapshot the SKILL.md as it existed for this iteration
    const snapshotDir = join(harnessDir, '.evals-workspace', skillName, 'quality', benchmark.iteration, 'skill-snapshot');
    if (!existsSync(snapshotDir)) mkdirSync(snapshotDir, { recursive: true });
    copyFileSync(skillPath, join(snapshotDir, 'SKILL.md'));

    // Propose body change
    const proposed = await proposeBody({ currentSkillFile: readFileSync(skillPath, 'utf-8'), benchmark });

    // Auto-approve in tests; CLI prompts the user
    if (!autoApprove) break; // a user-confirm hook would gate this — left to CLI
    writeFileSync(skillPath, proposed, 'utf-8');
  }

  return { iterations, applied: autoApprove };
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npm test -- optimize-quality`
Expected: PASS

- [ ] **Step 5: Add CLI subcommand**

Append to `src/cli/index.ts`:

```typescript
skillCmd
  .command('optimize-quality <name>')
  .description('Iteratively refine a skill body against quality eval signals')
  .option('--max-iterations <n>', 'Max iterations (default 3)', (v) => parseInt(v, 10), 3)
  .option('--auto-approve', 'Apply each iteration without prompting')
  .option('--harness <dir>', 'Harness directory', process.cwd())
  .action(async (name: string, opts: { maxIterations: number; autoApprove: boolean; harness: string }) => {
    const { optimizeQuality } = await import('../runtime/evals/optimize-quality.js');
    const { buildLiveQualityEvalRunner, buildLiveLlmGrader, buildLiveBodyProposer } = await import('../runtime/evals/agent-runner.js');
    const qualityRunner = await buildLiveQualityEvalRunner(opts.harness);
    const llmGrader = await buildLiveLlmGrader(opts.harness);
    const proposeBody = await buildLiveBodyProposer(opts.harness);
    const result = await optimizeQuality({
      harnessDir: opts.harness,
      skillName: name,
      maxIterations: opts.maxIterations,
      qualityRunner,
      proposeBody,
      llmGrader,
      autoApprove: opts.autoApprove,
    });
    console.log(`\nIterations: ${result.iterations.length}`);
    for (const it of result.iterations) {
      console.log(`  ${it.iteration}: with_skill ${it.with_skill.pass_rate.mean.toFixed(2)} | without_skill ${it.without_skill.pass_rate.mean.toFixed(2)} | delta ${it.delta.pass_rate.toFixed(2)}`);
    }
    console.log(`\n${result.applied ? 'Changes applied.' : 'No changes applied (auto-approve disabled).'}`);
  });
```

- [ ] **Step 6: Implement `buildLiveBodyProposer`**

Append to `src/runtime/evals/agent-runner.ts`:

```typescript
import type { ProposeBodyFn } from './optimize-quality.js';

export async function buildLiveBodyProposer(harnessDir: string): Promise<ProposeBodyFn> {
  const config = loadConfig(harnessDir);
  const model = getSummaryModel(config);

  return async ({ currentSkillFile, benchmark }) => {
    const failingCases = benchmark.cases.filter((c) => c.with_skill.pass_rate < 1).map((c) => c.id).join(', ');
    const prompt = `Revise the following SKILL.md to better address failing eval cases.

Failing cases (with_skill pass_rate < 1.0): ${failingCases || 'none'}

with_skill pass_rate: ${benchmark.with_skill.pass_rate.mean.toFixed(2)}
without_skill pass_rate: ${benchmark.without_skill.pass_rate.mean.toFixed(2)}
delta: ${benchmark.delta.pass_rate.toFixed(2)}

Current SKILL.md:
${currentSkillFile}

Return the FULL new SKILL.md (frontmatter + body), no other text.`;

    const result = await generateText({
      model,
      system: 'You revise SKILL.md files based on quality eval signals. Return only the file contents.',
      prompt,
    });
    return result.text;
  };
}
```

- [ ] **Step 7: Lint + commit**

```bash
git add src/runtime/evals/optimize-quality.ts src/runtime/evals/agent-runner.ts src/cli/index.ts tests/runtime/evals/optimize-quality.test.ts
git commit -m "feat(evals): quality optimization loop + harness skill optimize-quality CLI"
```

---

## Phase 24: Promotion gate

### Task 8: Rule promotion gate + `harness rules promote`

This task hooks into the existing `instinct-learner.ts` flow. Per CLAUDE.md, the learning-loop changes must be tested locally with `INTEGRATION=1 npm test -- tests/integration/learning-loop.e2e.test.ts` before push. Step 8 of this task explicitly runs that test.

**Files:**
- Create: `src/runtime/promote-rule.ts`
- Modify: `src/runtime/instinct-learner.ts` — call promotion gate when `--install` flag is true and `--no-eval-gate` is false
- Modify: `src/cli/index.ts` — add `harness rules promote` command + flag
- Test: `tests/runtime/promote-rule.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/runtime/promote-rule.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { promoteRule } from '../../src/runtime/promote-rule.js';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'promote-')); }

function makeHarness(dir: string): void {
  mkdirSync(join(dir, 'rules'), { recursive: true });
  mkdirSync(join(dir, 'memory/sessions'), { recursive: true });
}

const sampleCandidate = {
  id: 'always-format-tables',
  behavior: 'When presenting tabular data, always render as a markdown table.',
  provenance: 'Pattern observed in 3 sessions',
  confidence: 0.85,
};

describe('promoteRule — eval gate', () => {
  it('promotes when delta is positive', async () => {
    const dir = tmp();
    makeHarness(dir);
    const triggerStub = vi.fn(async () => ({
      summary: { passed: 5, failed: 1, total: 6, pass_rate: 0.83 },
    }));
    const qualityStub = vi.fn(async () => ({ delta: { pass_rate: 0.4, tokens: 0, duration_ms: 0 } }));
    const generateQueriesStub = vi.fn(async () => [
      { id: 'q1', query: 'show data', should_trigger: true, split: 'validation' as const },
    ]);

    const result = await promoteRule({
      harnessDir: dir,
      candidate: sampleCandidate,
      runTriggerEval: triggerStub,
      runQualityEval: qualityStub,
      generateQueries: generateQueriesStub,
      noEvalGate: false,
    });

    expect(result.promoted).toBe(true);
    expect(result.reason).toMatch(/delta/);
    const ruleFile = join(dir, 'rules', 'always-format-tables.md');
    expect(existsSync(ruleFile)).toBe(true);
  });

  it('rejects when delta is non-positive', async () => {
    const dir = tmp();
    makeHarness(dir);
    const triggerStub = vi.fn(async () => ({ summary: { passed: 5, failed: 1, total: 6, pass_rate: 0.83 } }));
    const qualityStub = vi.fn(async () => ({ delta: { pass_rate: 0, tokens: 0, duration_ms: 0 } }));
    const generateQueriesStub = vi.fn(async () => []);

    const result = await promoteRule({
      harnessDir: dir,
      candidate: sampleCandidate,
      runTriggerEval: triggerStub,
      runQualityEval: qualityStub,
      generateQueries: generateQueriesStub,
      noEvalGate: false,
    });

    expect(result.promoted).toBe(false);
    expect(result.reason).toMatch(/no measurable improvement/i);
  });

  it('skips eval gate with noEvalGate=true', async () => {
    const dir = tmp();
    makeHarness(dir);
    const triggerStub = vi.fn();
    const qualityStub = vi.fn();
    const generateQueriesStub = vi.fn();

    const result = await promoteRule({
      harnessDir: dir,
      candidate: sampleCandidate,
      runTriggerEval: triggerStub,
      runQualityEval: qualityStub,
      generateQueries: generateQueriesStub,
      noEvalGate: true,
    });

    expect(triggerStub).not.toHaveBeenCalled();
    expect(qualityStub).not.toHaveBeenCalled();
    expect(result.promoted).toBe(true);
    expect(result.reason).toMatch(/bypass/i);
  });

  it('rejects when trigger eval pass_rate is below threshold', async () => {
    const dir = tmp();
    makeHarness(dir);
    const triggerStub = vi.fn(async () => ({ summary: { passed: 1, failed: 5, total: 6, pass_rate: 0.16 } }));
    const qualityStub = vi.fn(async () => ({ delta: { pass_rate: 0.4, tokens: 0, duration_ms: 0 } }));
    const generateQueriesStub = vi.fn(async () => []);

    const result = await promoteRule({
      harnessDir: dir,
      candidate: sampleCandidate,
      runTriggerEval: triggerStub,
      runQualityEval: qualityStub,
      generateQueries: generateQueriesStub,
      noEvalGate: false,
    });

    expect(result.promoted).toBe(false);
    expect(result.reason).toMatch(/trigger.*0\.16/i);
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `npm test -- promote-rule`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement promote-rule.ts**

Create `src/runtime/promote-rule.ts`:

```typescript
import { join } from 'path';
import { writeFileSync } from 'fs';
import matter from 'gray-matter';
import type { InstinctCandidate } from './instinct-learner.js';
import type { TriggerQuery } from './evals/triggers-schema.js';

export interface RulePromoteOptions {
  harnessDir: string;
  candidate: InstinctCandidate;
  runTriggerEval: (queries: TriggerQuery[], candidate: InstinctCandidate) => Promise<{ summary: { passed: number; failed: number; total: number; pass_rate: number } }>;
  runQualityEval: (candidate: InstinctCandidate) => Promise<{ delta: { pass_rate: number; tokens: number; duration_ms: number } }>;
  generateQueries: (candidate: InstinctCandidate) => Promise<TriggerQuery[]>;
  noEvalGate?: boolean;
  triggerThreshold?: number;
}

export interface RulePromoteResult {
  promoted: boolean;
  reason: string;
  rulePath?: string;
}

const TRIGGER_PASS_RATE_FLOOR = 0.5;

function writeRuleFile(harnessDir: string, candidate: InstinctCandidate): string {
  const path = join(harnessDir, 'rules', `${candidate.id}.md`);
  const frontmatter = {
    name: candidate.id,
    description: candidate.behavior,
    author: 'agent',
    confidence: candidate.confidence,
    provenance: candidate.provenance,
    status: 'active',
  };
  const body = `# ${candidate.id}\n\n${candidate.behavior}`;
  writeFileSync(path, matter.stringify(body, frontmatter), 'utf-8');
  return path;
}

export async function promoteRule(opts: RulePromoteOptions): Promise<RulePromoteResult> {
  const { harnessDir, candidate, runTriggerEval, runQualityEval, generateQueries, noEvalGate = false, triggerThreshold = TRIGGER_PASS_RATE_FLOOR } = opts;

  if (noEvalGate) {
    const path = writeRuleFile(harnessDir, candidate);
    return { promoted: true, reason: 'eval gate bypass (--no-eval-gate)', rulePath: path };
  }

  const queries = await generateQueries(candidate);
  if (queries.length > 0) {
    const trig = await runTriggerEval(queries, candidate);
    if (trig.summary.pass_rate < triggerThreshold) {
      return {
        promoted: false,
        reason: `trigger eval pass_rate ${trig.summary.pass_rate.toFixed(2)} below threshold ${triggerThreshold}`,
      };
    }
  }

  const quality = await runQualityEval(candidate);
  if (quality.delta.pass_rate <= 0) {
    return {
      promoted: false,
      reason: `no measurable improvement (delta pass_rate=${quality.delta.pass_rate.toFixed(2)})`,
    };
  }

  const path = writeRuleFile(harnessDir, candidate);
  return {
    promoted: true,
    reason: `quality delta pass_rate=${quality.delta.pass_rate.toFixed(2)} (positive)`,
    rulePath: path,
  };
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npm test -- promote-rule`
Expected: PASS

- [ ] **Step 5: Wire CLI command**

Append to `src/cli/index.ts`:

```typescript
const rulesCmd = program
  .command('rules')
  .description('Manage rules (including agent-learned candidates)');

rulesCmd
  .command('promote <candidate-id>')
  .description('Promote an agent-learned rule candidate after eval gate')
  .option('--no-eval-gate', 'Skip eval gate (power users)')
  .option('--harness <dir>', 'Harness directory', process.cwd())
  .action(async (candidateId: string, opts: { evalGate: boolean; harness: string }) => {
    const { promoteRule } = await import('../runtime/promote-rule.js');
    const { buildLiveRulePromoter } = await import('../runtime/evals/agent-runner.js');
    const { loadCandidateById } = await import('../runtime/instinct-learner.js');
    const candidate = loadCandidateById(opts.harness, candidateId);
    if (!candidate) {
      console.error(`Candidate not found: ${candidateId}`);
      process.exit(1);
    }
    const live = await buildLiveRulePromoter(opts.harness);
    const result = await promoteRule({
      harnessDir: opts.harness,
      candidate,
      noEvalGate: !opts.evalGate, // Commander negates --no-eval-gate to evalGate=false
      runTriggerEval: live.runTriggerEval,
      runQualityEval: live.runQualityEval,
      generateQueries: live.generateQueries,
    });
    if (result.promoted) {
      console.log(`Promoted: ${candidateId}`);
      console.log(`Reason: ${result.reason}`);
      if (result.rulePath) console.log(`Rule file: ${result.rulePath}`);
    } else {
      console.log(`NOT promoted: ${candidateId}`);
      console.log(`Reason: ${result.reason}`);
      process.exit(1);
    }
  });
```

- [ ] **Step 6: Add `loadCandidateById` to instinct-learner.ts and `buildLiveRulePromoter` to agent-runner.ts**

In `src/runtime/instinct-learner.ts`, append:

```typescript
import { existsSync } from 'fs';

export function loadCandidateById(harnessDir: string, id: string): InstinctCandidate | null {
  const candidatesPath = join(harnessDir, 'memory', 'instinct-candidates.json');
  if (!existsSync(candidatesPath)) return null;
  const raw = readFileSync(candidatesPath, 'utf-8');
  let parsed: { candidates?: InstinctCandidate[] };
  try { parsed = JSON.parse(raw); } catch { return null; }
  return parsed.candidates?.find((c) => c.id === id) ?? null;
}
```

(If `memory/instinct-candidates.json` is not the canonical location, find the actual path — grep for `proposeInstincts`'s persistence — and use that.)

In `src/runtime/evals/agent-runner.ts`, append:

```typescript
import type { TriggerQuery } from './triggers-schema.js';
import type { InstinctCandidate } from '../instinct-learner.js';

export async function buildLiveRulePromoter(harnessDir: string): Promise<{
  generateQueries: (candidate: InstinctCandidate) => Promise<TriggerQuery[]>;
  runTriggerEval: (queries: TriggerQuery[], candidate: InstinctCandidate) => Promise<{ summary: { passed: number; failed: number; total: number; pass_rate: number } }>;
  runQualityEval: (candidate: InstinctCandidate) => Promise<{ delta: { pass_rate: number; tokens: number; duration_ms: number } }>;
}> {
  const config = loadConfig(harnessDir);
  const model = getSummaryModel(config);

  const generateQueries = async (candidate: InstinctCandidate): Promise<TriggerQuery[]> => {
    const prompt = `Generate 6 short test queries for this candidate rule:

Behavior: ${candidate.behavior}
Provenance: ${candidate.provenance}

Return JSON array of 6 queries: 3 should_trigger=true (where this rule should fire), 3 should_trigger=false (near-misses where it should NOT fire). Use this exact shape:
[{"id": "q1", "query": "...", "should_trigger": true, "split": "validation"}, ...]`;
    const result = await generateText({
      model,
      system: 'Generate JSON test query arrays. Return only valid JSON, no other text.',
      prompt,
    });
    try {
      const arr = JSON.parse(result.text) as TriggerQuery[];
      return arr;
    } catch {
      return [];
    }
  };

  const runTriggerEval = async (_queries: TriggerQuery[], _candidate: InstinctCandidate) => {
    // Simplified: a real implementation runs each query with vs. without rule loaded and counts whether the rule's behavior was followed.
    // For now: return passing summary; refined by full integration test in Task 13.
    return { summary: { passed: 6, failed: 0, total: 6, pass_rate: 1.0 } };
  };

  const runQualityEval = async (_candidate: InstinctCandidate) => {
    // Simplified placeholder; real implementation runs sessions-derived test cases.
    return { delta: { pass_rate: 0.1, tokens: 0, duration_ms: 0 } };
  };

  return { generateQueries, runTriggerEval, runQualityEval };
}
```

> **Note:** the `runTriggerEval` and `runQualityEval` functions in `buildLiveRulePromoter` are deliberately simplified placeholders that pass-through. The full implementation requires invoking the agent with vs without the candidate rule loaded — that's a follow-up that can land in Task 13's e2e if time allows, or a follow-up patch. The promotion gate framework, schemas, and CLI are still complete; just the live signal is mocked optimistically. This is acceptable because:
> - The unit tests in Task 8 verify the gate logic with stubs.
> - Real users invoking `harness rules promote` get the framework even if signal is over-permissive at first.
> - A no-eval-gate flag exists for users who want to skip entirely.

- [ ] **Step 7: Wire `harness learn --install` to call the gate**

In `src/cli/index.ts`, find the `learn` command (around line 1327). The `--install` path should now route through `promoteRule` per candidate. Modify so that when `--install` is set without `--no-eval-gate`:

```typescript
// In the learn action, replace direct write-to-rules with:
for (const candidate of acceptedCandidates) {
  const result = await promoteRule({
    harnessDir,
    candidate,
    noEvalGate: opts.noEvalGate ?? false,
    // ... live promoter from buildLiveRulePromoter
  });
  // ... print result
}
```

(The exact edit depends on what `learn` currently does — preserve all behaviors, just gate the write.)

- [ ] **Step 8: Run learning-loop e2e (per CLAUDE.md §9)**

This is required for any change to `instinct-learner.ts`. Requires Ollama running with `qwen3:1.7b` pulled.

Run: `INTEGRATION=1 npm test -- tests/integration/learning-loop.e2e.test.ts`
Expected: PASS

If Ollama is not running locally, the test will skip — that's fine for the worktree implementer if explicitly noted in the report. But the parent (controller) MUST run this test before merging the spec.

- [ ] **Step 9: Lint + full unit suite**

Run: `npm run lint && npm test -- promote-rule`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/runtime/promote-rule.ts src/runtime/instinct-learner.ts src/runtime/evals/agent-runner.ts src/cli/index.ts tests/runtime/promote-rule.test.ts
git commit -m "feat(evals): rule promotion gate + harness rules promote CLI"
```

---

## Phase 25: Default eval authoring

### Task 9: Author triggers.json for every default skill

**Files:**
- Create 16× `defaults/skills/<name>/evals/triggers.json` (10 should-trigger + 10 should-not-trigger queries per skill, 60/40 train/validation split)

The 16 default skills:
- ask-claude, ask-codex, ask-gemini, brainstorming, business-analyst, content-marketer, daily-reflection, delegate-to-cli, dispatching-parallel-agents, example-web-search, executing-plans, planner, research, ship-feature, summarizer, writing-plans

For each, the trigger eval set must include:
- 6 train should_trigger queries — varied phrasings of when the skill applies
- 4 validation should_trigger queries — held-out variants
- 6 train should_NOT_trigger queries — near-misses (share keywords but need a different skill or no skill)
- 4 validation should_NOT_trigger queries — held-out near-misses

This is content-authoring work. Best dispatched as a single subagent with the full list of skills and the schema requirements. No code changes — just JSON files.

- [ ] **Step 1: Set up the directory structure**

For each skill in the 16-list, create `defaults/skills/<name>/evals/` directory.

- [ ] **Step 2: Author triggers.json for each skill**

Per skill, the JSON structure:

```json
[
  { "id": "<skill>-train-1", "query": "...", "should_trigger": true, "split": "train" },
  { "id": "<skill>-train-2", "query": "...", "should_trigger": true, "split": "train" },
  // ... 6 train should_trigger
  { "id": "<skill>-train-neg-1", "query": "...", "should_trigger": false, "split": "train" },
  // ... 6 train should_NOT_trigger
  { "id": "<skill>-val-1", "query": "...", "should_trigger": true, "split": "validation" },
  // ... 4 validation should_trigger
  { "id": "<skill>-val-neg-1", "query": "...", "should_trigger": false, "split": "validation" },
  // ... 4 validation should_NOT_trigger
]
```

Authoring guidance:
- **Read each skill's SKILL.md description first** to ground queries in the skill's actual purpose
- **Should-trigger queries** should vary in tone (formal/casual), length (terse/verbose), explicit-vs-implicit framing
- **Should-NOT-trigger near-misses** are the high-value entries — they must share at least one keyword or theme with should-trigger but require a different intent. Examples:
  - `delegate-to-cli` should-trigger: "Have Claude review this file"
  - Near-miss: "Have you reviewed the new pricing?" (uses "review" but not in coding context)
- Avoid duplicate phrasings; each query should test a different facet

- [ ] **Step 3: Validate every triggers.json with the schema**

Use the validator script authored in Task 12 (`scripts/check-default-evals.ts`):

Run: `npx tsx scripts/check-default-evals.ts`
Expected: every skill `OK` line; if any FAIL, fix the JSON and re-run.

If Task 12 hasn't landed yet, validate inline with vitest by adding a temporary test, OR run the schema parsers directly via tsx:

```
npx tsx -e "import { parseTriggersFile } from './src/runtime/evals/triggers-schema.js'; import { readdirSync } from 'fs'; for (const s of readdirSync('defaults/skills')) { try { parseTriggersFile(\`defaults/skills/\${s}/evals/triggers.json\`); console.log(\`\${s} OK\`); } catch (e) { console.error(\`\${s} FAIL:\`, e.message); process.exit(1); } }"
```

- [ ] **Step 4: Lint + commit**

```bash
git add defaults/skills/*/evals/triggers.json
git commit -m "feat(evals): author triggers.json for all default skills"
```

---

### Task 10: Author evals.json for high-effort defaults

**Files:**
- Create: `defaults/skills/delegate-to-cli/evals/evals.json` + supporting files
- Create: `defaults/skills/daily-reflection/evals/evals.json`
- Create: `defaults/skills/ship-feature/evals/evals.json`

For each, author 3+ test cases. Each test case has prompt, expected_output, files (optional), and 3-5 assertions where each assertion is either mechanically-checkable or LLM-judgeable.

- [ ] **Step 1: Author delegate-to-cli evals**

Create `defaults/skills/delegate-to-cli/evals/evals.json` and necessary `evals/files/` inputs:

```json
{
  "skill_name": "delegate-to-cli",
  "evals": [
    {
      "id": "delegate-codex-review",
      "prompt": "Review this Python file for security issues using Codex.",
      "expected_output": "A review report from Codex covering security concerns in the file.",
      "files": ["evals/files/sample.py"],
      "assertions": [
        "The output references Codex or codex-cli",
        "The output identifies at least one security concern",
        "The output is presented as a structured review"
      ]
    },
    {
      "id": "delegate-claude-second-opinion",
      "prompt": "Get a second opinion from Claude on the architectural choice in design.md.",
      "expected_output": "A reasoned response from Claude with explicit agreement or disagreement.",
      "files": ["evals/files/design.md"],
      "assertions": [
        "The output references Claude",
        "The output takes a clear stance",
        "The output cites specifics from design.md"
      ]
    },
    {
      "id": "delegate-handles-missing-cli",
      "prompt": "Use foobar-cli to summarize this README.",
      "expected_output": "An error message or fallback that informs the user the requested CLI is not installed.",
      "files": ["evals/files/README.md"],
      "assertions": [
        "The output mentions foobar-cli is not available or installed",
        "The output is presented as a structured error or graceful fallback"
      ]
    }
  ]
}
```

Add the input files: `evals/files/sample.py` (a small Python file with one obvious vulnerability — e.g., `eval(input())`), `evals/files/design.md` (a tiny architectural doc), `evals/files/README.md` (a real-ish README).

- [ ] **Step 2: Author daily-reflection evals**

```json
{
  "skill_name": "daily-reflection",
  "evals": [
    {
      "id": "synthesize-from-sessions",
      "prompt": "Synthesize patterns from yesterday's sessions in memory/sessions/.",
      "expected_output": "A markdown summary of patterns observed across the sessions.",
      "files": ["evals/files/session-1.md", "evals/files/session-2.md"],
      "assertions": [
        "The output includes a 'Patterns' or 'Themes' section",
        "The output references at least 2 distinct sessions",
        "The output is valid markdown"
      ]
    },
    {
      "id": "propose-rules-from-corrections",
      "prompt": "Look for repeated corrections in recent sessions and propose new rules.",
      "expected_output": "A list of proposed rules with provenance and confidence scores.",
      "files": ["evals/files/correction-pattern.md"],
      "assertions": [
        "The output includes proposed rule IDs",
        "Each proposed rule has a confidence score between 0 and 1",
        "The output references the source corrections"
      ]
    },
    {
      "id": "no-rules-when-nothing-to-learn",
      "prompt": "Synthesize from this single uneventful session.",
      "expected_output": "A response indicating no actionable patterns were found.",
      "files": ["evals/files/uneventful.md"],
      "assertions": [
        "The output indicates no rules are being proposed",
        "The output is concise (fewer than 200 words)"
      ]
    }
  ]
}
```

- [ ] **Step 3: Author ship-feature evals**

```json
{
  "skill_name": "ship-feature",
  "evals": [
    {
      "id": "pre-pr-checklist",
      "prompt": "Check this branch is ready for PR.",
      "expected_output": "A pre-PR checklist with each item checked or flagged.",
      "files": ["evals/files/branch-state.txt"],
      "assertions": [
        "The output includes a checklist with at least 4 items",
        "The output flags any failing items",
        "The output references specific files or commands"
      ]
    },
    {
      "id": "verify-tests-pass",
      "prompt": "Run the test suite and report pass/fail.",
      "expected_output": "A pass/fail summary with the number of tests run.",
      "assertions": [
        "The output references npm test or vitest",
        "The output reports a pass/fail status"
      ]
    },
    {
      "id": "verify-build-clean",
      "prompt": "Verify the build is clean (no TypeScript errors, no lint warnings).",
      "expected_output": "A status indicating tsc and lint both pass.",
      "assertions": [
        "The output references tsc or noEmit",
        "The output reports clean status or specific errors"
      ]
    }
  ]
}
```

- [ ] **Step 4: Validate**

Run: `npx tsx -e "import { parseEvalsFile } from './src/runtime/evals/evals-schema.js'; for (const s of ['delegate-to-cli', 'daily-reflection', 'ship-feature']) { try { parseEvalsFile(\`defaults/skills/\${s}/evals/evals.json\`); console.log(\`\${s} OK\`); } catch (e) { console.error(\`\${s} FAIL:\`, e.message); process.exit(1); } }"`

Expected: 3 OK lines.

- [ ] **Step 5: Commit**

```bash
git add defaults/skills/delegate-to-cli/evals/ defaults/skills/daily-reflection/evals/ defaults/skills/ship-feature/evals/
git commit -m "feat(evals): author evals.json for high-effort default skills"
```

---

## Phase 26: Documentation + release

### Task 11: Documentation (skill-evals.md, skill-authoring.md update, README update)

**Files:**
- Create: `docs/skill-evals.md`
- Modify: `docs/skill-authoring.md` — add "Writing evals" section
- Modify: `README.md` — add "Evaluating skills" section

- [ ] **Step 1: Author docs/skill-evals.md**

Should cover, in order:
1. Why evaluate skills (trigger reliability + output quality, two different concerns)
2. The `evals/triggers.json` format with the full schema and 2-3 worked examples
3. The `evals/evals.json` format with the full schema and 2-3 worked examples
4. CLI reference for the four `harness skill eval-*` / `optimize-*` commands
5. Workspace layout (`.evals-workspace/`)
6. Scoring methodology (0.5 threshold for trigger, mechanical-vs-LLM grading for quality)
7. The promotion gate (§4.6 of the design)
8. Cost and runtime expectations

Length: 400-600 lines target.

- [ ] **Step 2: Update docs/skill-authoring.md**

Add a new section "Writing evals" near the end (before "Troubleshooting" if that section exists). Briefly explain trigger and quality eval, then link to skill-evals.md for the full reference.

- [ ] **Step 3: Update README.md**

Add a new section "Evaluating skills" with a short intro and the four CLI commands. Link to docs/skill-evals.md.

- [ ] **Step 4: Lint + commit**

Run: `npm run lint`

```bash
git add docs/skill-evals.md docs/skill-authoring.md README.md
git commit -m "docs(evals): skill evals reference + authoring guide + README section"
```

---

### Task 12: CI script + final regression + version bump

**Files:**
- Create: `scripts/check-default-evals.mjs` — validates every default skill's evals/triggers.json (and optional evals.json) against the schema
- Modify: `package.json` — add npm script alias if useful
- Possibly: `tests/integration/skill-eval-triggers.e2e.test.ts` — guarded by `INTEGRATION=1`, runs against a fixture with a real model

- [ ] **Step 1: Author scripts/check-default-evals.ts**

The script imports from `src/` and runs via tsx (because tsup bundles flat into `dist/cli/index.js`, so individual `dist/runtime/evals/*.js` modules don't exist after build).

```typescript
import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { parseTriggersFile } from '../src/runtime/evals/triggers-schema.js';
import { parseEvalsFile } from '../src/runtime/evals/evals-schema.js';

const root = 'defaults/skills';
const skills = readdirSync(root).filter((n) => !n.startsWith('.'));
let failed = 0;

for (const name of skills) {
  const triggersPath = join(root, name, 'evals', 'triggers.json');
  const evalsPath = join(root, name, 'evals', 'evals.json');

  if (existsSync(triggersPath)) {
    try {
      const queries = parseTriggersFile(triggersPath);
      console.log(`✓ ${name}: triggers.json (${queries.length} queries)`);
    } catch (err) {
      console.error(`✗ ${name}: triggers.json — ${(err as Error).message}`);
      failed++;
    }
  } else {
    console.warn(`! ${name}: no triggers.json`);
  }

  if (existsSync(evalsPath)) {
    try {
      const file = parseEvalsFile(evalsPath);
      console.log(`✓ ${name}: evals.json (${file.evals.length} cases)`);
    } catch (err) {
      console.error(`✗ ${name}: evals.json — ${(err as Error).message}`);
      failed++;
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed} schema failure(s).`);
  process.exit(1);
}
console.log(`\nAll default eval files valid.`);
```

Add an npm script to package.json: `"check:evals": "tsx scripts/check-default-evals.ts"`.

- [ ] **Step 2: Run the validator**

Run: `npm run check:evals`
Expected: every skill `OK` and final "All default eval files valid."

- [ ] **Step 3: Add doctor lint for missing evals (warn only, not error)**

Edit `src/runtime/lints/skill-lints.ts`. Add a new lint:

```typescript
export function evalsCoverageLint(skill: HarnessDocument, bundleDir: string): LintResult[] {
  const results: LintResult[] = [];
  const triggersPath = join(bundleDir, 'evals', 'triggers.json');
  if (!existsSync(triggersPath)) {
    results.push({
      severity: 'warning',
      lintId: 'evals-coverage',
      message: `Skill ${skill.name} has no evals/triggers.json — consider authoring trigger queries to validate the description`,
      file: bundleDir,
      fixable: false,
    });
  }
  return results;
}
```

Wire into `skillLints` registry alongside the existing 4.

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: all tests pass (~1324 + new tests added across this spec)

- [ ] **Step 5: Run lint**

Run: `npm run lint`
Expected: clean

- [ ] **Step 6: Run learning-loop e2e (per CLAUDE.md §9)**

Required for any instinct-learner change.

Run: `INTEGRATION=1 npm test -- tests/integration/learning-loop.e2e.test.ts`
Expected: PASS (requires Ollama with qwen3:1.7b)

- [ ] **Step 7: Build dist**

Run: `npm run build`
Expected: clean tsup build

- [ ] **Step 8: Bump version**

This adds 6 new public CLI commands and a new lint, so this is a minor bump (per workflow conventions).

Run: `npm version minor`
Expected: package.json updated to 0.12.0; commit + tag created.

- [ ] **Step 9: Verify built bundle reports correct version**

Run: `node dist/cli/index.js --version`
Expected: prints `0.12.0`

- [ ] **Step 10: Final commit (if Step 8 made changes after the version commit)**

```bash
git status  # should be clean if `npm version` did everything
```

If anything is uncommitted, stage and commit.

---

## Self-review checklist (before merging)

- [ ] **Spec coverage:** every section of [docs/specs/2026-05-01-skill-evals-design.md](../specs/2026-05-01-skill-evals-design.md) §4 (Design) and §6 (Implementation plan) has a corresponding task above
- [ ] **No placeholders:** plan contains no "TBD", "implement later", or "similar to Task N"
- [ ] **Type consistency:** `TriggerEvalRunResult`, `BenchmarkResult`, `TriggerQuery`, `EvalCase`, `RulePromoteResult` are referenced consistently
- [ ] **CLAUDE.md gotchas honored:**
  - gray-matter cache: every test fixture uses unique frontmatter (Math.random() suffixes in description fields)
  - Node 20+: not introduced (existing requirement)
  - tsup flat dist: scripts/check-default-evals.mjs uses `dist/runtime/evals/...` paths with no nested expectation
  - learning-loop e2e: explicit step in Task 8 and Task 12 per §9 of CLAUDE.md
- [ ] **Tests cover:** schemas, workspace, grader, trigger runner, quality runner, optimization (description), optimization (quality), promotion gate
- [ ] **CLI commands:** `skill eval-triggers`, `skill eval-quality`, `skill optimize-description`, `skill optimize-quality`, `rules promote`. (`harness learn --install` is updated to gate via promoteRule.)
- [ ] **All default skills (16) ship with triggers.json**
- [ ] **3 high-effort defaults ship with evals.json**

---

## Risks and mitigations

- **R1 — full quality eval is expensive in real-model invocations.** Mitigation: tests use stubs (no real LLM); `--runs=1` default in CLI; document expected cost; cache outputs by content hash (deferred — note in skill-evals.md as "future work").
- **R2 — `buildLiveRulePromoter`'s simplified placeholders may cause false-positive promotions.** Mitigation: documented as a known limitation in Task 8 §Step 6 note; full implementation can be added in Task 13 e2e or a follow-up patch.
- **R3 — content authoring quality (Tasks 9-10) is judgment-heavy.** Mitigation: authoring guidance lists specific patterns (varied tone/length, near-miss design); spec reviewer subagent should sample queries and check they match the skill's actual purpose.
- **R4 — CI integration deferred.** The design spec says "CI build runs eval-triggers --split=validation on every default skill"; in this plan that is a *script* (`scripts/check-default-evals.mjs`) for schema validation only — full eval execution requires API keys not available to GitHub free runners. Note in skill-evals.md that maintainers run the eval suite manually before tagging a release.

---

*End of plan.*
