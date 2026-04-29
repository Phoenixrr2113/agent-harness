import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseTriggersFile, TriggersFileSchema } from '../../../src/runtime/evals/triggers-schema.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'triggers-schema-'));
}

describe('TriggersFileSchema', () => {
  it('accepts valid array of queries', () => {
    const valid = [
      { id: 'q1', query: 'do the thing', should_trigger: true, split: 'train' },
      { id: 'q2', query: 'unrelated', should_trigger: false, split: 'validation' },
    ];
    expect(() => TriggersFileSchema.parse(valid)).not.toThrow();
  });

  it('rejects missing should_trigger', () => {
    const invalid = [{ id: 'q1', query: 'x', split: 'train' }];
    expect(() => TriggersFileSchema.parse(invalid)).toThrow(/should_trigger/);
  });

  it('rejects bad split values', () => {
    const invalid = [{ id: 'q1', query: 'x', should_trigger: true, split: 'test' }];
    expect(() => TriggersFileSchema.parse(invalid)).toThrow(/split/);
  });

  it('accepts optional notes field', () => {
    const valid = [{ id: 'q1', query: 'x', should_trigger: true, split: 'train', notes: 'why' }];
    expect(() => TriggersFileSchema.parse(valid)).not.toThrow();
  });

  it('rejects query > 500 chars', () => {
    const invalid = [{ id: 'q1', query: 'x'.repeat(501), should_trigger: true, split: 'train' }];
    expect(() => TriggersFileSchema.parse(invalid)).toThrow(/500/);
  });
});

describe('parseTriggersFile', () => {
  it('reads and parses a valid file', () => {
    const dir = tmp();
    const path = join(dir, 'triggers.json');
    writeFileSync(path, JSON.stringify([
      { id: 'q1', query: 'a', should_trigger: true, split: 'train' },
    ]));
    const queries = parseTriggersFile(path);
    expect(queries).toHaveLength(1);
    expect(queries[0].id).toBe('q1');
  });

  it('throws if file is missing', () => {
    expect(() => parseTriggersFile('/nonexistent/path.json')).toThrow(/not found/i);
  });

  it('throws if file is not valid JSON', () => {
    const dir = tmp();
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{ not valid');
    expect(() => parseTriggersFile(path)).toThrow();
  });
});
