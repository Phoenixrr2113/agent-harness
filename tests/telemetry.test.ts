import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  collectSnapshot,
  formatDashboard,
} from '../src/runtime/telemetry.js';
import { recordSuccess, recordFailure, recordBoot } from '../src/runtime/health.js';
import { saveMetrics } from '../src/runtime/metrics.js';
import { saveCosts } from '../src/runtime/cost-tracker.js';
import type { TelemetrySnapshot } from '../src/runtime/telemetry.js';

describe('telemetry', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'telemetry-test-'));
    mkdirSync(join(testDir, 'memory'), { recursive: true });
    mkdirSync(join(testDir, 'memory', 'sessions'), { recursive: true });
    mkdirSync(join(testDir, 'memory', 'journal'), { recursive: true });
    mkdirSync(join(testDir, 'rules'), { recursive: true });
    // Create minimal harness files
    writeFileSync(join(testDir, 'CORE.md'), '# Test Agent', 'utf-8');
    writeFileSync(join(testDir, 'config.yaml'), 'agent:\n  name: telemetry-test\n  version: "1.0.0"', 'utf-8');
    writeFileSync(join(testDir, 'state.md'), '---\nmode: idle\ngoals: []\nactive_workflows: []\nunfinished_business: []\nlast_interaction: "2025-01-15T10:00:00Z"\n---\n', 'utf-8');
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('collectSnapshot', () => {
    it('should collect a full snapshot from empty harness', () => {
      const snapshot = collectSnapshot(testDir);

      expect(snapshot.timestamp).toBeDefined();
      expect(snapshot.agent.name).toBe('telemetry-test');
      expect(snapshot.agent.version).toBe('1.0.0');
      expect(snapshot.agent.mode).toBe('idle');
      expect(snapshot.health.status).toBeDefined();
      expect(snapshot.spending.today.total_cost_usd).toBe(0);
      expect(snapshot.sessions.total).toBe(0);
      expect(snapshot.workflows.totalRuns).toBe(0);
      expect(snapshot.storage.sessionCount).toBe(0);
    });

    it('should reflect health metrics', () => {
      recordSuccess(testDir);
      recordSuccess(testDir);
      recordFailure(testDir, 'test error');
      recordBoot(testDir);

      const snapshot = collectSnapshot(testDir);

      expect(snapshot.health.metrics.totalRuns).toBe(3);
      expect(snapshot.health.metrics.totalSuccesses).toBe(2);
      expect(snapshot.health.metrics.totalFailures).toBe(1);
      expect(snapshot.health.metrics.bootedAt).not.toBeNull();
    });

    it('should reflect workflow metrics', () => {
      saveMetrics(testDir, {
        runs: [
          { workflow_id: 'wf-1', started: '2025-01-15T10:00:00Z', ended: '2025-01-15T10:01:00Z', duration_ms: 60000, success: true, tokens_used: 500, attempt: 1, max_retries: 0 },
          { workflow_id: 'wf-1', started: '2025-01-15T11:00:00Z', ended: '2025-01-15T11:01:00Z', duration_ms: 55000, success: false, error: 'timeout', attempt: 1, max_retries: 0 },
          { workflow_id: 'wf-2', started: '2025-01-15T12:00:00Z', ended: '2025-01-15T12:01:00Z', duration_ms: 30000, success: true, tokens_used: 300, attempt: 1, max_retries: 0 },
        ],
        updated: '2025-01-15T12:01:00Z',
      });

      const snapshot = collectSnapshot(testDir);

      expect(snapshot.workflows.totalRuns).toBe(3);
      expect(snapshot.workflows.totalSuccesses).toBe(2);
      expect(snapshot.workflows.totalFailures).toBe(1);
      expect(snapshot.workflows.overallSuccessRate).toBeCloseTo(0.667, 2);
      expect(snapshot.workflows.stats.length).toBe(2);
    });

    it('should reflect cost data', () => {
      const today = new Date().toISOString().split('T')[0];
      saveCosts(testDir, {
        entries: [
          { timestamp: `${today}T08:00:00Z`, model_id: 'anthropic/claude-sonnet-4', provider: 'openrouter', input_tokens: 1000, output_tokens: 500, cost_usd: 0.0105, source: 'run:test-1' },
          { timestamp: `${today}T09:00:00Z`, model_id: 'anthropic/claude-sonnet-4', provider: 'openrouter', input_tokens: 2000, output_tokens: 1000, cost_usd: 0.021, source: 'run:test-2' },
        ],
        updated: `${today}T09:00:00Z`,
      });

      const snapshot = collectSnapshot(testDir);

      expect(snapshot.spending.today.total_cost_usd).toBeCloseTo(0.0315, 4);
      expect(snapshot.spending.today.entries).toBe(2);
      expect(snapshot.spending.thisMonth.entries).toBe(2);
    });

    it('should count storage files', () => {
      // Add session files
      writeFileSync(join(testDir, 'memory', 'sessions', '2025-01-15-abc.md'), '---\nid: test\n---\n', 'utf-8');
      writeFileSync(join(testDir, 'memory', 'sessions', '2025-01-16-def.md'), '---\nid: test2\n---\n', 'utf-8');
      // Add journal file
      writeFileSync(join(testDir, 'memory', 'journal', '2025-01-15.md'), '---\n---\n', 'utf-8');
      // Add primitive
      writeFileSync(join(testDir, 'rules', 'test-rule.md'), '---\nid: test-rule\n---\n', 'utf-8');

      const snapshot = collectSnapshot(testDir);

      expect(snapshot.storage.sessionCount).toBe(2);
      expect(snapshot.storage.journalCount).toBe(1);
      expect(snapshot.storage.primitiveCount).toBe(1);
    });

    it('should skip sections when options are set', () => {
      recordSuccess(testDir);

      const snapshot = collectSnapshot(testDir, {
        skipHealth: true,
        skipSessions: true,
        skipWorkflows: true,
        skipSpending: true,
      });

      // Health is skipped — returns default healthy
      expect(snapshot.health.checks).toHaveLength(0);
      // Sessions skipped
      expect(snapshot.sessions.total).toBe(0);
      // Workflows skipped
      expect(snapshot.workflows.totalRuns).toBe(0);
      // Spending skipped
      expect(snapshot.spending.today.entries).toBe(0);
      // Storage still counted (not skippable)
      expect(snapshot.storage).toBeDefined();
    });

    it('should handle missing config gracefully', () => {
      const bareDir = mkdtempSync(join(tmpdir(), 'telemetry-bare-'));
      mkdirSync(join(bareDir, 'memory'), { recursive: true });

      const snapshot = collectSnapshot(bareDir);
      // loadConfig returns defaults when no config file exists, so name = 'agent'
      expect(snapshot.agent.name).toBeDefined();
      expect(snapshot.timestamp).toBeDefined();

      rmSync(bareDir, { recursive: true, force: true });
    });
  });

  describe('formatDashboard', () => {
    it('should return a non-empty string', () => {
      const snapshot = collectSnapshot(testDir);
      const output = formatDashboard(snapshot);

      expect(output).toBeDefined();
      expect(output.length).toBeGreaterThan(50);
    });

    it('should include agent name in output', () => {
      const snapshot = collectSnapshot(testDir);
      const output = formatDashboard(snapshot);

      expect(output).toContain('telemetry-test');
    });

    it('should include health checks section', () => {
      const snapshot = collectSnapshot(testDir);
      const output = formatDashboard(snapshot);

      expect(output).toContain('Health Checks');
      expect(output).toContain('core-files');
    });

    it('should include spending section', () => {
      const snapshot = collectSnapshot(testDir);
      const output = formatDashboard(snapshot);

      expect(output).toContain('Spending');
      expect(output).toContain('Today:');
      expect(output).toContain('Month:');
    });

    it('should include sessions section', () => {
      const snapshot = collectSnapshot(testDir);
      const output = formatDashboard(snapshot);

      expect(output).toContain('Sessions');
    });

    it('should include storage section', () => {
      const snapshot = collectSnapshot(testDir);
      const output = formatDashboard(snapshot);

      expect(output).toContain('Storage');
      expect(output).toContain('Primitives:');
    });

    it('should include run health section', () => {
      recordSuccess(testDir);
      recordFailure(testDir, 'oops');

      const snapshot = collectSnapshot(testDir);
      const output = formatDashboard(snapshot);

      expect(output).toContain('Run Health');
      expect(output).toContain('Total: 2');
      expect(output).toContain('oops');
    });

    it('should include workflow stats when present', () => {
      saveMetrics(testDir, {
        runs: [
          { workflow_id: 'daily-check', started: '2025-01-15T10:00:00Z', ended: '2025-01-15T10:01:00Z', duration_ms: 60000, success: true, tokens_used: 500, attempt: 1, max_retries: 0 },
        ],
        updated: '2025-01-15T10:01:00Z',
      });

      const snapshot = collectSnapshot(testDir);
      const output = formatDashboard(snapshot);

      expect(output).toContain('Workflows');
      expect(output).toContain('daily-check');
    });

    it('should handle snapshot with cost data in model breakdown', () => {
      const today = new Date().toISOString().split('T')[0];
      saveCosts(testDir, {
        entries: [
          { timestamp: `${today}T08:00:00Z`, model_id: 'claude-sonnet', provider: 'anthropic', input_tokens: 1000, output_tokens: 500, cost_usd: 0.01, source: 'run:test' },
        ],
        updated: `${today}T08:00:00Z`,
      });

      const snapshot = collectSnapshot(testDir);
      const output = formatDashboard(snapshot);

      expect(output).toContain('By model (today)');
      expect(output).toContain('claude-sonnet');
    });
  });

  describe('TelemetrySnapshot type', () => {
    it('should be JSON-serializable', () => {
      const snapshot = collectSnapshot(testDir);
      const json = JSON.stringify(snapshot);
      const parsed = JSON.parse(json) as TelemetrySnapshot;

      expect(parsed.timestamp).toBe(snapshot.timestamp);
      expect(parsed.agent.name).toBe(snapshot.agent.name);
      expect(parsed.health.status).toBe(snapshot.health.status);
    });
  });
});
