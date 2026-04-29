import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { loadAllPrimitivesWithErrors } from '../../src/primitives/loader.js';

describe('defaults/ — spec compliance', () => {
  const defaultsDir = join(__dirname, '..', '..', 'defaults');

  it('every default primitive loads cleanly (no errors)', () => {
    const result = loadAllPrimitivesWithErrors(defaultsDir);
    if (result.errors.length > 0) {
      console.error('Defaults loader errors:');
      for (const err of result.errors) {
        console.error(`  ${err.path}: ${err.error}`);
      }
    }
    expect(result.errors).toHaveLength(0);
  });

  it('every default skill has a description', () => {
    const result = loadAllPrimitivesWithErrors(defaultsDir);
    const skills = result.primitives.get('skills') ?? [];
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      expect(skill.description, `skill ${skill.name} missing description`).toBeTruthy();
      expect(skill.description!.length).toBeGreaterThan(0);
      expect(skill.description!.length).toBeLessThanOrEqual(1024);
    }
  });

  it('every default skill is a bundle (has bundleDir)', () => {
    const result = loadAllPrimitivesWithErrors(defaultsDir);
    const skills = result.primitives.get('skills') ?? [];
    for (const skill of skills) {
      expect(skill.bundleDir, `skill ${skill.name} should be a bundle`).toBeTruthy();
    }
  });
});
