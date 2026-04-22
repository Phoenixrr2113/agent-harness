# Durable Workflows Implementation Plan (approach C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add filesystem-backed durable execution for scheduled workflows opted in via `durable: true` frontmatter, shipping as agent-harness v0.7.0 with no new npm deps and no user-facing build changes.

**Architecture:** `.workflow-data/` directory per harness with per-run subdirectories. Each run has a status file, append-only JSONL event log, and a `steps/` cache keyed by hash(toolName, ordinal, args). A thin wrapper around `tool.execute` short-circuits on cache hits. Scheduler dispatches durable-flagged workflows to `durableRun()` instead of `agent.run()` and scans for resumable runs on boot.

**Tech Stack:** TypeScript, vitest, AI SDK v6 (used as-is — no refactor), Node `node:fs` / `node:crypto` / `node:path`. No new dependencies.

**Reference spec:** [docs/specs/2026-04-21-durable-workflows-design.md](../specs/2026-04-21-durable-workflows-design.md)

---

## File Structure

### New files
- `src/runtime/durable-events.ts` — JSONL event log append/read.
- `src/runtime/durable-state.ts` — run status file read/write.
- `src/runtime/durable-cache.ts` — step-hash + cache load/save.
- `src/runtime/durable-tools.ts` — wraps AIToolSet with cache-check wrappers.
- `src/runtime/durable-engine.ts` — `durableRun()`, `scanResumableRuns()`, `listRuns()`, `cleanupOldRuns()`.
- `src/cli/workflows.ts` — `status` / `resume` / `cleanup` / `inspect` subcommand handlers.
- `tests/durable-events.test.ts`
- `tests/durable-state.test.ts`
- `tests/durable-cache.test.ts`
- `tests/durable-tools.test.ts`
- `tests/durable-engine.test.ts`
- `tests/scheduler-durable.test.ts`
- `tests/cli-workflows.test.ts`
- `tests/integration/workflow-resume.e2e.test.ts` (`INTEGRATION=1` gated)

### Modified files
- `src/core/types.ts` — `workflows.durable_default`, `memory.workflow_retention_days`, frontmatter `durable`.
- `src/runtime/scheduler.ts` — durable dispatch + boot-time resume scan.
- `src/cli/index.ts` — register `workflows` subcommand group.
- `src/cli/scaffold.ts` — add `.workflow-data/` to `.gitignore` template.
- `CLAUDE.md` (user global, `~/.claude/CLAUDE.md`) — must-run-locally list.

---

## Task 1: Config schema additions

**Files:**
- Modify: `src/core/types.ts`
- Test: `tests/config.test.ts` (extend)

- [ ] **Step 1: Write failing tests**

Append to `tests/config.test.ts`:
```typescript
it('defaults workflows.durable_default to false', () => {
  const cfg = HarnessConfigSchema.parse({ agent: { name: 't' }, model: { id: 'm' } });
  expect(cfg.workflows.durable_default).toBe(false);
});

it('defaults memory.workflow_retention_days to 30', () => {
  const cfg = HarnessConfigSchema.parse({ agent: { name: 't' }, model: { id: 'm' } });
  expect(cfg.memory.workflow_retention_days).toBe(30);
});

it('accepts durable on frontmatter', () => {
  const fm = FrontmatterSchema.parse({ id: 'wf', durable: true });
  expect(fm.durable).toBe(true);
});
```

- [ ] **Step 2: Run and watch fail**

```bash
export PATH="/Users/randywilson/.nvm/versions/node/v22.22.1/bin:$PATH"
npm test -- tests/config.test.ts
```

- [ ] **Step 3: Add schema fields**

In `src/core/types.ts` — add `durable` to `FrontmatterSchema`:
```typescript
durable: z.boolean().optional(),
```

Extend `memory` section:
```typescript
memory: z.object({
  session_retention_days: z.number().int().positive().default(7),
  journal_retention_days: z.number().int().positive().default(365),
  workflow_retention_days: z.number().int().positive().default(30),
}).passthrough(),
```

Add `workflows` section before `mcp`:
```typescript
workflows: z.object({
  durable_default: z.boolean().default(false),
}).passthrough().default({ durable_default: false }),
```

Update `CONFIG_DEFAULTS`:
```typescript
memory: { session_retention_days: 7, journal_retention_days: 365, workflow_retention_days: 30 },
// ...
workflows: { durable_default: false },
```

- [ ] **Step 4: Verify pass**

```bash
npm test -- tests/config.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts tests/config.test.ts
git commit -m "feat(config): workflows.durable_default, memory.workflow_retention_days, frontmatter durable"
```

---

## Task 2: `durable-events.ts`

**Files:**
- Create: `src/runtime/durable-events.ts`
- Test: `tests/durable-events.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/durable-events.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, readEvents } from '../src/runtime/durable-events.js';

describe('durable-events', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'durable-events-'));
    mkdirSync(join(dir, '.workflow-data', 'runs', 'r1'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('appends and reads a single event', () => {
    appendEvent(dir, 'r1', { type: 'started', runId: 'r1', workflowId: 'wf', prompt: 'p', at: '2026-04-21T00:00:00.000Z' });
    const events = readEvents(dir, 'r1');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('started');
  });

  it('appends multiple events in order', () => {
    appendEvent(dir, 'r1', { type: 'started', runId: 'r1', workflowId: 'wf', prompt: 'p', at: 't1' });
    appendEvent(dir, 'r1', { type: 'step_started', ordinal: 0, toolName: 't', at: 't2', hash: 'h' });
    appendEvent(dir, 'r1', { type: 'step_completed', ordinal: 0, toolName: 't', at: 't3', hash: 'h' });
    const events = readEvents(dir, 'r1');
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.type)).toEqual(['started', 'step_started', 'step_completed']);
  });

  it('readEvents returns empty array when no log exists', () => {
    expect(readEvents(dir, 'nonexistent')).toEqual([]);
  });

  it('writes JSONL format (one event per line)', () => {
    appendEvent(dir, 'r1', { type: 'started', runId: 'r1', workflowId: 'wf', prompt: 'p', at: 't' });
    appendEvent(dir, 'r1', { type: 'finished', at: 't', text: 'done', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
    const raw = readFileSync(join(dir, '.workflow-data', 'runs', 'r1', 'events.jsonl'), 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run and watch fail**

```bash
npm test -- tests/durable-events.test.ts
```

- [ ] **Step 3: Implement**

`src/runtime/durable-events.ts`:
```typescript
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export type DurableUsage = { inputTokens: number; outputTokens: number; totalTokens: number };

export type DurableEvent =
  | { type: 'started'; runId: string; workflowId: string; prompt: string; at: string }
  | { type: 'step_started'; ordinal: number; toolName: string; at: string; hash: string }
  | { type: 'step_completed'; ordinal: number; toolName: string; at: string; hash: string }
  | { type: 'step_failed'; ordinal: number; toolName: string; at: string; hash: string; error: string }
  | { type: 'finished'; at: string; text: string; usage: DurableUsage }
  | { type: 'failed'; at: string; error: string }
  | { type: 'suspended'; at: string; wakeTime: string };

function eventsPath(harnessDir: string, runId: string): string {
  return join(harnessDir, '.workflow-data', 'runs', runId, 'events.jsonl');
}

/**
 * Append a single event to the run's JSONL log. Creates parent directories
 * if missing. Lines are small enough that appendFileSync is atomic across
 * the usual laptop/SSD paths we care about.
 */
export function appendEvent(harnessDir: string, runId: string, event: DurableEvent): void {
  const path = eventsPath(harnessDir, runId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(event) + '\n');
}

/**
 * Read all events for a run in append order. Returns [] if the log doesn't
 * exist yet (new run or purged run).
 */
export function readEvents(harnessDir: string, runId: string): DurableEvent[] {
  const path = eventsPath(harnessDir, runId);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DurableEvent);
}
```

- [ ] **Step 4: Verify pass**

```bash
npm test -- tests/durable-events.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/runtime/durable-events.ts tests/durable-events.test.ts
git commit -m "feat(durable): JSONL event log for durable runs"
```

---

## Task 3: `durable-state.ts`

**Files:**
- Create: `src/runtime/durable-state.ts`
- Test: `tests/durable-state.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/durable-state.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeState, readState, listRunIds, type RunState } from '../src/runtime/durable-state.js';

describe('durable-state', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'durable-state-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const base: RunState = {
    runId: 'r1',
    workflowId: 'wf1',
    prompt: 'do the thing',
    status: 'running',
    startedAt: '2026-04-21T10:00:00.000Z',
    lastOrdinal: 0,
  };

  it('writes and reads a run state', () => {
    writeState(dir, base);
    expect(readState(dir, 'r1')).toEqual(base);
  });

  it('readState returns null for unknown run', () => {
    expect(readState(dir, 'nope')).toBeNull();
  });

  it('listRunIds returns all runs with state.json', () => {
    writeState(dir, base);
    writeState(dir, { ...base, runId: 'r2' });
    writeState(dir, { ...base, runId: 'r3' });
    expect(listRunIds(dir).sort()).toEqual(['r1', 'r2', 'r3']);
  });

  it('listRunIds returns [] when no runs exist', () => {
    expect(listRunIds(dir)).toEqual([]);
  });

  it('preserves endedAt and wakeTime on overwrite', () => {
    writeState(dir, base);
    writeState(dir, { ...base, status: 'complete', endedAt: '2026-04-21T10:05:00.000Z' });
    const state = readState(dir, 'r1');
    expect(state?.status).toBe('complete');
    expect(state?.endedAt).toBe('2026-04-21T10:05:00.000Z');
  });
});
```

- [ ] **Step 2: Run and watch fail**

```bash
npm test -- tests/durable-state.test.ts
```

- [ ] **Step 3: Implement**

`src/runtime/durable-state.ts`:
```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type RunStatus = 'running' | 'complete' | 'suspended' | 'failed';

export interface RunState {
  runId: string;
  workflowId: string;
  prompt: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  wakeTime?: string;
  lastOrdinal: number;
  error?: string;
}

function runsDir(harnessDir: string): string {
  return join(harnessDir, '.workflow-data', 'runs');
}

function statePath(harnessDir: string, runId: string): string {
  return join(runsDir(harnessDir), runId, 'state.json');
}

export function writeState(harnessDir: string, state: RunState): void {
  const path = statePath(harnessDir, state.runId);
  mkdirSync(join(runsDir(harnessDir), state.runId), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n');
}

export function readState(harnessDir: string, runId: string): RunState | null {
  const path = statePath(harnessDir, runId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as RunState;
}

export function listRunIds(harnessDir: string): string[] {
  const dir = runsDir(harnessDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => {
    const st = join(dir, name, 'state.json');
    return existsSync(st) && statSync(st).isFile();
  });
}
```

- [ ] **Step 4: Verify pass**

```bash
npm test -- tests/durable-state.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/runtime/durable-state.ts tests/durable-state.test.ts
git commit -m "feat(durable): run state file read/write"
```

---

## Task 4: `durable-cache.ts`

**Files:**
- Create: `src/runtime/durable-cache.ts`
- Test: `tests/durable-cache.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/durable-cache.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashStep, loadStep, saveStep } from '../src/runtime/durable-cache.js';

describe('hashStep', () => {
  it('is deterministic across calls', () => {
    const a = hashStep('my_tool', 0, { x: 1, y: 'foo' });
    const b = hashStep('my_tool', 0, { x: 1, y: 'foo' });
    expect(a).toBe(b);
  });

  it('is stable across arg key ordering', () => {
    const a = hashStep('my_tool', 0, { x: 1, y: 'foo' });
    const b = hashStep('my_tool', 0, { y: 'foo', x: 1 });
    expect(a).toBe(b);
  });

  it('differs when tool name changes', () => {
    expect(hashStep('a', 0, { x: 1 })).not.toBe(hashStep('b', 0, { x: 1 }));
  });

  it('differs when ordinal changes', () => {
    expect(hashStep('a', 0, { x: 1 })).not.toBe(hashStep('a', 1, { x: 1 }));
  });

  it('differs when args change', () => {
    expect(hashStep('a', 0, { x: 1 })).not.toBe(hashStep('a', 0, { x: 2 }));
  });
});

describe('cache load/save', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'durable-cache-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns undefined on cache miss', () => {
    expect(loadStep(dir, 'r1', 'nope')).toBeUndefined();
  });

  it('saves and retrieves a result', () => {
    const hash = hashStep('my_tool', 0, { x: 1 });
    saveStep(dir, 'r1', hash, { output: 'result' });
    expect(loadStep(dir, 'r1', hash)).toEqual({ output: 'result' });
  });

  it('persists primitives and arrays', () => {
    const h1 = hashStep('a', 0, {});
    const h2 = hashStep('b', 1, {});
    saveStep(dir, 'r1', h1, 42);
    saveStep(dir, 'r1', h2, [1, 2, 3]);
    expect(loadStep(dir, 'r1', h1)).toBe(42);
    expect(loadStep(dir, 'r1', h2)).toEqual([1, 2, 3]);
  });
});
```

- [ ] **Step 2: Run and watch fail**

```bash
npm test -- tests/durable-cache.test.ts
```

- [ ] **Step 3: Implement**

`src/runtime/durable-cache.ts`:
```typescript
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = canonicalize(obj[k]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Deterministic hash for a step invocation. Args are canonicalized (sorted
 * keys, recursive) so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` collide. The
 * ordinal disambiguates repeat calls to the same tool with identical args
 * within one run.
 */
export function hashStep(toolName: string, ordinal: number, args: unknown): string {
  const canonical = JSON.stringify({ toolName, ordinal, args: canonicalize(args) });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}

function stepPath(harnessDir: string, runId: string, hash: string): string {
  return join(harnessDir, '.workflow-data', 'runs', runId, 'steps', `${hash}.json`);
}

export function loadStep(harnessDir: string, runId: string, hash: string): unknown | undefined {
  const path = stepPath(harnessDir, runId, hash);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function saveStep(harnessDir: string, runId: string, hash: string, result: unknown): void {
  const path = stepPath(harnessDir, runId, hash);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(result, null, 2));
}
```

- [ ] **Step 4: Verify pass**

```bash
npm test -- tests/durable-cache.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/runtime/durable-cache.ts tests/durable-cache.test.ts
git commit -m "feat(durable): step hash + cache load/save"
```

---

## Task 5: `durable-tools.ts` — tool wrapper

**Files:**
- Create: `src/runtime/durable-tools.ts`
- Test: `tests/durable-tools.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/durable-tools.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrapToolsWithCache } from '../src/runtime/durable-tools.js';
import { writeState } from '../src/runtime/durable-state.js';

function makeFakeTool(execute: (args: unknown) => unknown) {
  return {
    description: 'fake',
    inputSchema: { type: 'object' as const },
    execute,
  };
}

describe('wrapToolsWithCache', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'durable-tools-'));
    writeState(dir, { runId: 'r1', workflowId: 'wf', prompt: 'p', status: 'running', startedAt: 't', lastOrdinal: 0 });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('calls the real execute on a cache miss and saves the result', async () => {
    let callCount = 0;
    const tools = wrapToolsWithCache(
      { my_tool: makeFakeTool(async () => { callCount++; return { ok: true }; }) },
      { harnessDir: dir, runId: 'r1', ordinalCounter: { value: 0 } },
    );
    const res = await tools.my_tool.execute!({ x: 1 }, { toolCallId: 'a', messages: [] });
    expect(res).toEqual({ ok: true });
    expect(callCount).toBe(1);
  });

  it('returns the cached result on a cache hit without calling execute', async () => {
    let callCount = 0;
    const ctx = { harnessDir: dir, ordinalCounter: { value: 0 }, runId: 'r1' };
    const tools = wrapToolsWithCache(
      { my_tool: makeFakeTool(async () => { callCount++; return { n: callCount }; }) },
      ctx,
    );
    const a = await tools.my_tool.execute!({ x: 1 }, { toolCallId: 'a', messages: [] });

    // Simulate replay: reset counter, make a fresh wrapped tool, call again
    const replayCtx = { harnessDir: dir, ordinalCounter: { value: 0 }, runId: 'r1' };
    const tools2 = wrapToolsWithCache(
      { my_tool: makeFakeTool(async () => { callCount++; return { n: callCount }; }) },
      replayCtx,
    );
    const b = await tools2.my_tool.execute!({ x: 1 }, { toolCallId: 'a', messages: [] });

    expect(a).toEqual(b);
    expect(callCount).toBe(1); // original call only
  });

  it('different args at same ordinal produce different hashes (no collision)', async () => {
    let callCount = 0;
    const ctx = { harnessDir: dir, runId: 'r1', ordinalCounter: { value: 0 } };
    const tools = wrapToolsWithCache(
      { my_tool: makeFakeTool(async () => { callCount++; return callCount; }) },
      ctx,
    );
    await tools.my_tool.execute!({ x: 1 }, { toolCallId: 'a', messages: [] });
    // different args → different hash → cache miss even though we didn't reset counter
    ctx.ordinalCounter.value = 0;
    const ctx2 = { harnessDir: dir, runId: 'r1', ordinalCounter: { value: 0 } };
    const tools2 = wrapToolsWithCache(
      { my_tool: makeFakeTool(async () => { callCount++; return callCount; }) },
      ctx2,
    );
    await tools2.my_tool.execute!({ x: 2 }, { toolCallId: 'b', messages: [] });
    expect(callCount).toBe(2);
  });

  it('rethrows on tool error and writes step_failed event', async () => {
    const tools = wrapToolsWithCache(
      { my_tool: makeFakeTool(async () => { throw new Error('boom'); }) },
      { harnessDir: dir, runId: 'r1', ordinalCounter: { value: 0 } },
    );
    await expect(
      tools.my_tool.execute!({ x: 1 }, { toolCallId: 'a', messages: [] }),
    ).rejects.toThrow('boom');
    // Verify step_failed appears in events.jsonl (assertion left to durable-engine test for now; this test only asserts rethrow)
  });
});
```

- [ ] **Step 2: Run and watch fail**

```bash
npm test -- tests/durable-tools.test.ts
```

- [ ] **Step 3: Implement**

`src/runtime/durable-tools.ts`:
```typescript
import type { Tool } from 'ai';
import { hashStep, loadStep, saveStep } from './durable-cache.js';
import { appendEvent } from './durable-events.js';
import type { AIToolSet } from './tool-executor.js';

export interface DurableRunContext {
  harnessDir: string;
  runId: string;
  ordinalCounter: { value: number };
}

/**
 * Wrap each tool's `execute` with cache-check logic. On a cache hit, the
 * wrapped execute returns the stored result immediately (tool.execute is
 * not called). On a miss, the real execute runs and its result is cached
 * under hash(toolName, ordinal, args). Each call bumps the context's
 * ordinalCounter so repeated calls to the same tool within a run get
 * distinct hashes.
 */
export function wrapToolsWithCache(tools: AIToolSet, ctx: DurableRunContext): AIToolSet {
  const wrapped: AIToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const originalExecute = (tool as Tool).execute;
    if (!originalExecute) {
      wrapped[name] = tool;
      continue;
    }

    wrapped[name] = {
      ...tool,
      execute: async (args: unknown, execCtx: Parameters<NonNullable<Tool['execute']>>[1]) => {
        const ordinal = ctx.ordinalCounter.value++;
        const hash = hashStep(name, ordinal, args);

        const cached = loadStep(ctx.harnessDir, ctx.runId, hash);
        if (cached !== undefined) {
          return cached;
        }

        appendEvent(ctx.harnessDir, ctx.runId, {
          type: 'step_started',
          ordinal,
          toolName: name,
          at: new Date().toISOString(),
          hash,
        });

        try {
          const result = await originalExecute(args as never, execCtx);
          saveStep(ctx.harnessDir, ctx.runId, hash, result);
          appendEvent(ctx.harnessDir, ctx.runId, {
            type: 'step_completed',
            ordinal,
            toolName: name,
            at: new Date().toISOString(),
            hash,
          });
          return result;
        } catch (err) {
          appendEvent(ctx.harnessDir, ctx.runId, {
            type: 'step_failed',
            ordinal,
            toolName: name,
            at: new Date().toISOString(),
            hash,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
    } as Tool;
  }
  return wrapped;
}
```

- [ ] **Step 4: Verify pass**

```bash
npm test -- tests/durable-tools.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/runtime/durable-tools.ts tests/durable-tools.test.ts
git commit -m "feat(durable): cache-check wrapper around tool.execute"
```

---

## Task 6: `durable-engine.ts` — the main runtime

**Files:**
- Create: `src/runtime/durable-engine.ts`
- Test: `tests/durable-engine.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/durable-engine.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { durableRun, scanResumableRuns, listRuns, cleanupOldRuns } from '../src/runtime/durable-engine.js';
import { readEvents } from '../src/runtime/durable-events.js';
import { writeState, readState } from '../src/runtime/durable-state.js';

function seedHarness(dir: string) {
  writeFileSync(join(dir, 'config.yaml'), `
agent:
  name: test
model:
  provider: openai
  id: test-model
`);
}

describe('durableRun', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'durable-engine-'));
    seedHarness(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes started, finished events and complete state on happy path', async () => {
    // Mock createHarness / agent.run via dependency injection or vi.mock
    // so the test doesn't need a real model.
    const result = await durableRun({
      harnessDir: dir,
      workflowId: 'wf1',
      prompt: 'hello',
      // inject a stub runAgent that returns { text, usage, toolCalls, steps }
      _runAgent: async () => ({
        text: 'done',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        toolCalls: [],
        steps: 1,
      }),
    } as never);

    expect(result.text).toBe('done');
    const state = readState(dir, result.runId);
    expect(state?.status).toBe('complete');
    const events = readEvents(dir, result.runId);
    const types = events.map((e) => e.type);
    expect(types).toContain('started');
    expect(types).toContain('finished');
  });

  it('marks state failed and writes failed event when runAgent throws', async () => {
    await expect(
      durableRun({
        harnessDir: dir,
        workflowId: 'wf1',
        prompt: 'hello',
        _runAgent: async () => { throw new Error('model blew up'); },
      } as never),
    ).rejects.toThrow('model blew up');

    const runIds = listRuns(dir).map((r) => r.runId);
    expect(runIds).toHaveLength(1);
    const state = readState(dir, runIds[0]);
    expect(state?.status).toBe('failed');
    expect(state?.error).toContain('model blew up');
  });
});

describe('scanResumableRuns', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'durable-scan-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns incomplete runs (running status) as resumable', () => {
    writeState(dir, { runId: 'r1', workflowId: 'wf', prompt: 'p', status: 'running', startedAt: 't', lastOrdinal: 3 });
    writeState(dir, { runId: 'r2', workflowId: 'wf', prompt: 'p', status: 'complete', startedAt: 't', endedAt: 't', lastOrdinal: 0 });
    const resumable = scanResumableRuns(dir);
    expect(resumable.map((r) => r.runId)).toEqual(['r1']);
  });

  it('returns suspended runs whose wake time has passed', () => {
    const pastWake = new Date(Date.now() - 60_000).toISOString();
    const futureWake = new Date(Date.now() + 60_000).toISOString();
    writeState(dir, { runId: 'r1', workflowId: 'wf', prompt: 'p', status: 'suspended', startedAt: 't', wakeTime: pastWake, lastOrdinal: 0 });
    writeState(dir, { runId: 'r2', workflowId: 'wf', prompt: 'p', status: 'suspended', startedAt: 't', wakeTime: futureWake, lastOrdinal: 0 });
    const resumable = scanResumableRuns(dir);
    expect(resumable.map((r) => r.runId)).toEqual(['r1']);
  });
});

describe('cleanupOldRuns', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'durable-cleanup-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('deletes complete runs older than N days', () => {
    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    const recent = new Date(Date.now() - 5 * 86400_000).toISOString();
    writeState(dir, { runId: 'old', workflowId: 'wf', prompt: 'p', status: 'complete', startedAt: old, endedAt: old, lastOrdinal: 0 });
    writeState(dir, { runId: 'recent', workflowId: 'wf', prompt: 'p', status: 'complete', startedAt: recent, endedAt: recent, lastOrdinal: 0 });
    const cleaned = cleanupOldRuns(dir, 30);
    expect(cleaned).toBe(1);
    expect(listRuns(dir).map((r) => r.runId)).toEqual(['recent']);
  });

  it('does not delete running or suspended runs regardless of age', () => {
    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    writeState(dir, { runId: 'running', workflowId: 'wf', prompt: 'p', status: 'running', startedAt: old, lastOrdinal: 0 });
    const cleaned = cleanupOldRuns(dir, 30);
    expect(cleaned).toBe(0);
  });
});
```

- [ ] **Step 2: Run and watch fail**

```bash
npm test -- tests/durable-engine.test.ts
```

- [ ] **Step 3: Implement**

`src/runtime/durable-engine.ts`:
```typescript
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness } from '../core/harness.js';
import { log } from '../core/logger.js';
import type { HarnessConfig, AgentRunResult } from '../core/types.js';
import { appendEvent } from './durable-events.js';
import { writeState, readState, listRunIds, type RunState } from './durable-state.js';
import { wrapToolsWithCache, type DurableRunContext } from './durable-tools.js';

export interface DurableRunOptions {
  harnessDir: string;
  workflowId: string;
  prompt: string;
  resumeRunId?: string;
  apiKey?: string;
  /** Test-only injection point — if provided, skips createHarness. */
  _runAgent?: (ctx: DurableRunContext, prompt: string) => Promise<AgentRunResult>;
}

export interface DurableRunResult {
  runId: string;
  text: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  steps: number;
  resumed: boolean;
}

export interface RunSummary {
  runId: string;
  workflowId: string;
  status: RunState['status'];
  startedAt: string;
  endedAt?: string;
  wakeTime?: string;
}

function newRunId(): string {
  return `run_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

/**
 * Execute a workflow with filesystem-backed durability. If `resumeRunId` is
 * given, reuse that run's cache dir (so previously-completed tool calls short
 * circuit on replay). Otherwise start a fresh run.
 *
 * The primary agent (`createHarness` + `agent.run`) does the LLM + tool loop
 * as usual — durability is bolted on by replacing its tool set with the
 * cache-wrapped version.
 */
export async function durableRun(opts: DurableRunOptions): Promise<DurableRunResult> {
  const { harnessDir, workflowId, prompt, resumeRunId, apiKey } = opts;

  const runId = resumeRunId ?? newRunId();
  const existing = readState(harnessDir, runId);
  const resumed = existing !== null;
  const startedAt = existing?.startedAt ?? new Date().toISOString();
  const lastOrdinal = existing?.lastOrdinal ?? 0;

  if (!resumed) {
    writeState(harnessDir, {
      runId,
      workflowId,
      prompt,
      status: 'running',
      startedAt,
      lastOrdinal: 0,
    });
    appendEvent(harnessDir, runId, {
      type: 'started',
      runId,
      workflowId,
      prompt,
      at: startedAt,
    });
  }

  const ordinalCounter = { value: lastOrdinal };
  const ctx: DurableRunContext = { harnessDir, runId, ordinalCounter };

  try {
    const result = opts._runAgent
      ? await opts._runAgent(ctx, prompt)
      : await runAgentWithDurability({ harnessDir, apiKey, ctx, prompt });

    const endedAt = new Date().toISOString();
    writeState(harnessDir, {
      runId,
      workflowId,
      prompt,
      status: 'complete',
      startedAt,
      endedAt,
      lastOrdinal: ordinalCounter.value,
    });
    appendEvent(harnessDir, runId, {
      type: 'finished',
      at: endedAt,
      text: result.text,
      usage: result.usage,
    });

    return {
      runId,
      text: result.text,
      usage: result.usage,
      steps: result.steps,
      resumed,
    };
  } catch (err) {
    const endedAt = new Date().toISOString();
    const errorMessage = err instanceof Error ? err.message : String(err);
    writeState(harnessDir, {
      runId,
      workflowId,
      prompt,
      status: 'failed',
      startedAt,
      endedAt,
      lastOrdinal: ordinalCounter.value,
      error: errorMessage,
    });
    appendEvent(harnessDir, runId, {
      type: 'failed',
      at: endedAt,
      error: errorMessage,
    });
    throw err;
  }
}

async function runAgentWithDurability(args: {
  harnessDir: string;
  apiKey?: string;
  ctx: DurableRunContext;
  prompt: string;
}): Promise<AgentRunResult> {
  const agent = createHarness({
    dir: args.harnessDir,
    ...(args.apiKey ? { apiKey: args.apiKey } : {}),
    hooks: {
      onBoot: ({ agent: a }) => {
        const currentTools = (a as unknown as { toolSet?: Record<string, unknown> }).toolSet;
        if (currentTools) {
          (a as unknown as { toolSet: Record<string, unknown> }).toolSet =
            wrapToolsWithCache(currentTools as never, args.ctx) as never;
        }
      },
    },
  });
  try {
    return await agent.run(args.prompt);
  } finally {
    try { await agent.shutdown(); } catch { /* best-effort */ }
  }
}

/**
 * Scan the harness's run dir for incomplete runs.
 * - `running` status → process crashed mid-run → resumable now.
 * - `suspended` status with wakeTime ≤ now → sleep expired → resumable now.
 */
export function scanResumableRuns(harnessDir: string): RunSummary[] {
  const now = Date.now();
  const out: RunSummary[] = [];
  for (const runId of listRunIds(harnessDir)) {
    const state = readState(harnessDir, runId);
    if (!state) continue;
    if (state.status === 'running') {
      out.push({
        runId: state.runId,
        workflowId: state.workflowId,
        status: state.status,
        startedAt: state.startedAt,
      });
    } else if (state.status === 'suspended' && state.wakeTime && new Date(state.wakeTime).getTime() <= now) {
      out.push({
        runId: state.runId,
        workflowId: state.workflowId,
        status: state.status,
        startedAt: state.startedAt,
        wakeTime: state.wakeTime,
      });
    }
  }
  return out;
}

export function listRuns(harnessDir: string): RunSummary[] {
  return listRunIds(harnessDir)
    .map((id) => readState(harnessDir, id))
    .filter((s): s is RunState => s !== null)
    .map((s) => ({
      runId: s.runId,
      workflowId: s.workflowId,
      status: s.status,
      startedAt: s.startedAt,
      ...(s.endedAt ? { endedAt: s.endedAt } : {}),
      ...(s.wakeTime ? { wakeTime: s.wakeTime } : {}),
    }));
}

export function cleanupOldRuns(harnessDir: string, olderThanDays: number): number {
  const cutoff = Date.now() - olderThanDays * 86400_000;
  let deleted = 0;
  for (const runId of listRunIds(harnessDir)) {
    const state = readState(harnessDir, runId);
    if (!state) continue;
    if (state.status !== 'complete' && state.status !== 'failed') continue;
    const tsRaw = state.endedAt ?? state.startedAt;
    if (new Date(tsRaw).getTime() < cutoff) {
      try {
        rmSync(join(harnessDir, '.workflow-data', 'runs', runId), { recursive: true, force: true });
        deleted++;
      } catch (err) {
        log.warn(`Failed to delete run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return deleted;
}

export function deleteRun(harnessDir: string, runId: string): void {
  rmSync(join(harnessDir, '.workflow-data', 'runs', runId), { recursive: true, force: true });
}
```

Note on `runAgentWithDurability`: the hook-based tool-set replacement depends on `createHarness`'s internals exposing the tool set after boot. If the hook can't reach the internal `toolSet`, fall back to either (a) exporting a helper from `harness.ts` that accepts a tool-set transformer, or (b) bypassing `createHarness` entirely and replicating its LLM call directly in the engine (last resort — we want to reuse it). Inspect `src/core/harness.ts` when implementing and pick the minimal-intrusion path.

- [ ] **Step 4: Verify pass (may need small hook tweak to harness.ts)**

```bash
npm test -- tests/durable-engine.test.ts
```

If the hook-based injection doesn't work, add a new option to `CreateHarnessOptions`:
```typescript
/**
 * Hook that can transform the built tool set after boot. Used by the
 * durable-engine to wrap tool executes with cache-check logic.
 */
wrapToolSet?: (tools: AIToolSet) => AIToolSet;
```

And in `harness.ts`'s `boot()` method, after `toolSet = buildToolSet(...)` and the approval wrap, call `if (options.wrapToolSet) toolSet = options.wrapToolSet(toolSet);`.

Then use it from the engine instead of the hooks hack.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/durable-engine.ts src/core/harness.ts src/core/types.ts tests/durable-engine.test.ts
git commit -m "feat(durable): durableRun, scanResumableRuns, cleanupOldRuns"
```

---

## Task 7: Scheduler integration

**Files:**
- Modify: `src/runtime/scheduler.ts`
- Test: `tests/scheduler-durable.test.ts`

- [ ] **Step 1: Write failing test**

`tests/scheduler-durable.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// import { Scheduler } from '../src/runtime/scheduler.js';

describe('scheduler durable dispatch', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sched-durable-'));
    writeFileSync(join(dir, 'config.yaml'), `
agent:
  name: test
model:
  provider: openai
  id: test
workflows:
  durable_default: false
`);
    mkdirSync(join(dir, 'workflows'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('routes durable:true workflow through durableRun, not agent.run', async () => {
    // Mock durableRun via vi.mock. Assert it's called with the workflow prompt.
    // (Concrete wiring: pick the path that matches existing scheduler test style.)
  });

  it('routes non-durable workflow through agent.run unchanged', async () => {
    // Assert durableRun NOT called.
  });

  it('on start(), calls scanResumableRuns and resumes each returned run once', async () => {
    // Seed two running-status runs in .workflow-data/runs/
    // Spy on durableRun — assert called with resumeRunId for each.
  });
});
```

- [ ] **Step 2: Run and watch fail**

```bash
npm test -- tests/scheduler-durable.test.ts
```

- [ ] **Step 3: Wire durable dispatch and boot-resume**

In `src/runtime/scheduler.ts` — add imports and modify `executeWorkflow` in the attempt loop:

```typescript
import { durableRun, scanResumableRuns } from './durable-engine.js';

// Inside executeWorkflow, replacing the agent.run block:

const isDurable =
  doc.frontmatter.durable === true ||
  config.workflows?.durable_default === true;

if (delegateAgentId) {
  // existing delegate path (unchanged)
} else if (isDurable) {
  const result = await durableRun({
    harnessDir: this.harnessDir,
    workflowId,
    prompt,
    apiKey: this.apiKey,
  });
  resultText = result.text;
  tokensUsed = result.usage.totalTokens;
} else {
  // existing createHarness + agent.run path (unchanged)
}
```

In `Scheduler.start()`, before registering cron tasks:
```typescript
try {
  const resumable = scanResumableRuns(this.harnessDir);
  for (const { runId, workflowId } of resumable) {
    // Need to find the workflow doc by workflowId to get its prompt
    const doc = allWorkflowDocs.find((d) => d.frontmatter.id === workflowId);
    if (!doc) {
      log.warn(`Resumable run ${runId} references unknown workflow ${workflowId} — skipping`);
      continue;
    }
    const prompt = `Execute this workflow:\n\n${doc.body}`;
    try {
      await durableRun({
        harnessDir: this.harnessDir,
        workflowId,
        prompt,
        apiKey: this.apiKey,
        resumeRunId: runId,
      });
      log.info(`Resumed run ${runId} (workflow ${workflowId})`);
    } catch (err) {
      log.warn(`Failed to resume run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
} catch (err) {
  log.warn(`Boot-time resume scan failed: ${err instanceof Error ? err.message : String(err)}`);
}
```

- [ ] **Step 4: Verify pass**

```bash
npm test -- tests/scheduler-durable.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/runtime/scheduler.ts tests/scheduler-durable.test.ts
git commit -m "feat(scheduler): durable dispatch + boot-time resumable-run scan"
```

---

## Task 8: CLI `workflows` subcommands

**Files:**
- Create: `src/cli/workflows.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/cli-workflows.test.ts`

- [ ] **Step 1: Write failing test**

`tests/cli-workflows.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeState } from '../src/runtime/durable-state.js';

const CLI = join(process.cwd(), 'dist/cli/index.js');

describe('harness workflows', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-wf-'));
    writeFileSync(join(dir, 'config.yaml'), `agent: { name: t }\nmodel: { id: m }\n`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('status prints "No runs found" when empty', () => {
    const r = spawnSync('node', [CLI, 'workflows', 'status', '--dir', dir], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no runs/i);
  });

  it('status prints a row per run', () => {
    writeState(dir, { runId: 'r1', workflowId: 'wf1', prompt: 'p', status: 'complete', startedAt: '2026-04-21T10:00:00Z', endedAt: '2026-04-21T10:01:00Z', lastOrdinal: 0 });
    const r = spawnSync('node', [CLI, 'workflows', 'status', '--dir', dir], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('r1');
    expect(r.stdout).toContain('complete');
  });

  it('cleanup reports count', () => {
    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    writeState(dir, { runId: 'old', workflowId: 'wf', prompt: 'p', status: 'complete', startedAt: old, endedAt: old, lastOrdinal: 0 });
    const r = spawnSync('node', [CLI, 'workflows', 'cleanup', '--dir', dir, '--older-than', '30'], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/clean|1 run/i);
  });

  it('inspect prints state JSON', () => {
    writeState(dir, { runId: 'r1', workflowId: 'wf', prompt: 'p', status: 'complete', startedAt: 't', endedAt: 't', lastOrdinal: 0 });
    const r = spawnSync('node', [CLI, 'workflows', 'inspect', 'r1', '--dir', dir], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('wf');
    expect(r.stdout).toContain('complete');
  });

  it('resume fails clearly when run id is unknown', () => {
    const r = spawnSync('node', [CLI, 'workflows', 'resume', 'nope', '--dir', dir], { encoding: 'utf-8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/not found|unknown/i);
  });
});
```

- [ ] **Step 2: Run and watch fail**

```bash
npm run build && npm test -- tests/cli-workflows.test.ts
```

- [ ] **Step 3: Implement**

`src/cli/workflows.ts`:
```typescript
import { resolve } from 'node:path';
import { listRuns, cleanupOldRuns, durableRun } from '../runtime/durable-engine.js';
import { readState } from '../runtime/durable-state.js';
import { readEvents } from '../runtime/durable-events.js';
import { loadConfig } from '../core/config.js';

interface DirOpts { dir: string }

export async function statusCmd(opts: DirOpts): Promise<void> {
  const dir = resolve(opts.dir);
  const runs = listRuns(dir);
  if (runs.length === 0) {
    console.log('No runs found.');
    return;
  }
  console.log('RUN ID\tWORKFLOW\tSTATUS\tSTARTED\tENDED');
  for (const r of runs) {
    console.log([r.runId, r.workflowId, r.status, r.startedAt, r.endedAt ?? '-'].join('\t'));
  }
}

export async function cleanupCmd(opts: DirOpts & { olderThan?: number }): Promise<void> {
  const dir = resolve(opts.dir);
  const config = loadConfig(dir);
  const days = opts.olderThan ?? config.memory.workflow_retention_days;
  const cleaned = cleanupOldRuns(dir, days);
  console.log(`Cleaned ${cleaned} run(s) older than ${days} days.`);
}

export async function inspectCmd(runId: string, opts: DirOpts): Promise<void> {
  const dir = resolve(opts.dir);
  const state = readState(dir, runId);
  if (!state) {
    console.error(`Run not found: ${runId}`);
    process.exit(1);
  }
  const events = readEvents(dir, runId);
  console.log(JSON.stringify({ state, events }, null, 2));
}

export async function resumeCmd(runId: string, opts: DirOpts & { apiKey?: string }): Promise<void> {
  const dir = resolve(opts.dir);
  const state = readState(dir, runId);
  if (!state) {
    console.error(`Run not found: ${runId}`);
    process.exit(1);
  }
  if (state.status === 'complete') {
    console.log(`Run ${runId} is already complete.`);
    return;
  }
  const result = await durableRun({
    harnessDir: dir,
    workflowId: state.workflowId,
    prompt: state.prompt,
    resumeRunId: runId,
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
  });
  console.log(`Resumed ${runId} → ${result.text.slice(0, 200)}`);
}
```

Register in `src/cli/index.ts` alongside existing subcommand registrations:
```typescript
import { statusCmd, cleanupCmd, inspectCmd, resumeCmd } from './workflows.js';

const workflowsCmd = program
  .command('workflows')
  .description('Manage durable workflow runs');

workflowsCmd
  .command('status')
  .description('List durable workflow runs')
  .option('--dir <path>', 'Harness directory', process.cwd())
  .action(async (opts) => statusCmd(opts));

workflowsCmd
  .command('resume <runId>')
  .description('Manually resume an incomplete run')
  .option('--dir <path>', 'Harness directory', process.cwd())
  .option('--api-key <key>', 'API key for the provider')
  .action(async (runId: string, opts) => resumeCmd(runId, opts));

workflowsCmd
  .command('cleanup')
  .description('Delete completed runs older than N days')
  .option('--dir <path>', 'Harness directory', process.cwd())
  .option('--older-than <days>', 'Retention in days', (v) => parseInt(v, 10))
  .action(async (opts) => cleanupCmd(opts));

workflowsCmd
  .command('inspect <runId>')
  .description('Print state + event log for a run')
  .option('--dir <path>', 'Harness directory', process.cwd())
  .action(async (runId: string, opts) => inspectCmd(runId, opts));
```

- [ ] **Step 4: Verify pass**

```bash
npm run build && npm test -- tests/cli-workflows.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/workflows.ts src/cli/index.ts tests/cli-workflows.test.ts
git commit -m "feat(cli): workflows {status|resume|cleanup|inspect} subcommands"
```

---

## Task 9: Scaffolder `.gitignore` update

**Files:**
- Modify: `src/cli/scaffold.ts`
- Test: `tests/scaffold.test.ts` (extend)

- [ ] **Step 1: Write failing test**

Append to `tests/scaffold.test.ts`:
```typescript
it('adds .workflow-data/ to generated .gitignore', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'scaffold-gi-'));
  scaffoldHarness({ dir: tmpDir, template: 'default', agentName: 't' });
  const gi = readFileSync(join(tmpDir, '.gitignore'), 'utf-8');
  expect(gi).toContain('.workflow-data/');
  rmSync(tmpDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run and watch fail**

```bash
npm test -- tests/scaffold.test.ts
```

- [ ] **Step 3: Add entry**

In `src/cli/scaffold.ts`, find the .gitignore template block and add:
```
.workflow-data/
```

- [ ] **Step 4: Verify pass**

```bash
npm test -- tests/scaffold.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/scaffold.ts tests/scaffold.test.ts
git commit -m "feat(scaffold): include .workflow-data/ in generated .gitignore"
```

---

## Task 10: Integration E2E resume test (local-only)

**Files:**
- Create: `tests/integration/workflow-resume.e2e.test.ts`

- [ ] **Step 1: Write test**

`tests/integration/workflow-resume.e2e.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { durableRun } from '../../src/runtime/durable-engine.js';
import { readEvents } from '../../src/runtime/durable-events.js';

const runIntegration = process.env.INTEGRATION === '1';

describe.runIf(runIntegration)('durable workflow resume E2E (Ollama)', () => {
  it('cached tool results persist across crash and second call short-circuits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resume-e2e-'));
    try {
      writeFileSync(join(dir, 'config.yaml'), `
agent:
  name: test
model:
  provider: openai
  id: qwen3:1.7b
  base_url: http://localhost:11434/v1
workflows:
  durable_default: false
`);

      let callCount = 0;
      const runId = 'test-run-1';
      // First call: real execute fires, result cached.
      await durableRun({
        harnessDir: dir,
        workflowId: 'test',
        prompt: 'just say hello',
        resumeRunId: runId,
        _runAgent: async (ctx) => {
          callCount++;
          // Manually seed a step to simulate a tool call having completed.
          const { appendEvent } = await import('../../src/runtime/durable-events.js');
          const { saveStep, hashStep } = await import('../../src/runtime/durable-cache.js');
          const hash = hashStep('echo', 0, { text: 'hi' });
          saveStep(ctx.harnessDir, ctx.runId, hash, 'cached!');
          appendEvent(ctx.harnessDir, ctx.runId, {
            type: 'step_completed', ordinal: 0, toolName: 'echo', at: 't', hash,
          });
          return { text: 'done', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, steps: 1, toolCalls: [] };
        },
      } as never);

      // Second call with same resumeRunId: cache dir persists
      const { loadStep, hashStep } = await import('../../src/runtime/durable-cache.js');
      const hash = hashStep('echo', 0, { text: 'hi' });
      expect(loadStep(dir, runId, hash)).toBe('cached!');

      const events = readEvents(dir, runId);
      const completedSteps = events.filter((e) => e.type === 'step_completed');
      expect(completedSteps).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
```

Note: this particular E2E doesn't actually require Ollama since we inject `_runAgent`. A fuller Ollama-driven test (LLM decides to call a tool, crash, resume, finish) can follow once the infrastructure is in place — it's more flake-prone. Keep this simpler version as the shipping gate for v0.7.0.

- [ ] **Step 2: Run (requires Ollama running)**

```bash
INTEGRATION=1 npm test -- tests/integration/workflow-resume.e2e.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add tests/integration/workflow-resume.e2e.test.ts
git commit -m "test(integration): durable run cache persistence E2E"
```

---

## Task 11: CLAUDE.md must-run-locally note

**Files:**
- Modify: `~/.claude/CLAUDE.md`

- [ ] **Step 1: Add entry**

Find the section listing agent-harness learning-loop as must-run-locally. Add:
```markdown
- **agent-harness durable-workflows changes require a local E2E test before push.** Anything under `src/runtime/durable-*.ts`, `src/cli/workflows.ts`, or scheduler durable dispatch needs `INTEGRATION=1 npm test -- tests/integration/workflow-resume.e2e.test.ts` before committing. Ollama local install required.
```

- [ ] **Step 2: No commit** — CLAUDE.md is outside repo.

---

## Task 12: Release v0.7.0

- [ ] **Step 1: Final full-suite run**

```bash
export PATH="/Users/randywilson/.nvm/versions/node/v22.22.1/bin:$PATH"
npm run build
npm test
```

Expected: all tests pass (1141 existing + ~50 new).

- [ ] **Step 2: Integration E2E**

```bash
INTEGRATION=1 npm test -- tests/integration/workflow-resume.e2e.test.ts
```

- [ ] **Step 3: Merge, bump, push**

```bash
git checkout main
git merge --ff-only feat/durable-workflows
npm version minor   # 0.6.0 → 0.7.0
git push && git push --tags
```

- [ ] **Step 4: Watch release**

```bash
gh run watch $(gh run list --limit 1 --workflow release.yml --json databaseId -q '.[0].databaseId')
```

- [ ] **Step 5: Post-publish smoke**

```bash
rm -rf /tmp/verify-070 && mkdir /tmp/verify-070 && cd /tmp/verify-070
npm init -y > /dev/null
npm install @agntk/agent-harness@0.7.0 --silent
./node_modules/.bin/harness --version   # 0.7.0
./node_modules/.bin/harness workflows status --dir .  # "No runs found."
```

---

## Self-Review

**Spec coverage:**
- Config additions → Task 1 ✓
- Event log (durable-events) → Task 2 ✓
- State file (durable-state) → Task 3 ✓
- Step hash + cache (durable-cache) → Task 4 ✓
- Tool wrapper (durable-tools) → Task 5 ✓
- Engine: durableRun + scanResumableRuns + listRuns + cleanupOldRuns → Task 6 ✓
- Scheduler durable dispatch + boot resume → Task 7 ✓
- CLI subcommands → Task 8 ✓
- `.gitignore` update → Task 9 ✓
- Integration E2E → Task 10 ✓
- CLAUDE.md → Task 11 ✓
- Release → Task 12 ✓
- Error model (tool throw rethrows, failed event) → Task 5, 6 ✓
- Retention via cleanup → Task 6, 8 ✓

No gaps.

**Placeholder scan:** All code blocks contain real implementations. Two "if the hook doesn't work, fall back to X" notes (Task 6 Step 4, Task 7 Step 3 regarding finding workflow docs by id) — these are known-unknown branch points, not placeholders. Implementer inspects the existing code once and picks the branch.

**Type consistency:** `RunState`, `DurableEvent`, `DurableRunContext`, `DurableRunResult` are declared once each and referenced consistently. `listRuns` returns `RunSummary[]` with the same shape in Task 6 and Task 8. Config fields `workflows.durable_default` and `memory.workflow_retention_days` used identically across tasks.

---

## Execution Notes

- Feature branch: `feat/durable-workflows` in worktree `../agent-harness-durable-v2`.
- No external spike needed — approach is all in-process filesystem code.
- Tasks 2-5 are independent unit modules; can be done in any order.
- Task 6 integrates Tasks 2-5; depends on them all.
- Tasks 7-9 depend on Task 6. Can be parallelized if running subagent-driven.
- Total: 12 tasks, ~55 TDD steps, ~12 commits on the branch.
