import { describe, it, expect } from 'vitest';
import { nameSchema, descriptionSchema, compatibilitySchema, SkillFrontmatterSchema } from '../../src/core/types.js';

describe('nameSchema', () => {
  it('accepts valid lowercase-hyphen names', () => {
    expect(nameSchema.safeParse('pdf-processing').success).toBe(true);
    expect(nameSchema.safeParse('research').success).toBe(true);
    expect(nameSchema.safeParse('a').success).toBe(true);
    expect(nameSchema.safeParse('a1-b2').success).toBe(true);
  });

  it('rejects empty', () => {
    expect(nameSchema.safeParse('').success).toBe(false);
  });

  it('rejects names longer than 64 chars', () => {
    expect(nameSchema.safeParse('a'.repeat(64)).success).toBe(true);
    expect(nameSchema.safeParse('a'.repeat(65)).success).toBe(false);
  });

  it('rejects uppercase', () => {
    expect(nameSchema.safeParse('PDF-Processing').success).toBe(false);
    expect(nameSchema.safeParse('Research').success).toBe(false);
  });

  it('rejects leading or trailing hyphen', () => {
    expect(nameSchema.safeParse('-pdf').success).toBe(false);
    expect(nameSchema.safeParse('pdf-').success).toBe(false);
  });

  it('rejects consecutive hyphens', () => {
    expect(nameSchema.safeParse('pdf--processing').success).toBe(false);
  });

  it('rejects non-alphanumeric characters', () => {
    expect(nameSchema.safeParse('pdf_processing').success).toBe(false);
    expect(nameSchema.safeParse('pdf.processing').success).toBe(false);
    expect(nameSchema.safeParse('pdf processing').success).toBe(false);
  });
});

describe('descriptionSchema', () => {
  it('accepts a typical description', () => {
    const desc = 'Conducts deep research using web search. Use when investigating a topic.';
    expect(descriptionSchema.safeParse(desc).success).toBe(true);
  });

  it('rejects empty after trim', () => {
    expect(descriptionSchema.safeParse('').success).toBe(false);
    expect(descriptionSchema.safeParse('   ').success).toBe(false);
  });

  it('accepts up to 1024 chars', () => {
    expect(descriptionSchema.safeParse('x'.repeat(1024)).success).toBe(true);
    expect(descriptionSchema.safeParse('x'.repeat(1025)).success).toBe(false);
  });
});

describe('compatibilitySchema', () => {
  it('accepts up to 500 chars', () => {
    expect(compatibilitySchema.safeParse('Requires Node.js 20+').success).toBe(true);
    expect(compatibilitySchema.safeParse('x'.repeat(500)).success).toBe(true);
    expect(compatibilitySchema.safeParse('x'.repeat(501)).success).toBe(false);
  });

  it('rejects empty', () => {
    expect(compatibilitySchema.safeParse('').success).toBe(false);
  });
});

describe('SkillFrontmatterSchema', () => {
  it('accepts minimal valid skill frontmatter', () => {
    const result = SkillFrontmatterSchema.safeParse({
      name: 'research',
      description: 'Conducts deep research. Use when investigating a topic.',
    });
    expect(result.success).toBe(true);
  });

  it('requires name', () => {
    const result = SkillFrontmatterSchema.safeParse({
      description: 'A description.',
    });
    expect(result.success).toBe(false);
  });

  it('requires description', () => {
    const result = SkillFrontmatterSchema.safeParse({
      name: 'research',
    });
    expect(result.success).toBe(false);
  });

  it('accepts allowed-tools as space-separated string', () => {
    const result = SkillFrontmatterSchema.safeParse({
      name: 'research',
      description: 'Research stuff.',
      'allowed-tools': 'WebSearch Read Bash(jq:*)',
    });
    expect(result.success).toBe(true);
  });

  it('rejects allowed-tools as array', () => {
    const result = SkillFrontmatterSchema.safeParse({
      name: 'research',
      description: 'Research stuff.',
      'allowed-tools': ['WebSearch', 'Read'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown top-level fields (strict)', () => {
    const result = SkillFrontmatterSchema.safeParse({
      name: 'research',
      description: 'Research stuff.',
      tags: ['skill'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts metadata as string→string map', () => {
    const result = SkillFrontmatterSchema.safeParse({
      name: 'research',
      description: 'Research stuff.',
      metadata: { 'harness-tags': 'research,knowledge-work', 'harness-status': 'active' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects metadata with non-string values', () => {
    const result = SkillFrontmatterSchema.safeParse({
      name: 'research',
      description: 'Research stuff.',
      metadata: { 'harness-tags': ['research', 'knowledge-work'] },
    });
    expect(result.success).toBe(false);
  });
});
