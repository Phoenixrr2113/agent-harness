import { existsSync } from 'fs';
import { resolve } from 'path';
import { loadConfig } from './config.js';
import type {
  CreateHarnessOptions,
  HarnessConfig,
  HarnessAgent,
  AgentRunResult,
  AgentState,
} from './types.js';
import { getModel, generate, streamGenerate } from '../llm/provider.js';
import { buildSystemPrompt } from '../runtime/context-loader.js';
import { loadState, saveState } from '../runtime/state.js';
import { createSessionId, writeSession, type SessionRecord } from '../runtime/sessions.js';

export function createHarness(options: CreateHarnessOptions): HarnessAgent {
  const dir = resolve(options.dir);

  if (!existsSync(dir)) {
    throw new Error(`Harness directory not found: ${dir}`);
  }

  const config = loadConfig(dir, options.config);
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

      // Log boot info
      console.error(
        `[harness] Booted "${config.agent.name}" | ` +
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

      for await (const chunk of streamGenerate({
        model,
        system: systemPrompt,
        prompt,
      })) {
        fullText += chunk;
        yield chunk;
      }

      const ended = new Date().toISOString();

      // Write session
      const session: SessionRecord = {
        id: sessionId,
        started,
        ended,
        prompt,
        summary: fullText.slice(0, 200),
        tokens_used: 0, // Not available in streaming
        steps: 1,
      };

      writeSession(dir, session);

      // Update state
      state.last_interaction = ended;
      saveState(dir, state);
    },

    async shutdown() {
      if (!booted) return;

      state.mode = 'idle';
      saveState(dir, state);
      booted = false;

      console.error(`[harness] Shutdown "${config.agent.name}"`);
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
