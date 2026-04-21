import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText, stepCountIs, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import type { HarnessConfig, ToolCallInfo } from '../core/types.js';
import type { AIToolSet } from '../runtime/tool-executor.js';

/**
 * Middleware that injects `providerOptions.openai.reasoningEffort = 'none'`
 * by default on every Ollama call.
 *
 * Why: models tagged "thinking" on Ollama (gemma4, qwen3.5, qwen3.6, the
 * NVFP4 coding variants, and others) default to generating a reasoning
 * trace in `message.reasoning` before producing `message.content`. The AI
 * SDK reads `content` as the response text, so when `content` is empty
 * (truncated by output-token budget consumed by reasoning) the caller sees
 * silence. In tool-use loops this wastes tool steps too.
 *
 * Setting `reasoning_effort: none` via Ollama's OpenAI-compat endpoint
 * disables the thinking channel: models return `content` directly. Users
 * who want thinking on can override via per-call providerOptions.
 *
 * This middleware runs before each generate/stream call, merging its
 * defaults under any user-set providerOptions so explicit overrides win.
 */
const ollamaReasoningEffortMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v3',
  transformParams: async ({ params }) => ({
    ...params,
    providerOptions: {
      ...params.providerOptions,
      openai: {
        reasoningEffort: 'none',
        ...params.providerOptions?.openai,
      },
    },
  }),
};

/** Supported provider names for config.model.provider */
export type ProviderName = 'openrouter' | 'anthropic' | 'openai' | 'ollama';

/** Provider factory — maps provider names to (apiKey) => LanguageModel functions */
type ProviderFactory = (modelId: string, apiKey?: string) => LanguageModel;

/** Optional per-provider settings from config.yaml */
interface FactoryOptions {
  /**
   * Custom base URL for the `openai` provider. Lets users point at any
   * OpenAI-compatible endpoint (Cerebras Cloud, Groq, Together AI,
   * Fireworks, a local vLLM, etc.). When set, forces provider.chat() since
   * most OpenAI-compat providers implement Chat Completions but not
   * Responses API.
   */
  baseURL?: string;
}

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

function getOrCreateFactory(providerName: ProviderName, apiKey?: string, options?: FactoryOptions): ProviderFactory {
  const cacheKey = `${providerName}:${apiKey ?? 'env'}:${options?.baseURL ?? ''}`;
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
      // createOpenAI reads OPENAI_API_KEY from env by default.
      //
      // If `options.baseURL` is set, we're pointing at an OpenAI-compatible
      // endpoint that isn't api.openai.com (Cerebras, Groq, Together AI,
      // Fireworks, DeepInfra, a local vLLM, etc.). Force the .chat() code
      // path in that case — most OpenAI-compat providers implement Chat
      // Completions at /v1/chat/completions but NOT the Responses API. The
      // default callable resolves to Responses and would surface as:
      //   Error: input[2]: unknown input item type: "item_reference"
      //
      // For canonical OpenAI (no baseURL override), keep the default callable
      // so advanced users can rely on Responses API features.
      const createOptions: Parameters<typeof createOpenAI>[0] = {};
      if (key) createOptions.apiKey = key;
      if (options?.baseURL) createOptions.baseURL = options.baseURL;
      const provider = createOpenAI(Object.keys(createOptions).length > 0 ? createOptions : undefined);
      factory = options?.baseURL
        ? (modelId) => provider.chat(modelId)
        : (modelId) => provider(modelId);
      break;
    }
    case 'ollama': {
      // Ollama exposes an OpenAI-compatible chat completions endpoint at
      // http://localhost:11434/v1 by default. Reuses @ai-sdk/openai with a
      // baseURL override and a dummy apiKey (Ollama doesn't authenticate but
      // the OpenAI SDK requires the field to be set to something).
      // Override the host with OLLAMA_BASE_URL env var when needed.
      //
      // Must call provider.chat() explicitly: the default callable
      // `provider(modelId)` resolves to the Responses API, which Ollama does
      // not implement — it only speaks Chat Completions at
      // /v1/chat/completions. Responses API surfaces as:
      //   Error: input[2]: unknown input item type: "item_reference"
      //
      // wrapLanguageModel with ollamaReasoningEffortMiddleware injects
      // `reasoning_effort: none` by default, making models with a thinking
      // channel (gemma4, qwen3.5, qwen3.6, NVFP4 coding variants) return
      // content directly instead of silently emitting their reasoning trace
      // into `message.reasoning` (which the AI SDK drops).
      const baseURL = process.env.OLLAMA_BASE_URL ?? OLLAMA_DEFAULT_BASE_URL;
      const provider = createOpenAI({ baseURL, apiKey: 'ollama' });
      factory = (modelId) => wrapLanguageModel({
        model: provider.chat(modelId),
        middleware: ollamaReasoningEffortMiddleware,
      });
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
  const factory = getOrCreateFactory(providerName, apiKey, { baseURL: config.model.base_url });
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
  const factory = getOrCreateFactory(providerName, apiKey, { baseURL: config.model.base_url });
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
  const factory = getOrCreateFactory(providerName, apiKey, { baseURL: config.model.base_url });
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
    ...(hasTools ? { stopWhen: stepCountIs(opts.maxToolSteps ?? 25) } : {}),
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
