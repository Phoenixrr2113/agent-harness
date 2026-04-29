import { describe, it, expect } from 'vitest';
import { normalizeFrontmatter } from '../../src/primitives/normalize.js';

describe('normalizeFrontmatter — skills (strict spec)', () => {
  it('extracts harness-tags from metadata into tags array', () => {
    const result = normalizeFrontmatter(
      {
        name: 'research',
        description: 'A skill.',
        metadata: { 'harness-tags': 'research,knowledge-work' },
      },
      'skills',
      '/path/to/research'
    );
    expect(result.tags).toEqual(['research', 'knowledge-work']);
  });

  it('extracts harness-status default of active when missing', () => {
    const result = normalizeFrontmatter(
      { name: 'foo', description: 'A skill.' },
      'skills',
      '/path/to/foo'
    );
    expect(result.status).toBe('active');
  });

  it('reads harness-status from metadata', () => {
    const result = normalizeFrontmatter(
      {
        name: 'foo',
        description: 'A skill.',
        metadata: { 'harness-status': 'draft' },
      },
      'skills',
      '/path/to/foo'
    );
    expect(result.status).toBe('draft');
  });

  it('strips harness- prefixed keys from the metadata bag', () => {
    const result = normalizeFrontmatter(
      {
        name: 'foo',
        description: 'A skill.',
        metadata: {
          'harness-tags': 'a,b',
          'harness-status': 'active',
          'author': 'example-org',
          'version': '1.0',
        },
      },
      'skills',
      '/path/to/foo'
    );
    expect(result.metadata).toEqual({ author: 'example-org', version: '1.0' });
  });

  it('parses allowed-tools as space-separated string into array', () => {
    const result = normalizeFrontmatter(
      {
        name: 'foo',
        description: 'A skill.',
        'allowed-tools': 'WebSearch Read Bash(jq:*)',
      },
      'skills',
      '/path/to/foo'
    );
    expect(result.allowedTools).toEqual(['WebSearch', 'Read', 'Bash(jq:*)']);
  });

  it('sets id from name', () => {
    const result = normalizeFrontmatter(
      { name: 'research', description: 'A skill.' },
      'skills',
      '/path/to/research'
    );
    expect(result.id).toBe('research');
  });
});

describe('normalizeFrontmatter — non-skills', () => {
  it('reads tags from top-level field directly', () => {
    const result = normalizeFrontmatter(
      {
        name: 'daily-reflection',
        description: 'A workflow.',
        tags: ['reflection', 'daily'],
      },
      'workflows',
      '/path/to/daily-reflection'
    );
    expect(result.tags).toEqual(['reflection', 'daily']);
  });

  it('preserves type-specific top-level fields', () => {
    const result = normalizeFrontmatter(
      {
        name: 'daily-reflection',
        description: 'A workflow.',
        schedule: '0 22 * * *',
        durable: true,
      },
      'workflows',
      '/path/to/daily-reflection'
    );
    expect(result.schedule).toBe('0 22 * * *');
    expect(result.durable).toBe(true);
  });

  it('falls back id to basename when name not given', () => {
    const result = normalizeFrontmatter(
      { description: 'A flat rule.' },
      'rules',
      '/path/to/operations'
    );
    expect(result.id).toBe('operations');
  });
});
