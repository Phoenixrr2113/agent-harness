import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { promoteRule } from '../../src/runtime/promote-rule.js';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'promote-')); }

function makeHarness(dir: string): void {
  mkdirSync(join(dir, 'rules'), { recursive: true });
  mkdirSync(join(dir, 'memory/sessions'), { recursive: true });
}

const sampleCandidate = {
  id: 'always-format-tables',
  behavior: 'When presenting tabular data, always render as a markdown table.',
  provenance: 'Pattern observed in 3 sessions',
  confidence: 0.85,
};

describe('promoteRule — eval gate', () => {
  it('promotes when delta is positive', async () => {
    const dir = tmp();
    makeHarness(dir);
    const triggerStub = vi.fn(async () => ({
      summary: { passed: 5, failed: 1, total: 6, pass_rate: 0.83 },
    }));
    const qualityStub = vi.fn(async () => ({ delta: { pass_rate: 0.4, tokens: 0, duration_ms: 0 } }));
    const generateQueriesStub = vi.fn(async () => [
      { id: 'q1', query: 'show data', should_trigger: true, split: 'validation' as const },
    ]);

    const result = await promoteRule({
      harnessDir: dir,
      candidate: sampleCandidate,
      runTriggerEval: triggerStub,
      runQualityEval: qualityStub,
      generateQueries: generateQueriesStub,
      noEvalGate: false,
    });

    expect(result.promoted).toBe(true);
    expect(result.reason).toMatch(/delta/);
    const ruleFile = join(dir, 'rules', 'always-format-tables.md');
    expect(existsSync(ruleFile)).toBe(true);
  });

  it('rejects when delta is non-positive', async () => {
    const dir = tmp();
    makeHarness(dir);
    const triggerStub = vi.fn(async () => ({ summary: { passed: 5, failed: 1, total: 6, pass_rate: 0.83 } }));
    const qualityStub = vi.fn(async () => ({ delta: { pass_rate: 0, tokens: 0, duration_ms: 0 } }));
    const generateQueriesStub = vi.fn(async () => []);

    const result = await promoteRule({
      harnessDir: dir,
      candidate: sampleCandidate,
      runTriggerEval: triggerStub,
      runQualityEval: qualityStub,
      generateQueries: generateQueriesStub,
      noEvalGate: false,
    });

    expect(result.promoted).toBe(false);
    expect(result.reason).toMatch(/no measurable improvement/i);
  });

  it('skips eval gate with noEvalGate=true', async () => {
    const dir = tmp();
    makeHarness(dir);
    const triggerStub = vi.fn();
    const qualityStub = vi.fn();
    const generateQueriesStub = vi.fn();

    const result = await promoteRule({
      harnessDir: dir,
      candidate: sampleCandidate,
      runTriggerEval: triggerStub,
      runQualityEval: qualityStub,
      generateQueries: generateQueriesStub,
      noEvalGate: true,
    });

    expect(triggerStub).not.toHaveBeenCalled();
    expect(qualityStub).not.toHaveBeenCalled();
    expect(result.promoted).toBe(true);
    expect(result.reason).toMatch(/bypass/i);
  });

  it('rejects when trigger eval pass_rate is below threshold', async () => {
    const dir = tmp();
    makeHarness(dir);
    const triggerStub = vi.fn(async () => ({ summary: { passed: 1, failed: 5, total: 6, pass_rate: 0.16 } }));
    const qualityStub = vi.fn(async () => ({ delta: { pass_rate: 0.4, tokens: 0, duration_ms: 0 } }));
    const generateQueriesStub = vi.fn(async () => [
      { id: 'q1', query: 'show data', should_trigger: true, split: 'validation' as const },
    ]);

    const result = await promoteRule({
      harnessDir: dir,
      candidate: sampleCandidate,
      runTriggerEval: triggerStub,
      runQualityEval: qualityStub,
      generateQueries: generateQueriesStub,
      noEvalGate: false,
    });

    expect(result.promoted).toBe(false);
    expect(result.reason).toMatch(/trigger.*0\.16/i);
  });
});
