import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, readEvents } from '../src/runtime/durable-events.js';

describe('durable-events', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'durable-events-'));
    mkdirSync(join(dir, '.workflow-data', 'runs', 'r1'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('appends and reads a single event', () => {
    appendEvent(dir, 'r1', {
      type: 'started',
      runId: 'r1',
      workflowId: 'wf',
      prompt: 'p',
      at: '2026-04-21T00:00:00.000Z',
    });
    const events = readEvents(dir, 'r1');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('started');
  });

  it('appends multiple events in order', () => {
    appendEvent(dir, 'r1', { type: 'started', runId: 'r1', workflowId: 'wf', prompt: 'p', at: 't1' });
    appendEvent(dir, 'r1', { type: 'step_started', ordinal: 0, toolName: 't', at: 't2', hash: 'h' });
    appendEvent(dir, 'r1', { type: 'step_completed', ordinal: 0, toolName: 't', at: 't3', hash: 'h' });
    const events = readEvents(dir, 'r1');
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.type)).toEqual(['started', 'step_started', 'step_completed']);
  });

  it('readEvents returns empty array when no log exists', () => {
    expect(readEvents(dir, 'nonexistent')).toEqual([]);
  });

  it('writes JSONL format (one event per line, each line is valid JSON)', () => {
    appendEvent(dir, 'r1', { type: 'started', runId: 'r1', workflowId: 'wf', prompt: 'p', at: 't' });
    appendEvent(dir, 'r1', { type: 'finished', at: 't', text: 'done', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
    const raw = readFileSync(join(dir, '.workflow-data', 'runs', 'r1', 'events.jsonl'), 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('creates parent directories when appending for the first time', () => {
    appendEvent(dir, 'fresh-run', { type: 'started', runId: 'fresh-run', workflowId: 'wf', prompt: 'p', at: 't' });
    const events = readEvents(dir, 'fresh-run');
    expect(events).toHaveLength(1);
  });
});
