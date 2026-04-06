import { existsSync } from 'fs';
import { resolve } from 'path';
import { loadConfig } from './config.js';
import { log } from './logger.js';
import type {
  CreateHarnessOptions,
  HarnessConfig,
  HarnessAgent,
  AgentRunResult,
  AgentState,
} from './types.js';
import { getModel, generate } from '../llm/provider.js';
import { streamText } from 'ai';
import { buildSystemPrompt } from '../runtime/context-loader.js';
import { loadState, saveState } from '../runtime/state.js';
import { createSessionId, writeSession, type SessionRecord } from '../runtime/sessions.js';

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

  let state: AgentState;
  let systemPrompt: string;
  let booted = false;

  const agent: HarnessAgent = {
    name: config.agent.name,
    config,

    async boot() {
      // Load state
      state = loadState(dir);
      state.mode = 'active';
      state.last_interaction = new Date().toISOString();

      // Build system prompt from harness files
      const ctx = buildSystemPrompt(dir, config);
      systemPrompt = ctx.systemPrompt;

      booted = true;

      log.info(
        `Booted "${config.agent.name}" | ` +
        `${ctx.budget.loaded_files.length} files loaded | ` +
        `~${ctx.budget.used_tokens} tokens used | ` +
        `${ctx.budget.remaining} remaining`
      );
    },

    async run(prompt: string): Promise<AgentRunResult> {
      if (!booted) await agent.boot();

      const sessionId = createSessionId();
      const started = new Date().toISOString();

      const result = await generate({
        model,
        system: systemPrompt,
        prompt,
        maxRetries: config.model.max_retries,
        timeoutMs: config.model.timeout_ms,
      });

      const ended = new Date().toISOString();

      // Write session record
      const session: SessionRecord = {
        id: sessionId,
        started,
        ended,
        prompt,
        summary: result.text.slice(0, 200),
        tokens_used: result.usage.totalTokens,
        steps: 1,
        model_id: config.model.id,
      };

      writeSession(dir, session);

      // Update state
      state.last_interaction = ended;
      saveState(dir, state);

      return {
        text: result.text,
        usage: result.usage,
        session_id: sessionId,
        steps: 1,
      };
    },

    async *stream(prompt: string): AsyncIterable<string> {
      if (!booted) await agent.boot();

      const sessionId = createSessionId();
      const started = new Date().toISOString();
      let fullText = '';

      const result = streamText({
        model,
        system: systemPrompt,
        prompt,
        maxRetries: config.model.max_retries,
        ...(config.model.timeout_ms ? { timeout: config.model.timeout_ms } : {}),
      });

      for await (const chunk of result.textStream) {
        fullText += chunk;
        yield chunk;
      }

      // Await usage after stream completes
      const usage = await Promise.resolve(result.usage);
      const totalTokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);

      const ended = new Date().toISOString();

      const session: SessionRecord = {
        id: sessionId,
        started,
        ended,
        prompt,
        summary: fullText.slice(0, 200),
        tokens_used: totalTokens,
        steps: 1,
        model_id: config.model.id,
      };

      writeSession(dir, session);

      state.last_interaction = ended;
      saveState(dir, state);
    },

    async shutdown() {
      if (!booted) return;

      state.mode = 'idle';
      saveState(dir, state);
      booted = false;

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
