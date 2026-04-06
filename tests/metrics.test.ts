import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  loadMetrics,
  saveMetrics,
  recordRun,
  getWorkflowStats,
  getAllWorkflowStats,
  clearMetrics,
} from '../src/runtime/metrics.js';
import type { WorkflowRun, MetricsStore } from '../src/runtime/metrics.js';

const TEST_DIR = join(__dirname, '__test_metrics__');

describe('metrics', () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, 'memory'), { recursive: true });
    writeFileSync(join(TEST_DIR, 'CORE.md'), '# Core', 'utf-8');
    writeFileSync(
      join(TEST_DIR, 'config.yaml'),
      `agent:\n  name: test\n  version: "0.1.0"\nmodel:\n  provider: openrouter\n  id: test-model\n  max_tokens: 200000\n`,
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should return empty store when no metrics file exists', () => {
    const store = loadMetrics(TEST_DIR);
    expect(store.runs).toEqual([]);
  });

  it('should save and load metrics', () => {
    const store: MetricsStore = {
      runs: [
        {
          workflow_id: 'test-wf',
          started: '2026-04-01T10:00:00Z',
          ended: '2026-04-01T10:00:05Z',
          duration_ms: 5000,
          success: true,
          tokens_used: 500,
          attempt: 1,
          max_retries: 0,
        },
      ],
      updated: '2026-04-01T10:00:05Z',
    };

    saveMetrics(TEST_DIR, store);

    const loaded = loadMetrics(TEST_DIR);
    expect(loaded.runs).toHaveLength(1);
    expect(loaded.runs[0].workflow_id).toBe('test-wf');
    expect(loaded.runs[0].success).toBe(true);
    expect(loaded.runs[0].tokens_used).toBe(500);
  });

  it('should record a run', () => {
    const run: WorkflowRun = {
      workflow_id: 'daily-report',
      started: '2026-04-01T10:00:00Z',
      ended: '2026-04-01T10:00:03Z',
      duration_ms: 3000,
      success: true,
      tokens_used: 250,
      attempt: 1,
      max_retries: 0,
    };

    recordRun(TEST_DIR, run);

    const store = loadMetrics(TEST_DIR);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0].workflow_id).toBe('daily-report');
  });

  it('should get workflow stats', () => {
    recordRun(TEST_DIR, {
      workflow_id: 'wf-1',
      started: '2026-04-01T10:00:00Z',
      ended: '2026-04-01T10:00:05Z',
      duration_ms: 5000,
      success: true,
      tokens_used: 400,
      attempt: 1,
      max_retries: 0,
    });

    recordRun(TEST_DIR, {
      workflow_id: 'wf-1',
      started: '2026-04-01T11:00:00Z',
      ended: '2026-04-01T11:00:03Z',
      duration_ms: 3000,
      success: true,
      tokens_used: 300,
      attempt: 1,
      max_retries: 0,
    });

    recordRun(TEST_DIR, {
      workflow_id: 'wf-1',
      started: '2026-04-01T12:00:00Z',
      ended: '2026-04-01T12:00:10Z',
      duration_ms: 10000,
      success: false,
      error: 'API timeout',
      attempt: 3,
      max_retries: 2,
    });

    const stats = getWorkflowStats(TEST_DIR, 'wf-1');
    expect(stats).not.toBeNull();
    expect(stats!.total_runs).toBe(3);
    expect(stats!.successes).toBe(2);
    expect(stats!.failures).toBe(1);
    expect(stats!.success_rate).toBeCloseTo(2 / 3);
    expect(stats!.avg_duration_ms).toBe(6000);
    expect(stats!.total_tokens).toBe(700);
    expect(stats!.last_run).toBe('2026-04-01T12:00:10Z');
    expect(stats!.last_success).toBe('2026-04-01T11:00:03Z');
    expect(stats!.last_failure).toBe('2026-04-01T12:00:10Z');
  });

  it('should return null stats for unknown workflow', () => {
    const stats = getWorkflowStats(TEST_DIR, 'nonexistent');
    expect(stats).toBeNull();
  });

  it('should get all workflow stats sorted by most recent', () => {
    recordRun(TEST_DIR, {
      workflow_id: 'old-wf',
      started: '2026-04-01T08:00:00Z',
      ended: '2026-04-01T08:00:05Z',
      duration_ms: 5000,
      success: true,
      attempt: 1,
      max_retries: 0,
    });

    recordRun(TEST_DIR, {
      workflow_id: 'new-wf',
      started: '2026-04-01T12:00:00Z',
      ended: '2026-04-01T12:00:05Z',
      duration_ms: 5000,
      success: true,
      attempt: 1,
      max_retries: 0,
    });

    const all = getAllWorkflowStats(TEST_DIR);
    expect(all).toHaveLength(2);
    expect(all[0].workflow_id).toBe('new-wf');
    expect(all[1].workflow_id).toBe('old-wf');
  });

  it('should clear metrics for a specific workflow', () => {
    recordRun(TEST_DIR, {
      workflow_id: 'wf-a',
      started: '2026-04-01T10:00:00Z',
      ended: '2026-04-01T10:00:05Z',
      duration_ms: 5000,
      success: true,
      attempt: 1,
      max_retries: 0,
    });

    recordRun(TEST_DIR, {
      workflow_id: 'wf-b',
      started: '2026-04-01T10:00:00Z',
      ended: '2026-04-01T10:00:05Z',
      duration_ms: 5000,
      success: true,
      attempt: 1,
      max_retries: 0,
    });

    const removed = clearMetrics(TEST_DIR, 'wf-a');
    expect(removed).toBe(1);

    const store = loadMetrics(TEST_DIR);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0].workflow_id).toBe('wf-b');
  });

  it('should clear all metrics when no workflow specified', () => {
    recordRun(TEST_DIR, {
      workflow_id: 'wf-a',
      started: '2026-04-01T10:00:00Z',
      ended: '2026-04-01T10:00:05Z',
      duration_ms: 5000,
      success: true,
      attempt: 1,
      max_retries: 0,
    });

    recordRun(TEST_DIR, {
      workflow_id: 'wf-b',
      started: '2026-04-01T10:00:00Z',
      ended: '2026-04-01T10:00:05Z',
      duration_ms: 5000,
      success: true,
      attempt: 1,
      max_retries: 0,
    });

    const removed = clearMetrics(TEST_DIR);
    expect(removed).toBe(2);

    const store = loadMetrics(TEST_DIR);
    expect(store.runs).toHaveLength(0);
  });

  it('should handle corrupted metrics file gracefully', () => {
    writeFileSync(join(TEST_DIR, 'memory', 'metrics.json'), 'not json at all', 'utf-8');

    const store = loadMetrics(TEST_DIR);
    expect(store.runs).toEqual([]);
  });

  it('should handle metrics file with wrong shape gracefully', () => {
    writeFileSync(join(TEST_DIR, 'memory', 'metrics.json'), '{"something": "else"}', 'utf-8');

    const store = loadMetrics(TEST_DIR);
    expect(store.runs).toEqual([]);
  });

  it('should trim runs to MAX_RUNS on save', () => {
    const store: MetricsStore = { runs: [], updated: '' };
    // Add 1005 runs
    for (let i = 0; i < 1005; i++) {
      store.runs.push({
        workflow_id: `wf-${i}`,
        started: '2026-04-01T10:00:00Z',
        ended: '2026-04-01T10:00:05Z',
        duration_ms: 5000,
        success: true,
        attempt: 1,
        max_retries: 0,
      });
    }

    saveMetrics(TEST_DIR, store);

    const loaded = loadMetrics(TEST_DIR);
    expect(loaded.runs).toHaveLength(1000);
    // Should keep the most recent (last 1000), so first should be wf-5
    expect(loaded.runs[0].workflow_id).toBe('wf-5');
  });

  it('should create memory directory if it does not exist', () => {
    rmSync(join(TEST_DIR, 'memory'), { recursive: true, force: true });

    recordRun(TEST_DIR, {
      workflow_id: 'test',
      started: '2026-04-01T10:00:00Z',
      ended: '2026-04-01T10:00:05Z',
      duration_ms: 5000,
      success: true,
      attempt: 1,
      max_retries: 0,
    });

    expect(existsSync(join(TEST_DIR, 'memory', 'metrics.json'))).toBe(true);
  });

  it('should track failure runs with error messages', () => {
    recordRun(TEST_DIR, {
      workflow_id: 'failing-wf',
      started: '2026-04-01T10:00:00Z',
      ended: '2026-04-01T10:00:01Z',
      duration_ms: 1000,
      success: false,
      error: 'Connection refused',
      attempt: 3,
      max_retries: 2,
    });

    const store = loadMetrics(TEST_DIR);
    expect(store.runs[0].success).toBe(false);
    expect(store.runs[0].error).toBe('Connection refused');
    expect(store.runs[0].attempt).toBe(3);
    expect(store.runs[0].max_retries).toBe(2);
  });
});
