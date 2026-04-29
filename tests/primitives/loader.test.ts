import { describe, it, expect } from 'vitest';
import type { HarnessDocument } from '../../src/core/types.js';

describe('HarnessDocument', () => {
  it('exposes normalized accessor fields', () => {
    const doc: HarnessDocument = {
      path: '/test/skills/foo/SKILL.md',
      name: 'foo',
      id: 'foo',
      description: 'A test skill.',
      tags: ['test'],
      status: 'active',
      author: 'human',
      related: [],
      allowedTools: [],
      body: 'Test body.',
      raw: '---\nname: foo\n---\nTest body.',
      frontmatter: { name: 'foo', description: 'A test skill.' },
    };
    expect(doc.id).toBe('foo');
    expect(doc.name).toBe('foo');
    expect(doc.tags).toEqual(['test']);
    expect(doc.status).toBe('active');
  });
});
