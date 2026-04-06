import { createHarness } from '../core/harness.js';
import type {
  CreateHarnessOptions,
  HarnessConfig,
  HarnessAgent,
  HarnessHooks,
  AgentRunResult,
  AgentState,
  DeepPartial,
  ToolExecutorOptions,
} from '../core/types.js';

/**
 * Fluent builder for defining agents with a clean, declarative API.
 *
 * Usage:
 * ```ts
 * const agent = defineAgent('/path/to/harness')
 *   .model('anthropic/claude-sonnet-4')
 *   .provider('openrouter')
 *   .onBoot(({ config }) => console.log(`Booted ${config.agent.name}`))
 *   .onSessionEnd(({ sessionId }) => console.log(`Session ${sessionId} done`))
 *   .onError(({ error }) => console.error(error))
 *   .maxToolCalls(10)
 *   .build();
 *
 * await agent.boot();
 * const result = await agent.run('Hello');
 * await agent.shutdown();
 * ```
 */
export interface AgentBuilder {
  /** Override the model ID (e.g., "anthropic/claude-sonnet-4") */
  model(id: string): AgentBuilder;

  /** Override the provider (e.g., "openrouter", "anthropic", "openai") */
  provider(name: string): AgentBuilder;

  /** Set the API key for LLM calls */
  apiKey(key: string): AgentBuilder;

  /** Merge partial config overrides */
  configure(overrides: DeepPartial<HarnessConfig>): AgentBuilder;

  /** Register a boot lifecycle hook */
  onBoot(fn: NonNullable<HarnessHooks['onBoot']>): AgentBuilder;

  /** Register a session-end lifecycle hook */
  onSessionEnd(fn: NonNullable<HarnessHooks['onSessionEnd']>): AgentBuilder;

  /** Register an error lifecycle hook */
  onError(fn: NonNullable<HarnessHooks['onError']>): AgentBuilder;

  /** Register a state-change lifecycle hook */
  onStateChange(fn: NonNullable<HarnessHooks['onStateChange']>): AgentBuilder;

  /** Register a shutdown lifecycle hook */
  onShutdown(fn: NonNullable<HarnessHooks['onShutdown']>): AgentBuilder;

  /** Set maximum tool calls per run */
  maxToolCalls(n: number): AgentBuilder;

  /** Set per-tool timeout in ms */
  toolTimeout(ms: number): AgentBuilder;

  /** Enable/disable HTTP tool execution */
  allowHttp(enabled: boolean): AgentBuilder;

  /** Build and return the HarnessAgent (does NOT auto-boot) */
  build(): HarnessAgent;
}

/**
 * Create a fluent builder for defining a HarnessAgent.
 * This is the recommended entry point for programmatic agent creation.
 *
 * @param dir - Path to the harness directory
 * @returns A builder with chainable methods
 */
export function defineAgent(dir: string): AgentBuilder {
  let modelId: string | undefined;
  let providerName: string | undefined;
  let apiKeyValue: string | undefined;
  let configOverrides: DeepPartial<HarnessConfig> | undefined;
  const hooks: HarnessHooks = {};
  const toolOptions: ToolExecutorOptions = {};

  const builder: AgentBuilder = {
    model(id: string): AgentBuilder {
      modelId = id;
      return builder;
    },

    provider(name: string): AgentBuilder {
      providerName = name;
      return builder;
    },

    apiKey(key: string): AgentBuilder {
      apiKeyValue = key;
      return builder;
    },

    configure(overrides: DeepPartial<HarnessConfig>): AgentBuilder {
      if (!configOverrides) {
        configOverrides = overrides;
      } else {
        // Shallow merge top-level keys, deep merge nested objects
        configOverrides = mergeDeep(configOverrides, overrides);
      }
      return builder;
    },

    onBoot(fn: NonNullable<HarnessHooks['onBoot']>): AgentBuilder {
      const prev = hooks.onBoot;
      hooks.onBoot = prev
        ? async (ctx) => { await prev(ctx); await fn(ctx); }
        : fn;
      return builder;
    },

    onSessionEnd(fn: NonNullable<HarnessHooks['onSessionEnd']>): AgentBuilder {
      const prev = hooks.onSessionEnd;
      hooks.onSessionEnd = prev
        ? async (ctx) => { await prev(ctx); await fn(ctx); }
        : fn;
      return builder;
    },

    onError(fn: NonNullable<HarnessHooks['onError']>): AgentBuilder {
      const prev = hooks.onError;
      hooks.onError = prev
        ? async (ctx) => { await prev(ctx); await fn(ctx); }
        : fn;
      return builder;
    },

    onStateChange(fn: NonNullable<HarnessHooks['onStateChange']>): AgentBuilder {
      const prev = hooks.onStateChange;
      hooks.onStateChange = prev
        ? async (ctx) => { await prev(ctx); await fn(ctx); }
        : fn;
      return builder;
    },

    onShutdown(fn: NonNullable<HarnessHooks['onShutdown']>): AgentBuilder {
      const prev = hooks.onShutdown;
      hooks.onShutdown = prev
        ? async (ctx) => { await prev(ctx); await fn(ctx); }
        : fn;
      return builder;
    },

    maxToolCalls(n: number): AgentBuilder {
      toolOptions.maxToolCalls = n;
      return builder;
    },

    toolTimeout(ms: number): AgentBuilder {
      toolOptions.toolTimeoutMs = ms;
      return builder;
    },

    allowHttp(enabled: boolean): AgentBuilder {
      toolOptions.allowHttpExecution = enabled;
      return builder;
    },

    build(): HarnessAgent {
      const options: CreateHarnessOptions = {
        dir,
        model: modelId,
        provider: providerName,
        apiKey: apiKeyValue,
        config: configOverrides,
        hooks,
        toolExecutor: Object.keys(toolOptions).length > 0 ? toolOptions : undefined,
      };
      return createHarness(options);
    },
  };

  return builder;
}

/**
 * Deep merge two DeepPartial objects. Second argument wins on conflict.
 * Only merges plain objects — arrays and primitives are replaced.
 */
function mergeDeep<T>(base: DeepPartial<T>, override: DeepPartial<T>): DeepPartial<T> {
  const result = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      result[key] !== null &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = mergeDeep(
        result[key] as DeepPartial<Record<string, unknown>>,
        value as DeepPartial<Record<string, unknown>>,
      );
    } else {
      result[key] = value;
    }
  }
  return result as DeepPartial<T>;
}
