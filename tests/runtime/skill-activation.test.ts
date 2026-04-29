import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildActivateSkillTool } from '../../src/runtime/skill-activation.js';

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
