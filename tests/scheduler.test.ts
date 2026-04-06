import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { isQuietHours, Scheduler } from '../src/runtime/scheduler.js';
import type { HarnessConfig } from '../src/core/types.js';

function makeConfig(start: number, end: number, timezone = 'America/New_York'): HarnessConfig {
  return {
    agent: { name: 'test', version: '0.1.0' },
    model: { provider: 'openrouter', id: 'test', max_tokens: 200000, max_retries: 2 },
    runtime: {
      scratchpad_budget: 10000,
      quiet_hours: { start, end },
      timezone,
    },
    memory: { session_retention_days: 7, journal_retention_days: 365 },
    channels: { primary: 'cli' },
    extensions: { directories: [] },
  };
}

describe('isQuietHours', () => {
  it('should return true during quiet hours (wraps midnight)', () => {
    const config = makeConfig(23, 6, 'UTC');
    // 23:30 UTC is within quiet hours (23:00–05:59)
    const lateNight = new Date('2026-04-06T23:30:00Z');
    expect(isQuietHours(config, lateNight)).toBe(true);
  });

  it('should return true during early morning quiet hours', () => {
    const config = makeConfig(23, 6, 'UTC');
    // 3:00 UTC is within quiet hours (23:00–05:59)
    const earlyMorning = new Date('2026-04-06T03:00:00Z');
    expect(isQuietHours(config, earlyMorning)).toBe(true);
  });

  it('should return false outside quiet hours', () => {
    const config = makeConfig(23, 6, 'UTC');
    // 12:00 UTC is outside quiet hours
    const midday = new Date('2026-04-06T12:00:00Z');
    expect(isQuietHours(config, midday)).toBe(false);
  });

  it('should return false at the exact end hour (end is exclusive)', () => {
    const config = makeConfig(23, 6, 'UTC');
    // 6:00 UTC — the end hour is exclusive, so 6:xx should NOT be quiet
    const exactEnd = new Date('2026-04-06T06:30:00Z');
    expect(isQuietHours(config, exactEnd)).toBe(false);
  });

  it('should handle non-wrapping range (e.g. 8–17)', () => {
    const config = makeConfig(8, 17, 'UTC');
    // 10:00 UTC is within 8:00–16:59
    const morning = new Date('2026-04-06T10:00:00Z');
    expect(isQuietHours(config, morning)).toBe(true);

    // 18:00 UTC is outside
    const evening = new Date('2026-04-06T18:00:00Z');
    expect(isQuietHours(config, evening)).toBe(false);
  });

  it('should return false when start equals end (no quiet hours)', () => {
    const config = makeConfig(0, 0, 'UTC');
    const anytime = new Date('2026-04-06T15:00:00Z');
    expect(isQuietHours(config, anytime)).toBe(false);
  });

  it('should handle timezone conversion', () => {
    // April 6 is in EDT (UTC-4). Quiet hours 23–6 in America/New_York.
    const config = makeConfig(23, 6, 'America/New_York');

    // 3:00 UTC = 23:00 EDT — within quiet hours (>= 23)
    const utc3am = new Date('2026-04-06T03:00:00Z');
    expect(isQuietHours(config, utc3am)).toBe(true);

    // 10:00 UTC = 6:00 EDT — end hour is exclusive, so NOT quiet
    const utc10am = new Date('2026-04-06T10:00:00Z');
    expect(isQuietHours(config, utc10am)).toBe(false);

    // 16:00 UTC = 12:00 EDT — clearly outside quiet hours
    const utc4pm = new Date('2026-04-06T16:00:00Z');
    expect(isQuietHours(config, utc4pm)).toBe(false);
  });

  it('should fallback to local time for invalid timezone', () => {
    const config = makeConfig(23, 6, 'Invalid/Timezone');
    // Should not throw, falls back to local time
    expect(() => isQuietHours(config)).not.toThrow();
  });
});

const SCHED_TEST_DIR = join(__dirname, '__test_scheduler__');

describe('Scheduler', () => {
  beforeEach(() => {
    mkdirSync(SCHED_TEST_DIR, { recursive: true });
    writeFileSync(join(SCHED_TEST_DIR, 'CORE.md'), '# Core', 'utf-8');
    writeFileSync(
      join(SCHED_TEST_DIR, 'config.yaml'),
      `agent:\n  name: test\n  version: "0.1.0"\nmodel:\n  provider: openrouter\n  id: test-model\n  max_tokens: 200000\nmemory:\n  session_retention_days: 7\n  journal_retention_days: 365\n`,
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(SCHED_TEST_DIR, { recursive: true, force: true });
  });

  it('should start and stop without error', () => {
    const scheduler = new Scheduler({ harnessDir: SCHED_TEST_DIR, autoArchival: false });
    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });

  it('should list scheduled workflows', () => {
    const workflowDir = join(SCHED_TEST_DIR, 'workflows');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      join(workflowDir, 'heartbeat.md'),
      `---\nid: heartbeat\ntags: [workflow]\nstatus: active\nschedule: "*/5 * * * *"\n---\n# Workflow: Heartbeat\n\nCheck system status every 5 minutes.`,
      'utf-8',
    );

    const scheduler = new Scheduler({ harnessDir: SCHED_TEST_DIR, autoArchival: false });
    scheduler.start();

    const listed = scheduler.listScheduled();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe('heartbeat');
    expect(listed[0].cron).toBe('*/5 * * * *');

    scheduler.stop();
  });

  it('should run archival via runArchival()', () => {
    // Create an old session
    const sessionsDir = join(SCHED_TEST_DIR, 'memory', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, '2020-01-01-old.md'),
      `---\nid: 2020-01-01-old\n---\nOld session`,
      'utf-8',
    );

    let archivalCalled = false;
    const scheduler = new Scheduler({
      harnessDir: SCHED_TEST_DIR,
      autoArchival: false,
      onArchival: (sessions, journals) => {
        archivalCalled = true;
        expect(sessions).toBe(1);
        expect(journals).toBe(0);
      },
    });

    scheduler.runArchival();
    expect(archivalCalled).toBe(true);

    // Old session should be archived
    expect(existsSync(join(sessionsDir, '2020-01-01-old.md'))).toBe(false);
    expect(existsSync(join(sessionsDir, 'archive', '2020-01', '2020-01-01-old.md'))).toBe(true);
  });

  it('should skip workflows without schedule', () => {
    const workflowDir = join(SCHED_TEST_DIR, 'workflows');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      join(workflowDir, 'manual.md'),
      `---\nid: manual\ntags: [workflow]\nstatus: active\n---\n# Workflow: Manual\n\nThis workflow has no schedule and runs manually.`,
      'utf-8',
    );

    const scheduler = new Scheduler({ harnessDir: SCHED_TEST_DIR, autoArchival: false });
    scheduler.start();

    const listed = scheduler.listScheduled();
    expect(listed).toHaveLength(0);

    scheduler.stop();
  });

  it('should report invalid cron expressions via onError', () => {
    const workflowDir = join(SCHED_TEST_DIR, 'workflows');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      join(workflowDir, 'bad-cron.md'),
      `---\nid: bad-cron\ntags: [workflow]\nstatus: active\nschedule: "not a cron"\n---\n# Workflow: Bad Cron\n\nThis has an invalid cron expression.`,
      'utf-8',
    );

    let errorReported = false;
    const scheduler = new Scheduler({
      harnessDir: SCHED_TEST_DIR,
      autoArchival: false,
      onError: (id, error) => {
        if (id === 'bad-cron') errorReported = true;
      },
    });
    scheduler.start();

    expect(errorReported).toBe(true);
    expect(scheduler.listScheduled()).toHaveLength(0);

    scheduler.stop();
  });

  it('should parse max_retries and retry_delay_ms from workflow frontmatter', () => {
    const workflowDir = join(SCHED_TEST_DIR, 'workflows');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      join(workflowDir, 'retry-wf.md'),
      `---\nid: retry-wf\ntags: [workflow]\nstatus: active\nschedule: "0 * * * *"\nmax_retries: 3\nretry_delay_ms: 500\n---\n# Workflow: Retry\n\nThis workflow has retry configuration in its frontmatter.`,
      'utf-8',
    );

    const scheduler = new Scheduler({ harnessDir: SCHED_TEST_DIR, autoArchival: false });
    scheduler.start();

    const listed = scheduler.listScheduled();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe('retry-wf');

    scheduler.stop();
  });

  it('should call onRetry callback during retry attempts', async () => {
    // We test retry logic by calling executeWorkflow directly.
    // Disable quiet hours so executeWorkflow proceeds to the LLM call
    writeFileSync(
      join(SCHED_TEST_DIR, 'config.yaml'),
      `agent:\n  name: test\n  version: "0.1.0"\nmodel:\n  provider: openrouter\n  id: test-model\n  max_tokens: 200000\nruntime:\n  quiet_hours:\n    start: 0\n    end: 0\nmemory:\n  session_retention_days: 7\n  journal_retention_days: 365\n`,
      'utf-8',
    );

    const workflowDir = join(SCHED_TEST_DIR, 'workflows');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      join(workflowDir, 'retry-test.md'),
      `---\nid: retry-test\ntags: [workflow]\nstatus: active\nmax_retries: 2\nretry_delay_ms: 10\n---\n# Workflow: Retry Test\n\nThis workflow is configured to retry twice with 10ms base delay.`,
      'utf-8',
    );

    const retries: Array<{ attempt: number; maxRetries: number }> = [];
    let errorCalled = false;

    const scheduler = new Scheduler({
      harnessDir: SCHED_TEST_DIR,
      autoArchival: false,
      onRetry: (id, attempt, maxRetries) => {
        retries.push({ attempt, maxRetries });
      },
      onError: () => {
        errorCalled = true;
      },
    });

    // executeWorkflow will fail because there's no API key / provider available
    // This exercises the retry path
    const { parseHarnessDocument } = await import('../src/primitives/loader.js');
    const doc = parseHarnessDocument(join(workflowDir, 'retry-test.md'));

    try {
      await scheduler.executeWorkflow(doc);
    } catch {
      // Expected to fail after all retries
    }

    // Should have retried twice (attempt 1, attempt 2)
    expect(retries).toHaveLength(2);
    expect(retries[0].attempt).toBe(1);
    expect(retries[0].maxRetries).toBe(2);
    expect(retries[1].attempt).toBe(2);
    expect(retries[1].maxRetries).toBe(2);
    expect(errorCalled).toBe(true);
  });

  it('should not retry when max_retries is not set', async () => {
    // Disable quiet hours
    writeFileSync(
      join(SCHED_TEST_DIR, 'config.yaml'),
      `agent:\n  name: test\n  version: "0.1.0"\nmodel:\n  provider: openrouter\n  id: test-model\n  max_tokens: 200000\nruntime:\n  quiet_hours:\n    start: 0\n    end: 0\nmemory:\n  session_retention_days: 7\n  journal_retention_days: 365\n`,
      'utf-8',
    );

    const workflowDir = join(SCHED_TEST_DIR, 'workflows');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      join(workflowDir, 'no-retry.md'),
      `---\nid: no-retry\ntags: [workflow]\nstatus: active\n---\n# Workflow: No Retry\n\nThis workflow has no retry config and should fail immediately.`,
      'utf-8',
    );

    const retries: number[] = [];

    const scheduler = new Scheduler({
      harnessDir: SCHED_TEST_DIR,
      autoArchival: false,
      onRetry: (id, attempt) => {
        retries.push(attempt);
      },
    });

    const { parseHarnessDocument } = await import('../src/primitives/loader.js');
    const doc = parseHarnessDocument(join(workflowDir, 'no-retry.md'));

    try {
      await scheduler.executeWorkflow(doc);
    } catch {
      // Expected to fail
    }

    // No retries when max_retries is not set (defaults to 0)
    expect(retries).toHaveLength(0);
  });
});
