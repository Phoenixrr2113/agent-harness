import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getModel, generateWithMessages, streamWithMessages } from '../llm/provider.js';
import { loadConfig } from '../core/config.js';
import { log } from '../core/logger.js';
import { buildSystemPrompt } from './context-loader.js';
import { estimateTokens } from '../primitives/loader.js';
import { createSessionId, writeSession, type SessionRecord } from './sessions.js';
import { withFileLockSync } from './file-lock.js';
import type { AIToolSet } from './tool-executor.js';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import type { HarnessConfig, ToolCallInfo } from '../core/types.js';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  tokens: number;
}

/** Persisted context format — one JSON object per line */
interface PersistedMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Reserve 50% of remaining context (after system prompt) for conversation history
const CONVERSATION_BUDGET_RATIO = 0.50;
// Minimum messages to always keep (latest exchange)
const MIN_MESSAGES = 2;
// Hard cap on message count regardless of tokens
const MAX_MESSAGES = 100;

export interface ConversationOptions {
  recordSessions?: boolean;
  /** AI SDK tools available during conversation */
  tools?: AIToolSet;
  /** Maximum tool-use roundtrips per message (default: 5) */
  maxToolSteps?: number;
}

export interface ConversationSendResult {
  text: string;
  usage: { totalTokens: number };
  steps: number;
  toolCalls: ToolCallInfo[];
}

export interface ConversationStreamResult {
  /** Async iterable of text chunks — consume with for-await */
  textStream: AsyncIterable<string>;
  /** Resolves after the stream is fully consumed with turn metadata */
  result: Promise<{ text: string; usage: { totalTokens: number }; steps: number; toolCalls: ToolCallInfo[] }>;
}

export class Conversation {
  private messages: Message[] = [];
  private harnessDir: string;
  private apiKey?: string;
  private systemPrompt: string = '';
  private systemPromptTokens: number = 0;
  private maxContextTokens: number = 200000;
  private modelOverride?: string;
  private providerOverride?: string;
  private recordSessions: boolean = true;
  private tools: AIToolSet;
  private maxToolSteps: number;

  constructor(harnessDir: string, apiKey?: string, options?: ConversationOptions) {
    this.harnessDir = harnessDir;
    this.apiKey = apiKey;
    this.tools = options?.tools ?? {};
    this.maxToolSteps = options?.maxToolSteps ?? 5;
    if (options?.recordSessions !== undefined) {
      this.recordSessions = options.recordSessions;
    }
  }

  /** Update the tool set (e.g., after MCP servers connect) */
  setTools(tools: AIToolSet): void {
    this.tools = tools;
  }

  setModelOverride(modelId: string): void {
    if (!modelId || !modelId.trim()) {
      throw new Error('modelId cannot be empty');
    }
    this.modelOverride = modelId.trim();
  }

  setProviderOverride(provider: string): void {
    if (!provider || !provider.trim()) {
      throw new Error('provider cannot be empty');
    }
    this.providerOverride = provider.trim();
  }

  async init(): Promise<void> {
    const config = this.getConfig();
    const ctx = buildSystemPrompt(this.harnessDir, config);
    this.systemPrompt = ctx.systemPrompt;
    this.systemPromptTokens = ctx.budget.used_tokens;
    this.maxContextTokens = config.model.max_tokens;

    // Load persisted context — try JSON-lines first, fall back to legacy markdown
    const jsonlPath = join(this.harnessDir, 'memory', 'context.jsonl');
    const legacyPath = join(this.harnessDir, 'memory', 'context.md');

    if (existsSync(jsonlPath)) {
      const raw = readFileSync(jsonlPath, 'utf-8');
      this.messages = parseJsonlContext(raw);
    } else if (existsSync(legacyPath)) {
      const raw = readFileSync(legacyPath, 'utf-8');
      this.messages = parseLegacyContext(raw);
      // Migrate: save in new format immediately
      this.save();
    }
  }

  private getConfig(): HarnessConfig {
    const config = loadConfig(this.harnessDir);
    if (this.modelOverride || this.providerOverride) {
      return {
        ...config,
        model: {
          ...config.model,
          ...(this.modelOverride ? { id: this.modelOverride } : {}),
          ...(this.providerOverride ? { provider: this.providerOverride } : {}),
        },
      };
    }
    return config;
  }

  /**
   * Token budget available for conversation messages.
   * Allocates CONVERSATION_BUDGET_RATIO of (max_tokens - system_prompt) to messages.
   */
  private getMessageBudget(): number {
    const available = this.maxContextTokens - this.systemPromptTokens;
    return Math.floor(available * CONVERSATION_BUDGET_RATIO);
  }

  /**
   * Trim oldest messages until token budget is satisfied.
   * Always retains at least MIN_MESSAGES.
   */
  private trimToTokenBudget(): void {
    const budget = this.getMessageBudget();

    // Hard cap on count
    while (this.messages.length > MAX_MESSAGES) {
      this.messages.shift();
    }

    // Trim by token budget — drop oldest messages first
    let totalTokens = this.messages.reduce((sum, m) => sum + m.tokens, 0);
    while (totalTokens > budget && this.messages.length > MIN_MESSAGES) {
      const removed = this.messages.shift();
      if (removed) {
        totalTokens -= removed.tokens;
      }
    }
  }

  private toModelMessages(): ModelMessage[] {
    return this.messages.map((m): ModelMessage => ({
      role: m.role,
      content: m.content,
    }));
  }

  async send(userMessage: string): Promise<ConversationSendResult> {
    if (!userMessage || !userMessage.trim()) {
      throw new Error('Message cannot be empty');
    }

    this.messages.push({
      role: 'user',
      content: userMessage,
      tokens: estimateTokens(userMessage),
    });

    this.trimToTokenBudget();

    const config = this.getConfig();
    const model = getModel(config, this.apiKey);

    const started = new Date().toISOString();
    const hasTools = Object.keys(this.tools).length > 0;

    const result = await generateWithMessages({
      model,
      system: this.systemPrompt,
      messages: this.toModelMessages(),
      ...(hasTools ? { tools: this.tools, maxToolSteps: this.maxToolSteps } : {}),
    });

    this.messages.push({
      role: 'assistant',
      content: result.text,
      tokens: estimateTokens(result.text),
    });

    try {
      this.save();
    } catch (err) {
      log.warn(`Failed to save conversation context: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Record session for this chat turn
    if (this.recordSessions) {
      try {
        this.writeSessionRecord(
          config, userMessage, result.text,
          result.usage.totalTokens, started,
          result.steps, result.toolCalls,
        );
      } catch (err) {
        log.warn(`Failed to record chat session: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      text: result.text,
      usage: result.usage,
      steps: result.steps,
      toolCalls: result.toolCalls,
    };
  }

  sendStream(userMessage: string): ConversationStreamResult {
    if (!userMessage || !userMessage.trim()) {
      throw new Error('Message cannot be empty');
    }

    this.messages.push({
      role: 'user',
      content: userMessage,
      tokens: estimateTokens(userMessage),
    });

    this.trimToTokenBudget();

    const config = this.getConfig();
    const model = getModel(config, this.apiKey);
    const started = new Date().toISOString();
    const hasTools = Object.keys(this.tools).length > 0;

    const streamResult = streamWithMessages({
      model,
      system: this.systemPrompt,
      messages: this.toModelMessages(),
      ...(hasTools ? { tools: this.tools, maxToolSteps: this.maxToolSteps } : {}),
    });

    // Deferred result — resolves after stream is fully consumed
    let resolveResult: (r: ConversationStreamResult['result'] extends Promise<infer T> ? T : never) => void;
    const resultPromise = new Promise<ConversationStreamResult['result'] extends Promise<infer T> ? T : never>((res) => {
      resolveResult = res;
    });

    const self = this;

    async function* generateStream(): AsyncIterable<string> {
      let fullResponse = '';

      for await (const chunk of streamResult.textStream) {
        fullResponse += chunk;
        yield chunk;
      }

      self.messages.push({
        role: 'assistant',
        content: fullResponse,
        tokens: estimateTokens(fullResponse),
      });

      try {
        self.save();
      } catch (err) {
        log.warn(`Failed to save conversation context: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Resolve post-stream metadata
      let usageResult = { totalTokens: 0 };
      let stepsResult = 1;
      let toolCallsResult: ToolCallInfo[] = [];
      try {
        [usageResult, stepsResult, toolCallsResult] = await Promise.all([
          streamResult.usage,
          streamResult.steps,
          streamResult.toolCalls,
        ]);
      } catch (err) {
        log.warn(`Failed to resolve stream metadata: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Record session for this chat turn
      if (self.recordSessions) {
        try {
          self.writeSessionRecord(
            config, userMessage, fullResponse,
            usageResult.totalTokens, started,
            stepsResult, toolCallsResult,
          );
        } catch (err) {
          log.warn(`Failed to record chat session: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      resolveResult({
        text: fullResponse,
        usage: usageResult,
        steps: stepsResult,
        toolCalls: toolCallsResult,
      });
    }

    return {
      textStream: generateStream(),
      result: resultPromise,
    };
  }

  save(): void {
    const memoryDir = join(this.harnessDir, 'memory');
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }

    // Write JSON-lines format — one JSON object per line, with file lock
    const jsonlPath = join(memoryDir, 'context.jsonl');
    const lines = this.messages.map((m): string =>
      JSON.stringify({ role: m.role, content: m.content } satisfies PersistedMessage)
    );
    withFileLockSync(this.harnessDir, 'context.jsonl', () => {
      writeFileSync(jsonlPath, lines.join('\n'), 'utf-8');
    });
  }

  clear(): void {
    this.messages = [];
    const jsonlPath = join(this.harnessDir, 'memory', 'context.jsonl');
    const legacyPath = join(this.harnessDir, 'memory', 'context.md');
    if (existsSync(jsonlPath)) {
      writeFileSync(jsonlPath, '', 'utf-8');
    }
    if (existsSync(legacyPath)) {
      writeFileSync(legacyPath, '', 'utf-8');
    }
  }

  private writeSessionRecord(
    config: HarnessConfig,
    prompt: string,
    response: string,
    totalTokens: number,
    started: string,
    steps?: number,
    toolCalls?: ToolCallInfo[],
  ): void {
    const sessionId = createSessionId();
    const ended = new Date().toISOString();

    const session: SessionRecord = {
      id: sessionId,
      started,
      ended,
      prompt: prompt.slice(0, 500),
      summary: response.slice(0, 200),
      tokens_used: totalTokens,
      model_id: config.model.id,
      steps: steps ?? 1,
      tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
    };

    writeSession(this.harnessDir, session);
  }

  getHistory(): Array<{ role: string; content: string }> {
    return this.messages.map((m) => ({ role: m.role, content: m.content }));
  }

  /** Token usage stats for the conversation window */
  getTokenStats(): { messageTokens: number; budget: number; messageCount: number } {
    const messageTokens = this.messages.reduce((sum, m) => sum + m.tokens, 0);
    return {
      messageTokens,
      budget: this.getMessageBudget(),
      messageCount: this.messages.length,
    };
  }
}

/**
 * Parse JSON-lines context format.
 * Each line is a JSON object: { role, content }
 */
function parseJsonlContext(raw: string): Message[] {
  if (!raw.trim()) return [];

  const messages: Message[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as PersistedMessage;
      if (parsed.role && parsed.content) {
        messages.push({
          role: parsed.role,
          content: parsed.content,
          tokens: estimateTokens(parsed.content),
        });
      }
    } catch {
      // Skip malformed lines
    }
  }
  return messages;
}

/**
 * Parse legacy context.md format (### User / ### Assistant sections).
 * Kept for backward compatibility — auto-migrates on first load.
 */
function parseLegacyContext(raw: string): Message[] {
  const messages: Message[] = [];
  const lines = raw.split('\n');
  let currentRole: 'user' | 'assistant' | null = null;
  let currentContent: string[] = [];

  for (const line of lines) {
    if (line.startsWith('### User')) {
      if (currentRole && currentContent.length > 0) {
        const content = currentContent.join('\n').trim();
        messages.push({ role: currentRole, content, tokens: estimateTokens(content) });
      }
      currentRole = 'user';
      currentContent = [];
    } else if (line.startsWith('### Assistant')) {
      if (currentRole && currentContent.length > 0) {
        const content = currentContent.join('\n').trim();
        messages.push({ role: currentRole, content, tokens: estimateTokens(content) });
      }
      currentRole = 'assistant';
      currentContent = [];
    } else if (currentRole) {
      currentContent.push(line);
    }
  }
  if (currentRole && currentContent.length > 0) {
    const content = currentContent.join('\n').trim();
    messages.push({ role: currentRole, content, tokens: estimateTokens(content) });
  }

  return messages;
}

// Export parsers for testing
export { parseJsonlContext, parseLegacyContext };
