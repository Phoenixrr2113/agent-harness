import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { skillLints } from '../../src/runtime/lints/skill-lints.js';
import { loadAllPrimitives } from '../../src/primitives/loader.js';

function loadFirstSkill(harnessDir: string) {
  const skills = loadAllPrimitives(harnessDir).get('skills') ?? [];
  return skills[0];
}

function makeSkillBundle(harnessDir: string, name: string, frontmatter: string, body: string): string {
  const dir = join(harnessDir, 'skills', name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'SKILL.md');
  writeFileSync(path, `---\n${frontmatter}\n---\n${body}`, 'utf-8');
  return dir;
}

describe('skillLints', () => {
  it('description-quality: flags vague descriptions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const bundleDir = makeSkillBundle(dir, 'foo', 'name: foo\ndescription: Helps with stuff.', 'Body.');
    const skill = loadFirstSkill(dir);
    const results = skillLints.descriptionQuality(skill, bundleDir);
    const warn = results.find((r) => r.severity === 'warn');
    expect(warn).toBeTruthy();
    expect(warn?.code).toMatch(/description/i);
  });

  it('description-quality: passes well-formed descriptions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const bundleDir = makeSkillBundle(dir, 'foo', 'name: foo\ndescription: Conducts deep research using web search and document analysis. Use when investigating a topic, gathering sources, or comparing options.', 'Body.');
    const skill = loadFirstSkill(dir);
    const results = skillLints.descriptionQuality(skill, bundleDir);
    expect(results).toHaveLength(0);
  });

  it('body-length: warns over 4000 tokens, errors over 6000', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const longBody = 'word '.repeat(5000); // ~5000 tokens (1 token ≈ 4 chars; 'word ' = 5 chars × 5000 = 25000 chars ≈ 6250 tokens)
    const bundleDir = makeSkillBundle(dir, 'foo', 'name: foo\ndescription: A test skill. Use when testing the linter.', longBody);
    const skill = loadFirstSkill(dir);
    const results = skillLints.bodyLength(skill, bundleDir);
    expect(results.some((r) => r.severity === 'error' || r.severity === 'warn')).toBe(true);
  });

  it('referenced-files-exist: errors when SKILL.md mentions a missing script', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const bundleDir = makeSkillBundle(
      dir,
      'foo',
      'name: foo\ndescription: A skill. Use when testing.',
      '## Available scripts\n\n- `scripts/run.sh` — Does the thing'
    );
    const skill = loadFirstSkill(dir);
    const results = skillLints.referencedFilesExist(skill, bundleDir);
    expect(results.find((r) => r.severity === 'error')).toBeTruthy();
  });

  it('required-sections: warns when SKILL.md lacks ## When to use AND any of Available scripts/Workflow/Gotchas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const bundleDir = makeSkillBundle(
      dir,
      'foo',
      'name: foo\ndescription: A skill. Use when testing.',
      '# Foo\n\nNo standard sections here.'
    );
    const skill = loadFirstSkill(dir);
    const results = skillLints.requiredSections(skill, bundleDir);
    expect(results.some((r) => r.severity === 'warn')).toBe(true);
  });
});
