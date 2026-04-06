import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  calculateCost,
  findPricing,
  recordCost,
  getSpending,
  checkBudget,
  clearCosts,
  loadCosts,
  saveCosts,
} from '../src/runtime/cost-tracker.js';

describe('cost-tracker', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cost-test-'));
    mkdirSync(join(testDir, 'memory'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('pricing', () => {
    it('should find pricing for known models', () => {
      const pricing = findPricing('anthropic/claude-sonnet-4');
      expect(pricing).not.toBeNull();
      expect(pricing!.input_per_million).toBe(3.0);
      expect(pricing!.output_per_million).toBe(15.0);
    });

    it('should find pricing by prefix match', () => {
      const pricing = findPricing('anthropic/claude-sonnet-4-20250514');
      expect(pricing).not.toBeNull();
      expect(pricing!.input_per_million).toBe(3.0);
    });

    it('should return null for unknown models', () => {
      const pricing = findPricing('unknown/nonexistent-model');
      expect(pricing).toBeNull();
    });

    it('should prefer custom pricing over defaults', () => {
      const pricing = findPricing('anthropic/claude-sonnet-4', [
        { model_pattern: 'anthropic/claude-sonnet-4', input_per_million: 99, output_per_million: 99 },
      ]);
      expect(pricing!.input_per_million).toBe(99);
    });
  });

  describe('calculateCost', () => {
    it('should calculate cost for known model', () => {
      // claude-sonnet-4: $3/M in, $15/M out
      const cost = calculateCost('anthropic/claude-sonnet-4', 1000, 500);
      // (1000/1M * 3) + (500/1M * 15) = 0.003 + 0.0075 = 0.0105
      expect(cost).toBeCloseTo(0.0105, 6);
    });

    it('should return 0 for unknown model', () => {
      const cost = calculateCost('unknown/model', 1000, 500);
      expect(cost).toBe(0);
    });

    it('should return 0 for local models', () => {
      const cost = calculateCost('local/llama', 10000, 5000);
      expect(cost).toBe(0);
    });

    it('should handle large token counts', () => {
      // gpt-4o: $2.5/M in, $10/M out
      const cost = calculateCost('gpt-4o', 1000000, 500000);
      // (1M/1M * 2.5) + (500K/1M * 10) = 2.5 + 5 = 7.5
      expect(cost).toBeCloseTo(7.5, 4);
    });
  });

  describe('recordCost', () => {
    it('should record a cost entry with auto-calculated cost', () => {
      const entry = recordCost(testDir, {
        model_id: 'anthropic/claude-sonnet-4',
        provider: 'openrouter',
        input_tokens: 2000,
        output_tokens: 1000,
        source: 'run:test-session',
      });

      expect(entry.cost_usd).toBeGreaterThan(0);
      expect(entry.timestamp).toBeDefined();
      expect(entry.source).toBe('run:test-session');

      const store = loadCosts(testDir);
      expect(store.entries.length).toBe(1);
    });

    it('should accept explicit cost_usd', () => {
      const entry = recordCost(testDir, {
        model_id: 'unknown/model',
        provider: 'custom',
        input_tokens: 100,
        output_tokens: 50,
        source: 'test',
        cost_usd: 0.42,
      });

      expect(entry.cost_usd).toBe(0.42);
    });

    it('should accumulate multiple entries', () => {
      for (let i = 0; i < 3; i++) {
        recordCost(testDir, {
          model_id: 'gpt-4o',
          provider: 'openai',
          input_tokens: 100,
          output_tokens: 50,
          source: `run:session-${i}`,
        });
      }

      const store = loadCosts(testDir);
      expect(store.entries.length).toBe(3);
    });
  });

  describe('getSpending', () => {
    it('should return zero spending for empty store', () => {
      const summary = getSpending(testDir);
      expect(summary.total_cost_usd).toBe(0);
      expect(summary.entries).toBe(0);
    });

    it('should aggregate spending correctly', () => {
      recordCost(testDir, {
        model_id: 'gpt-4o',
        provider: 'openai',
        input_tokens: 1000,
        output_tokens: 500,
        source: 'run:1',
      });

      recordCost(testDir, {
        model_id: 'anthropic/claude-sonnet-4',
        provider: 'openrouter',
        input_tokens: 2000,
        output_tokens: 1000,
        source: 'run:2',
      });

      const summary = getSpending(testDir);
      expect(summary.entries).toBe(2);
      expect(summary.total_cost_usd).toBeGreaterThan(0);
      expect(summary.total_input_tokens).toBe(3000);
      expect(summary.total_output_tokens).toBe(1500);
      expect(Object.keys(summary.by_model).length).toBe(2);
      expect(Object.keys(summary.by_provider).length).toBe(2);
    });

    it('should filter by date range', () => {
      // Record cost manually with specific timestamps
      const store = loadCosts(testDir);
      store.entries.push({
        timestamp: '2025-01-15T10:00:00Z',
        model_id: 'gpt-4o',
        provider: 'openai',
        input_tokens: 1000,
        output_tokens: 500,
        cost_usd: 0.01,
        source: 'test',
      });
      store.entries.push({
        timestamp: '2025-01-20T10:00:00Z',
        model_id: 'gpt-4o',
        provider: 'openai',
        input_tokens: 1000,
        output_tokens: 500,
        cost_usd: 0.02,
        source: 'test',
      });
      saveCosts(testDir, store);

      const summary = getSpending(testDir, '2025-01-18', '2025-01-25');
      expect(summary.entries).toBe(1);
      expect(summary.total_cost_usd).toBeCloseTo(0.02, 6);
    });
  });

  describe('checkBudget', () => {
    it('should report no alerts when under budget', () => {
      const status = checkBudget(testDir, {
        daily_limit_usd: 10.0,
        monthly_limit_usd: 100.0,
      });

      expect(status.alerts.length).toBe(0);
      expect(status.daily_spent_usd).toBe(0);
      expect(status.daily_remaining_usd).toBe(10.0);
      expect(status.monthly_remaining_usd).toBe(100.0);
    });

    it('should handle no limits set', () => {
      const status = checkBudget(testDir, {});

      expect(status.daily_limit_usd).toBeNull();
      expect(status.monthly_limit_usd).toBeNull();
      expect(status.daily_pct).toBeNull();
      expect(status.monthly_pct).toBeNull();
      expect(status.alerts.length).toBe(0);
    });
  });

  describe('clearCosts', () => {
    it('should clear all cost entries', () => {
      recordCost(testDir, {
        model_id: 'gpt-4o',
        provider: 'openai',
        input_tokens: 100,
        output_tokens: 50,
        source: 'test',
      });
      recordCost(testDir, {
        model_id: 'claude-sonnet-4',
        provider: 'anthropic',
        input_tokens: 100,
        output_tokens: 50,
        source: 'test',
      });

      const removed = clearCosts(testDir);
      expect(removed).toBe(2);

      const store = loadCosts(testDir);
      expect(store.entries.length).toBe(0);
    });

    it('should clear entries for specific model', () => {
      recordCost(testDir, {
        model_id: 'gpt-4o',
        provider: 'openai',
        input_tokens: 100,
        output_tokens: 50,
        source: 'test',
      });
      recordCost(testDir, {
        model_id: 'claude-sonnet-4',
        provider: 'anthropic',
        input_tokens: 100,
        output_tokens: 50,
        source: 'test',
      });

      const removed = clearCosts(testDir, 'gpt-4o');
      expect(removed).toBe(1);

      const store = loadCosts(testDir);
      expect(store.entries.length).toBe(1);
      expect(store.entries[0].model_id).toBe('claude-sonnet-4');
    });
  });

  it('should handle corrupt store file gracefully', () => {
    writeFileSync(join(testDir, 'memory', 'costs.json'), 'corrupted data', 'utf-8');

    const store = loadCosts(testDir);
    expect(store.entries).toEqual([]);
  });
});
