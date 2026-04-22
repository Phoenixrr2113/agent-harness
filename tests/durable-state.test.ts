import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeState, readState, listRunIds, type RunState } from '../src/runtime/durable-state.js';

describe('durable-state', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'durable-state-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const base: RunState = {
    runId: 'r1',
    workflowId: 'wf1',
    prompt: 'do the thing',
    status: 'running',
    startedAt: '2026-04-21T10:00:00.000Z',
    lastOrdinal: 0,
  };

  it('writes and reads a run state', () => {
    writeState(dir, base);
    expect(readState(dir, 'r1')).toEqual(base);
  });

  it('readState returns null for unknown run', () => {
    expect(readState(dir, 'nope')).toBeNull();
  });

  it('listRunIds returns all runs with state.json', () => {
    writeState(dir, base);
    writeState(dir, { ...base, runId: 'r2' });
    writeState(dir, { ...base, runId: 'r3' });
    expect(listRunIds(dir).sort()).toEqual(['r1', 'r2', 'r3']);
  });

  it('listRunIds returns [] when no runs exist', () => {
    expect(listRunIds(dir)).toEqual([]);
  });

  it('overwrites fields on write', () => {
    writeState(dir, base);
    writeState(dir, { ...base, status: 'complete', endedAt: '2026-04-21T10:05:00.000Z' });
    const state = readState(dir, 'r1');
    expect(state?.status).toBe('complete');
    expect(state?.endedAt).toBe('2026-04-21T10:05:00.000Z');
  });

  it('preserves wakeTime when status is suspended', () => {
    writeState(dir, { ...base, status: 'suspended', wakeTime: '2026-04-22T10:00:00.000Z' });
    const state = readState(dir, 'r1');
    expect(state?.wakeTime).toBe('2026-04-22T10:00:00.000Z');
  });
});
