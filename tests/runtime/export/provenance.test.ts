import { describe, it, expect } from 'vitest';
import { computeContentHash, embedProvenance, extractProvenance, hasProvenance } from '../../../src/runtime/export/provenance.js';

describe('computeContentHash', () => {
  it('returns sha256 prefixed string', () => {
    const h = computeContentHash('hello');
    expect(h).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('is deterministic', () => {
    expect(computeContentHash('x')).toBe(computeContentHash('x'));
  });

  it('changes on content change', () => {
    expect(computeContentHash('x')).not.toBe(computeContentHash('y'));
  });
});

describe('embedProvenance / extractProvenance — frontmatter mode', () => {
  it('round-trips a frontmatter document', () => {
    const original = '---\nname: foo\ndescription: bar\n---\nBody.';
    const marker = {
      'harness-exported-from': '/h/skills/foo/SKILL.md',
      'harness-exported-at': '2026-05-03T00:00:00Z',
      'harness-exported-by': 'agent-harness@0.13.0',
      'harness-content-hash': 'sha256:abc',
    };
    const embedded = embedProvenance(original, marker, 'frontmatter');
    expect(embedded).toContain('harness-exported-from');
    const extracted = extractProvenance(embedded, 'frontmatter');
    expect(extracted).not.toBeNull();
    expect(extracted!['harness-exported-from']).toBe('/h/skills/foo/SKILL.md');
  });
});

describe('embedProvenance / extractProvenance — markdown comment mode', () => {
  it('round-trips a plain markdown document', () => {
    const original = '# Hello\n\nWorld.';
    const marker = {
      'harness-exported-from': '/h/IDENTITY.md',
      'harness-exported-at': '2026-05-03T00:00:00Z',
      'harness-exported-by': 'agent-harness@0.13.0',
      'harness-content-hash': 'sha256:def',
    };
    const embedded = embedProvenance(original, marker, 'markdown-comment');
    expect(embedded.startsWith('<!--')).toBe(true);
    expect(embedded).toContain('# Hello');
    const extracted = extractProvenance(embedded, 'markdown-comment');
    expect(extracted).not.toBeNull();
    expect(extracted!['harness-content-hash']).toBe('sha256:def');
  });
});

describe('hasProvenance', () => {
  it('detects frontmatter marker', () => {
    const text = '---\nmetadata:\n  harness-exported-from: x\n  harness-exported-at: 2026\n  harness-exported-by: harness\n  harness-content-hash: sha256:x\n---\nBody.';
    expect(hasProvenance(text)).toBe(true);
  });

  it('detects markdown comment marker', () => {
    const text = '<!-- agent-harness-provenance\nharness-exported-from: x\n-->\n# Body';
    expect(hasProvenance(text)).toBe(true);
  });

  it('returns false for unmarked content', () => {
    expect(hasProvenance('# Just markdown')).toBe(false);
  });
});
