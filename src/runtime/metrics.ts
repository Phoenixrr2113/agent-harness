import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface WorkflowRun {
  workflow_id: string;
  started: string;
  ended: string;
  duration_ms: number;
  success: boolean;
  error?: string;
  tokens_used?: number;
  attempt: number;
  max_retries: number;
}

export interface MetricsStore {
  runs: WorkflowRun[];
  updated: string;
}

export interface WorkflowStats {
  workflow_id: string;
  total_runs: number;
  successes: number;
  failures: number;
  success_rate: number;
  avg_duration_ms: number;
  total_tokens: number;
  last_run: string;
  last_success: string | null;
  last_failure: string | null;
}

const METRICS_FILE = 'metrics.json';
const MAX_RUNS = 1000;

function getMetricsPath(harnessDir: string): string {
  return join(harnessDir, 'memory', METRICS_FILE);
}

/**
 * Load metrics from the metrics store file.
 * Returns an empty store if the file doesn't exist.
 */
export function loadMetrics(harnessDir: string): MetricsStore {
  const metricsPath = getMetricsPath(harnessDir);
  if (!existsSync(metricsPath)) {
    return { runs: [], updated: new Date().toISOString() };
  }

  try {
    const content = readFileSync(metricsPath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'runs' in parsed &&
      Array.isArray((parsed as MetricsStore).runs)
    ) {
      return parsed as MetricsStore;
    }
    return { runs: [], updated: new Date().toISOString() };
  } catch {
    return { runs: [], updated: new Date().toISOString() };
  }
}

/**
 * Save metrics to the store file. Trims to MAX_RUNS most recent entries.
 */
export function saveMetrics(harnessDir: string, store: MetricsStore): void {
  const memoryDir = join(harnessDir, 'memory');
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }

  // Keep only the most recent runs
  if (store.runs.length > MAX_RUNS) {
    store.runs = store.runs.slice(store.runs.length - MAX_RUNS);
  }

  store.updated = new Date().toISOString();
  const metricsPath = getMetricsPath(harnessDir);
  writeFileSync(metricsPath, JSON.stringify(store, null, 2), 'utf-8');
}

/**
 * Record a workflow run in the metrics store.
 */
export function recordRun(harnessDir: string, run: WorkflowRun): void {
  const store = loadMetrics(harnessDir);
  store.runs.push(run);
  saveMetrics(harnessDir, store);
}

/**
 * Get aggregated stats for a specific workflow.
 */
export function getWorkflowStats(harnessDir: string, workflowId: string): WorkflowStats | null {
  const store = loadMetrics(harnessDir);
  const runs = store.runs.filter((r) => r.workflow_id === workflowId);

  if (runs.length === 0) return null;

  const successes = runs.filter((r) => r.success);
  const failures = runs.filter((r) => !r.success);
  const totalDuration = runs.reduce((sum, r) => sum + r.duration_ms, 0);
  const totalTokens = runs.reduce((sum, r) => sum + (r.tokens_used ?? 0), 0);

  const lastSuccess = successes.length > 0 ? successes[successes.length - 1].ended : null;
  const lastFailure = failures.length > 0 ? failures[failures.length - 1].ended : null;

  return {
    workflow_id: workflowId,
    total_runs: runs.length,
    successes: successes.length,
    failures: failures.length,
    success_rate: runs.length > 0 ? successes.length / runs.length : 0,
    avg_duration_ms: runs.length > 0 ? Math.round(totalDuration / runs.length) : 0,
    total_tokens: totalTokens,
    last_run: runs[runs.length - 1].ended,
    last_success: lastSuccess,
    last_failure: lastFailure,
  };
}

/**
 * Get aggregated stats for all workflows that have been run.
 */
export function getAllWorkflowStats(harnessDir: string): WorkflowStats[] {
  const store = loadMetrics(harnessDir);

  // Collect unique workflow IDs
  const workflowIds = new Set<string>();
  for (const run of store.runs) {
    workflowIds.add(run.workflow_id);
  }

  const stats: WorkflowStats[] = [];
  for (const id of workflowIds) {
    const s = getWorkflowStats(harnessDir, id);
    if (s) stats.push(s);
  }

  // Sort by most recent run
  stats.sort((a, b) => b.last_run.localeCompare(a.last_run));
  return stats;
}

/**
 * Clear all metrics for a specific workflow, or all workflows if no ID given.
 */
export function clearMetrics(harnessDir: string, workflowId?: string): number {
  const store = loadMetrics(harnessDir);
  const before = store.runs.length;

  if (workflowId) {
    store.runs = store.runs.filter((r) => r.workflow_id !== workflowId);
  } else {
    store.runs = [];
  }

  saveMetrics(harnessDir, store);
  return before - store.runs.length;
}
