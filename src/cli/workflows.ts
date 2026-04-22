import { resolve } from 'node:path';
import { listRuns, cleanupOldRuns, durableRun } from '../runtime/durable-engine.js';
import { readState } from '../runtime/durable-state.js';
import { readEvents } from '../runtime/durable-events.js';
import { loadConfig } from '../core/config.js';

interface DirOpts {
  dir: string;
}

/**
 * `harness workflows status` — tabular listing of durable runs. Prints a
 * friendly "No runs found." line for empty harnesses.
 */
export async function statusCmd(opts: DirOpts): Promise<void> {
  const dir = resolve(opts.dir);
  const runs = listRuns(dir);
  if (runs.length === 0) {
    console.log('No runs found.');
    return;
  }
  console.log(['RUN ID', 'WORKFLOW', 'STATUS', 'STARTED', 'ENDED'].join('\t'));
  for (const r of runs) {
    console.log([r.runId, r.workflowId, r.status, r.startedAt, r.endedAt ?? '-'].join('\t'));
  }
}

/**
 * `harness workflows cleanup [--older-than <days>]` — delete completed and
 * failed runs older than the retention cutoff. Defaults to
 * `memory.workflow_retention_days` from the harness config.
 */
export async function cleanupCmd(opts: DirOpts & { olderThan?: number }): Promise<void> {
  const dir = resolve(opts.dir);
  const config = loadConfig(dir);
  const days = opts.olderThan ?? config.memory.workflow_retention_days;
  const cleaned = cleanupOldRuns(dir, days);
  console.log(`Cleaned ${cleaned} run(s) older than ${days} days.`);
}

/**
 * `harness workflows inspect <runId>` — pretty-print the state file and the
 * full event log for a single run. Exits non-zero when the run is unknown.
 */
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

/**
 * `harness workflows resume <runId>` — manual resume for an incomplete run
 * (e.g. when the scheduler's boot-time drain didn't pick it up).
 */
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
