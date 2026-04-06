import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkGuardrails, buildRateLimits } from '../src/runtime/guardrails.js';
import { recordEvent, clearRateLimits } from '../src/runtime/rate-limiter.js';
import { saveCosts } from '../src/runtime/cost-tracker.js';
import type { HarnessConfig } from '../src/core/types.js';
import { CONFIG_DEFAULTS } from '../src/core/types.js';

function makeConfig(overrides: Partial<Pick<HarnessConfig, 'rate_limits' | 'budget'>> = {}): HarnessConfig {
  return {
    ...CONFIG_DEFAULTS,
    rate_limits: overrides.rate_limits ?? {},
    budget: { enforce: true, ...overrides.budget },
  };
}

describe('guardrails', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'guardrails-test-'));
    mkdirSync(join(testDir, 'memory'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('buildRateLimits', () => {
    it('should return empty array when no limits configured', () => {
      const limits = buildRateLimits(makeConfig());
      expect(limits).toHaveLength(0);
    });

    it('should create per-minute limit', () => {
      const limits = buildRateLimits(makeConfig({ rate_limits: { per_minute: 5 } }));
      expect(limits).toHaveLength(1);
      expect(limits[0].max_requests).toBe(5);
      expect(limits[0].window_ms).toBe(60_000);
    });

    it('should create all three limits when configured', () => {
      const limits = buildRateLimits(makeConfig({
        rate_limits: { per_minute: 5, per_hour: 100, per_day: 500 },
      }));
      expect(limits).toHaveLength(3);
    });

    it('should create per-hour limit', () => {
      const limits = buildRateLimits(makeConfig({ rate_limits: { per_hour: 50 } }));
      expect(limits).toHaveLength(1);
      expect(limits[0].window_ms).toBe(3_600_000);
    });

    it('should create per-day limit', () => {
      const limits = buildRateLimits(makeConfig({ rate_limits: { per_day: 200 } }));
      expect(limits).toHaveLength(1);
      expect(limits[0].window_ms).toBe(86_400_000);
    });
  });

  describe('checkGuardrails', () => {
    it('should allow when no limits configured', () => {
      const result = checkGuardrails(testDir, makeConfig());
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeNull();
    });

    it('should allow when under rate limit', () => {
      const config = makeConfig({ rate_limits: { per_minute: 3 } });
      const result = checkGuardrails(testDir, config);
      expect(result.allowed).toBe(true);
    });

    it('should block when rate limit exceeded', () => {
      const config = makeConfig({ rate_limits: { per_minute: 2 } });
      const now = Date.now();

      // Record 2 events manually to fill the limit
      recordEvent(testDir, 'llm-calls:minute', now - 1000);
      recordEvent(testDir, 'llm-calls:minute', now - 500);

      const result = checkGuardrails(testDir, config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Rate limit exceeded');
      expect(result.reason).toContain('per minute');
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(result.rateLimitCheck).not.toBeNull();
    });

    it('should block when per-hour limit exceeded', () => {
      const config = makeConfig({ rate_limits: { per_hour: 1 } });

      // Record 1 event to fill the limit
      recordEvent(testDir, 'llm-calls:hour', Date.now() - 1000);

      const result = checkGuardrails(testDir, config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('per hour');
    });

    it('should block when per-day limit exceeded', () => {
      const config = makeConfig({ rate_limits: { per_day: 1 } });

      // Record 1 event
      recordEvent(testDir, 'llm-calls:day', Date.now() - 1000);

      const result = checkGuardrails(testDir, config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('per day');
    });

    it('should record events when allowed', () => {
      const config = makeConfig({ rate_limits: { per_minute: 3 } });

      // First call should be allowed and record an event
      const result1 = checkGuardrails(testDir, config);
      expect(result1.allowed).toBe(true);

      // Second call should also be allowed
      const result2 = checkGuardrails(testDir, config);
      expect(result2.allowed).toBe(true);

      // Third call should be allowed
      const result3 = checkGuardrails(testDir, config);
      expect(result3.allowed).toBe(true);

      // Fourth call should be blocked (3 recorded events)
      const result4 = checkGuardrails(testDir, config);
      expect(result4.allowed).toBe(false);
    });

    it('should allow again after events expire', () => {
      const config = makeConfig({ rate_limits: { per_minute: 1 } });

      // Record event outside the 1-minute window
      recordEvent(testDir, 'llm-calls:minute', Date.now() - 120_000);

      const result = checkGuardrails(testDir, config);
      expect(result.allowed).toBe(true);
    });

    it('should block when daily budget exceeded', () => {
      const config = makeConfig({ budget: { daily_limit_usd: 1.0, enforce: true } });
      const today = new Date().toISOString().split('T')[0];

      saveCosts(testDir, {
        entries: [
          { timestamp: `${today}T08:00:00Z`, model_id: 'test-model', provider: 'test', input_tokens: 100000, output_tokens: 50000, cost_usd: 1.5, source: 'test' },
        ],
        updated: `${today}T08:00:00Z`,
      });

      const result = checkGuardrails(testDir, config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Daily budget exceeded');
      expect(result.budgetStatus).not.toBeNull();
    });

    it('should block when monthly budget exceeded', () => {
      const config = makeConfig({ budget: { monthly_limit_usd: 10.0, enforce: true } });
      const today = new Date().toISOString().split('T')[0];

      saveCosts(testDir, {
        entries: [
          { timestamp: `${today}T08:00:00Z`, model_id: 'test-model', provider: 'test', input_tokens: 500000, output_tokens: 200000, cost_usd: 15.0, source: 'test' },
        ],
        updated: `${today}T08:00:00Z`,
      });

      const result = checkGuardrails(testDir, config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Monthly budget exceeded');
    });

    it('should allow when budget.enforce is false even if exceeded', () => {
      const config = makeConfig({ budget: { daily_limit_usd: 1.0, enforce: false } });
      const today = new Date().toISOString().split('T')[0];

      saveCosts(testDir, {
        entries: [
          { timestamp: `${today}T08:00:00Z`, model_id: 'test-model', provider: 'test', input_tokens: 100000, output_tokens: 50000, cost_usd: 5.0, source: 'test' },
        ],
        updated: `${today}T08:00:00Z`,
      });

      const result = checkGuardrails(testDir, config);
      expect(result.allowed).toBe(true);
    });

    it('should allow when under budget', () => {
      const config = makeConfig({ budget: { daily_limit_usd: 10.0, enforce: true } });
      const today = new Date().toISOString().split('T')[0];

      saveCosts(testDir, {
        entries: [
          { timestamp: `${today}T08:00:00Z`, model_id: 'test-model', provider: 'test', input_tokens: 1000, output_tokens: 500, cost_usd: 0.01, source: 'test' },
        ],
        updated: `${today}T08:00:00Z`,
      });

      const result = checkGuardrails(testDir, config);
      expect(result.allowed).toBe(true);
    });

    it('should check rate limits before budget', () => {
      const config = makeConfig({
        rate_limits: { per_minute: 1 },
        budget: { daily_limit_usd: 1.0, enforce: true },
      });

      // Exceed rate limit
      recordEvent(testDir, 'llm-calls:minute', Date.now() - 500);

      const result = checkGuardrails(testDir, config);
      expect(result.allowed).toBe(false);
      // Should be rate limit error, not budget error
      expect(result.reason).toContain('Rate limit exceeded');
      expect(result.rateLimitCheck).not.toBeNull();
      expect(result.budgetStatus).toBeNull();
    });

    it('should handle no costs file gracefully', () => {
      const config = makeConfig({ budget: { daily_limit_usd: 10.0, enforce: true } });
      // No costs.json exists — should allow
      const result = checkGuardrails(testDir, config);
      expect(result.allowed).toBe(true);
    });
  });
});
