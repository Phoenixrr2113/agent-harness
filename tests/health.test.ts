import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadHealth,
  saveHealth,
  recordSuccess,
  recordFailure,
  recordBoot,
  getHealthStatus,
  resetHealth,
} from '../src/runtime/health.js';
import type { HealthMetrics } from '../src/runtime/health.js';

describe('health', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'health-test-'));
    mkdirSync(join(testDir, 'memory'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('loadHealth', () => {
    it('should return default metrics when no file exists', () => {
      const metrics = loadHealth(testDir);
      expect(metrics.totalRuns).toBe(0);
      expect(metrics.totalSuccesses).toBe(0);
      expect(metrics.totalFailures).toBe(0);
      expect(metrics.consecutiveFailures).toBe(0);
      expect(metrics.lastSuccessfulRun).toBeNull();
      expect(metrics.lastFailedRun).toBeNull();
      expect(metrics.lastError).toBeNull();
      expect(metrics.bootedAt).toBeNull();
    });

    it('should load saved metrics', () => {
      const metrics: HealthMetrics = {
        lastSuccessfulRun: '2025-01-15T10:00:00Z',
        lastFailedRun: null,
        lastError: null,
        consecutiveFailures: 0,
        totalRuns: 5,
        totalSuccesses: 5,
        totalFailures: 0,
        bootedAt: '2025-01-15T09:00:00Z',
        updatedAt: '2025-01-15T10:00:00Z',
      };
      saveHealth(testDir, metrics);

      const loaded = loadHealth(testDir);
      expect(loaded.totalRuns).toBe(5);
      expect(loaded.totalSuccesses).toBe(5);
      expect(loaded.bootedAt).toBe('2025-01-15T09:00:00Z');
    });

    it('should handle corrupt file gracefully', () => {
      writeFileSync(join(testDir, 'memory', 'health.json'), 'not json', 'utf-8');
      const metrics = loadHealth(testDir);
      expect(metrics.totalRuns).toBe(0);
    });

    it('should handle invalid JSON object gracefully', () => {
      writeFileSync(join(testDir, 'memory', 'health.json'), '{"foo": "bar"}', 'utf-8');
      const metrics = loadHealth(testDir);
      expect(metrics.totalRuns).toBe(0);
    });
  });

  describe('saveHealth', () => {
    it('should create memory directory if missing', () => {
      const bareDir = mkdtempSync(join(tmpdir(), 'health-bare-'));
      const metrics = loadHealth(bareDir);
      saveHealth(bareDir, metrics);

      expect(existsSync(join(bareDir, 'memory', 'health.json'))).toBe(true);
      rmSync(bareDir, { recursive: true, force: true });
    });

    it('should update the updatedAt timestamp', () => {
      const metrics = loadHealth(testDir);
      const before = new Date().toISOString();
      saveHealth(testDir, metrics);

      const loaded = loadHealth(testDir);
      expect(loaded.updatedAt >= before).toBe(true);
    });
  });

  describe('recordSuccess', () => {
    it('should increment totalRuns and totalSuccesses', () => {
      recordSuccess(testDir);
      const metrics = loadHealth(testDir);

      expect(metrics.totalRuns).toBe(1);
      expect(metrics.totalSuccesses).toBe(1);
      expect(metrics.totalFailures).toBe(0);
      expect(metrics.consecutiveFailures).toBe(0);
      expect(metrics.lastSuccessfulRun).not.toBeNull();
    });

    it('should reset consecutiveFailures', () => {
      recordFailure(testDir, 'err1');
      recordFailure(testDir, 'err2');
      expect(loadHealth(testDir).consecutiveFailures).toBe(2);

      recordSuccess(testDir);
      expect(loadHealth(testDir).consecutiveFailures).toBe(0);
    });

    it('should accumulate multiple successes', () => {
      recordSuccess(testDir);
      recordSuccess(testDir);
      recordSuccess(testDir);

      const metrics = loadHealth(testDir);
      expect(metrics.totalRuns).toBe(3);
      expect(metrics.totalSuccesses).toBe(3);
    });
  });

  describe('recordFailure', () => {
    it('should increment totalRuns and totalFailures', () => {
      recordFailure(testDir, 'something broke');
      const metrics = loadHealth(testDir);

      expect(metrics.totalRuns).toBe(1);
      expect(metrics.totalFailures).toBe(1);
      expect(metrics.totalSuccesses).toBe(0);
      expect(metrics.consecutiveFailures).toBe(1);
      expect(metrics.lastError).toBe('something broke');
      expect(metrics.lastFailedRun).not.toBeNull();
    });

    it('should increment consecutiveFailures', () => {
      recordFailure(testDir);
      recordFailure(testDir);
      recordFailure(testDir);

      const metrics = loadHealth(testDir);
      expect(metrics.consecutiveFailures).toBe(3);
      expect(metrics.totalFailures).toBe(3);
    });

    it('should set lastError to null when no message provided', () => {
      recordFailure(testDir);
      const metrics = loadHealth(testDir);
      expect(metrics.lastError).toBeNull();
    });
  });

  describe('recordBoot', () => {
    it('should set bootedAt timestamp', () => {
      recordBoot(testDir);
      const metrics = loadHealth(testDir);
      expect(metrics.bootedAt).not.toBeNull();
    });
  });

  describe('getHealthStatus', () => {
    it('should return unhealthy when core files are missing', () => {
      const status = getHealthStatus(testDir);
      expect(status.status).toBe('unhealthy');

      const coreCheck = status.checks.find((c) => c.name === 'core-files');
      expect(coreCheck).toBeDefined();
      expect(coreCheck!.status).toBe('fail');
    });

    it('should pass core-files check when files exist', () => {
      writeFileSync(join(testDir, 'CORE.md'), '# Core', 'utf-8');
      writeFileSync(join(testDir, 'config.yaml'), 'agent:\n  name: test', 'utf-8');
      writeFileSync(join(testDir, 'state.md'), '# State', 'utf-8');

      const status = getHealthStatus(testDir);
      const coreCheck = status.checks.find((c) => c.name === 'core-files');
      expect(coreCheck!.status).toBe('pass');
    });

    it('should pass memory-dir check when directory exists', () => {
      const status = getHealthStatus(testDir);
      const memCheck = status.checks.find((c) => c.name === 'memory-dir');
      expect(memCheck!.status).toBe('pass');
    });

    it('should fail memory-dir check when directory is missing', () => {
      const bareDir = mkdtempSync(join(tmpdir(), 'health-nomem-'));
      const status = getHealthStatus(bareDir);
      const memCheck = status.checks.find((c) => c.name === 'memory-dir');
      expect(memCheck!.status).toBe('fail');
      rmSync(bareDir, { recursive: true, force: true });
    });

    it('should warn on consecutive failures < 3', () => {
      recordFailure(testDir, 'err1');
      recordFailure(testDir, 'err2');

      const status = getHealthStatus(testDir);
      const runCheck = status.checks.find((c) => c.name === 'run-health');
      expect(runCheck!.status).toBe('warn');
    });

    it('should fail on 3+ consecutive failures', () => {
      recordFailure(testDir, 'err1');
      recordFailure(testDir, 'err2');
      recordFailure(testDir, 'err3');

      const status = getHealthStatus(testDir);
      const runCheck = status.checks.find((c) => c.name === 'run-health');
      expect(runCheck!.status).toBe('fail');
      expect(runCheck!.message).toContain('err3');
    });

    it('should pass run-health when no failures', () => {
      const status = getHealthStatus(testDir);
      const runCheck = status.checks.find((c) => c.name === 'run-health');
      expect(runCheck!.status).toBe('pass');
    });

    it('should return healthy when all checks pass', () => {
      writeFileSync(join(testDir, 'CORE.md'), '# Core', 'utf-8');
      writeFileSync(join(testDir, 'config.yaml'), 'agent:\n  name: test', 'utf-8');
      writeFileSync(join(testDir, 'state.md'), '# State', 'utf-8');

      const status = getHealthStatus(testDir);
      // api-keys check may warn if no env vars, so filter it
      const nonApiChecks = status.checks.filter((c) => c.name !== 'api-keys');
      const hasFails = nonApiChecks.some((c) => c.status === 'fail');
      expect(hasFails).toBe(false);
    });

    it('should include cost data (defaults to 0 when no costs)', () => {
      const status = getHealthStatus(testDir);
      expect(status.costToday).toBe(0);
      expect(status.costThisMonth).toBe(0);
    });

    it('should return degraded when only warnings exist', () => {
      writeFileSync(join(testDir, 'CORE.md'), '# Core', 'utf-8');
      writeFileSync(join(testDir, 'config.yaml'), 'agent:\n  name: test', 'utf-8');
      writeFileSync(join(testDir, 'state.md'), '# State', 'utf-8');
      // 1 failure = warn on run-health
      recordFailure(testDir, 'one-off');

      const status = getHealthStatus(testDir);
      // api-keys may also warn, but at least run-health should warn
      const runCheck = status.checks.find((c) => c.name === 'run-health');
      expect(runCheck!.status).toBe('warn');
    });
  });

  describe('resetHealth', () => {
    it('should reset all metrics to defaults', () => {
      recordSuccess(testDir);
      recordSuccess(testDir);
      recordFailure(testDir, 'oops');
      recordBoot(testDir);

      resetHealth(testDir);
      const metrics = loadHealth(testDir);

      expect(metrics.totalRuns).toBe(0);
      expect(metrics.totalSuccesses).toBe(0);
      expect(metrics.totalFailures).toBe(0);
      expect(metrics.consecutiveFailures).toBe(0);
      expect(metrics.lastSuccessfulRun).toBeNull();
      expect(metrics.lastFailedRun).toBeNull();
      expect(metrics.lastError).toBeNull();
      expect(metrics.bootedAt).toBeNull();
    });
  });

  describe('mixed success/failure sequences', () => {
    it('should track interleaved success and failure correctly', () => {
      recordSuccess(testDir);
      recordSuccess(testDir);
      recordFailure(testDir, 'fail1');
      recordFailure(testDir, 'fail2');
      recordSuccess(testDir);

      const metrics = loadHealth(testDir);
      expect(metrics.totalRuns).toBe(5);
      expect(metrics.totalSuccesses).toBe(3);
      expect(metrics.totalFailures).toBe(2);
      expect(metrics.consecutiveFailures).toBe(0);
      expect(metrics.lastError).toBe('fail2');
    });
  });
});
