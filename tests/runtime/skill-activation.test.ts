import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildActivateSkillTool, getModelInvokableSkills } from '../../src/runtime/skill-activation.js';

function makeFixture(): { dir: string; harnessDir: string } {
  const harnessDir = mkdtempSync(join(tmpdir(), 'activation-'));
  mkdirSync(join(harnessDir, 'skills', 'research'), { recursive: true });
  writeFileSync(
    join(harnessDir, 'skills', 'research', 'SKILL.md'),
    '---\nname: research\ndescription: Research a topic.\n---\n# Research\n\nDo research.',
    'utf-8'
  );
  return { dir: harnessDir, harnessDir };
}

describe('activate_skill tool', () => {
  it('returns an AI SDK tool definition with enum-constrained name', () => {
    const { harnessDir } = makeFixture();
    const tool = buildActivateSkillTool(harnessDir);
    expect(tool).toBeTruthy();
    expect(tool!.description).toMatch(/skill/i);
    // name parameter should accept 'research', reject 'unknown-skill'
    const result1 = (tool as any).inputSchema.safeParse({ name: 'research' });
    expect(result1.success).toBe(true);
    const result2 = (tool as any).inputSchema.safeParse({ name: 'nonexistent' });
    expect(result2.success).toBe(false);
  });

  it('returns null when no model-invokable skills exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'activation-empty-'));
    const tool = buildActivateSkillTool(dir);
    expect(tool).toBeNull();
  });

  it('execute returns wrapped skill content', async () => {
    const { harnessDir } = makeFixture();
    const tool = buildActivateSkillTool(harnessDir);
    const result = await tool!.execute({ name: 'research' });
    expect(result).toContain('<skill_content name="research">');
    expect(result).toContain('# Research');
    expect(result).toContain('Do research.');
    expect(result).toContain('</skill_content>');
  });

  it('execute returns short message on duplicate activation', async () => {
    const { harnessDir } = makeFixture();
    const tool = buildActivateSkillTool(harnessDir);
    await tool!.execute({ name: 'research' });
    const result2 = await tool!.execute({ name: 'research' });
    expect(result2).toMatch(/already loaded|already activated/i);
  });
});

function makeSkill(harnessDir: string, name: string): void {
  const dir = join(harnessDir, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Pretend skill named ${name} for excludeSkillNames test ${Math.random()}\n---\nBody.`,
  );
}

describe('buildActivateSkillTool — excludeSkillNames', () => {
  it('excludes named skills from the enum', () => {
    const dir = mkdtempSync(join(tmpdir(), 'as-'));
    makeSkill(dir, 'alpha');
    makeSkill(dir, 'beta');
    const tool = buildActivateSkillTool(dir, { excludeSkillNames: ['alpha'] });
    expect(tool).not.toBeNull();
    const skills = getModelInvokableSkills(dir, { excludeSkillNames: ['alpha'] });
    expect(skills.map((s) => s.name)).toEqual(['beta']);
  });

  it('returns null if all skills are excluded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'as-'));
    makeSkill(dir, 'only-one');
    const tool = buildActivateSkillTool(dir, { excludeSkillNames: ['only-one'] });
    expect(tool).toBeNull();
  });

  it('default options leave all skills available', () => {
    const dir = mkdtempSync(join(tmpdir(), 'as-'));
    makeSkill(dir, 'one');
    makeSkill(dir, 'two');
    const skills = getModelInvokableSkills(dir);
    expect(skills.map((s) => s.name).sort()).toEqual(['one', 'two']);
  });
});
