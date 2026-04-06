import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText, streamText, type LanguageModel } from 'ai';
import type { ModelMessage } from '@ai-sdk/provider-utils';
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

export function resetProvider(): void {
  _provider = null;
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
