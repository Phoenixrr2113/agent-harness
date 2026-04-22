import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export type DurableUsage = { inputTokens: number; outputTokens: number; totalTokens: number };

export type DurableEvent =
  | { type: 'started'; runId: string; workflowId: string; prompt: string; at: string }
  | { type: 'step_started'; ordinal: number; toolName: string; at: string; hash: string }
  | { type: 'step_completed'; ordinal: number; toolName: string; at: string; hash: string }
  | { type: 'step_cached'; ordinal: number; toolName: string; at: string; hash: string }
  | { type: 'step_failed'; ordinal: number; toolName: string; at: string; hash: string; error: string }
  | { type: 'finished'; at: string; text: string; usage: DurableUsage }
  | { type: 'failed'; at: string; error: string }
  | { type: 'suspended'; at: string; wakeTime: string };

function eventsPath(harnessDir: string, runId: string): string {
  return join(harnessDir, '.workflow-data', 'runs', runId, 'events.jsonl');
}

/**
 * Append a single event to the run's JSONL log.
 * Creates parent directories if missing.
 */
export function appendEvent(harnessDir: string, runId: string, event: DurableEvent): void {
  const path = eventsPath(harnessDir, runId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(event) + '\n');
}

/**
 * Read all events for a run in append order.
 * Returns an empty array when the log file does not yet exist.
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
