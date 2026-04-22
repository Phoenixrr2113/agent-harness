---
title: Durable workflows via filesystem-backed event log
status: draft
author: Randy Wilson
date: 2026-04-21
target_version: "0.7.0"
supersedes: 2026-04-21-durable-workflows-design.md (WDK draft, superseded after spike)
---

# Durable workflows via filesystem-backed event log

## Goal

Add crash-recoverable, resumable, scheduler-driven workflow execution to
agent-harness with no user-facing compile step, no external dependency, and
the markdown authoring surface unchanged. Scheduled workflows that opt in via
`durable: true` frontmatter get:

1. **Mid-run crash recovery** — tool calls that completed before a crash
   return cached results on retry; the model's tool loop converges without
   re-firing side effects.
2. **Missed-run replay** — runs that should have fired while the scheduler
   was down get picked up on next boot.
3. **Future: pause/resume** — a `sleep_until` tool exposed to the LLM that
   suspends a run and wakes it later (deferred to v0.8.0).

## Why not Vercel WDK

A spike against WDK's standalone builder + LocalWorld confirmed the library
is tightly designed around framework-hosted execution (Next / Nitro /
Astro). The workflow bundle runs in a bare `node:vm` sandbox that excludes
Node builtins; WDK's own dependencies (ulid → node:crypto) are bundled in and
throw `ReferenceError: require is not defined` on workflow start. Making this
work would require patching bundle output or maintaining a fork. The features
we'd be paying for (cross-deployment replay, framework routing, skew
protection) are not features we need.

Building our own durability layer — ~500 LOC — preserves markdown-first
authoring, avoids VM sandbox brittleness, and ships faster. This spec assumes
approach C.

## Non-goals

- LLM call caching. Model responses are non-deterministic; we accept that
  replay may produce different model text as long as tool calls converge.
- Cross-machine replay. Runs are tied to the laptop's filesystem.
- Distributed or multi-process execution. One scheduler owns its harness dir.
- Interactive `harness run` / `harness chat` durability — stays non-durable.

## Context

Today, `scheduler.ts` fires a workflow at its cron time by calling
`agent.run(prompt)` once. The workflow body is the prompt. AI SDK's internal
tool loop drives tool execution. Session records are written only after the
full run completes. If the process dies mid-run, tool calls may have fired
with no record; next cron tick starts over from scratch.

## Architecture

A small filesystem-backed event log lives at `<harnessDir>/.workflow-data/`.
For each durable run:

```
.workflow-data/
├── runs/
│   └── <run-id>/
│       ├── state.json          ← status, wake_time, workflow_id, prompt, started, ended
│       ├── events.jsonl        ← append-only event log (started / step_completed / finished / failed)
│       └── steps/
│           └── <step-hash>.json ← cached tool-call result, keyed by hash(kind, ordinal, args)
└── version                     ← schema version marker
```

Durable execution flows:

1. **Start**: `scheduler.executeWorkflow()` sees `durable: true` → calls
   `durableRun(prompt, harnessDir, config, state)` instead of `agent.run(prompt)`.
2. **Run context**: `durableRun` creates a fresh run id (or reuses an
   incomplete one for resume), writes `state.json` with `status: 'running'`,
   builds the tool set and wraps each tool's `execute` with a cache-check
   wrapper that keys by `hash(toolName, ordinalInRun, args)`. The ordinal is
   a monotonically-incrementing counter per run.
3. **LLM loop**: delegates to AI SDK's `generateText` as today — we do NOT
   refactor the tool loop. Cached tool results short-circuit execution;
   uncached calls fire for real and append to the event log.
4. **Finish**: on return, writes `finished` event and flips `state.json` to
   `status: 'complete'`.
5. **Crash**: if process dies mid-run, `state.json` is left at `status: 'running'`
   with partial `events.jsonl`. Tool results that already completed have
   `steps/<hash>.json` files.
6. **Resume**: on scheduler boot, `scanResumableRuns(harnessDir)` finds
   incomplete runs (status `running` or `suspended` with passed wake-time) and
   re-invokes `durableRun` with the same run id. The wrapped tool set returns
   cached results for prior step hashes; the model's second-pass may take a
   slightly different path, but any repeated tool call with identical args at
   the same ordinal hits the cache.

No new primitives, no directives, no bundling, no VM sandbox. Just filesystem
+ JSON + a wrapper around `tool.execute`.

## Components

### `src/runtime/durable-engine.ts` — the core runtime

```typescript
export interface DurableRunOptions {
  harnessDir: string;
  workflowId: string;
  prompt: string;
  config: HarnessConfig;
  resumeRunId?: string;   // when resuming an existing run
}

export interface DurableRunResult {
  runId: string;
  text: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  steps: number;
  resumed: boolean;
}

export async function durableRun(opts: DurableRunOptions): Promise<DurableRunResult>;

export function scanResumableRuns(harnessDir: string): Array<{
  runId: string;
  workflowId: string;
  status: 'running' | 'suspended';
  startedAt: string;
  wakeTime?: string;
}>;

export function readRunState(harnessDir: string, runId: string): RunState | null;
export function listRuns(harnessDir: string): RunSummary[];
export function deleteRun(harnessDir: string, runId: string): void;
export function cleanupOldRuns(harnessDir: string, olderThanDays: number): number;
```

### `src/runtime/durable-cache.ts` — step-result caching

Pure functions over the `.workflow-data/runs/<run-id>/steps/` directory.

```typescript
export function hashStep(toolName: string, ordinal: number, args: unknown): string;
export function loadStep(harnessDir: string, runId: string, stepHash: string): unknown | undefined;
export function saveStep(harnessDir: string, runId: string, stepHash: string, result: unknown): void;
```

Step hashes are stable across replays for the same (tool, ordinal, args) triple.
Args are canonicalized (sorted keys) before hashing.

### `src/runtime/durable-tools.ts` — tool wrapper

```typescript
export function wrapToolsWithCache(
  tools: AIToolSet,
  ctx: { harnessDir: string; runId: string; ordinalCounter: { value: number } },
): AIToolSet;
```

Each wrapped tool's `execute`:
1. Increments `ctx.ordinalCounter.value`.
2. Computes `stepHash = hashStep(toolName, ordinal, args)`.
3. Looks up the cache; returns cached on hit.
4. Calls the original `execute`; writes `step_started` event, awaits result,
   writes `step_completed` event with the hash, saves to cache, returns.
5. On throw, writes `step_failed` event; re-throws. Next replay will retry.

Side-effectful tools (file writes, shell exec, HTTP POSTs) thus re-run at
most once per unique (ordinal, args) — a significant safety improvement over
"re-run the whole workflow from scratch."

### `src/runtime/durable-events.ts` — append-only event log

```typescript
export type DurableEvent =
  | { type: 'started'; runId: string; workflowId: string; prompt: string; at: string }
  | { type: 'step_started'; ordinal: number; toolName: string; at: string; hash: string }
  | { type: 'step_completed'; ordinal: number; toolName: string; at: string; hash: string }
  | { type: 'step_failed'; ordinal: number; toolName: string; at: string; hash: string; error: string }
  | { type: 'finished'; at: string; text: string; usage: Usage }
  | { type: 'failed'; at: string; error: string }
  | { type: 'suspended'; at: string; wakeTime: string };

export function appendEvent(harnessDir: string, runId: string, event: DurableEvent): void;
export function readEvents(harnessDir: string, runId: string): DurableEvent[];
```

JSONL format. Atomic append via `fs.appendFileSync` (small lines, single process per harness).

### `src/runtime/durable-state.ts` — run status file

Simple read/write of `.workflow-data/runs/<run-id>/state.json`:
```json
{
  "runId": "run_xxx",
  "workflowId": "daily-summary",
  "prompt": "...",
  "status": "complete|running|suspended|failed",
  "startedAt": "2026-04-21T10:00:00.000Z",
  "endedAt": "2026-04-21T10:02:13.000Z",
  "wakeTime": null,
  "lastOrdinal": 7
}
```

`status: 'running'` on a run from a previous process indicates a crash → eligible for resume.

### Scheduler integration

```typescript
// src/runtime/scheduler.ts — inside executeWorkflow()
const isDurable =
  doc.frontmatter.durable === true || config.workflows?.durable_default === true;

if (isDurable) {
  const result = await durableRun({
    harnessDir: this.harnessDir,
    workflowId,
    prompt,
    config,
  });
  resultText = result.text;
  tokensUsed = result.usage.totalTokens;
} else {
  // existing agent.run() path, unchanged
}
```

Boot-time resume in `Scheduler.start()`:
```typescript
const resumable = scanResumableRuns(this.harnessDir);
for (const { runId, wakeTime } of resumable) {
  if (wakeTime && new Date(wakeTime) > new Date()) continue;
  try {
    await durableRun({ harnessDir: this.harnessDir, workflowId, prompt, config, resumeRunId: runId });
  } catch (err) {
    log.warn(`Failed to resume run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

No refactor of AI SDK, no `generateTurn`, no provider changes.

## Storage, state & ops

- `.workflow-data/` directory inside the harness dir.
- `.workflow-data/version` tracks our own schema version (`"1"` for v0.7.0).
  On boot, if the version is newer than we understand, log a warning and
  refuse to resume. If older and a migration is known, run it; otherwise
  refuse and tell the user to run `harness workflows cleanup --force`.
- Scaffolder adds `.workflow-data/` to the generated `.gitignore`.
- Retention: `memory.workflow_retention_days` (default 30) applied by
  `harness workflows cleanup`.

New CLI subcommands (under `harness workflows`):
- `status` — table of runs with status, started time, duration.
- `resume <runId>` — manually resume an incomplete run.
- `cleanup [--older-than <days>] [--force]` — delete completed runs older
  than N days; `--force` deletes all runs regardless of status (escape hatch
  for schema migration).
- `inspect <runId>` — pretty-print the run's `state.json` + `events.jsonl`.

## Error handling & retry

Simpler than WDK's RetryableError / FatalError taxonomy. We only distinguish:
- **Tool call throws** → append `step_failed`, re-throw so AI SDK's own retry
  (`maxRetries: 2` by default on the model call) can handle it.
- **Exhausted retries** → `failed` event, `state.json.status = 'failed'`. The
  scheduler's existing `max_retries` / `retry_delay_ms` frontmatter logic
  applies at the run level (not step level).
- **LLM call fails entirely** → caught by the existing `createHarness`
  error path, which already has health/failure recording. Durable runs
  additionally write a `failed` event to their event log.

No new error types.

## Config additions

```yaml
workflows:
  # Apply durability to every markdown workflow by default, even without
  # `durable: true` in frontmatter. Default false (opt-in per-workflow).
  durable_default: false

memory:
  workflow_retention_days: 30
```

Frontmatter:
```yaml
---
id: workflow-daily-summary
schedule: "0 22 * * *"
durable: true
---
```

## Testing

Unit tests (no external deps, tmpdir-scoped):
- `tests/durable-cache.test.ts` — hashStep determinism, load/save roundtrip,
  cache miss semantics.
- `tests/durable-events.test.ts` — append/read correctness, atomic appends.
- `tests/durable-engine.test.ts` — durableRun lifecycle: fresh run, happy
  path; resume of incomplete run returns cached tool results and eventually
  completes; failed tool logs event and propagates.
- `tests/durable-tools.test.ts` — wrap behaviour: cache hit skips real
  execute; unique ordinals produce unique hashes.
- `tests/cli-workflows.test.ts` — subcommand behaviour (empty dir, seeded runs).
- `tests/scheduler-durable.test.ts` — durable dispatch flag; boot-time scan
  of resumable runs.

Integration test (`INTEGRATION=1` gated, local-only, Ollama):
- `tests/integration/workflow-resume.e2e.test.ts` — run a durable workflow
  with 3 tool calls against `qwen3:1.7b`; kill the process after step 2 via
  SIGKILL on a child process; restart scheduler and resume; assert the run
  completes and steps/ contains exactly 3 cached results (no duplicates).

Gated like the existing learning-loop test. CI doesn't run it; CLAUDE.md is
updated with the must-run-locally reminder.

## Deferred / future

- **`sleep_until` tool** for the LLM — suspends run, wakes on schedule.
  v0.8.0 candidate; straightforward extension: new event type `suspended`,
  `state.status = 'suspended'`, `wakeTime` set; scheduler boot-scan already
  handles it.
- **LLM call caching** — middleware that caches `(messages, model)` →
  `text + toolCalls`. Would make replay fully deterministic; defer until we
  see evidence it matters.
- **Multi-step workflows with named checkpoints** — require a different UX
  (not just "a run"); defer until requested.
- **Webhook-triggered hooks** — would need a local HTTP listener; out of
  scope for v0.7.0.

## Risks & mitigations

1. **Step ordinal drift under non-determinism.** If the LLM takes a different
   path on replay (calls tool B before tool A instead of A before B), the
   ordinals don't line up and cached results miss. In practice, with a stable
   prompt and cached prior tool outputs, convergence is common but not
   guaranteed. **Mitigation:** log cache miss events and surface in `inspect`
   so divergence is visible. If this hurts in practice, add (toolName, args-only)
   fallback keying as a secondary cache layer.
2. **Concurrent resumes.** If the scheduler boots while another scheduler
   process is already running in the same harness dir, two resumers could
   fight over the same run. **Mitigation:** a simple lockfile at
   `.workflow-data/runs/<run-id>/.lock` acquired at durableRun entry;
   release on exit (including abnormal exit via process.on('exit')). Stale
   locks older than N minutes are considered abandoned.
3. **Disk usage growth.** Unbounded runs = unbounded disk. **Mitigation:**
   retention via `memory.workflow_retention_days` + `harness workflows cleanup`.
4. **Schema evolution.** Our event types / state fields may need to change.
   **Mitigation:** `.workflow-data/version` marker + refuse-with-guidance on
   mismatch. Migrations are per-version functions registered in the engine.

## Ship target

v0.7.0. No breaking changes — durability is opt-in per-workflow. No new
npm dependencies. No build pipeline changes.
