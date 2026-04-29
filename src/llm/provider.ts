import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText, stepCountIs, wrapLanguageModel, ToolLoopAgent, type LanguageModel, type LanguageModelMiddleware, type PrepareStepFunction, type ToolSet } from 'ai';
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
export type ProviderName = 'openrouter' | 'anthropic' | 'openai' | 'ollama' | 'cerebras' | 'agntk-free';

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
  cerebras: 'CEREBRAS_API_KEY',
};

/**
 * Default base URL for the local Ollama HTTP server. Ollama exposes an
 * OpenAI-compatible chat completions endpoint at /v1 on this port.
 * Override with the OLLAMA_BASE_URL env var when running on a non-default
 * host or port (e.g. in Docker, on a remote box, behind a proxy).
 */
const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1';

/**
 * Cerebras Inference API endpoint. Used by the `cerebras` provider when the
 * user supplies their own CEREBRAS_API_KEY. Currently serves llama3.1-8b,
 * gpt-oss-120b, qwen-3-235b-a22b-instruct-2507, zai-glm-4.7. Free developer
 * tier is available at cerebras.ai.
 */
const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';

/**
 * agntK-hosted free-tier proxy. Forwards OpenAI-compatible requests to
 * Cerebras using a server-held API key. Rate-limited (10 req/60s per IP)
 * and daily-budgeted by the maintainer. Accepts a static bearer token —
 * users of the `agntk-free` provider don't need their own API key.
 */
const AGNTK_FREE_BASE_URL = 'https://api.agntk.dev/api/v1';
const AGNTK_FREE_STATIC_TOKEN = 'agntk-free-v1';

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
      if (options?.baseURL) {
        createOptions.baseURL = options.baseURL;
        if (!createOptions.apiKey && /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(options.baseURL)) {
          createOptions.apiKey = 'local-no-auth';
        }
      }
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
    case 'cerebras': {
      if (!key) {
        throw new Error(
          `No API key found for provider "${providerName}". ` +
          `Set CEREBRAS_API_KEY environment variable (free developer tier at cerebras.ai).`
        );
      }
      const provider = createOpenAI({ baseURL: CEREBRAS_BASE_URL, apiKey: key });
      factory = (modelId) => provider.chat(modelId);
      break;
    }
    case 'agntk-free': {
      const provider = createOpenAI({ baseURL: AGNTK_FREE_BASE_URL, apiKey: AGNTK_FREE_STATIC_TOKEN });
      factory = (modelId) => provider.chat(modelId);
      break;
    }
    default:
      throw new Error(
        `Unknown provider "${providerName}". ` +
        `Supported providers: openrouter, anthropic, openai, ollama, cerebras, agntk-free`
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
  /**
   * Subset of `tools` (by name) the model may call during this invocation.
   * Narrows without unloading. Unknown names are silently ignored by the AI SDK.
   */
  activeTools?: string[];
  /**
   * AI SDK prepareStep hook — called before each step in the tool-use loop
   * and may return a partial settings override (e.g., an augmented system
   * prompt for reflection). Usually supplied by `createReflectionPrepareStep`.
   */
  prepareStep?: (args: { stepNumber: number; steps: unknown[] }) => { system?: string } | undefined;
  /**
   * AI SDK onStepFinish hook — called after each step (LLM call) in the
   * tool-use loop. Used by trigger skills with harness-trigger: step-finish.
   * Observation only — return value is ignored.
   */
  onStepFinish?: (event: unknown) => Promise<void> | void;
  /**
   * AI SDK onFinish hook — called when all steps are finished.
   * Used by trigger skills with harness-trigger: run-finish.
   * Observation only — return value is ignored.
   */
  onFinish?: (event: unknown) => Promise<void> | void;
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
  /**
   * Subset of `tools` (by name) the model may call during this invocation.
   * Narrows without unloading. Unknown names are silently ignored by the AI SDK.
   */
  activeTools?: string[];
  /**
   * AI SDK prepareStep hook — see GenerateOptions.prepareStep.
   */
  prepareStep?: (args: { stepNumber: number; steps: unknown[] }) => { system?: string } | undefined;
  /** AI SDK onStepFinish hook — see GenerateOptions.onStepFinish. */
  onStepFinish?: (event: unknown) => Promise<void> | void;
  /** AI SDK onFinish hook — see GenerateOptions.onFinish. */
  onFinish?: (event: unknown) => Promise<void> | void;
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

function buildCallSettings(
  opts: CallOptions & {
    tools?: AIToolSet;
    maxToolSteps?: number;
    activeTools?: string[];
    prepareStep?: (args: { stepNumber: number; steps: unknown[] }) => { system?: string } | undefined;
    onStepFinish?: (event: unknown) => Promise<void> | void;
    onFinish?: (event: unknown) => Promise<void> | void;
  },
) {
  const hasTools = opts.tools && Object.keys(opts.tools).length > 0;
  const hasActive = hasTools && opts.activeTools && opts.activeTools.length > 0;
  return {
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    ...(hasTools ? { tools: opts.tools } : {}),
    ...(hasActive ? { activeTools: opts.activeTools } : {}),
    ...(hasTools ? { stopWhen: stepCountIs(opts.maxToolSteps ?? 25) } : {}),
    ...(opts.prepareStep ? { prepareStep: opts.prepareStep } : {}),
    ...(opts.onStepFinish ? { onStepFinish: opts.onStepFinish } : {}),
    ...(opts.onFinish ? { onFinish: opts.onFinish } : {}),
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

// ---------------------------------------------------------------------------
// ToolLoopAgent-based execution paths — required for prepareCall wiring
// ---------------------------------------------------------------------------

/**
 * Extended options for agent-based generation. Identical to GenerateOptions
 * but adds `prepareCall` — a ToolLoopAgent-only lifecycle hook that fires once
 * per agent.generate() call and can mutate instructions, tools, activeTools,
 * and providerOptions before the first step begins.
 */
export interface AgentGenerateOptions extends GenerateOptions {
  /**
   * prepareCall hook from composeTriggerHandlers. Called once per generate()
   * invocation, before any steps run. Can mutate: instructions, tools,
   * activeTools, providerOptions. Skills with harness-trigger: prepare-call
   * are composed into this function.
   *
   * The ToolLoopAgent passes typed settings; we bridge to the trigger handler's
   * generic Record<string, unknown> shape.
   */
  prepareCall?: (settings: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/**
 * Adapt the prepareStep shape from `createReflectionPrepareStep` (which returns
 * `{ system?: string } | undefined`) to `PrepareStepFunction` (which must return
 * `PrepareStepResult | PromiseLike<PrepareStepResult>`).
 */
function adaptPrepareStep(
  fn: (args: { stepNumber: number; steps: unknown[] }) => { system?: string } | undefined,
): PrepareStepFunction<ToolSet> {
  return (opts) => {
    const result = fn({ stepNumber: opts.stepNumber, steps: opts.steps });
    return result ?? {};
  };
}

/**
 * Build a ToolLoopAgent<never, ToolSet> from AgentGenerateOptions.
 * Using `never` for CALL_OPTIONS so agent.generate/stream don't require an
 * `options` field. The `prepareCall` handler is bridged via `unknown` cast
 * because the trigger handler returns `Record<string, unknown>` while the SDK
 * expects the full typed settings shape — at runtime the object is compatible.
 */
function buildAgent(opts: AgentGenerateOptions): ToolLoopAgent<never, ToolSet> {
  const hasTools = opts.tools && Object.keys(opts.tools).length > 0;
  const hasActive = hasTools && opts.activeTools && opts.activeTools.length > 0;
  const callSettings = buildCallSettings(opts);

  // Build the prepareCall bridge: trigger handler returns Record<string, unknown>,
  // ToolLoopAgent expects the full typed pick — cast via unknown.
  type AgentSettings = ConstructorParameters<typeof ToolLoopAgent<never, ToolSet>>[0];
  type PrepareCallFn = NonNullable<AgentSettings['prepareCall']>;

  const prepareCallBridge: PrepareCallFn | undefined = opts.prepareCall
    ? async (options) => {
        const merged = await opts.prepareCall!(options as Record<string, unknown>);
        return merged as unknown as Awaited<ReturnType<PrepareCallFn>>;
      }
    : undefined;

  const settings: AgentSettings = {
    model: opts.model,
    instructions: opts.system,
    ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    ...(callSettings.maxRetries !== undefined ? { maxRetries: callSettings.maxRetries } : {}),
    ...(hasTools ? { tools: opts.tools as ToolSet } : {}),
    ...(hasActive ? { activeTools: opts.activeTools as string[] } : {}),
    ...(hasTools ? { stopWhen: callSettings.stopWhen } : {}),
    ...(opts.prepareStep ? { prepareStep: adaptPrepareStep(opts.prepareStep) } : {}),
    ...(opts.onStepFinish ? { onStepFinish: opts.onStepFinish as AgentSettings['onStepFinish'] } : {}),
    ...(opts.onFinish ? { onFinish: opts.onFinish as AgentSettings['onFinish'] } : {}),
    ...(prepareCallBridge ? { prepareCall: prepareCallBridge } : {}),
  };

  return new ToolLoopAgent<never, ToolSet>(settings);
}

/** Build call parameters shared by generate() and stream(). */
function buildAgentCallParams(opts: AgentGenerateOptions) {
  return {
    prompt: opts.prompt,
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    ...(opts.timeoutMs !== undefined ? { timeout: { totalMs: opts.timeoutMs } } : {}),
  } as const;
}

/**
 * Build and run a ToolLoopAgent for non-streaming generation. The agent is
 * constructed fresh on every call (settings are per-invocation). This enables
 * the `prepareCall` hook — a ToolLoopAgent-only lifecycle event that fires
 * before any LLM step and can inject instructions / tools / providerOptions.
 */
export async function generateWithAgent(opts: AgentGenerateOptions): Promise<GenerateResult> {
  const agent = buildAgent(opts);
  const result = await agent.generate(buildAgentCallParams(opts));
  const usage = result.totalUsage ?? result.usage;

  return {
    text: result.text,
    usage: extractUsage(usage),
    toolCalls: extractToolCalls(result),
    steps: result.steps?.length ?? 1,
  };
}

/**
 * Build and run a ToolLoopAgent for streaming generation. Returns the same
 * StreamGenerateResult shape as streamGenerateWithDetails, so callers are
 * unchanged. The `prepareCall` hook fires before any LLM step.
 *
 * ToolLoopAgent.stream() returns a Promise<StreamTextResult>, so the textStream
 * is an async generator that awaits the promise then iterates. We cache the
 * stream promise so all four consumers (textStream, usage, toolCalls, steps)
 * share the same underlying call.
 */
export function streamWithAgent(opts: AgentGenerateOptions): StreamGenerateResult {
  const agent = buildAgent(opts);
  const callParams = buildAgentCallParams(opts);

  // Eagerly start and cache the agent.stream() Promise so all consumers
  // share the same underlying LLM call.
  const streamResultPromise = agent.stream(callParams);

  async function* textStream(): AsyncIterable<string> {
    const streamResult = await streamResultPromise;
    for await (const chunk of streamResult.textStream) {
      yield chunk;
    }
  }

  const totalUsage = streamResultPromise
    .then((r) => r.totalUsage ?? r.usage)
    .then((u) => extractUsage(u));
  const toolCalls = streamResultPromise
    .then((r) => r.steps)
    .then((s) => extractToolCalls({ steps: s }));
  const steps = streamResultPromise
    .then((r) => r.steps)
    .then((s) => s?.length ?? 1);

  return {
    textStream: textStream(),
    usage: totalUsage,
    toolCalls,
    steps,
  };
}
