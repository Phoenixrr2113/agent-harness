import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText, type LanguageModel } from 'ai';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import type { HarnessConfig } from '../core/types.js';

/** Supported provider names for config.model.provider */
export type ProviderName = 'openrouter' | 'anthropic' | 'openai';

/** Provider factory — maps provider names to (apiKey) => LanguageModel functions */
type ProviderFactory = (modelId: string, apiKey?: string) => LanguageModel;

const ENV_KEYS: Record<ProviderName, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

/** Cached provider instances keyed by provider name */
const _providers: Map<string, ProviderFactory> = new Map();

function getOrCreateFactory(providerName: ProviderName, apiKey?: string): ProviderFactory {
  const cacheKey = `${providerName}:${apiKey ?? 'env'}`;
  const cached = _providers.get(cacheKey);
  if (cached) return cached;

  const envKey = ENV_KEYS[providerName];
  const key = apiKey ?? process.env[envKey];

  let factory: ProviderFactory;

  switch (providerName) {
    case 'openrouter': {
      if (!key) {
        throw new Error(
          `No API key found for provider "${providerName}". ` +
          `Set ${envKey} environment variable or pass apiKey option.`
        );
      }
      const provider = createOpenRouter({ apiKey: key });
      factory = (modelId) => provider(modelId);
      break;
    }
    case 'anthropic': {
      // createAnthropic reads ANTHROPIC_API_KEY from env by default
      const provider = createAnthropic(key ? { apiKey: key } : undefined);
      factory = (modelId) => provider(modelId);
      break;
    }
    case 'openai': {
      // createOpenAI reads OPENAI_API_KEY from env by default
      const provider = createOpenAI(key ? { apiKey: key } : undefined);
      factory = (modelId) => provider(modelId);
      break;
    }
    default:
      throw new Error(
        `Unknown provider "${providerName}". ` +
        `Supported providers: ${Object.keys(ENV_KEYS).join(', ')}`
      );
  }

  _providers.set(cacheKey, factory);
  return factory;
}

/**
 * Get the OpenRouter provider (backward-compatible).
 * @deprecated Use getModel() with config.model.provider instead.
 */
export function getProvider(apiKey?: string): ReturnType<typeof createOpenRouter> {
  const key = apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error(
      'No OpenRouter API key found. Set OPENROUTER_API_KEY environment variable or pass apiKey option.'
    );
  }
  return createOpenRouter({ apiKey: key });
}

export function resetProvider(): void {
  _providers.clear();
}

/**
 * Get a LanguageModel from config. Supports openrouter, anthropic, and openai providers.
 *
 * Provider is selected from config.model.provider (defaults to 'openrouter').
 * Model ID format depends on provider:
 *   - openrouter: "anthropic/claude-sonnet-4" (vendor/model)
 *   - anthropic: "claude-sonnet-4-20250514" (native model ID)
 *   - openai: "gpt-4o" (native model ID)
 */
export function getModel(config: HarnessConfig, apiKey?: string): LanguageModel {
  const providerName = (config.model.provider ?? 'openrouter') as ProviderName;
  const factory = getOrCreateFactory(providerName, apiKey);
  return factory(config.model.id);
}

export interface GenerateOptions {
  model: LanguageModel;
  system: string;
  prompt: string;
  maxOutputTokens?: number;
}

export interface GenerateWithMessagesOptions {
  model: LanguageModel;
  system: string;
  messages: ModelMessage[];
  maxOutputTokens?: number;
}

export interface GenerateResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

function extractUsage(usage: { inputTokens?: number; outputTokens?: number } | undefined) {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    totalTokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
  };
}

export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  const result = await generateText({
    model: opts.model,
    system: opts.system,
    prompt: opts.prompt,
    maxOutputTokens: opts.maxOutputTokens,
  });

  return { text: result.text, usage: extractUsage(result.usage) };
}

export async function generateWithMessages(opts: GenerateWithMessagesOptions): Promise<GenerateResult> {
  const result = await generateText({
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    maxOutputTokens: opts.maxOutputTokens,
  });

  return { text: result.text, usage: extractUsage(result.usage) };
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

export interface StreamWithMessagesResult {
  textStream: AsyncIterable<string>;
  usage: Promise<GenerateResult['usage']>;
}

export function streamWithMessages(opts: GenerateWithMessagesOptions): StreamWithMessagesResult {
  const result = streamText({
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    maxOutputTokens: opts.maxOutputTokens,
  });

  const usage = Promise.resolve(result.usage).then((u) => extractUsage(u));

  return {
    textStream: result.textStream,
    usage,
  };
}
