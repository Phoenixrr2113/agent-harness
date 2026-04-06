import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getModel, getSummaryModel, getFastModel, resetProvider } from '../src/llm/provider.js';
import type { HarnessConfig } from '../src/core/types.js';
import { CONFIG_DEFAULTS } from '../src/core/types.js';

function makeConfig(overrides: Partial<HarnessConfig['model']> = {}): HarnessConfig {
  return {
    ...CONFIG_DEFAULTS,
    model: { ...CONFIG_DEFAULTS.model, ...overrides },
  };
}

describe('multi-provider support', () => {
  beforeEach(() => {
    resetProvider();
  });

  afterEach(() => {
    resetProvider();
  });

  describe('getModel', () => {
    it('should create an OpenRouter model with explicit API key', () => {
      const config = makeConfig({ provider: 'openrouter', id: 'anthropic/claude-sonnet-4' });
      const model = getModel(config, 'test-key-123');
      expect(model).toBeDefined();
      expect(model.modelId).toBe('anthropic/claude-sonnet-4');
      expect(model.provider).toBe('openrouter');
    });

    it('should create an Anthropic model with explicit API key', () => {
      const config = makeConfig({ provider: 'anthropic', id: 'claude-sonnet-4-20250514' });
      const model = getModel(config, 'test-key-123');
      expect(model).toBeDefined();
      expect(model.modelId).toContain('claude-sonnet-4-20250514');
    });

    it('should create an OpenAI model with explicit API key', () => {
      const config = makeConfig({ provider: 'openai', id: 'gpt-4o' });
      const model = getModel(config, 'test-key-123');
      expect(model).toBeDefined();
      expect(model.modelId).toContain('gpt-4o');
    });

    it('should default to openrouter when provider not specified', () => {
      const config = makeConfig({ id: 'anthropic/claude-sonnet-4' });
      // Remove provider to test default
      delete (config.model as Record<string, unknown>).provider;
      const model = getModel(config, 'test-key-123');
      expect(model).toBeDefined();
      expect(model.provider).toBe('openrouter');
    });

    it('should throw for unknown provider', () => {
      const config = makeConfig({ provider: 'unknown-provider' as string, id: 'some-model' });
      expect(() => getModel(config, 'test-key')).toThrow('Unknown provider "unknown-provider"');
      expect(() => getModel(config, 'test-key')).toThrow('Supported providers:');
    });

    it('should throw for openrouter with no API key and no env var', () => {
      const config = makeConfig({ provider: 'openrouter', id: 'test/model' });
      const original = process.env.OPENROUTER_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      try {
        expect(() => getModel(config)).toThrow('No API key found');
        expect(() => getModel(config)).toThrow('OPENROUTER_API_KEY');
      } finally {
        if (original) process.env.OPENROUTER_API_KEY = original;
      }
    });

    it('should cache provider factories for the same provider+key', () => {
      const config = makeConfig({ provider: 'anthropic', id: 'claude-sonnet-4-20250514' });
      const model1 = getModel(config, 'test-key');
      const model2 = getModel(config, 'test-key');
      // Both should work — caching shouldn't break anything
      expect(model1.modelId).toBe(model2.modelId);
    });

    it('should create separate factories for different API keys', () => {
      const config = makeConfig({ provider: 'anthropic', id: 'claude-sonnet-4-20250514' });
      const model1 = getModel(config, 'key-1');
      const model2 = getModel(config, 'key-2');
      // Both should be valid models (not sharing cached instance)
      expect(model1).toBeDefined();
      expect(model2).toBeDefined();
    });
  });

  describe('getSummaryModel', () => {
    it('should return summary_model when configured', () => {
      const config = makeConfig({
        provider: 'openrouter',
        id: 'anthropic/claude-sonnet-4',
        summary_model: 'google/gemini-flash-1.5',
      });
      const model = getSummaryModel(config, 'test-key');
      expect(model).toBeDefined();
      expect(model.modelId).toBe('google/gemini-flash-1.5');
    });

    it('should fall back to primary model when summary_model not set', () => {
      const config = makeConfig({
        provider: 'openrouter',
        id: 'anthropic/claude-sonnet-4',
      });
      const model = getSummaryModel(config, 'test-key');
      expect(model).toBeDefined();
      expect(model.modelId).toBe('anthropic/claude-sonnet-4');
    });
  });

  describe('getFastModel', () => {
    it('should return fast_model when configured', () => {
      const config = makeConfig({
        provider: 'openrouter',
        id: 'anthropic/claude-sonnet-4',
        fast_model: 'google/gemini-flash-2.0',
      });
      const model = getFastModel(config, 'test-key');
      expect(model).toBeDefined();
      expect(model.modelId).toBe('google/gemini-flash-2.0');
    });

    it('should fall back to summary_model when fast_model not set', () => {
      const config = makeConfig({
        provider: 'openrouter',
        id: 'anthropic/claude-sonnet-4',
        summary_model: 'google/gemini-flash-1.5',
      });
      const model = getFastModel(config, 'test-key');
      expect(model).toBeDefined();
      expect(model.modelId).toBe('google/gemini-flash-1.5');
    });

    it('should fall back to primary model when neither fast_model nor summary_model set', () => {
      const config = makeConfig({
        provider: 'openrouter',
        id: 'anthropic/claude-sonnet-4',
      });
      const model = getFastModel(config, 'test-key');
      expect(model).toBeDefined();
      expect(model.modelId).toBe('anthropic/claude-sonnet-4');
    });
  });

  describe('resetProvider', () => {
    it('should clear cached providers', () => {
      const config = makeConfig({ provider: 'openai', id: 'gpt-4o' });
      getModel(config, 'test-key');
      resetProvider();
      // After reset, should still work (just creates new instance)
      const model = getModel(config, 'test-key');
      expect(model).toBeDefined();
    });
  });
});
