import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrapToolsWithCache } from '../src/runtime/durable-tools.js';
import { writeState } from '../src/runtime/durable-state.js';
import { readEvents } from '../src/runtime/durable-events.js';
import type { AIToolSet } from '../src/runtime/tool-executor.js';

function makeFakeTool(execute: (args: unknown) => unknown): AIToolSet[string] {
  return {
    description: 'fake',
    inputSchema: { jsonSchema: { type: 'object' } },
    execute,
  } as unknown as AIToolSet[string];
}

const fakeExecCtx = { toolCallId: 'a', messages: [] } as never;

describe('wrapToolsWithCache', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'durable-tools-'));
    writeState(dir, { runId: 'r1', workflowId: 'wf', prompt: 'p', status: 'running', startedAt: 't', lastOrdinal: 0 });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('calls the real execute on a cache miss and saves the result', async () => {
    let callCount = 0;
    const tools = wrapToolsWithCache(
      { my_tool: makeFakeTool(async () => { callCount++; return { ok: true }; }) },
      { harnessDir: dir, runId: 'r1', ordinalCounter: { value: 0 } },
    );
    const res = await tools.my_tool.execute!({ x: 1 }, fakeExecCtx);
    expect(res).toEqual({ ok: true });
    expect(callCount).toBe(1);
  });

  it('returns cached on replay without calling execute again', async () => {
    let callCount = 0;
    const tools = wrapToolsWithCache(
      { my_tool: makeFakeTool(async () => { callCount++; return { n: callCount }; }) },
      { harnessDir: dir, runId: 'r1', ordinalCounter: { value: 0 } },
    );
    const a = await tools.my_tool.execute!({ x: 1 }, fakeExecCtx);

    const tools2 = wrapToolsWithCache(
      { my_tool: makeFakeTool(async () => { callCount++; return { n: callCount }; }) },
      { harnessDir: dir, runId: 'r1', ordinalCounter: { value: 0 } },
    );
    const b = await tools2.my_tool.execute!({ x: 1 }, fakeExecCtx);

    expect(a).toEqual(b);
    expect(callCount).toBe(1);
  });

  it('different args at same ordinal produce different hashes (no collision)', async () => {
    let callCount = 0;
    const tools = wrapToolsWithCache(
      { my_tool: makeFakeTool(async () => { callCount++; return callCount; }) },
      { harnessDir: dir, runId: 'r1', ordinalCounter: { value: 0 } },
    );
    await tools.my_tool.execute!({ x: 1 }, fakeExecCtx);

    const tools2 = wrapToolsWithCache(
      { my_tool: makeFakeTool(async () => { callCount++; return callCount; }) },
      { harnessDir: dir, runId: 'r1', ordinalCounter: { value: 0 } },
    );
    await tools2.my_tool.execute!({ x: 2 }, fakeExecCtx);
    expect(callCount).toBe(2);
  });

  it('writes step_started + step_completed events on success', async () => {
    const tools = wrapToolsWithCache(
      { my_tool: makeFakeTool(async () => 'ok') },
      { harnessDir: dir, runId: 'r1', ordinalCounter: { value: 0 } },
    );
    await tools.my_tool.execute!({ x: 1 }, fakeExecCtx);
    const types = readEvents(dir, 'r1').map((e) => e.type);
    expect(types).toContain('step_started');
    expect(types).toContain('step_completed');
  });

  it('rethrows tool error and writes step_failed event', async () => {
    const tools = wrapToolsWithCache(
      { my_tool: makeFakeTool(async () => { throw new Error('boom'); }) },
      { harnessDir: dir, runId: 'r1', ordinalCounter: { value: 0 } },
    );
    await expect(tools.my_tool.execute!({ x: 1 }, fakeExecCtx)).rejects.toThrow('boom');
    const types = readEvents(dir, 'r1').map((e) => e.type);
    expect(types).toContain('step_failed');
  });

  it('leaves tools without execute untouched', () => {
    const tools = wrapToolsWithCache(
      { no_exec: { description: 'x', inputSchema: { jsonSchema: { type: 'object' } } } as unknown as AIToolSet[string] },
      { harnessDir: dir, runId: 'r1', ordinalCounter: { value: 0 } },
    );
    expect(tools.no_exec.execute).toBeUndefined();
  });
});
