import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { searchPrimitives } from '../src/runtime/search.js';

const TEST_DIR = join(__dirname, '__test_search__');

function writePrimitive(dir: string, subdir: string, filename: string, content: string): void {
  const fullDir = join(dir, subdir);
  mkdirSync(fullDir, { recursive: true });
  writeFileSync(join(fullDir, filename), content, 'utf-8');
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(join(TEST_DIR, 'CORE.md'), '# Core', 'utf-8');
  writeFileSync(
    join(TEST_DIR, 'config.yaml'),
    `agent:\n  name: test\n  version: "0.1.0"\nmodel:\n  provider: openrouter\n  id: test-model\n  max_tokens: 200000\n`,
    'utf-8',
  );

  // Create some test primitives — descriptions in frontmatter (not L0/L1 comments)
  writePrimitive(TEST_DIR, 'rules', 'code-review.md',
    `---\nid: code-review\ntags: [quality, review]\nstatus: active\nauthor: human\ndescription: Enforce code review before merge\n---\n# Rule: Code Review\n\nAll pull requests require at least one approval before merging to main.`);

  writePrimitive(TEST_DIR, 'rules', 'testing.md',
    `---\nid: testing\ntags: [quality, testing]\nstatus: active\nauthor: agent\ndescription: Require tests for all features with 80% coverage\n---\n# Rule: Testing\n\nEvery feature branch must include comprehensive unit tests.`);

  writePrimitive(TEST_DIR, 'instincts', 'typescript.md',
    `---\nid: typescript\ntags: [language, typescript]\nstatus: active\nauthor: human\ndescription: TypeScript development expertise\n---\n# Skill: TypeScript\n\nExpertise in TypeScript including generics, type guards, and conditional types.`);

  writePrimitive(TEST_DIR, 'instincts', 'deprecated-skill.md',
    `---\nid: deprecated-skill\ntags: [old]\nstatus: deprecated\nauthor: human\ndescription: An old skill\n---\n# Skill: Old\n\nThis skill is deprecated.`);

  writePrimitive(TEST_DIR, 'instincts', 'be-concise.md',
    `---\nid: be-concise\ntags: [communication]\nstatus: draft\nauthor: agent\ndescription: Keep responses concise\n---\n# Instinct: Be Concise\n\nPrefer short, clear answers over verbose explanations.`);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('searchPrimitives', () => {
  it('should find primitives by query text in id', () => {
    const results = searchPrimitives(TEST_DIR, 'code-review');
    expect(results).toHaveLength(1);
    expect(results[0].doc.id).toBe('code-review');
    expect(results[0].matchReason).toContain('id:');
  });

  it('should find primitives by query text in tags', () => {
    const results = searchPrimitives(TEST_DIR, 'quality');
    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.doc.id).sort();
    expect(ids).toEqual(['code-review', 'testing']);
  });

  it('should find primitives by query text in description', () => {
    const results = searchPrimitives(TEST_DIR, 'code review before merge');
    expect(results).toHaveLength(1);
    expect(results[0].doc.id).toBe('code-review');
    expect(results[0].matchReason).toContain('description:');
  });

  it('should find primitives by query text in body', () => {
    const results = searchPrimitives(TEST_DIR, 'conditional types');
    expect(results).toHaveLength(1);
    expect(results[0].doc.id).toBe('typescript');
    expect(results[0].matchReason).toContain('body:');
  });

  it('should be case-insensitive', () => {
    const results = searchPrimitives(TEST_DIR, 'TYPESCRIPT');
    expect(results).toHaveLength(1);
    expect(results[0].doc.id).toBe('typescript');
  });

  it('should return all active/draft primitives when no query or filters', () => {
    // loadDirectory skips archived and deprecated primitives
    const results = searchPrimitives(TEST_DIR);
    expect(results).toHaveLength(4);
    expect(results.every((r) => r.matchReason === 'filter match')).toBe(true);
  });

  it('should filter by tag', () => {
    const results = searchPrimitives(TEST_DIR, undefined, { tag: 'quality' });
    expect(results).toHaveLength(2);
  });

  it('should filter by tag case-insensitively', () => {
    const results = searchPrimitives(TEST_DIR, undefined, { tag: 'QUALITY' });
    expect(results).toHaveLength(2);
  });

  it('should filter by type directory', () => {
    const results = searchPrimitives(TEST_DIR, undefined, { type: 'rules' });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.directory === 'rules')).toBe(true);
  });

  it('should accept singular type name', () => {
    const results = searchPrimitives(TEST_DIR, undefined, { type: 'rule' });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.directory === 'rules')).toBe(true);
  });

  it('should filter by status', () => {
    // Note: loadDirectory skips deprecated/archived, so we filter by 'draft'
    const results = searchPrimitives(TEST_DIR, undefined, { status: 'draft' });
    expect(results).toHaveLength(1);
    expect(results[0].doc.id).toBe('be-concise');
  });

  it('should filter by author', () => {
    const results = searchPrimitives(TEST_DIR, undefined, { author: 'agent' });
    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.doc.id).sort();
    expect(ids).toEqual(['be-concise', 'testing']);
  });

  it('should combine query with filters', () => {
    const results = searchPrimitives(TEST_DIR, 'quality', { type: 'rules' });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.directory === 'rules')).toBe(true);
  });

  it('should combine multiple filters', () => {
    const results = searchPrimitives(TEST_DIR, undefined, { type: 'rules', author: 'agent' });
    expect(results).toHaveLength(1);
    expect(results[0].doc.id).toBe('testing');
  });

  it('should return empty results for non-matching query', () => {
    const results = searchPrimitives(TEST_DIR, 'nonexistent-term-xyz');
    expect(results).toHaveLength(0);
  });

  it('should return empty results for non-matching filter', () => {
    const results = searchPrimitives(TEST_DIR, undefined, { tag: 'nonexistent-tag' });
    expect(results).toHaveLength(0);
  });

  it('should include directory info in results', () => {
    const results = searchPrimitives(TEST_DIR, 'typescript');
    expect(results).toHaveLength(1);
    expect(results[0].directory).toBe('instincts');
  });

  it('should handle missing directories gracefully', () => {
    const results = searchPrimitives(TEST_DIR, undefined, { type: 'workflows' });
    expect(results).toHaveLength(0);
  });

  it('should find by description match', () => {
    const results = searchPrimitives(TEST_DIR, '80% coverage');
    expect(results).toHaveLength(1);
    expect(results[0].doc.id).toBe('testing');
    expect(results[0].matchReason).toContain('description:');
  });

  it('should filter draft status', () => {
    const results = searchPrimitives(TEST_DIR, undefined, { status: 'draft' });
    expect(results).toHaveLength(1);
    expect(results[0].doc.id).toBe('be-concise');
  });
});
