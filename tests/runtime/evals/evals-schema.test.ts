import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseEvalsFile, EvalsFileSchema } from '../../../src/runtime/evals/evals-schema.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'evals-schema-'));
}

describe('EvalsFileSchema', () => {
  it('accepts valid skill_name + evals array', () => {
    const valid = {
      skill_name: 'csv-analyzer',
      evals: [
        {
          id: 't1',
          prompt: 'do thing',
          expected_output: 'a chart',
          assertions: ['has axes'],
        },
      ],
    };
    expect(() => EvalsFileSchema.parse(valid)).not.toThrow();
  });

  it('accepts optional files array', () => {
    const valid = {
      skill_name: 's',
      evals: [{ id: 't1', prompt: 'x', expected_output: 'y', assertions: ['z'], files: ['evals/files/a.csv'] }],
    };
    expect(() => EvalsFileSchema.parse(valid)).not.toThrow();
  });

  it('rejects missing assertions', () => {
    const invalid = {
      skill_name: 's',
      evals: [{ id: 't1', prompt: 'x', expected_output: 'y' }],
    };
    expect(() => EvalsFileSchema.parse(invalid)).toThrow(/assertions/);
  });

  it('rejects assertions: []', () => {
    const invalid = {
      skill_name: 's',
      evals: [{ id: 't1', prompt: 'x', expected_output: 'y', assertions: [] }],
    };
    expect(() => EvalsFileSchema.parse(invalid)).toThrow(/at least one/i);
  });
});

describe('parseEvalsFile', () => {
  it('reads and parses a valid file', () => {
    const dir = tmp();
    const path = join(dir, 'evals.json');
    writeFileSync(path, JSON.stringify({
      skill_name: 's',
      evals: [{ id: 't1', prompt: 'x', expected_output: 'y', assertions: ['z'] }],
    }));
    const file = parseEvalsFile(path);
    expect(file.skill_name).toBe('s');
    expect(file.evals).toHaveLength(1);
  });
});
