import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { HarnessDocument } from '../../src/core/types.js';
import { CORE_PRIMITIVE_DIRS } from '../../src/core/types.js';
import { loadDirectoryWithErrors, BUNDLE_ENTRY_BY_KIND } from '../../src/primitives/loader.js';

describe('loadDirectoryWithErrors — strict mode reports errors', () => {
  it('reports skills missing required name', () => {
    const root = mkdtempSync(join(tmpdir(), 'loader-test-'));
    const skillsDir = join(root, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const bundleDir = join(skillsDir, 'foo');
    mkdirSync(bundleDir);
    writeFileSync(
      join(bundleDir, 'SKILL.md'),
      `---
description: No name field.
---
Body.`,
      'utf-8'
    );

    const result = loadDirectoryWithErrors(skillsDir);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/name/i);
    expect(result.docs).toHaveLength(0);
  });

  it('reports flat skill files as an error in strict mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'loader-test-'));
    const skillsDir = join(root, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, 'foo.md'),
      `---
name: foo
description: A flat skill.
---
Body.`,
      'utf-8'
    );

    const result = loadDirectoryWithErrors(skillsDir);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/flat .* not supported/i);
  });
});

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

describe('loadDirectoryWithErrors — parent-dir name match for skill bundles', () => {
  it('errors when skill bundle name does not match parent directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'loader-test-'));
    const skillsDir = join(root, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const bundleDir = join(skillsDir, 'foo');
    mkdirSync(bundleDir);
    writeFileSync(
      join(bundleDir, 'SKILL.md'),
      `---
name: bar
description: Mismatch.
---
Body.`,
      'utf-8'
    );

    const result = loadDirectoryWithErrors(skillsDir);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/parent directory/i);
    expect(result.errors[0].error).toMatch(/foo/);
    expect(result.errors[0].error).toMatch(/bar/);
    expect(result.docs).toHaveLength(0);
  });

  it('accepts matching name', () => {
    const root = mkdtempSync(join(tmpdir(), 'loader-test-'));
    const skillsDir = join(root, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const bundleDir = join(skillsDir, 'foo');
    mkdirSync(bundleDir);
    writeFileSync(
      join(bundleDir, 'SKILL.md'),
      `---
name: foo
description: Match.
---
Body.`,
      'utf-8'
    );

    const result = loadDirectoryWithErrors(skillsDir);
    expect(result.errors).toHaveLength(0);
    expect(result.docs).toHaveLength(1);
    expect(result.docs[0].name).toBe('foo');
  });

  it('does NOT enforce parent-dir match for non-skill bundles (e.g., rules)', () => {
    const root = mkdtempSync(join(tmpdir(), 'loader-test-'));
    const rulesDir = join(root, 'rules');
    mkdirSync(rulesDir, { recursive: true });
    const bundleDir = join(rulesDir, 'foo');
    mkdirSync(bundleDir);
    writeFileSync(
      join(bundleDir, 'RULE.md'),
      `---
name: bar
description: Non-skill bundle, mismatch allowed.
---
Body.`,
      'utf-8'
    );

    const result = loadDirectoryWithErrors(rulesDir);
    expect(result.errors).toHaveLength(0);
    expect(result.docs).toHaveLength(1);
  });
});

describe('primitive collapse — only skills and rules', () => {
  it('CORE_PRIMITIVE_DIRS contains exactly [skills, rules]', () => {
    expect(CORE_PRIMITIVE_DIRS).toEqual(['skills', 'rules']);
  });

  it('BUNDLE_ENTRY_BY_KIND contains exactly skills and rules', () => {
    expect(Object.keys(BUNDLE_ENTRY_BY_KIND).sort()).toEqual(['rules', 'skills']);
    expect(BUNDLE_ENTRY_BY_KIND.skills).toBe('SKILL.md');
    expect(BUNDLE_ENTRY_BY_KIND.rules).toBe('RULE.md');
  });
});
