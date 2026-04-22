import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/llm/provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm/provider.js')>();
  const { MockLanguageModelV3 } = await import('ai/test');
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
      finishReason: { type: 'stop' as const },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
    }),
  });
  return {
    ...actual,
    getModel: vi.fn().mockReturnValue(model),
  };
});

import { Scheduler } from '../src/runtime/scheduler.js';

function seedHarness(dir: string, workflowContent: string, cfg = ''): void {
  writeFileSync(
    join(dir, 'config.yaml'),
    `agent:\n  name: test\nmodel:\n  provider: openai\n  id: test\nruntime:\n  quiet_hours:\n    start: 0\n    end: 0\n${cfg}`,
  );
  writeFileSync(join(dir, 'CORE.md'), '# Test\n');
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  writeFileSync(join(dir, 'workflows', 'wf.md'), workflowContent);
}

const runsDir = (dir: string) => join(dir, '.workflow-data', 'runs');

describe('scheduler durable dispatch', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sched-durable-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('routes durable:true workflow through durableRun (creates .workflow-data/runs entry)', async () => {
    seedHarness(dir, `---\nid: wf1\ndurable: true\n---\nDo the thing.\n`);
    const sched = new Scheduler({ harnessDir: dir });
    const loadedDoc = { frontmatter: { id: 'wf1', durable: true, tags: [], related: [], author: 'human', status: 'active' }, body: 'Do the thing.', l0: '', l1: '', path: '', raw: '' };
    await sched.executeWorkflow(loadedDoc as never);
    expect(existsSync(runsDir(dir))).toBe(true);
    expect(readdirSync(runsDir(dir)).length).toBeGreaterThanOrEqual(1);
  });

  it('routes non-durable workflow through agent.run (no .workflow-data written)', async () => {
    seedHarness(dir, `---\nid: wf1\n---\nDo the thing.\n`);
    const sched = new Scheduler({ harnessDir: dir });
    const loadedDoc = { frontmatter: { id: 'wf1', tags: [], related: [], author: 'human', status: 'active' }, body: 'Do the thing.', l0: '', l1: '', path: '', raw: '' };
    await sched.executeWorkflow(loadedDoc as never);
    expect(existsSync(join(dir, '.workflow-data'))).toBe(false);
  });

  it('durable_default: true in config routes non-flagged workflow through durableRun', async () => {
    seedHarness(dir, `---\nid: wf1\n---\nDo the thing.\n`, `workflows:\n  durable_default: true\n`);
    const sched = new Scheduler({ harnessDir: dir });
    const loadedDoc = { frontmatter: { id: 'wf1', tags: [], related: [], author: 'human', status: 'active' }, body: 'Do the thing.', l0: '', l1: '', path: '', raw: '' };
    await sched.executeWorkflow(loadedDoc as never);
    expect(existsSync(runsDir(dir))).toBe(true);
    expect(readdirSync(runsDir(dir)).length).toBeGreaterThanOrEqual(1);
  });
});
