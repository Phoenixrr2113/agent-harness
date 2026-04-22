import { describe, it, expect } from 'vitest';
import { getModel } from '../src/llm/provider.js';
import type { HarnessConfig } from '../src/core/types.js';

function configWith(baseUrl: string | undefined): HarnessConfig {
  return {
    model: {
      provider: 'openai',
      id: 'qwen3:1.7b',
      max_tokens: 32000,
      max_retries: 2,
      ...(baseUrl ? { base_url: baseUrl } : {}),
    },
  } as unknown as HarnessConfig;
}

describe('openai provider with localhost base_url', () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalOllamaKey = process.env.OLLAMA_API_KEY;

  function cleanEnv() {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OLLAMA_API_KEY;
  }
  function restore() {
    if (originalKey !== undefined) process.env.OPENAI_API_KEY = originalKey;
    if (originalOllamaKey !== undefined) process.env.OLLAMA_API_KEY = originalOllamaKey;
  }

  it('does not throw when base_url points at localhost and no API key is configured', () => {
    cleanEnv();
    try {
      expect(() => getModel(configWith('http://localhost:11434/v1'))).not.toThrow();
    } finally {
      restore();
    }
  });

  it('does not throw for 127.0.0.1 or 0.0.0.0 base_url either', () => {
    cleanEnv();
    try {
      expect(() => getModel(configWith('http://127.0.0.1:8000/v1'))).not.toThrow();
      expect(() => getModel(configWith('http://0.0.0.0:8000/v1'))).not.toThrow();
    } finally {
      restore();
    }
  });

  it('uses the explicit apiKey when provided, regardless of base_url', () => {
    cleanEnv();
    try {
      expect(() => getModel(configWith('https://api.groq.com/openai/v1'), 'test-key')).not.toThrow();
    } finally {
      restore();
    }
  });
});
