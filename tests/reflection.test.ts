import { describe, it, expect } from 'vitest';
import {
  buildReflectionPrompt,
  createReflectionPrepareStep,
  estimateReflectionTokens,
  type ReflectionConfig,
} from '../src/runtime/reflection.js';

describe('buildReflectionPrompt', () => {
  it('returns undefined for strategy=none regardless of step', () => {
    const cfg: ReflectionConfig = { strategy: 'none' };
    expect(buildReflectionPrompt(cfg, 0)).toBeUndefined();
    expect(buildReflectionPrompt(cfg, 1)).toBeUndefined();
    expect(buildReflectionPrompt(cfg, 5)).toBeUndefined();
  });

  it('every-step skips step 0 and fires on every subsequent step', () => {
    const cfg: ReflectionConfig = { strategy: 'every-step' };
    expect(buildReflectionPrompt(cfg, 0)).toBeUndefined();
    expect(buildReflectionPrompt(cfg, 1)).toMatch(/reflection/i);
    expect(buildReflectionPrompt(cfg, 2)).toMatch(/reflection/i);
    expect(buildReflectionPrompt(cfg, 10)).toMatch(/reflection/i);
  });

  it('periodic uses default frequency 3 when unset', () => {
    const cfg: ReflectionConfig = { strategy: 'periodic' };
    expect(buildReflectionPrompt(cfg, 0)).toBeUndefined();
    expect(buildReflectionPrompt(cfg, 1)).toBeUndefined();
    expect(buildReflectionPrompt(cfg, 2)).toBeUndefined();
    expect(buildReflectionPrompt(cfg, 3)).toMatch(/reflection/i);
    expect(buildReflectionPrompt(cfg, 4)).toBeUndefined();
    expect(buildReflectionPrompt(cfg, 6)).toMatch(/reflection/i);
  });

  it('periodic respects a custom frequency', () => {
    const cfg: ReflectionConfig = { strategy: 'periodic', frequency: 5 };
    expect(buildReflectionPrompt(cfg, 4)).toBeUndefined();
    expect(buildReflectionPrompt(cfg, 5)).toMatch(/reflection/i);
    expect(buildReflectionPrompt(cfg, 9)).toBeUndefined();
    expect(buildReflectionPrompt(cfg, 10)).toMatch(/reflection/i);
  });

  it('prompt_template overrides built-in for every-step', () => {
    const cfg: ReflectionConfig = { strategy: 'every-step', prompt_template: 'CUSTOM REFLECTION' };
    expect(buildReflectionPrompt(cfg, 1)).toBe('CUSTOM REFLECTION');
  });

  it('prompt_template overrides built-in for periodic', () => {
    const cfg: ReflectionConfig = { strategy: 'periodic', frequency: 2, prompt_template: 'CUSTOM PERIODIC' };
    expect(buildReflectionPrompt(cfg, 2)).toBe('CUSTOM PERIODIC');
  });
});

describe('createReflectionPrepareStep', () => {
  it('returns undefined always when strategy=none', () => {
    const prep = createReflectionPrepareStep('BASE SYSTEM', { strategy: 'none' });
    expect(prep({ stepNumber: 0, steps: [] })).toBeUndefined();
    expect(prep({ stepNumber: 5, steps: [] })).toBeUndefined();
  });

  it('appends reflection to base system on firing steps (every-step)', () => {
    const prep = createReflectionPrepareStep('BASE SYSTEM', { strategy: 'every-step' });
    const r0 = prep({ stepNumber: 0, steps: [] });
    expect(r0).toBeUndefined();
    const r1 = prep({ stepNumber: 1, steps: [] });
    expect(r1?.system).toContain('BASE SYSTEM');
    expect(r1?.system).toMatch(/reflection/i);
  });

  it('supports a lazy base-system thunk', () => {
    let called = 0;
    const thunk = () => { called++; return 'LAZY SYSTEM'; };
    const prep = createReflectionPrepareStep(thunk, { strategy: 'every-step' });
    prep({ stepNumber: 0, steps: [] });
    expect(called).toBe(0);
    const r = prep({ stepNumber: 1, steps: [] });
    expect(called).toBe(1);
    expect(r?.system).toContain('LAZY SYSTEM');
  });
});

describe('estimateReflectionTokens', () => {
  it('returns 0 for strategy=none', () => {
    expect(estimateReflectionTokens({ strategy: 'none' })).toBe(0);
  });

  it('returns a positive estimate for every-step and periodic defaults', () => {
    expect(estimateReflectionTokens({ strategy: 'every-step' })).toBeGreaterThan(0);
    expect(estimateReflectionTokens({ strategy: 'periodic' })).toBeGreaterThan(0);
  });

  it('reflects custom template length', () => {
    const shortTokens = estimateReflectionTokens({ strategy: 'every-step', prompt_template: 'short' });
    const longTokens = estimateReflectionTokens({
      strategy: 'every-step',
      prompt_template: 'a much longer prompt template that produces a larger token estimate than the short one',
    });
    expect(longTokens).toBeGreaterThan(shortTokens);
  });
});
