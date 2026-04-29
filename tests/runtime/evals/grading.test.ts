import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { gradeAssertion } from '../../../src/runtime/evals/grading.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'grade-'));
}

describe('gradeAssertion — code-checks first', () => {
  it('detects "output file <X> exists" mechanically', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'report.md'), 'hello');
    const r = await gradeAssertion('the output includes a file named report.md', dir, { llmGrader: null });
    expect(r.passed).toBe(true);
    expect(r.method).toBe('code');
    expect(r.evidence).toMatch(/report\.md/);
  });

  it('detects "output is valid JSON" mechanically', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ ok: true }));
    const r = await gradeAssertion('result.json is valid JSON', dir, { llmGrader: null });
    expect(r.passed).toBe(true);
    expect(r.method).toBe('code');
  });

  it('fails when mechanically-checkable assertion is false', async () => {
    const dir = tmp();
    const r = await gradeAssertion('the output includes a file named missing.md', dir, { llmGrader: null });
    expect(r.passed).toBe(false);
    expect(r.method).toBe('code');
  });
});

describe('gradeAssertion — LLM judge fallback', () => {
  it('routes prose assertions to the grader model', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'chart.png'), 'fakebytes');
    const llmGrader = vi.fn(async () => ({ passed: true, evidence: 'looks like a chart' }));
    const r = await gradeAssertion('the chart has labeled axes', dir, { llmGrader });
    expect(llmGrader).toHaveBeenCalledTimes(1);
    expect(r.passed).toBe(true);
    expect(r.method).toBe('llm');
    expect(r.evidence).toBe('looks like a chart');
  });

  it('returns false from grader verdict', async () => {
    const dir = tmp();
    const llmGrader = vi.fn(async () => ({ passed: false, evidence: 'no chart' }));
    const r = await gradeAssertion('the chart has 3 bars', dir, { llmGrader });
    expect(r.passed).toBe(false);
    expect(r.method).toBe('llm');
  });

  it('treats grader exception as passed=false with error evidence', async () => {
    const dir = tmp();
    const llmGrader = vi.fn(async () => { throw new Error('LLM down'); });
    const r = await gradeAssertion('something subjective', dir, { llmGrader });
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('LLM down');
  });
});
