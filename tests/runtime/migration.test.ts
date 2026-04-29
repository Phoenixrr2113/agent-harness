import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import matter from 'gray-matter';
import { checkMigrations, applyMigrations } from '../../src/runtime/migration.js';

describe('checkMigrations', () => {
  it('reports no work needed on a clean modern harness', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    writeFileSync(join(dir, 'IDENTITY.md'), '# Identity', 'utf-8');
    mkdirSync(join(dir, 'memory'), { recursive: true });
    mkdirSync(join(dir, 'skills'), { recursive: true });

    const report = checkMigrations(dir);
    expect(report.findings).toHaveLength(0);
  });

  it('detects CORE.md needs renaming', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    writeFileSync(join(dir, 'CORE.md'), '# Old', 'utf-8');

    const report = checkMigrations(dir);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ kind: 'rename-core-to-identity' })
    );
  });

  it('detects SYSTEM.md needs deletion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    writeFileSync(join(dir, 'SYSTEM.md'), '# Old', 'utf-8');

    const report = checkMigrations(dir);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ kind: 'delete-system-md' })
    );
  });

  it('detects state.md at top level needs moving', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    writeFileSync(join(dir, 'state.md'), '---\nmode: idle\n---', 'utf-8');

    const report = checkMigrations(dir);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ kind: 'move-state-to-memory' })
    );
  });

  it('detects flat skills need bundle restructure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    mkdirSync(join(dir, 'skills'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'foo.md'),
      '---\nname: foo\ndescription: Test.\n---\nBody.',
      'utf-8'
    );

    const report = checkMigrations(dir);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ kind: 'bundle-flat-skill', path: expect.stringContaining('foo.md') })
    );
  });
});

describe('applyMigrations', () => {
  it('renames CORE.md to IDENTITY.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    writeFileSync(join(dir, 'CORE.md'), '# Original content', 'utf-8');

    const report = applyMigrations(dir, checkMigrations(dir));

    expect(existsSync(join(dir, 'CORE.md'))).toBe(false);
    expect(existsSync(join(dir, 'IDENTITY.md'))).toBe(true);
    expect(readFileSync(join(dir, 'IDENTITY.md'), 'utf-8')).toBe('# Original content');
    expect(report.applied).toContainEqual(
      expect.objectContaining({ kind: 'rename-core-to-identity' })
    );
  });

  it('does NOT rename CORE.md when IDENTITY.md exists (warns instead)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    writeFileSync(join(dir, 'CORE.md'), '# Old', 'utf-8');
    writeFileSync(join(dir, 'IDENTITY.md'), '# New', 'utf-8');

    const report = applyMigrations(dir, checkMigrations(dir));

    expect(readFileSync(join(dir, 'IDENTITY.md'), 'utf-8')).toBe('# New');
    expect(readFileSync(join(dir, 'CORE.md'), 'utf-8')).toBe('# Old');
    expect(report.skipped).toContainEqual(
      expect.objectContaining({ kind: 'rename-core-to-identity', reason: expect.stringMatching(/IDENTITY\.md exists/) })
    );
  });

  it('moves state.md to memory/state.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    writeFileSync(join(dir, 'state.md'), '---\nmode: idle\n---', 'utf-8');

    applyMigrations(dir, checkMigrations(dir));

    expect(existsSync(join(dir, 'state.md'))).toBe(false);
    expect(existsSync(join(dir, 'memory', 'state.md'))).toBe(true);
  });

  it('deletes SYSTEM.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    writeFileSync(join(dir, 'SYSTEM.md'), '# Old infra docs', 'utf-8');

    applyMigrations(dir, checkMigrations(dir));

    expect(existsSync(join(dir, 'SYSTEM.md'))).toBe(false);
  });

  it('bundles a flat skill into <name>/SKILL.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    mkdirSync(join(dir, 'skills'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'foo.md'),
      '---\nname: foo\ndescription: Test.\n---\nBody.',
      'utf-8'
    );

    applyMigrations(dir, checkMigrations(dir));

    expect(existsSync(join(dir, 'skills', 'foo.md'))).toBe(false);
    expect(existsSync(join(dir, 'skills', 'foo', 'SKILL.md'))).toBe(true);
  });

  it('is idempotent — running twice is a no-op the second time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    writeFileSync(join(dir, 'CORE.md'), '# Old', 'utf-8');

    const r1 = applyMigrations(dir, checkMigrations(dir));
    const r2 = applyMigrations(dir, checkMigrations(dir));

    expect(r1.applied.length).toBeGreaterThan(0);
    expect(r2.applied).toHaveLength(0);
    expect(r2.skipped).toHaveLength(0);
  });
});

describe('applyMigrations — skill frontmatter rewrite', () => {
  it('moves top-level extension fields into metadata.harness-*', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    mkdirSync(join(dir, 'skills', 'research'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'research', 'SKILL.md'),
      `---
id: research
name: research
description: A skill.
tags:
  - research
status: active
author: human
created: 2026-01-15
allowed-tools:
  - WebSearch
  - Read
---
Body.`,
      'utf-8'
    );

    const report = checkMigrations(dir);
    expect(report.findings.some(f => f.kind === 'rewrite-skill-frontmatter')).toBe(true);

    applyMigrations(dir, report);

    const after = readFileSync(join(dir, 'skills', 'research', 'SKILL.md'), 'utf-8');
    const parsed = matter(after);
    expect(parsed.data).not.toHaveProperty('id');
    expect(parsed.data).not.toHaveProperty('tags');
    expect(parsed.data).not.toHaveProperty('status');
    expect(parsed.data).not.toHaveProperty('author');
    expect(parsed.data).not.toHaveProperty('created');
    expect((parsed.data.metadata as Record<string, unknown>)?.['harness-tags']).toBe('research');
    expect((parsed.data.metadata as Record<string, unknown>)?.['harness-status']).toBe('active');
    expect((parsed.data.metadata as Record<string, unknown>)?.['harness-author']).toBe('human');
    expect((parsed.data.metadata as Record<string, unknown>)?.['harness-created']).toBe('2026-01-15');
    expect(parsed.data['allowed-tools']).toBe('WebSearch Read');
  });

  it('strips L0/L1 HTML comments from body', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    mkdirSync(join(dir, 'skills', 'foo'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'foo', 'SKILL.md'),
      `---
name: foo
description: A skill.
---
<!-- L0: short -->
<!-- L1: longer -->
Body content.`,
      'utf-8'
    );

    const report = checkMigrations(dir);
    expect(report.findings.some(f => f.kind === 'strip-l0-l1-comments')).toBe(true);

    applyMigrations(dir, report);

    const after = readFileSync(join(dir, 'skills', 'foo', 'SKILL.md'), 'utf-8');
    expect(after).not.toMatch(/L0:/);
    expect(after).not.toMatch(/L1:/);
    expect(after).toContain('Body content.');
  });

  it('lifts L0 into description when description is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    mkdirSync(join(dir, 'skills', 'foo'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'foo', 'SKILL.md'),
      `---
name: foo
---
<!-- L0: This is the trigger summary -->
Body content.`,
      'utf-8'
    );

    const report = checkMigrations(dir);
    applyMigrations(dir, report);

    const after = readFileSync(join(dir, 'skills', 'foo', 'SKILL.md'), 'utf-8');
    const parsed = matter(after);
    expect(parsed.data.description).toBe('This is the trigger summary');
    expect(parsed.content).not.toMatch(/L0:/);
  });

  it('preserves existing description when both description AND L0 present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    mkdirSync(join(dir, 'skills', 'foo'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'foo', 'SKILL.md'),
      `---
name: foo
description: Authoritative description here.
---
<!-- L0: Less authoritative summary -->
Body content.`,
      'utf-8'
    );

    const report = checkMigrations(dir);
    applyMigrations(dir, report);

    const after = readFileSync(join(dir, 'skills', 'foo', 'SKILL.md'), 'utf-8');
    const parsed = matter(after);
    expect(parsed.data.description).toBe('Authoritative description here.');
    expect(parsed.content).not.toMatch(/L0:/);
  });

  it('rewrite migration is deduplicated per file', () => {
    // A single skill triggering all three rewrite kinds should only result in
    // one applied finding (the consolidated rewrite-skill-frontmatter), not three.
    const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
    mkdirSync(join(dir, 'skills', 'foo'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'foo', 'SKILL.md'),
      `---
id: foo
name: foo
description: A skill.
tags: [foo]
allowed-tools: [Read]
---
<!-- L0: summary -->
Body.`,
      'utf-8'
    );

    const result = applyMigrations(dir, checkMigrations(dir));
    const rewriteCount = result.applied.filter(f =>
      f.kind === 'rewrite-skill-frontmatter' ||
      f.kind === 'convert-allowed-tools-to-string' ||
      f.kind === 'strip-l0-l1-comments'
    ).length;
    expect(rewriteCount).toBe(1);
  });
});
