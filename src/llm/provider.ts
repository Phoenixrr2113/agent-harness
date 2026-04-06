import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText, streamText, type LanguageModel } from 'ai';
import type { HarnessConfig } from '../core/types.js';

let _provider: ReturnType<typeof createOpenRouter> | null = null;

export function getProvider(apiKey?: string): ReturnType<typeof createOpenRouter> {
  if (_provider) return _provider;

  const key = apiKey || process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error(
      'No OpenRouter API key found. Set OPENROUTER_API_KEY environment variable or pass apiKey option.'
    );
  }

  _provider = createOpenRouter({ apiKey: key });
  return _provider;
}

export function getModel(config: HarnessConfig, apiKey?: string): LanguageModel {
  const provider = getProvider(apiKey);
  return provider(config.model.id);
}

export interface GenerateOptions {
  model: LanguageModel;
  system: string;
  prompt: string;
  maxOutputTokens?: number;
}

export async function generate(opts: GenerateOptions) {
  const result = await generateText({
    model: opts.model,
    system: opts.system,
    prompt: opts.prompt,
    maxOutputTokens: opts.maxOutputTokens,
  });

  return {
    text: result.text,
    usage: {
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      totalTokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
    },
  };
}

export async function* streamGenerate(opts: GenerateOptions): AsyncIterable<string> {
  const result = streamText({
    model: opts.model,
    system: opts.system,
    prompt: opts.prompt,
    maxOutputTokens: opts.maxOutputTokens,
  });

  for await (const chunk of result.textStream) {
    yield chunk;
  }
}
