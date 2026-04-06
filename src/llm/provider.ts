import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText, stepCountIs, type LanguageModel } from 'ai';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import type { HarnessConfig, ToolCallInfo } from '../core/types.js';
import type { AIToolSet } from '../runtime/tool-executor.js';

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

export interface CallOptions {
  maxRetries?: number;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface GenerateOptions extends CallOptions {
  model: LanguageModel;
  system: string;
  prompt: string;
  maxOutputTokens?: number;
  /** AI SDK tools to make available for the LLM */
  tools?: AIToolSet;
  /** Max tool-use roundtrips (default: 1 if tools provided, 0 otherwise) */
  maxToolSteps?: number;
}

export interface GenerateWithMessagesOptions extends CallOptions {
  model: LanguageModel;
  system: string;
  messages: ModelMessage[];
  maxOutputTokens?: number;
  /** AI SDK tools to make available for the LLM */
  tools?: AIToolSet;
  /** Max tool-use roundtrips (default: 1 if tools provided, 0 otherwise) */
  maxToolSteps?: number;
}

export interface GenerateResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  /** Tool calls made during generation (empty if no tools used) */
  toolCalls: ToolCallInfo[];
  /** Number of steps taken (1 = no tool calls, >1 = tool roundtrips) */
  steps: number;
}

function extractUsage(usage: { inputTokens?: number; outputTokens?: number } | undefined) {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    totalTokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
  };
}

function buildCallSettings(opts: CallOptions & { tools?: AIToolSet; maxToolSteps?: number }) {
  const hasTools = opts.tools && Object.keys(opts.tools).length > 0;
  return {
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    ...(hasTools ? { tools: opts.tools } : {}),
    ...(hasTools ? { stopWhen: stepCountIs(opts.maxToolSteps ?? 5) } : {}),
  };
}

/** Extract tool call info from AI SDK step results */
function extractToolCalls(result: { steps?: Array<{ toolCalls?: Array<{ toolName: string; input: unknown }>; toolResults?: Array<{ toolName: string; output: unknown }> }> }): ToolCallInfo[] {
  const calls: ToolCallInfo[] = [];
  if (!result.steps) return calls;

  for (const step of result.steps) {
    if (!step.toolCalls) continue;
    for (let i = 0; i < step.toolCalls.length; i++) {
      const tc = step.toolCalls[i];
      const tr = step.toolResults?.[i];
      calls.push({
        toolName: tc.toolName,
        args: (tc.input ?? {}) as Record<string, unknown>,
        result: tr?.output ?? null,
      });
    }
  }
  return calls;
}

export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  const result = await generateText({
    model: opts.model,
    system: opts.system,
    prompt: opts.prompt,
    maxOutputTokens: opts.maxOutputTokens,
    ...buildCallSettings(opts),
  });

  // Use totalUsage when available (multi-step) otherwise fall back to usage
  const usage = result.totalUsage ?? result.usage;

  return {
    text: result.text,
    usage: extractUsage(usage),
    toolCalls: extractToolCalls(result),
    steps: result.steps?.length ?? 1,
  };
}

export async function generateWithMessages(opts: GenerateWithMessagesOptions): Promise<GenerateResult> {
  const result = await generateText({
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    maxOutputTokens: opts.maxOutputTokens,
    ...buildCallSettings(opts),
  });

  const usage = result.totalUsage ?? result.usage;

  return {
    text: result.text,
    usage: extractUsage(usage),
    toolCalls: extractToolCalls(result),
    steps: result.steps?.length ?? 1,
  };
}

export async function* streamGenerate(opts: GenerateOptions): AsyncIterable<string> {
  const result = streamText({
    model: opts.model,
    system: opts.system,
    prompt: opts.prompt,
    maxOutputTokens: opts.maxOutputTokens,
    ...buildCallSettings(opts),
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
    ...buildCallSettings(opts),
  });

  const usage = Promise.resolve(result.usage).then((u) => extractUsage(u));

  return {
    textStream: result.textStream,
    usage,
  };
}
