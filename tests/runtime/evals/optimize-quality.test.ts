import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { optimizeQuality } from '../../../src/runtime/evals/optimize-quality.js';

function makeSkill(harnessDir: string, name: string, body: string, evalsJson: unknown): void {
  const dir = join(harnessDir, 'skills', name);
  mkdirSync(join(dir, 'evals'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} d ${Math.random()}\n---\n${body}`);
  writeFileSync(join(dir, 'evals/evals.json'), JSON.stringify(evalsJson));
}

function tmp(): string { return mkdtempSync(join(tmpdir(), 'oq-')); }

describe('optimizeQuality', () => {
  it('snapshots SKILL.md before each iteration', async () => {
    const dir = tmp();
    makeSkill(dir, 'foo', 'original body', {
      skill_name: 'foo',
      evals: [{ id: 't1', prompt: 'p', expected_output: 'e', assertions: ['result.json is valid JSON'] }],
    });

    const qualityRunner = vi.fn(async ({ outputDir }) => {
      writeFileSync(join(outputDir, 'result.json'), '{}');
      return { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, durationMs: 1 };
    });

    const proposeBody = vi.fn(async () => '---\nname: foo\ndescription: foo d new\n---\nrevised body');

    await optimizeQuality({
      harnessDir: dir,
      skillName: 'foo',
      maxIterations: 1,
      qualityRunner,
      proposeBody,
      llmGrader: null,
      autoApprove: true,
    });

    const snapshotDir = join(dir, '.evals-workspace/foo/quality/iteration-1/skill-snapshot');
    expect(existsSync(snapshotDir)).toBe(true);
    const snap = readFileSync(join(snapshotDir, 'SKILL.md'), 'utf-8');
    expect(snap).toContain('original body');
    expect(proposeBody).toHaveBeenCalled();
  });
});
