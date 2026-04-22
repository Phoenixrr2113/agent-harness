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

/**
 * Overwrite the state.json for a run. Creates the run directory if needed.
 */
export function writeState(harnessDir: string, state: RunState): void {
  const path = statePath(harnessDir, state.runId);
  mkdirSync(join(runsDir(harnessDir), state.runId), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Read the state.json for a run. Returns null if the state does not exist.
 */
export function readState(harnessDir: string, runId: string): RunState | null {
  const path = statePath(harnessDir, runId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as RunState;
}

/**
 * List every run ID that has a state.json on disk.
 */
export function listRunIds(harnessDir: string): string[] {
  const dir = runsDir(harnessDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => {
    const st = join(dir, name, 'state.json');
    return existsSync(st) && statSync(st).isFile();
  });
}
