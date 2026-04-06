import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scaffoldHarness } from '../src/cli/scaffold.js';
import {
  loadEmotionalState,
  saveEmotionalState,
  applySignals,
  deriveSignals,
  summarizeEmotionalState,
  resetEmotionalState,
  getEmotionalTrends,
} from '../src/runtime/emotional-state.js';

describe('emotional-state', () => {
  let harnessDir: string;
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'emo-state-'));
    harnessDir = join(tmpBase, 'test-agent');
    scaffoldHarness(harnessDir, 'test-agent', { template: 'base' });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  describe('loadEmotionalState', () => {
    it('should return defaults when no state file exists', () => {
      const state = loadEmotionalState(harnessDir);
      expect(state.confidence).toBe(50);
      expect(state.engagement).toBe(50);
      expect(state.frustration).toBe(0);
      expect(state.curiosity).toBe(50);
      expect(state.urgency).toBe(0);
    });

    it('should load saved state', () => {
      saveEmotionalState(harnessDir, {
        confidence: 80,
        engagement: 60,
        frustration: 20,
        curiosity: 70,
        urgency: 10,
        updatedAt: '2025-01-01T00:00:00.000Z',
      });

      const loaded = loadEmotionalState(harnessDir);
      expect(loaded.confidence).toBe(80);
      expect(loaded.engagement).toBe(60);
      expect(loaded.frustration).toBe(20);
      expect(loaded.curiosity).toBe(70);
      expect(loaded.urgency).toBe(10);
    });
  });

  describe('saveEmotionalState', () => {
    it('should clamp values to 0-100', () => {
      saveEmotionalState(harnessDir, {
        confidence: 150,
        engagement: -20,
        frustration: 0,
        curiosity: 100,
        urgency: 50,
        updatedAt: new Date().toISOString(),
      });

      const loaded = loadEmotionalState(harnessDir);
      expect(loaded.confidence).toBe(100);
      expect(loaded.engagement).toBe(0);
    });
  });

  describe('applySignals', () => {
    it('should apply positive deltas', () => {
      const state = applySignals(harnessDir, [
        { dimension: 'confidence', delta: 20 },
        { dimension: 'frustration', delta: 15 },
      ]);

      expect(state.confidence).toBe(70); // 50 + 20
      expect(state.frustration).toBe(15); // 0 + 15
    });

    it('should apply negative deltas', () => {
      // First set some values
      saveEmotionalState(harnessDir, {
        confidence: 80,
        engagement: 50,
        frustration: 30,
        curiosity: 50,
        urgency: 0,
        updatedAt: new Date().toISOString(),
      });

      const state = applySignals(harnessDir, [
        { dimension: 'confidence', delta: -20 },
        { dimension: 'frustration', delta: -30 },
      ]);

      expect(state.confidence).toBe(60);
      expect(state.frustration).toBe(0); // Clamped to 0
    });

    it('should clamp results to 0-100', () => {
      saveEmotionalState(harnessDir, {
        confidence: 95,
        engagement: 5,
        frustration: 0,
        curiosity: 50,
        urgency: 0,
        updatedAt: new Date().toISOString(),
      });

      const state = applySignals(harnessDir, [
        { dimension: 'confidence', delta: 20 },  // 95 + 20 → 100
        { dimension: 'engagement', delta: -20 },  // 5 - 20 → 0
      ]);

      expect(state.confidence).toBe(100);
      expect(state.engagement).toBe(0);
    });

    it('should skip unknown dimensions', () => {
      const state = applySignals(harnessDir, [
        { dimension: 'unknown_dimension' as never, delta: 50 },
      ]);

      // Should not throw, values should be defaults
      expect(state.confidence).toBe(50);
    });

    it('should create history entry', () => {
      applySignals(harnessDir, [
        { dimension: 'confidence', delta: 10, reason: 'test' },
      ]);

      const historyPath = join(harnessDir, 'memory', 'emotional-history.jsonl');
      expect(existsSync(historyPath)).toBe(true);
    });
  });

  describe('deriveSignals', () => {
    it('should derive signals from successful run', () => {
      const signals = deriveSignals({
        success: true,
        steps: 3,
        toolCalls: 2,
      });

      const confidenceSignal = signals.find((s) => s.dimension === 'confidence' && s.delta > 0);
      expect(confidenceSignal).toBeDefined();

      const frustrationSignal = signals.find((s) => s.dimension === 'frustration' && s.delta < 0);
      expect(frustrationSignal).toBeDefined();
    });

    it('should derive signals from error', () => {
      const signals = deriveSignals({
        success: false,
        steps: 1,
        toolCalls: 0,
        error: true,
      });

      const frustrationSignal = signals.find((s) => s.dimension === 'frustration' && s.delta > 0);
      expect(frustrationSignal).toBeDefined();

      const confidenceSignal = signals.find((s) => s.dimension === 'confidence' && s.delta < 0);
      expect(confidenceSignal).toBeDefined();
    });

    it('should add urgency when budget is near limit', () => {
      const signals = deriveSignals({
        success: true,
        steps: 1,
        toolCalls: 0,
        budgetPercent: 90,
      });

      const urgencySignal = signals.find((s) => s.dimension === 'urgency' && s.delta > 0);
      expect(urgencySignal).toBeDefined();
    });

    it('should add curiosity for tool calls', () => {
      const signals = deriveSignals({
        success: true,
        steps: 1,
        toolCalls: 5,
      });

      const curiositySignal = signals.find((s) => s.dimension === 'curiosity');
      expect(curiositySignal).toBeDefined();
      expect(curiositySignal!.delta).toBeGreaterThan(0);
    });

    it('should add engagement for long runs', () => {
      const signals = deriveSignals({
        success: true,
        steps: 10,
        toolCalls: 0,
      });

      const engagementSignal = signals.find((s) => s.dimension === 'engagement');
      expect(engagementSignal).toBeDefined();
    });
  });

  describe('summarizeEmotionalState', () => {
    it('should describe low confidence', () => {
      const summary = summarizeEmotionalState({
        confidence: 20,
        engagement: 50,
        frustration: 0,
        curiosity: 50,
        urgency: 0,
        updatedAt: new Date().toISOString(),
      });

      expect(summary).toContain('Confidence is low');
    });

    it('should describe high frustration', () => {
      const summary = summarizeEmotionalState({
        confidence: 50,
        engagement: 50,
        frustration: 80,
        curiosity: 50,
        urgency: 0,
        updatedAt: new Date().toISOString(),
      });

      expect(summary).toContain('Frustration is elevated');
    });

    it('should return balanced for default state', () => {
      const summary = summarizeEmotionalState({
        confidence: 50,
        engagement: 50,
        frustration: 0,
        curiosity: 50,
        urgency: 0,
        updatedAt: new Date().toISOString(),
      });

      expect(summary).toContain('balanced');
    });

    it('should describe multiple dimensions', () => {
      const summary = summarizeEmotionalState({
        confidence: 20,
        engagement: 20,
        frustration: 80,
        curiosity: 80,
        urgency: 80,
        updatedAt: new Date().toISOString(),
      });

      expect(summary).toContain('Confidence');
      expect(summary).toContain('Frustration');
      expect(summary).toContain('Urgency');
    });
  });

  describe('resetEmotionalState', () => {
    it('should reset to defaults', () => {
      saveEmotionalState(harnessDir, {
        confidence: 90,
        engagement: 10,
        frustration: 80,
        curiosity: 20,
        urgency: 70,
        updatedAt: new Date().toISOString(),
      });

      const reset = resetEmotionalState(harnessDir);
      expect(reset.confidence).toBe(50);
      expect(reset.engagement).toBe(50);
      expect(reset.frustration).toBe(0);
      expect(reset.curiosity).toBe(50);
      expect(reset.urgency).toBe(0);
    });
  });

  describe('getEmotionalTrends', () => {
    it('should return defaults when no history exists', () => {
      const trends = getEmotionalTrends(harnessDir);
      expect(trends).toHaveLength(5);

      const confidenceTrend = trends.find((t) => t.dimension === 'confidence');
      expect(confidenceTrend).toBeDefined();
      expect(confidenceTrend!.trend).toBe('stable');
      expect(confidenceTrend!.values).toHaveLength(0);
    });

    it('should compute trends from history', () => {
      // Apply multiple signals to build history
      applySignals(harnessDir, [{ dimension: 'confidence', delta: 10 }]);
      applySignals(harnessDir, [{ dimension: 'confidence', delta: 10 }]);
      applySignals(harnessDir, [{ dimension: 'confidence', delta: 10 }]);
      applySignals(harnessDir, [{ dimension: 'confidence', delta: 10 }]);

      const trends = getEmotionalTrends(harnessDir);
      const confidenceTrend = trends.find((t) => t.dimension === 'confidence');
      expect(confidenceTrend).toBeDefined();
      expect(confidenceTrend!.values.length).toBe(4);
      expect(confidenceTrend!.average).toBeGreaterThan(50);
    });
  });
});
