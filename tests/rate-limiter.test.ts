import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  checkRateLimit,
  recordEvent,
  tryAcquire,
  getUsage,
  clearRateLimits,
  loadRateLimits,
} from '../src/runtime/rate-limiter.js';

describe('rate-limiter', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'rate-test-'));
    mkdirSync(join(testDir, 'memory'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should allow requests under the limit', () => {
    const result = checkRateLimit(testDir, {
      key: 'tool:github',
      max_requests: 5,
      window_ms: 60000,
    });

    expect(result.allowed).toBe(true);
    expect(result.current).toBe(0);
    expect(result.max).toBe(5);
    expect(result.retry_after_ms).toBe(0);
  });

  it('should deny requests at the limit', () => {
    const now = Date.now();

    // Record 5 events
    for (let i = 0; i < 5; i++) {
      recordEvent(testDir, 'tool:github', now + i);
    }

    const result = checkRateLimit(testDir, {
      key: 'tool:github',
      max_requests: 5,
      window_ms: 60000,
    }, now + 10);

    expect(result.allowed).toBe(false);
    expect(result.current).toBe(5);
    expect(result.retry_after_ms).toBeGreaterThan(0);
  });

  it('should allow after window expires', () => {
    const now = Date.now();

    // Record 5 events
    for (let i = 0; i < 5; i++) {
      recordEvent(testDir, 'tool:github', now);
    }

    // Check after window expires
    const result = checkRateLimit(testDir, {
      key: 'tool:github',
      max_requests: 5,
      window_ms: 60000,
    }, now + 70000);

    expect(result.allowed).toBe(true);
    expect(result.current).toBe(0);
  });

  it('should track keys independently', () => {
    const now = Date.now();

    for (let i = 0; i < 3; i++) {
      recordEvent(testDir, 'tool:github', now);
    }

    const githubResult = checkRateLimit(testDir, {
      key: 'tool:github',
      max_requests: 3,
      window_ms: 60000,
    }, now + 1);

    const telegramResult = checkRateLimit(testDir, {
      key: 'tool:telegram',
      max_requests: 3,
      window_ms: 60000,
    }, now + 1);

    expect(githubResult.allowed).toBe(false);
    expect(telegramResult.allowed).toBe(true);
  });

  it('tryAcquire should record event when allowed', () => {
    const now = Date.now();

    const first = tryAcquire(testDir, {
      key: 'api',
      max_requests: 2,
      window_ms: 60000,
    }, now);

    expect(first.allowed).toBe(true);
    expect(first.current).toBe(0);

    const second = tryAcquire(testDir, {
      key: 'api',
      max_requests: 2,
      window_ms: 60000,
    }, now + 1);

    expect(second.allowed).toBe(true);
    expect(second.current).toBe(1);

    const third = tryAcquire(testDir, {
      key: 'api',
      max_requests: 2,
      window_ms: 60000,
    }, now + 2);

    expect(third.allowed).toBe(false);
    expect(third.current).toBe(2);
  });

  it('tryAcquire should NOT record event when denied', () => {
    const now = Date.now();

    // Fill up the limit
    for (let i = 0; i < 3; i++) {
      recordEvent(testDir, 'api', now);
    }

    // Try to acquire — should be denied
    tryAcquire(testDir, {
      key: 'api',
      max_requests: 3,
      window_ms: 60000,
    }, now + 1);

    // Verify no additional event was recorded
    const usage = getUsage(testDir, 'api', 60000, now + 2);
    expect(usage.count).toBe(3);
  });

  it('getUsage should return count and timestamps', () => {
    const now = Date.now();

    recordEvent(testDir, 'model:claude', now - 5000);
    recordEvent(testDir, 'model:claude', now - 2000);
    recordEvent(testDir, 'model:claude', now);

    const usage = getUsage(testDir, 'model:claude', 60000, now + 1);

    expect(usage.count).toBe(3);
    expect(usage.oldest).toBe(now - 5000);
    expect(usage.newest).toBe(now);
  });

  it('getUsage should return zeros for unknown keys', () => {
    const usage = getUsage(testDir, 'unknown:key', 60000);

    expect(usage.count).toBe(0);
    expect(usage.oldest).toBeNull();
    expect(usage.newest).toBeNull();
  });

  it('clearRateLimits should remove events for specific key', () => {
    const now = Date.now();

    recordEvent(testDir, 'a', now);
    recordEvent(testDir, 'a', now);
    recordEvent(testDir, 'b', now);

    const removed = clearRateLimits(testDir, 'a');
    expect(removed).toBe(2);

    const store = loadRateLimits(testDir);
    expect(store.events.length).toBe(1);
    expect(store.events[0].key).toBe('b');
  });

  it('clearRateLimits should remove all events when no key specified', () => {
    const now = Date.now();

    recordEvent(testDir, 'a', now);
    recordEvent(testDir, 'b', now);

    const removed = clearRateLimits(testDir);
    expect(removed).toBe(2);

    const store = loadRateLimits(testDir);
    expect(store.events.length).toBe(0);
  });

  it('should calculate correct retry_after_ms', () => {
    const now = 1000000;

    // Record event at now
    recordEvent(testDir, 'api', now);

    // Check with window of 10000ms at now + 3000
    const result = checkRateLimit(testDir, {
      key: 'api',
      max_requests: 1,
      window_ms: 10000,
    }, now + 3000);

    expect(result.allowed).toBe(false);
    // oldest event at now, window is 10000, current time is now+3000
    // retry_after = oldest + window - currentTime = 1000000 + 10000 - 1003000 = 7000
    expect(result.retry_after_ms).toBe(7000);
  });

  it('should handle corrupt store file gracefully', () => {
    writeFileSync(join(testDir, 'memory', 'rate-limits.json'), 'not json', 'utf-8');

    const store = loadRateLimits(testDir);
    expect(store.events).toEqual([]);
  });
});
