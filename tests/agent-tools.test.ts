import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildAgentTools } from '../src/runtime/agent-tools.js';

let TEST_DIR: string;

function writeAgent(name: string, frontmatter: Record<string, unknown>, body: string): void {
  const fmLines = ['---'];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (Array.isArray(v)) {
      fmLines.push(`${k}:`);
      for (const item of v) fmLines.push(`  - ${item}`);
    } else {
      fmLines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
  }
  fmLines.push('---', '', body);
  writeFileSync(join(TEST_DIR, 'agents', `${name}.md`), fmLines.join('\n'), 'utf-8');
}

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'agent-tools-test-'));
  mkdirSync(join(TEST_DIR, 'agents'), { recursive: true });
});

afterEach(() => {
  if (TEST_DIR) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('buildAgentTools', () => {
  it('returns empty tool set when agents/ is empty', () => {
    const tools = buildAgentTools(TEST_DIR);
    expect(Object.keys(tools)).toHaveLength(0);
  });

  it('returns empty tool set when agents/ is missing', () => {
    rmSync(join(TEST_DIR, 'agents'), { recursive: true, force: true });
    const tools = buildAgentTools(TEST_DIR);
    expect(Object.keys(tools)).toHaveLength(0);
  });

  it('registers each active agent as a tool keyed by id', () => {
    writeAgent(
      'alpha',
      { id: 'alpha', tags: ['agent'], status: 'active' },
      '<!-- L0: Alpha summary. -->\n\n# Agent: Alpha\n\nAlpha does alpha things.',
    );
    writeAgent(
      'bravo',
      { id: 'bravo', tags: ['agent'], status: 'active' },
      '<!-- L0: Bravo summary. -->\n\n# Agent: Bravo\n\nBravo does bravo things.',
    );

    const tools = buildAgentTools(TEST_DIR);
    expect(Object.keys(tools).sort()).toEqual(['alpha', 'bravo']);
  });

  it('excludes agents with status other than active', () => {
    writeAgent(
      'active-one',
      { id: 'active-one', tags: ['agent'], status: 'active' },
      '<!-- L0: ok -->',
    );
    writeAgent(
      'draft-one',
      { id: 'draft-one', tags: ['agent'], status: 'draft' },
      '<!-- L0: wip -->',
    );
    writeAgent(
      'archived-one',
      { id: 'archived-one', tags: ['agent'], status: 'archived' },
      '<!-- L0: old -->',
    );

    const tools = buildAgentTools(TEST_DIR);
    expect(Object.keys(tools)).toEqual(['active-one']);
  });

  it('uses explicit description from frontmatter when present', () => {
    writeAgent(
      'with-desc',
      {
        id: 'with-desc',
        tags: ['agent'],
        status: 'active',
        description: 'Explicit description wins.',
      },
      '<!-- L0: L0 summary. -->\n<!-- L1: L1 summary. -->\n\n# body',
    );

    const tools = buildAgentTools(TEST_DIR);
    const t = tools['with-desc'] as { description?: string };
    expect(t.description).toBe('Explicit description wins.');
  });

  it('uses description from frontmatter when present alongside body content', () => {
    writeAgent(
      'l1-fallback',
      { id: 'l1-fallback', tags: ['agent'], status: 'active', description: 'Use the description here.' },
      '# body',
    );

    const tools = buildAgentTools(TEST_DIR);
    const t = tools['l1-fallback'] as { description?: string };
    expect(t.description).toBe('Use the description here.');
  });

  it('falls back to generic message when description is not set in frontmatter', () => {
    writeAgent(
      'l0-only',
      { id: 'l0-only', tags: ['agent'], status: 'active' },
      '# body only, no description',
    );

    const tools = buildAgentTools(TEST_DIR);
    const t = tools['l0-only'] as { description?: string };
    expect(t.description).toBe('Delegate to the l0-only sub-agent.');
  });

  it('falls back to a generic description when none of description/L1/L0 are set', () => {
    writeAgent(
      'nothing',
      { id: 'nothing', tags: ['agent'], status: 'active' },
      '# body only, no summaries',
    );

    const tools = buildAgentTools(TEST_DIR);
    const t = tools['nothing'] as { description?: string };
    expect(t.description).toBe('Delegate to the nothing sub-agent.');
  });

  it('exposes an execute function on each tool', () => {
    writeAgent(
      'runner',
      { id: 'runner', tags: ['agent'], status: 'active' },
      '<!-- L0: runner -->',
    );

    const tools = buildAgentTools(TEST_DIR);
    const t = tools['runner'] as { execute?: unknown };
    expect(typeof t.execute).toBe('function');
  });
});
