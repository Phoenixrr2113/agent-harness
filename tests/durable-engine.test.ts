import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/llm/provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm/provider.js')>();
  const { MockLanguageModelV3 } = await import('ai/test');
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: 'done' }],
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

import {
  durableRun,
  scanResumableRuns,
  listRuns,
  cleanupOldRuns,
  deleteRun,
} from '../src/runtime/durable-engine.js';
import { readEvents } from '../src/runtime/durable-events.js';
import { readState, writeState } from '../src/runtime/durable-state.js';
import { getModel } from '../src/llm/provider.js';

function seedHarness(dir: string) {
  writeFileSync(
    join(dir, 'config.yaml'),
    `agent:\n  name: test\nmodel:\n  provider: openai\n  id: test\n`,
  );
  writeFileSync(join(dir, 'CORE.md'), '# Test Agent\n');
}

describe('durableRun', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'durable-engine-'));
    seedHarness(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes started + finished events and marks state complete on happy path', async () => {
    const result = await durableRun({
      harnessDir: dir,
      workflowId: 'wf1',
      prompt: 'hello',
      apiKey: 'test-key',
    });

    expect(result.text).toBe('done');
    expect(result.resumed).toBe(false);
    const state = readState(dir, result.runId);
    expect(state?.status).toBe('complete');
    const types = readEvents(dir, result.runId).map((e) => e.type);
    expect(types).toEqual(['started', 'finished']);
  });

  it('marks state failed and writes failed event when the model throws', async () => {
    const { MockLanguageModelV3 } = await import('ai/test');
    const failModel = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-fail',
      doGenerate: async () => {
        throw new Error('model blew up');
      },
    });
    (getModel as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(failModel);

    await expect(
      durableRun({
        harnessDir: dir,
        workflowId: 'wf1',
        prompt: 'hello',
        apiKey: 'test-key',
      }),
    ).rejects.toThrow('model blew up');

    const runIds = listRuns(dir).map((r) => r.runId);
    expect(runIds).toHaveLength(1);
    const state = readState(dir, runIds[0]);
    expect(state?.status).toBe('failed');
    expect(state?.error).toContain('model blew up');
  });

  it('resumes existing run when resumeRunId is provided and preserves runId', async () => {
    const first = await durableRun({
      harnessDir: dir,
      workflowId: 'wf1',
      prompt: 'hello',
      apiKey: 'test-key',
    });
    const second = await durableRun({
      harnessDir: dir,
      workflowId: 'wf1',
      prompt: 'hello',
      resumeRunId: first.runId,
      apiKey: 'test-key',
    });
    expect(second.runId).toBe(first.runId);
    expect(second.resumed).toBe(true);
  });
});

describe('scanResumableRuns', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'durable-scan-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns incomplete runs (running status) as resumable', () => {
    writeState(dir, { runId: 'r1', workflowId: 'wf', prompt: 'p', status: 'running', startedAt: 't', lastOrdinal: 3 });
    writeState(dir, { runId: 'r2', workflowId: 'wf', prompt: 'p', status: 'complete', startedAt: 't', endedAt: 't', lastOrdinal: 0 });
    const resumable = scanResumableRuns(dir);
    expect(resumable.map((r) => r.runId)).toEqual(['r1']);
  });

  it('returns suspended runs whose wake time has passed', () => {
    const pastWake = new Date(Date.now() - 60_000).toISOString();
    const futureWake = new Date(Date.now() + 60_000).toISOString();
    writeState(dir, { runId: 'r1', workflowId: 'wf', prompt: 'p', status: 'suspended', startedAt: 't', wakeTime: pastWake, lastOrdinal: 0 });
    writeState(dir, { runId: 'r2', workflowId: 'wf', prompt: 'p', status: 'suspended', startedAt: 't', wakeTime: futureWake, lastOrdinal: 0 });
    const resumable = scanResumableRuns(dir);
    expect(resumable.map((r) => r.runId)).toEqual(['r1']);
  });

  it('returns empty array for clean harness', () => {
    expect(scanResumableRuns(dir)).toEqual([]);
  });
});

describe('cleanupOldRuns', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'durable-cleanup-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('deletes complete runs older than N days', () => {
    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    const recent = new Date(Date.now() - 5 * 86400_000).toISOString();
    writeState(dir, { runId: 'old', workflowId: 'wf', prompt: 'p', status: 'complete', startedAt: old, endedAt: old, lastOrdinal: 0 });
    writeState(dir, { runId: 'recent', workflowId: 'wf', prompt: 'p', status: 'complete', startedAt: recent, endedAt: recent, lastOrdinal: 0 });
    const cleaned = cleanupOldRuns(dir, 30);
    expect(cleaned).toBe(1);
    expect(listRuns(dir).map((r) => r.runId)).toEqual(['recent']);
  });

  it('does not delete running runs regardless of age', () => {
    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    writeState(dir, { runId: 'still-running', workflowId: 'wf', prompt: 'p', status: 'running', startedAt: old, lastOrdinal: 0 });
    expect(cleanupOldRuns(dir, 30)).toBe(0);
  });

  it('does not delete suspended runs regardless of age', () => {
    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    writeState(dir, { runId: 'paused', workflowId: 'wf', prompt: 'p', status: 'suspended', startedAt: old, wakeTime: old, lastOrdinal: 0 });
    expect(cleanupOldRuns(dir, 30)).toBe(0);
  });

  it('deletes failed runs older than N days', () => {
    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    writeState(dir, { runId: 'failed', workflowId: 'wf', prompt: 'p', status: 'failed', startedAt: old, endedAt: old, lastOrdinal: 0, error: 'x' });
    expect(cleanupOldRuns(dir, 30)).toBe(1);
  });
});

describe('deleteRun', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'durable-delete-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('removes the run directory', () => {
    writeState(dir, { runId: 'r1', workflowId: 'wf', prompt: 'p', status: 'complete', startedAt: 't', endedAt: 't', lastOrdinal: 0 });
    expect(listRuns(dir).map((r) => r.runId)).toEqual(['r1']);
    deleteRun(dir, 'r1');
    expect(listRuns(dir)).toEqual([]);
  });
});
