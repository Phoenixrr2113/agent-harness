import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/runtime/durable-engine.js', async () => {
  const actual = await vi.importActual<typeof import('../src/runtime/durable-engine.js')>(
    '../src/runtime/durable-engine.js',
  );
  return {
    ...actual,
    durableRun: vi.fn(async () => ({
      runId: 'run_mock',
      text: 'durable-ok',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      steps: 1,
      resumed: false,
    })),
  };
});

vi.mock('../src/core/harness.js', async () => {
  const actual = await vi.importActual<typeof import('../src/core/harness.js')>(
    '../src/core/harness.js',
  );
  return {
    ...actual,
    createHarness: vi.fn(() => ({
      name: 'mock',
      async boot() {},
      async run() {
        return {
          text: 'non-durable-ok',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          session_id: 's',
          steps: 1,
          toolCalls: [],
        };
      },
      stream() { throw new Error('nyi'); },
      async shutdown() {},
      getSystemPrompt() { return ''; },
      getState() { return { mode: 'active', goals: [], active_workflows: [], last_interaction: '', unfinished_business: [] }; },
    })),
  };
});

import { Scheduler } from '../src/runtime/scheduler.js';
import { durableRun } from '../src/runtime/durable-engine.js';

function seedHarness(dir: string, workflowContent: string, cfg = ''): void {
  writeFileSync(
    join(dir, 'config.yaml'),
    `agent:\n  name: test\nmodel:\n  provider: openai\n  id: test\n${cfg}`,
  );
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  writeFileSync(join(dir, 'workflows', 'wf.md'), workflowContent);
}

describe('scheduler durable dispatch', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sched-durable-'));
    vi.clearAllMocks();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('routes durable:true workflow through durableRun', async () => {
    seedHarness(dir, `---\nid: wf1\ndurable: true\n---\nDo the thing.\n`);
    const sched = new Scheduler({ harnessDir: dir });
    const loadedDoc = { frontmatter: { id: 'wf1', durable: true, tags: [], related: [], author: 'human', status: 'active' }, body: 'Do the thing.', l0: '', l1: '', path: '', raw: '' };
    await sched.executeWorkflow(loadedDoc as never);
    expect(durableRun).toHaveBeenCalledTimes(1);
  });

  it('routes non-durable workflow through agent.run (durableRun not called)', async () => {
    seedHarness(dir, `---\nid: wf1\n---\nDo the thing.\n`);
    const sched = new Scheduler({ harnessDir: dir });
    const loadedDoc = { frontmatter: { id: 'wf1', tags: [], related: [], author: 'human', status: 'active' }, body: 'Do the thing.', l0: '', l1: '', path: '', raw: '' };
    await sched.executeWorkflow(loadedDoc as never);
    expect(durableRun).not.toHaveBeenCalled();
  });

  it('durable_default: true in config routes non-flagged workflow through durableRun', async () => {
    seedHarness(dir, `---\nid: wf1\n---\nDo the thing.\n`, `workflows:\n  durable_default: true\n`);
    const sched = new Scheduler({ harnessDir: dir });
    const loadedDoc = { frontmatter: { id: 'wf1', tags: [], related: [], author: 'human', status: 'active' }, body: 'Do the thing.', l0: '', l1: '', path: '', raw: '' };
    await sched.executeWorkflow(loadedDoc as never);
    expect(durableRun).toHaveBeenCalledTimes(1);
  });
});
