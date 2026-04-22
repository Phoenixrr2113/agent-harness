import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness } from '../core/harness.js';
import { log } from '../core/logger.js';
import type { AgentRunResult } from '../core/types.js';
import { appendEvent } from './durable-events.js';
import { writeState, readState, listRunIds, type RunState, type RunStatus } from './durable-state.js';
import { wrapToolsWithCache, type DurableRunContext } from './durable-tools.js';
import type { AIToolSet } from './tool-executor.js';

export interface DurableRunOptions {
  harnessDir: string;
  workflowId: string;
  prompt: string;
  resumeRunId?: string;
  apiKey?: string;
  /** Test-only injection point. Replaces the real `createHarness + agent.run` path. */
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
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  wakeTime?: string;
}

function newRunId(): string {
  return `run_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

/**
 * Execute a workflow with filesystem-backed durability. If `resumeRunId` is
 * given, reuse that run's cache dir so previously-completed tool calls
 * short-circuit on replay. Otherwise start a fresh run with a new id.
 */
export async function durableRun(opts: DurableRunOptions): Promise<DurableRunResult> {
  const { harnessDir, workflowId, prompt, resumeRunId, apiKey } = opts;

  const runId = resumeRunId ?? newRunId();
  const existing = readState(harnessDir, runId);
  const resumed = existing !== null;
  const startedAt = existing?.startedAt ?? new Date().toISOString();
  const lastOrdinal = existing?.lastOrdinal ?? 0;

  writeState(harnessDir, {
    runId,
    workflowId,
    prompt,
    status: 'running',
    startedAt,
    lastOrdinal,
  });
  if (!resumed) {
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
    wrapToolSet: (tools) => wrapToolsWithCache(tools as AIToolSet, args.ctx) as unknown as Record<string, unknown>,
  });
  try {
    return await agent.run(args.prompt);
  } finally {
    try {
      await agent.shutdown();
    } catch (err) {
      log.warn(`Durable-run shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Scan the harness's run dir for incomplete runs:
 *   - `running` status → process crashed mid-run → resumable now.
 *   - `suspended` status with wakeTime ≤ now → sleep expired → resumable now.
 */
export function scanResumableRuns(harnessDir: string): RunSummary[] {
  const now = Date.now();
  const out: RunSummary[] = [];
  for (const runId of listRunIds(harnessDir)) {
    const state = readState(harnessDir, runId);
    if (!state) continue;
    if (state.status === 'running') {
      out.push(toSummary(state));
    } else if (state.status === 'suspended' && state.wakeTime && new Date(state.wakeTime).getTime() <= now) {
      out.push(toSummary(state));
    }
  }
  return out;
}

/**
 * List every run that has a state file, in no particular order.
 */
export function listRuns(harnessDir: string): RunSummary[] {
  return listRunIds(harnessDir)
    .map((id) => readState(harnessDir, id))
    .filter((s): s is RunState => s !== null)
    .map(toSummary);
}

/**
 * Delete finished (complete or failed) runs whose most-recent timestamp is
 * older than the retention cutoff. Returns the number deleted. Running and
 * suspended runs are always preserved.
 */
export function cleanupOldRuns(harnessDir: string, olderThanDays: number): number {
  const cutoff = Date.now() - olderThanDays * 86400_000;
  let deleted = 0;
  for (const runId of listRunIds(harnessDir)) {
    const state = readState(harnessDir, runId);
    if (!state) continue;
    if (state.status !== 'complete' && state.status !== 'failed') continue;
    const ts = new Date(state.endedAt ?? state.startedAt).getTime();
    if (ts < cutoff) {
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

/**
 * Remove a single run's directory on disk regardless of its status.
 */
export function deleteRun(harnessDir: string, runId: string): void {
  rmSync(join(harnessDir, '.workflow-data', 'runs', runId), { recursive: true, force: true });
}

function toSummary(s: RunState): RunSummary {
  return {
    runId: s.runId,
    workflowId: s.workflowId,
    status: s.status,
    startedAt: s.startedAt,
    ...(s.endedAt ? { endedAt: s.endedAt } : {}),
    ...(s.wakeTime ? { wakeTime: s.wakeTime } : {}),
  };
}
