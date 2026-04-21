import { describe, it, expect } from 'vitest';
import {
  isCloudModel,
  isUsableSize,
  recommendOllamaModels,
  type SystemProfile,
} from '../src/runtime/system-detect.js';

function mkProfile(overrides: Partial<SystemProfile> = {}): SystemProfile {
  return {
    totalRAMGb: 16,
    usableForModelsGb: 10.4,
    platform: 'darwin',
    isAppleSilicon: true,
    nvidiaVRAMGb: null,
    ...overrides,
  };
}

describe('isCloudModel', () => {
  it('detects -cloud suffix', () => {
    expect(isCloudModel('qwen3-coder:480b-cloud')).toBe(true);
    expect(isCloudModel('gpt-oss:20b-cloud')).toBe(true);
  });
  it('detects :cloud tag', () => {
    expect(isCloudModel('qwen3.5:cloud')).toBe(true);
  });
  it('returns false for local tags', () => {
    expect(isCloudModel('qwen3.5:9b')).toBe(false);
    expect(isCloudModel('gemma4:26b')).toBe(false);
  });
});

describe('isUsableSize', () => {
  it('accepts cloud models regardless of size', () => {
    expect(isUsableSize('gpt-oss:20b-cloud')).toBe(true);
  });
  it('rejects models below 4B', () => {
    expect(isUsableSize('qwen3:0.6b')).toBe(false);
    expect(isUsableSize('qwen3:1.7b')).toBe(false);
  });
  it('accepts 4B and larger', () => {
    expect(isUsableSize('qwen3.5:4b')).toBe(true);
    expect(isUsableSize('qwen3.5:9b')).toBe(true);
    expect(isUsableSize('gemma4:26b')).toBe(true);
  });
  it('accepts tags with no size marker', () => {
    expect(isUsableSize('embeddinggemma:latest')).toBe(true);
  });
});

describe('recommendOllamaModels', () => {
  it('recommends tiny tier for memory-constrained systems', () => {
    const rec = recommendOllamaModels(mkProfile({ totalRAMGb: 4, usableForModelsGb: 2.6 }));
    expect(rec.tier).toBe('tiny');
    expect(rec.primary).toBe('qwen3.5:4b');
    expect(rec.reason).toContain('4 GB');
  });

  it('recommends small tier for ~8 GB Apple Silicon', () => {
    const rec = recommendOllamaModels(mkProfile({ totalRAMGb: 8, usableForModelsGb: 5.2 }));
    expect(rec.tier).toBe('small');
    expect(rec.primary).toBe('qwen3.5:9b');
  });

  it('recommends medium tier for ~24 GB Apple Silicon', () => {
    const rec = recommendOllamaModels(mkProfile({ totalRAMGb: 24, usableForModelsGb: 15.6 }));
    expect(rec.tier).toBe('medium');
    expect(rec.primary).toBe('gemma4:26b');
  });

  it('recommends large tier for 48+ GB Apple Silicon', () => {
    const rec = recommendOllamaModels(mkProfile({ totalRAMGb: 48, usableForModelsGb: 31.2 }));
    expect(rec.tier).toBe('large');
    expect(rec.primary).toBe('gemma4:26b');
    expect(rec.summary).toBe('gemma4:26b');
  });

  it('clamps to installed models when a preferred one is present', () => {
    const rec = recommendOllamaModels(
      mkProfile({ totalRAMGb: 24, usableForModelsGb: 15.6 }),
      ['qwen3.5:9b', 'qwen3.5:4b'],
    );
    expect(rec.primary).toBe('qwen3.5:9b');
  });

  it('marks noUsableModels when nothing installed is usable', () => {
    const rec = recommendOllamaModels(
      mkProfile({ totalRAMGb: 24, usableForModelsGb: 15.6 }),
      ['qwen3:0.6b', 'qwen3:1.7b'],
    );
    expect(rec.noUsableModels).toBe(true);
  });

  it('returns ideal unchanged when installedModels is undefined', () => {
    const rec = recommendOllamaModels(mkProfile({ totalRAMGb: 48, usableForModelsGb: 31.2 }));
    expect(rec.tier).toBe('large');
    expect(rec.noUsableModels).toBeUndefined();
  });
});
