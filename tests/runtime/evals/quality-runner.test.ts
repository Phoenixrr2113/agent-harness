import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runQualityEval, type QualityEvalAgentRunner } from '../../../src/runtime/evals/quality.js';

function makeSkill(harnessDir: string, name: string, evals: unknown): void {
  const dir = join(harnessDir, 'skills', name);
  mkdirSync(join(dir, 'evals/files'), { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Description for quality test ${Math.random()}\n---\nBody.`,
  );
  writeFileSync(join(dir, 'evals/evals.json'), JSON.stringify(evals));
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'eval-q-'));
}

describe('runQualityEval', () => {
  it('runs with-skill and without-skill, computes delta', async () => {
    const dir = tmp();
    makeSkill(dir, 'foo', {
      skill_name: 'foo',
      evals: [
        { id: 't1', prompt: 'do x', expected_output: 'y', assertions: ['the output is valid JSON'] },
      ],
    });

    let withCount = 0;
    let withoutCount = 0;
    const runner: QualityEvalAgentRunner = vi.fn(async ({ withSkill, outputDir }) => {
      if (withSkill) withCount++;
      else withoutCount++;
      writeFileSync(
        join(outputDir, 'result.json'),
        withSkill ? JSON.stringify({ ok: true }) : '{ not valid',
      );
      return {
        usage: { inputTokens: withSkill ? 100 : 80, outputTokens: 50, totalTokens: withSkill ? 150 : 130 },
        durationMs: withSkill ? 2000 : 1500,
      };
    });

    // Note: the assertion text is "the output is valid JSON" — the grader's VALID_JSON_PATTERN
    // matches "<filename>.json is valid json"; this test uses an assertion that will route to
    // the LLM grader. To keep this test mechanical we use llmGrader=null so the grader returns
    // a code-method false, and instead use an assertion phrase that DOES route mechanically.
    // Update the assertion to explicitly name the file:
    // (the test fixture above uses "the output is valid JSON" which won't match either pattern;
    //  we can pass an llmGrader that returns based on whether result.json content parses.)
    const llmGrader = vi.fn(async ({ outputDir }) => {
      try {
        JSON.parse(readFileSync(join(outputDir, 'result.json'), 'utf-8'));
        return { passed: true, evidence: 'parses' };
      } catch {
        return { passed: false, evidence: 'invalid' };
      }
    });

    const result = await runQualityEval({
      harnessDir: dir,
      skillName: 'foo',
      runner,
      llmGrader,
    });

    expect(withCount).toBe(1);
    expect(withoutCount).toBe(1);
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0].with_skill.pass_rate).toBe(1);
    expect(result.cases[0].without_skill.pass_rate).toBe(0);
    expect(result.delta.pass_rate).toBe(1);
    expect(result.delta.tokens).toBe(20);
    expect(result.delta.duration_ms).toBe(500);
  });

  it('writes benchmark.json to a fresh iteration directory', async () => {
    const dir = tmp();
    makeSkill(dir, 'foo', {
      skill_name: 'foo',
      evals: [{ id: 't1', prompt: 'p', expected_output: 'e', assertions: ['result.json is valid JSON'] }],
    });
    const runner: QualityEvalAgentRunner = vi.fn(async ({ outputDir }) => {
      writeFileSync(join(outputDir, 'result.json'), '{}');
      return { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, durationMs: 100 };
    });
    const result = await runQualityEval({ harnessDir: dir, skillName: 'foo', runner, llmGrader: null });
    expect(result.iteration).toBe('iteration-1');
    const path = join(dir, '.evals-workspace/foo/quality/iteration-1/benchmark.json');
    expect(existsSync(path)).toBe(true);
    const persisted = JSON.parse(readFileSync(path, 'utf-8'));
    expect(persisted.skill).toBe('foo');
    expect(persisted.cases).toHaveLength(1);
  });

  it('copies eval files into temp working dir before agent run', async () => {
    const dir = tmp();
    makeSkill(dir, 'foo', {
      skill_name: 'foo',
      evals: [
        { id: 't1', prompt: 'p', expected_output: 'e', files: ['evals/files/a.txt'], assertions: ['result.json is valid JSON'] },
      ],
    });
    writeFileSync(join(dir, 'skills/foo/evals/files/a.txt'), 'hello');

    const observed: string[] = [];
    const runner: QualityEvalAgentRunner = vi.fn(async ({ workingDir, outputDir }) => {
      observed.push(workingDir);
      expect(existsSync(join(workingDir, 'a.txt'))).toBe(true);
      writeFileSync(join(outputDir, 'result.json'), '{}');
      return { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, durationMs: 1 };
    });

    await runQualityEval({ harnessDir: dir, skillName: 'foo', runner, llmGrader: null });
    expect(observed.length).toBe(2); // with-skill + without-skill
  });
});
