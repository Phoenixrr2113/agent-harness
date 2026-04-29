import { existsSync } from 'fs';
import { resolve } from 'path';
import { loadConfig } from './config.js';
import { log } from './logger.js';
import type {
  CreateHarnessOptions,
  HarnessAgent,
  HarnessHooks,
  AgentRunResult,
  AgentStreamResult,
  AgentState,
} from './types.js';
import { getModel, generate, streamGenerateWithDetails } from '../llm/provider.js';
import { buildLoadedContext } from '../runtime/context-loader.js';
import { loadState, saveState } from '../runtime/state.js';
import { createSessionId, writeSession, type SessionRecord } from '../runtime/sessions.js';
import { recordCost } from '../runtime/cost-tracker.js';
import { recordSuccess, recordFailure, recordBoot } from '../runtime/health.js';
import { checkGuardrails } from '../runtime/guardrails.js';
import { applyContentFilters } from '../runtime/content-filters.js';
import { buildToolSet, type AIToolSet } from '../runtime/tool-executor.js';
import { createMcpManager, type McpManager } from '../runtime/mcp.js';

export function createHarness(options: CreateHarnessOptions): HarnessAgent {
  const dir = resolve(options.dir);

  if (!existsSync(dir)) {
    throw new Error(`Harness directory not found: ${dir}`);
  }

  const config = loadConfig(dir, options.config);

  // Apply model and provider overrides from options
  if (options.model) {
    config.model = { ...config.model, id: options.model };
  }
  if (options.provider) {
    config.model = { ...config.model, provider: options.provider };
  }

  const model = getModel(config, options.apiKey);
  const hooks: HarnessHooks = options.hooks ?? {};

  let state: AgentState;
  let systemPrompt: string;
  let booted = false;
  let toolSet: AIToolSet = {};
  let mcpManager: McpManager | undefined;

  const agent: HarnessAgent = {
    name: config.agent.name,
    config,

    async boot() {
      // Load state
      state = loadState(dir);
      const previousMode = state.mode;
      state.mode = 'active';
      state.last_interaction = new Date().toISOString();

      // Build system prompt from harness files
      const ctx = buildLoadedContext(dir, config);
      systemPrompt = ctx.systemPrompt;

      // Connect to MCP servers and load their tools
      let mcpTools: AIToolSet = {};
      mcpManager = createMcpManager(config);
      if (mcpManager.hasServers()) {
        try {
          await mcpManager.connect();
          mcpTools = mcpManager.getTools();
        } catch (err) {
          log.warn(`MCP connection failed during boot: ${err instanceof Error ? err.message : String(err)}. Continuing without MCP tools.`);
        }
      }

      toolSet = buildToolSet(dir, options.toolExecutor, mcpTools);
      if (config.approval?.enabled && config.approval.tools.length > 0 && !options.bypassApproval) {
        const { wrapToolSetWithApproval } = await import('../runtime/approval.js');
        toolSet = wrapToolSetWithApproval(toolSet, {
          enabled: config.approval.enabled,
          mode: config.approval.mode,
          tools: config.approval.tools,
        });
      }
      if (options.wrapToolSet) {
        toolSet = options.wrapToolSet(toolSet as Record<string, unknown>) as AIToolSet;
      }
      const toolCount = Object.keys(toolSet).length;

      booted = true;

      log.info(
        `Booted "${config.agent.name}" | ` +
        `${ctx.budget.loaded_files.length} files loaded | ` +
        `~${ctx.budget.used_tokens} tokens used | ` +
        `${ctx.budget.remaining} remaining` +
        (toolCount > 0 ? ` | ${toolCount} tools` : ''),
      );

      for (const warning of ctx.warnings) {
        log.warn(warning);
      }

      // Lifecycle: onStateChange
      if (previousMode !== 'active' && hooks.onStateChange) {
        await hooks.onStateChange({ agent, previous: previousMode, current: 'active' });
      }

      // Record boot in health metrics
      try { recordBoot(dir); } catch { /* best-effort */ }

      // Lifecycle: onBoot
      if (hooks.onBoot) {
        await hooks.onBoot({ agent, config, state });
      }
    },

    async run(prompt: string): Promise<AgentRunResult> {
      if (!booted) await agent.boot();

      // Check guardrails (rate limits + budget) before LLM call
      const guard = checkGuardrails(dir, config);
      if (!guard.allowed) {
        const error = new Error(`Guardrail blocked: ${guard.reason}`);
        try { recordFailure(dir, error.message); } catch { /* best-effort */ }
        if (hooks.onError) {
          try { await hooks.onError({ agent, error, prompt }); } catch { /* best-effort */ }
        }
        throw error;
      }

      const sessionId = createSessionId();
      const started = new Date().toISOString();

      const hasTools = Object.keys(toolSet).length > 0;
      const reflectionCfg = config.reflection;
      const prepareStep = reflectionCfg && reflectionCfg.strategy !== 'none'
        ? (await import('../runtime/reflection.js')).createReflectionPrepareStep(systemPrompt, reflectionCfg)
        : undefined;
      let result;
      try {
        result = await generate({
          model,
          system: systemPrompt,
          prompt,
          maxRetries: config.model.max_retries,
          timeoutMs: config.model.timeout_ms,
          ...(hasTools ? { tools: toolSet, maxToolSteps: options.toolExecutor?.maxToolCalls ?? 25, ...(options.activeTools ? { activeTools: options.activeTools } : {}) } : {}),
          ...(prepareStep ? { prepareStep } : {}),
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        try { recordFailure(dir, error.message); } catch { /* best-effort */ }
        if (hooks.onError) {
          try { await hooks.onError({ agent, error, prompt }); } catch { /* best-effort */ }
        }
        throw error;
      }

      const ended = new Date().toISOString();

      let finalText = result.text;
      try {
        const filtered = await applyContentFilters(config, result.text);
        finalText = filtered.text;
        if (filtered.blocked) {
          log.info(`Content filter redacted/blocked output for session ${sessionId}: ${filtered.results.filter((r) => !r.passed).map((r) => r.name).join(', ')}`);
        }
      } catch (err) {
        try { recordFailure(dir, err instanceof Error ? err.message : String(err)); } catch { /* best-effort */ }
        if (hooks.onError) {
          try { await hooks.onError({ agent, error: err instanceof Error ? err : new Error(String(err)), prompt }); } catch { /* best-effort */ }
        }
        throw err;
      }

      // Write session record
      const session: SessionRecord = {
        id: sessionId,
        started,
        ended,
        prompt,
        summary: finalText.slice(0, 200),
        tokens_used: result.usage.totalTokens,
        steps: result.steps,
        model_id: config.model.id,
        tool_calls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
      };

      // Post-LLM recording — wrapped in try-catch so telemetry failures
      // never mask a successful LLM result
      try {
        writeSession(dir, session);
      } catch (err) {
        log.warn(`Failed to write session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }

      try {
        recordCost(dir, {
          model_id: config.model.id,
          provider: config.model.provider ?? 'openrouter',
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
          source: `run:${sessionId}`,
        });
      } catch (err) {
        log.warn(`Failed to record cost: ${err instanceof Error ? err.message : String(err)}`);
      }

      try {
        recordSuccess(dir);
      } catch (err) {
        log.warn(`Failed to record health: ${err instanceof Error ? err.message : String(err)}`);
      }

      try {
        state.last_interaction = ended;
        saveState(dir, state);
      } catch (err) {
        log.warn(`Failed to save state: ${err instanceof Error ? err.message : String(err)}`);
      }

      const runResult: AgentRunResult = {
        text: finalText,
        usage: result.usage,
        session_id: sessionId,
        steps: result.steps,
        toolCalls: result.toolCalls,
      };

      // Lifecycle: onSessionEnd — wrapped so hook errors don't lose the result
      if (hooks.onSessionEnd) {
        try {
          await hooks.onSessionEnd({ agent, sessionId, prompt, result: runResult });
        } catch (err) {
          log.warn(`onSessionEnd hook error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return runResult;
    },

    stream(prompt: string): AgentStreamResult {
      const sessionId = createSessionId();

      // Deferred result — resolves after stream is fully consumed and recording completes
      let resolveResult: (r: AgentRunResult) => void;
      let rejectResult: (e: Error) => void;
      const resultPromise = new Promise<AgentRunResult>((res, rej) => {
        resolveResult = res;
        rejectResult = rej;
      });
      // Prevent unhandled rejection when error propagates via the generator throw path
      // and consumer doesn't explicitly await .result
      resultPromise.catch(() => {});

      async function* generateStream(): AsyncIterable<string> {
        if (!booted) await agent.boot();

        // Check guardrails (rate limits + budget) before LLM call
        const guard = checkGuardrails(dir, config);
        if (!guard.allowed) {
          const error = new Error(`Guardrail blocked: ${guard.reason}`);
          try { recordFailure(dir, error.message); } catch { /* best-effort */ }
          if (hooks.onError) {
            try { await hooks.onError({ agent, error, prompt }); } catch { /* best-effort */ }
          }
          rejectResult(error);
          throw error;
        }

        const started = new Date().toISOString();
        let fullText = '';

        const hasTools = Object.keys(toolSet).length > 0;
        const reflectionCfg = config.reflection;
        const prepareStep = reflectionCfg && reflectionCfg.strategy !== 'none'
          ? (await import('../runtime/reflection.js')).createReflectionPrepareStep(systemPrompt, reflectionCfg)
          : undefined;

        let streamResult;
        try {
          streamResult = streamGenerateWithDetails({
            model,
            system: systemPrompt,
            prompt,
            maxRetries: config.model.max_retries,
            timeoutMs: config.model.timeout_ms,
            ...(hasTools ? { tools: toolSet, maxToolSteps: options.toolExecutor?.maxToolCalls ?? 25, ...(options.activeTools ? { activeTools: options.activeTools } : {}) } : {}),
            ...(prepareStep ? { prepareStep } : {}),
          });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          try { recordFailure(dir, error.message); } catch { /* best-effort */ }
          if (hooks.onError) {
            try { await hooks.onError({ agent, error, prompt }); } catch { /* best-effort */ }
          }
          rejectResult(error);
          throw error;
        }

        try {
          for await (const chunk of streamResult.textStream) {
            fullText += chunk;
            yield chunk;
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          try { recordFailure(dir, error.message); } catch { /* best-effort */ }
          if (hooks.onError) {
            try { await hooks.onError({ agent, error, prompt }); } catch { /* best-effort */ }
          }
          rejectResult(error);
          throw error;
        }

        // Await post-stream metadata — wrapped so failures don't crash the generator
        let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        let steps = 1;
        let toolCalls: Array<{ toolName: string; args: Record<string, unknown>; result: unknown }> = [];
        try {
          [usage, steps, toolCalls] = await Promise.all([
            streamResult.usage,
            streamResult.steps,
            streamResult.toolCalls,
          ]);
        } catch (err) {
          log.warn(`Failed to resolve post-stream metadata: ${err instanceof Error ? err.message : String(err)}`);
        }

        const ended = new Date().toISOString();

        let finalText = fullText;
        try {
          const filtered = await applyContentFilters(config, fullText);
          finalText = filtered.text;
          if (filtered.blocked) {
            log.info(`Content filter redacted/blocked output for session ${sessionId}: ${filtered.results.filter((r) => !r.passed).map((r) => r.name).join(', ')}`);
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          try { recordFailure(dir, error.message); } catch { /* best-effort */ }
          if (hooks.onError) {
            try { await hooks.onError({ agent, error, prompt }); } catch { /* best-effort */ }
          }
          rejectResult(error);
          throw error;
        }

        const session: SessionRecord = {
          id: sessionId,
          started,
          ended,
          prompt,
          summary: finalText.slice(0, 200),
          tokens_used: usage.totalTokens,
          steps,
          model_id: config.model.id,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        };

        // Post-stream recording — wrapped so telemetry failures don't break the caller
        try {
          writeSession(dir, session);
        } catch (err) {
          log.warn(`Failed to write session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
        }

        try {
          recordCost(dir, {
            model_id: config.model.id,
            provider: config.model.provider ?? 'openrouter',
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            source: `stream:${sessionId}`,
          });
        } catch (err) {
          log.warn(`Failed to record cost: ${err instanceof Error ? err.message : String(err)}`);
        }

        try {
          recordSuccess(dir);
        } catch (err) {
          log.warn(`Failed to record health: ${err instanceof Error ? err.message : String(err)}`);
        }

        try {
          state.last_interaction = ended;
          saveState(dir, state);
        } catch (err) {
          log.warn(`Failed to save state: ${err instanceof Error ? err.message : String(err)}`);
        }

        const runResult: AgentRunResult = {
          text: finalText,
          usage,
          session_id: sessionId,
          steps,
          toolCalls,
        };

        // Lifecycle: onSessionEnd
        if (hooks.onSessionEnd) {
          try {
            await hooks.onSessionEnd({ agent, sessionId, prompt, result: runResult });
          } catch (err) {
            log.warn(`onSessionEnd hook error: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        resolveResult(runResult);
      }

      return {
        textStream: generateStream(),
        result: resultPromise,
      };
    },

    async shutdown() {
      if (!booted) return;

      // Lifecycle: onShutdown — wrapped so hook errors don't prevent cleanup
      if (hooks.onShutdown) {
        try {
          await hooks.onShutdown({ agent, state });
        } catch (err) {
          log.warn(`onShutdown hook error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Close MCP server connections
      if (mcpManager) {
        try {
          await mcpManager.close();
        } catch (err) {
          log.warn(`MCP shutdown error: ${err instanceof Error ? err.message : String(err)}`);
        }
        mcpManager = undefined;
      }

      const previousMode = state.mode;
      state.mode = 'idle';
      try {
        saveState(dir, state);
      } catch (err) {
        log.warn(`Failed to save state during shutdown: ${err instanceof Error ? err.message : String(err)}`);
      }
      booted = false;

      // Lifecycle: onStateChange
      if (previousMode !== 'idle' && hooks.onStateChange) {
        try {
          await hooks.onStateChange({ agent, previous: previousMode, current: 'idle' });
        } catch (err) {
          log.warn(`onStateChange hook error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      log.info(`Shutdown "${config.agent.name}"`);
    },

    getSystemPrompt() {
      return systemPrompt || '';
    },

    getState() {
      return state || loadState(dir);
    },
  };

  return agent;
}
