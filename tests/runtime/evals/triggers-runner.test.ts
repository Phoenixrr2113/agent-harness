import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runTriggerEval, type TriggerEvalAgentRunner } from '../../../src/runtime/evals/triggers.js';

function makeSkill(harnessDir: string, name: string, description: string, triggers: unknown[]): void {
  const dir = join(harnessDir, 'skills', name);
  mkdirSync(join(dir, 'evals'), { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\nBody ${Math.random()}.`,
  );
  writeFileSync(join(dir, 'evals/triggers.json'), JSON.stringify(triggers));
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'eval-trig-'));
}

describe('runTriggerEval', () => {
  it('counts activate_skill calls per query', async () => {
    const dir = tmp();
    makeSkill(dir, 'foo', 'helps with foo tasks', [
      { id: 'q1', query: 'do a foo task', should_trigger: true, split: 'train' },
    ]);
    const runner: TriggerEvalAgentRunner = vi.fn(async () => ({
      toolCalls: [{ toolName: 'activate_skill', args: { name: 'foo' }, result: '' }],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      steps: 2,
      text: '',
    }));

    const result = await runTriggerEval({
      harnessDir: dir,
      skillName: 'foo',
      runs: 3,
      split: 'train',
      runner,
    });

    expect(runner).toHaveBeenCalledTimes(3);
    expect(result.results[0].trigger_count).toBe(3);
    expect(result.results[0].trigger_rate).toBe(1.0);
    expect(result.results[0].passed).toBe(true);
    expect(result.summary.passed).toBe(1);
    expect(result.summary.total).toBe(1);
  });

  it('marks should_trigger=true with rate < 0.5 as failed', async () => {
    const dir = tmp();
    makeSkill(dir, 'foo', 'desc', [
      { id: 'q1', query: 'q', should_trigger: true, split: 'train' },
    ]);
    let calls = 0;
    const runner: TriggerEvalAgentRunner = vi.fn(async () => {
      calls++;
      const triggered = calls === 1;
      return {
        toolCalls: triggered ? [{ toolName: 'activate_skill', args: { name: 'foo' }, result: '' }] : [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        steps: 1,
        text: '',
      };
    });

    const result = await runTriggerEval({ harnessDir: dir, skillName: 'foo', runs: 3, split: 'train', runner });
    expect(result.results[0].trigger_rate).toBeCloseTo(0.333, 2);
    expect(result.results[0].passed).toBe(false);
  });

  it('passes should_not_trigger query when model abstains', async () => {
    const dir = tmp();
    makeSkill(dir, 'foo', 'desc', [
      { id: 'neg1', query: 'unrelated thing', should_trigger: false, split: 'validation' },
    ]);
    const runner: TriggerEvalAgentRunner = vi.fn(async () => ({
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      steps: 1,
      text: '',
    }));

    const result = await runTriggerEval({ harnessDir: dir, skillName: 'foo', runs: 3, split: 'validation', runner });
    expect(result.results[0].trigger_rate).toBe(0);
    expect(result.results[0].passed).toBe(true);
  });

  it('filters by split', async () => {
    const dir = tmp();
    makeSkill(dir, 'foo', 'desc', [
      { id: 'a', query: 'q', should_trigger: true, split: 'train' },
      { id: 'b', query: 'q', should_trigger: true, split: 'validation' },
    ]);
    const runner: TriggerEvalAgentRunner = vi.fn(async () => ({
      toolCalls: [{ toolName: 'activate_skill', args: { name: 'foo' }, result: '' }],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      steps: 1,
      text: '',
    }));
    const result = await runTriggerEval({ harnessDir: dir, skillName: 'foo', runs: 1, split: 'train', runner });
    expect(result.results.map((r) => r.id)).toEqual(['a']);
  });

  it('writes report to workspace', async () => {
    const dir = tmp();
    makeSkill(dir, 'foo', 'desc', [
      { id: 'q1', query: 'q', should_trigger: true, split: 'train' },
    ]);
    const runner: TriggerEvalAgentRunner = vi.fn(async () => ({
      toolCalls: [{ toolName: 'activate_skill', args: { name: 'foo' }, result: '' }],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      steps: 1,
      text: '',
    }));
    await runTriggerEval({ harnessDir: dir, skillName: 'foo', runs: 1, split: 'train', runner });
    const triggersDir = join(dir, '.evals-workspace/foo/triggers');
    expect(existsSync(triggersDir)).toBe(true);
    const reports = readdirSync(triggersDir).filter((f) => f.endsWith('.json'));
    expect(reports.length).toBe(1);
    const data = JSON.parse(readFileSync(join(triggersDir, reports[0]), 'utf-8'));
    expect(data.skill).toBe('foo');
  });
});
