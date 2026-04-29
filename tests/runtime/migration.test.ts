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

describe('applyMigrations — primitive type collapse', () => {
  it('moves instincts/foo.md → rules/foo.md with author: agent', () => {
    const dir = mkdtempSync(join(tmpdir(), `mig-collapse-${Math.random().toString(36).slice(2, 10)}-`));
    mkdirSync(join(dir, 'instincts'), { recursive: true });
    writeFileSync(
      join(dir, 'instincts', 'lead-with-answer.md'),
      `---\nname: lead-with-answer\ndescription: Lead with the answer.\n---\nLead with the answer.`,
      'utf-8'
    );

    applyMigrations(dir, checkMigrations(dir));

    expect(existsSync(join(dir, 'instincts', 'lead-with-answer.md'))).toBe(false);
    const newPath = join(dir, 'rules', 'lead-with-answer.md');
    expect(existsSync(newPath)).toBe(true);
    const after = matter(readFileSync(newPath, 'utf-8'));
    expect(after.data.author).toBe('agent');
    expect((after.data.metadata as Record<string, unknown>)?.['harness-source']).toBe('learned');
  });

  it('moves playbooks/foo.md → skills/foo/SKILL.md', () => {
    const dir = mkdtempSync(join(tmpdir(), `mig-collapse-${Math.random().toString(36).slice(2, 10)}-`));
    mkdirSync(join(dir, 'playbooks'), { recursive: true });
    writeFileSync(
      join(dir, 'playbooks', 'ship-feature.md'),
      `---\nname: ship-feature\ndescription: Ship a feature.\n---\nWorkflow.`,
      'utf-8'
    );

    applyMigrations(dir, checkMigrations(dir));

    expect(existsSync(join(dir, 'playbooks', 'ship-feature.md'))).toBe(false);
    expect(existsSync(join(dir, 'skills', 'ship-feature', 'SKILL.md'))).toBe(true);
  });

  it('moves workflows/foo.md → skills/foo/SKILL.md with metadata.harness-schedule', () => {
    const dir = mkdtempSync(join(tmpdir(), `mig-collapse-${Math.random().toString(36).slice(2, 10)}-`));
    mkdirSync(join(dir, 'workflows'), { recursive: true });
    writeFileSync(
      join(dir, 'workflows', 'daily-reflection.md'),
      `---\nname: daily-reflection\ndescription: Daily reflection.\nschedule: "0 22 * * *"\n---\nBody.`,
      'utf-8'
    );

    applyMigrations(dir, checkMigrations(dir));

    expect(existsSync(join(dir, 'workflows', 'daily-reflection.md'))).toBe(false);
    const newPath = join(dir, 'skills', 'daily-reflection', 'SKILL.md');
    expect(existsSync(newPath)).toBe(true);
    const after = matter(readFileSync(newPath, 'utf-8'));
    expect(after.data).not.toHaveProperty('schedule');
    expect((after.data.metadata as Record<string, unknown>)?.['harness-schedule']).toBe('0 22 * * *');
  });

  it('moves agents/foo.md → skills/foo/SKILL.md with harness-trigger: subagent', () => {
    const dir = mkdtempSync(join(tmpdir(), `mig-collapse-${Math.random().toString(36).slice(2, 10)}-`));
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(
      join(dir, 'agents', 'summarizer.md'),
      `---\nname: summarizer\ndescription: Summarize text.\nmodel: fast\n---\nBody.`,
      'utf-8'
    );

    applyMigrations(dir, checkMigrations(dir));

    expect(existsSync(join(dir, 'agents', 'summarizer.md'))).toBe(false);
    const newPath = join(dir, 'skills', 'summarizer', 'SKILL.md');
    expect(existsSync(newPath)).toBe(true);
    const after = matter(readFileSync(newPath, 'utf-8'));
    expect(after.data).not.toHaveProperty('model');
    expect((after.data.metadata as Record<string, unknown>)?.['harness-trigger']).toBe('subagent');
    expect((after.data.metadata as Record<string, unknown>)?.['harness-model']).toBe('fast');
  });

  it('removes empty primitive directories after migration', () => {
    const dir = mkdtempSync(join(tmpdir(), `mig-collapse-${Math.random().toString(36).slice(2, 10)}-`));
    mkdirSync(join(dir, 'instincts'), { recursive: true });
    writeFileSync(
      join(dir, 'instincts', 'foo.md'),
      `---\nname: foo\ndescription: A.\n---\nBody.`,
      'utf-8'
    );

    applyMigrations(dir, checkMigrations(dir));

    expect(existsSync(join(dir, 'instincts'))).toBe(false);
  });
});

describe('applyMigrations — tools to skills with scripts', () => {
  it('converts a markdown HTTP tool to a skill bundle with auto-generated scripts/call.sh', () => {
    const dir = mkdtempSync(join(tmpdir(), `mig-tools-${Math.random().toString(36).slice(2, 10)}-`));
    mkdirSync(join(dir, 'tools'), { recursive: true });
    writeFileSync(
      join(dir, 'tools', 'example-api.md'),
      `---
name: example-api
description: Example HTTP API.
---
# Example API

## Authentication

Set EXAMPLE_API_KEY environment variable.

## Operations

### get_status

GET https://example.com/status
Headers: { "Authorization": "Bearer \${EXAMPLE_API_KEY}" }
Returns: JSON with status field.
`,
      'utf-8'
    );

    applyMigrations(dir, checkMigrations(dir));

    expect(existsSync(join(dir, 'tools', 'example-api.md'))).toBe(false);
    expect(existsSync(join(dir, 'skills', 'example-api', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, 'skills', 'example-api', 'scripts', 'call.sh'))).toBe(true);

    const skillRaw = readFileSync(join(dir, 'skills', 'example-api', 'SKILL.md'), 'utf-8');
    const skill = matter(skillRaw);
    expect((skill.data.metadata as Record<string, unknown>)?.['harness-script-source']).toBe('auto-generated-from-tools');

    const script = readFileSync(join(dir, 'skills', 'example-api', 'scripts', 'call.sh'), 'utf-8');
    expect(script).toContain('#!/usr/bin/env bash');
    expect(script).toContain('NOT_IMPLEMENTED');

    expect(skillRaw).toContain('## Available scripts');
    expect(skillRaw).toContain('scripts/call.sh');
  });

  it('preserves the tool md as-is when the operations block cannot be parsed', () => {
    const dir = mkdtempSync(join(tmpdir(), `mig-tools-${Math.random().toString(36).slice(2, 10)}-`));
    mkdirSync(join(dir, 'tools'), { recursive: true });
    writeFileSync(
      join(dir, 'tools', 'unparseable.md'),
      `---\nname: unparseable\ndescription: Unparseable tool.\n---\nNo operations section.`,
      'utf-8'
    );

    const result = applyMigrations(dir, checkMigrations(dir));

    // Either skipped with reason OR converted with a stub script + warning
    const tool =
      result.applied.find((f) => f.kind === 'convert-tool-to-skill-with-script' && f.path.includes('unparseable')) ||
      result.skipped.find((f) => f.kind === 'convert-tool-to-skill-with-script' && f.path.includes('unparseable')) ||
      result.errors.find((f) => f.kind === 'convert-tool-to-skill-with-script' && f.path.includes('unparseable'));
    expect(tool).toBeTruthy();

    // When converted, the stub script must flag NEEDS_MANUAL_CONVERSION
    if (result.applied.find((f) => f.kind === 'convert-tool-to-skill-with-script' && f.path.includes('unparseable'))) {
      const script = readFileSync(join(dir, 'skills', 'unparseable', 'scripts', 'call.sh'), 'utf-8');
      expect(script).toContain('NEEDS_MANUAL_CONVERSION');
    }
  });

  it('skips conversion when the target skill bundle already exists', () => {
    const dir = mkdtempSync(join(tmpdir(), `mig-tools-${Math.random().toString(36).slice(2, 10)}-`));
    mkdirSync(join(dir, 'tools'), { recursive: true });
    mkdirSync(join(dir, 'skills', 'my-tool'), { recursive: true });
    writeFileSync(join(dir, 'tools', 'my-tool.md'), `---\nname: my-tool\ndescription: Tool.\n---\nBody.`, 'utf-8');
    writeFileSync(join(dir, 'skills', 'my-tool', 'SKILL.md'), `---\nname: my-tool\n---\nExisting.`, 'utf-8');

    const result = applyMigrations(dir, checkMigrations(dir));

    expect(result.skipped).toContainEqual(
      expect.objectContaining({ kind: 'convert-tool-to-skill-with-script', reason: expect.stringMatching(/exists/) })
    );
    expect(existsSync(join(dir, 'tools', 'my-tool.md'))).toBe(true);
  });
});
