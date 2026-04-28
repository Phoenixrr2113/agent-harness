import { describe, it, expect } from 'vitest';
import { nameSchema } from '../../src/core/types.js';

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
