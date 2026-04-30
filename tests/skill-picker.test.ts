import { describe, it, expect } from 'vitest';
import { parseSkillsFlag, DEFAULT_SKILLS, SHIPPED_SKILLS } from '../src/cli/skill-picker.js';

describe('parseSkillsFlag', () => {
  it('returns "all" for the literal string "all"', () => {
    expect(parseSkillsFlag('all')).toBe('all');
  });

  it('returns empty array for the literal string "none"', () => {
    expect(parseSkillsFlag('none')).toEqual([]);
  });

  it('returns empty array for empty/whitespace input', () => {
    expect(parseSkillsFlag('')).toEqual([]);
    expect(parseSkillsFlag('   ')).toEqual([]);
  });

  it('parses a single skill id', () => {
    expect(parseSkillsFlag('brainstorming')).toEqual(['brainstorming']);
  });

  it('parses comma-separated ids', () => {
    expect(parseSkillsFlag('brainstorming,research')).toEqual(['brainstorming', 'research']);
  });

  it('parses space-separated ids', () => {
    expect(parseSkillsFlag('brainstorming research')).toEqual(['brainstorming', 'research']);
  });

  it('parses mixed comma+space separators', () => {
    expect(parseSkillsFlag('brainstorming, research,planner')).toEqual([
      'brainstorming', 'research', 'planner',
    ]);
  });

  it('throws on unknown skill ids with a helpful error message', () => {
    expect(() => parseSkillsFlag('not-a-real-skill')).toThrow(/Unknown skill\(s\): not-a-real-skill/);
    expect(() => parseSkillsFlag('not-a-real-skill')).toThrow(/Known skills:/);
    expect(() => parseSkillsFlag('not-a-real-skill')).toThrow(/--skills all/);
  });

  it('throws on partial unknown ids (rejects the whole list)', () => {
    expect(() => parseSkillsFlag('brainstorming,not-real')).toThrow(/not-real/);
  });
});

describe('DEFAULT_SKILLS', () => {
  it('contains exactly the four superpowers skills', () => {
    expect([...DEFAULT_SKILLS].sort()).toEqual([
      'brainstorming',
      'dispatching-parallel-agents',
      'executing-plans',
      'writing-plans',
    ]);
  });

  it('every default-skill id exists in SHIPPED_SKILLS', () => {
    const shippedIds = new Set(SHIPPED_SKILLS.map((s) => s.id));
    for (const id of DEFAULT_SKILLS) {
      expect(shippedIds.has(id), `${id} must be in SHIPPED_SKILLS`).toBe(true);
    }
  });

  it('every default-skill is grouped as "default"', () => {
    const defaultGroupIds = SHIPPED_SKILLS.filter((s) => s.group === 'default').map((s) => s.id);
    expect([...defaultGroupIds].sort()).toEqual([...DEFAULT_SKILLS].sort());
  });
});

describe('SHIPPED_SKILLS catalog', () => {
  it('every shipped-skill id corresponds to a real directory under defaults/skills/', async () => {
    const { existsSync } = await import('fs');
    const { join } = await import('path');
    const repoRoot = join(__dirname, '..');
    for (const skill of SHIPPED_SKILLS) {
      const dir = join(repoRoot, 'defaults/skills', skill.id);
      expect(existsSync(dir), `defaults/skills/${skill.id} must exist`).toBe(true);
    }
  });

  it('has no duplicate ids', () => {
    const ids = SHIPPED_SKILLS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every shipped-skill has a non-empty short description', () => {
    for (const skill of SHIPPED_SKILLS) {
      expect(skill.short.length, `${skill.id} short must be non-empty`).toBeGreaterThan(0);
    }
  });
});
