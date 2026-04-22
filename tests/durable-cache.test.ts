import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashStep, loadStep, saveStep } from '../src/runtime/durable-cache.js';

describe('hashStep', () => {
  it('is deterministic across calls', () => {
    const a = hashStep('my_tool', 0, { x: 1, y: 'foo' });
    const b = hashStep('my_tool', 0, { x: 1, y: 'foo' });
    expect(a).toBe(b);
  });

  it('is stable across arg key ordering', () => {
    const a = hashStep('my_tool', 0, { x: 1, y: 'foo' });
    const b = hashStep('my_tool', 0, { y: 'foo', x: 1 });
    expect(a).toBe(b);
  });

  it('is stable for nested objects regardless of key order', () => {
    const a = hashStep('t', 0, { outer: { a: 1, b: 2 } });
    const b = hashStep('t', 0, { outer: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });

  it('differs when tool name changes', () => {
    expect(hashStep('a', 0, { x: 1 })).not.toBe(hashStep('b', 0, { x: 1 }));
  });

  it('differs when ordinal changes', () => {
    expect(hashStep('a', 0, { x: 1 })).not.toBe(hashStep('a', 1, { x: 1 }));
  });

  it('differs when args change', () => {
    expect(hashStep('a', 0, { x: 1 })).not.toBe(hashStep('a', 0, { x: 2 }));
  });
});

describe('cache load/save', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'durable-cache-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns undefined on cache miss', () => {
    expect(loadStep(dir, 'r1', 'nope')).toBeUndefined();
  });

  it('saves and retrieves a result', () => {
    const hash = hashStep('my_tool', 0, { x: 1 });
    saveStep(dir, 'r1', hash, { output: 'result' });
    expect(loadStep(dir, 'r1', hash)).toEqual({ output: 'result' });
  });

  it('persists primitives and arrays', () => {
    const h1 = hashStep('a', 0, {});
    const h2 = hashStep('b', 1, {});
    saveStep(dir, 'r1', h1, 42);
    saveStep(dir, 'r1', h2, [1, 2, 3]);
    expect(loadStep(dir, 'r1', h1)).toBe(42);
    expect(loadStep(dir, 'r1', h2)).toEqual([1, 2, 3]);
  });

  it('scopes cache to run id (different runs do not collide)', () => {
    const hash = hashStep('t', 0, {});
    saveStep(dir, 'run1', hash, 'a');
    saveStep(dir, 'run2', hash, 'b');
    expect(loadStep(dir, 'run1', hash)).toBe('a');
    expect(loadStep(dir, 'run2', hash)).toBe('b');
  });
});
