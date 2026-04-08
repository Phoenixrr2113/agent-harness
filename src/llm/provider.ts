import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText, stepCountIs, type LanguageModel } from 'ai';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import type { HarnessConfig, ToolCallInfo } from '../core/types.js';
import type { AIToolSet } from '../runtime/tool-executor.js';

/** Supported provider names for config.model.provider */
export type ProviderName = 'openrouter' | 'anthropic' | 'openai' | 'ollama';

/** Provider factory — maps provider names to (apiKey) => LanguageModel functions */
type ProviderFactory = (modelId: string, apiKey?: string) => LanguageModel;

/**
 * Environment variable each provider reads its API key from.
 * Ollama runs locally and needs no auth, so it has no env key.
 */
const ENV_KEYS: Partial<Record<ProviderName, string>> = {
  openrouter: 'OPENROUTER_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

/**
 * Default base URL for the local Ollama HTTP server. Ollama exposes an
 * OpenAI-compatible chat completions endpoint at /v1 on this port.
 * Override with the OLLAMA_BASE_URL env var when running on a non-default
 * host or port (e.g. in Docker, on a remote box, behind a proxy).
 */
const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1';

/** Cached provider instances keyed by provider name */
const _providers: Map<string, ProviderFactory> = new Map();

function getOrCreateFactory(providerName: ProviderName, apiKey?: string): ProviderFactory {
  const cacheKey = `${providerName}:${apiKey ?? 'env'}`;
  const cached = _providers.get(cacheKey);
  if (cached) return cached;

  const envKey = ENV_KEYS[providerName];
  const key = apiKey ?? (envKey ? process.env[envKey] : undefined);

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
    case 'ollama': {
      // Ollama exposes an OpenAI-compatible chat completions endpoint at
      // http://localhost:11434/v1 by default. Reuses @ai-sdk/openai with a
      // baseURL override and a dummy apiKey (Ollama doesn't authenticate but
      // the OpenAI SDK requires the field to be set to something).
      // Override the host with OLLAMA_BASE_URL env var when needed.
      const baseURL = process.env.OLLAMA_BASE_URL ?? OLLAMA_DEFAULT_BASE_URL;
      const provider = createOpenAI({ baseURL, apiKey: 'ollama' });
      factory = (modelId) => provider(modelId);
      break;
    }
    default:
      throw new Error(
        `Unknown provider "${providerName}". ` +
        `Supported providers: openrouter, anthropic, openai, ollama`
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

/**
 * Get the summary model for cheap auto-generation tasks (L0/L1 summaries, tags, frontmatter).
 * Falls back to the primary model if summary_model is not configured.
 *
 * Usage: set `model.summary_model` in config.yaml, e.g.:
 *   summary_model: "google/gemini-flash-1.5"
 */
export function getSummaryModel(config: HarnessConfig, apiKey?: string): LanguageModel {
  const modelId = config.model.summary_model ?? config.model.id;
  const providerName = (config.model.provider ?? 'openrouter') as ProviderName;
  const factory = getOrCreateFactory(providerName, apiKey);
  return factory(modelId);
}

/**
 * Get the fast model for validation, checks, and quick decisions.
 * Falls back to summary_model, then primary model.
 *
 * Usage: set `model.fast_model` in config.yaml, e.g.:
 *   fast_model: "google/gemini-flash-1.5"
 */
export function getFastModel(config: HarnessConfig, apiKey?: string): LanguageModel {
  const modelId = config.model.fast_model ?? config.model.summary_model ?? config.model.id;
  const providerName = (config.model.provider ?? 'openrouter') as ProviderName;
  const factory = getOrCreateFactory(providerName, apiKey);
  return factory(modelId);
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

/**
 * @deprecated Use `streamGenerateWithDetails()` instead — returns metadata (usage, toolCalls, steps).
 */
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
  /** Tool calls made across all steps (resolves after stream completes) */
  toolCalls: Promise<ToolCallInfo[]>;
  /** Number of steps (resolves after stream completes) */
  steps: Promise<number>;
}

export function streamWithMessages(opts: GenerateWithMessagesOptions): StreamWithMessagesResult {
  const result = streamText({
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    maxOutputTokens: opts.maxOutputTokens,
    ...buildCallSettings(opts),
  });

  const totalUsage = Promise.resolve(result.totalUsage ?? result.usage).then((u) => extractUsage(u));
  const toolCalls = Promise.resolve(result.steps).then((s) => extractToolCalls({ steps: s }));
  const steps = Promise.resolve(result.steps).then((s) => s?.length ?? 1);

  return {
    textStream: result.textStream,
    usage: totalUsage,
    toolCalls,
    steps,
  };
}

export interface StreamGenerateResult {
  textStream: AsyncIterable<string>;
  usage: Promise<GenerateResult['usage']>;
  toolCalls: Promise<ToolCallInfo[]>;
  steps: Promise<number>;
}

export function streamGenerateWithDetails(opts: GenerateOptions): StreamGenerateResult {
  const result = streamText({
    model: opts.model,
    system: opts.system,
    prompt: opts.prompt,
    maxOutputTokens: opts.maxOutputTokens,
    ...buildCallSettings(opts),
  });

  const totalUsage = Promise.resolve(result.totalUsage ?? result.usage).then((u) => extractUsage(u));
  const toolCalls = Promise.resolve(result.steps).then((s) => extractToolCalls({ steps: s }));
  const steps = Promise.resolve(result.steps).then((s) => s?.length ?? 1);

  return {
    textStream: result.textStream,
    usage: totalUsage,
    toolCalls,
    steps,
  };
}
