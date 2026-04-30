import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildIndex, writeIndexFile, rebuildAllIndexes } from '../src/runtime/indexer.js';

function makeTestDir(): string {
  const dir = join(tmpdir(), `indexer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writePrimitive(dir: string, subdir: string, id: string, opts?: { tags?: string[]; status?: string; description?: string }): void {
  const primDir = join(dir, subdir);
  mkdirSync(primDir, { recursive: true });
  const tags = opts?.tags ?? [subdir.replace(/s$/, '')];
  const status = opts?.status ?? 'active';
  const description = opts?.description ?? `Summary for ${id}`;
  writeFileSync(
    join(primDir, `${id}.md`),
    `---\nid: ${id}\ntags: [${tags.join(', ')}]\nstatus: ${status}\ncreated: "2026-04-01"\ndescription: "${description}"\n---\n# ${id}\n\nBody text for ${id}.\n`,
    'utf-8',
  );
}

describe('buildIndex', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return entries for primitives in a directory', () => {
    writePrimitive(testDir, 'rules', 'rule-a', { description: 'Rule A summary' });
    writePrimitive(testDir, 'rules', 'rule-b', { description: 'Rule B summary', status: 'draft' });

    const entries = buildIndex(testDir, 'rules');
    expect(entries).toHaveLength(2);

    const ruleA = entries.find((e) => e.id === 'rule-a');
    expect(ruleA).toBeDefined();
    expect(ruleA!.description).toBe('Rule A summary');
    expect(ruleA!.status).toBe('active');
    expect(ruleA!.created).toBe('2026-04-01');

    const ruleB = entries.find((e) => e.id === 'rule-b');
    expect(ruleB).toBeDefined();
    expect(ruleB!.status).toBe('draft');
  });

  it('should return empty array for non-existent directory', () => {
    const entries = buildIndex(testDir, 'nonexistent');
    expect(entries).toEqual([]);
  });

  it('should return empty array for directory with no markdown files', () => {
    mkdirSync(join(testDir, 'empty-dir'), { recursive: true });
    const entries = buildIndex(testDir, 'empty-dir');
    expect(entries).toEqual([]);
  });

  it('should capture tags from frontmatter', () => {
    writePrimitive(testDir, 'rules', 'multi-tag', { tags: ['skill', 'coding', 'typescript'] });

    const entries = buildIndex(testDir, 'rules');
    expect(entries).toHaveLength(1);
    expect(entries[0].tags).toEqual(['skill', 'coding', 'typescript']);
  });
});

describe('writeIndexFile', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should write _index.md with markdown table', () => {
    writePrimitive(testDir, 'rules', 'my-rule', { description: 'A test rule' });

    writeIndexFile(testDir, 'rules');

    const indexPath = join(testDir, 'rules', '_index.md');
    expect(existsSync(indexPath)).toBe(true);

    const content = readFileSync(indexPath, 'utf-8');
    expect(content).toContain('<!-- Auto-generated index');
    expect(content).toContain('# Rules Index');
    expect(content).toContain('| ID | Tags | Created | Status | Summary |');
    expect(content).toContain('my-rule');
    expect(content).toContain('A test rule');
  });

  it('should truncate long L0 summaries', () => {
    const longSummary = 'A'.repeat(200);
    writePrimitive(testDir, 'rules', 'long-rule', { description: longSummary });

    writeIndexFile(testDir, 'rules', { summaryMaxLength: 50 });

    const content = readFileSync(join(testDir, 'rules', '_index.md'), 'utf-8');
    expect(content).toContain('A'.repeat(47) + '...');
    expect(content).not.toContain('A'.repeat(200));
  });

  it('should create directory if it does not exist', () => {
    writeIndexFile(testDir, 'new-dir');

    expect(existsSync(join(testDir, 'new-dir', '_index.md'))).toBe(true);
    const content = readFileSync(join(testDir, 'new-dir', '_index.md'), 'utf-8');
    expect(content).toContain('# New-dir Index');
  });

  it('should produce valid table with multiple entries', () => {
    writePrimitive(testDir, 'instincts', 'instinct-a');
    writePrimitive(testDir, 'instincts', 'instinct-b');
    writePrimitive(testDir, 'instincts', 'instinct-c');

    writeIndexFile(testDir, 'instincts');

    const content = readFileSync(join(testDir, 'instincts', '_index.md'), 'utf-8');
    const rows = content.split('\n').filter((l) => l.startsWith('| instinct-'));
    expect(rows).toHaveLength(3);
  });
});

describe('rebuildAllIndexes', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should rebuild indexes for all core primitive directories that exist', () => {
    writePrimitive(testDir, 'rules', 'rule-1');
    writePrimitive(testDir, 'rules', 'rule-2');

    rebuildAllIndexes(testDir);

    expect(existsSync(join(testDir, 'rules', '_index.md'))).toBe(true);
    // Non-existent dirs should not have indexes
    expect(existsSync(join(testDir, 'skills', '_index.md'))).toBe(false);
    expect(existsSync(join(testDir, 'instincts', '_index.md'))).toBe(false);
    expect(existsSync(join(testDir, 'playbooks', '_index.md'))).toBe(false);
  });

  it('should include extra directories when specified', () => {
    writePrimitive(testDir, 'custom-dir', 'custom-1');

    rebuildAllIndexes(testDir, ['custom-dir']);

    expect(existsSync(join(testDir, 'custom-dir', '_index.md'))).toBe(true);
    const content = readFileSync(join(testDir, 'custom-dir', '_index.md'), 'utf-8');
    expect(content).toContain('custom-1');
  });

  it('should not duplicate core dirs when extra dirs include a core dir', () => {
    writePrimitive(testDir, 'rules', 'rule-1');

    // Pass 'rules' as extra — should not create duplicate entries
    rebuildAllIndexes(testDir, ['rules']);

    const content = readFileSync(join(testDir, 'rules', '_index.md'), 'utf-8');
    const rows = content.split('\n').filter((l) => l.startsWith('| rule-1'));
    expect(rows).toHaveLength(1);
  });
});
