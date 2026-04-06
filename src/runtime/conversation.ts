import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getModel, generateWithMessages, streamWithMessages } from '../llm/provider.js';
import { loadConfig } from '../core/config.js';
import { buildSystemPrompt } from './context-loader.js';
import { estimateTokens } from '../primitives/loader.js';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import type { HarnessConfig } from '../core/types.js';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  tokens: number;
}

// Reserve 50% of remaining context (after system prompt) for conversation history
const CONVERSATION_BUDGET_RATIO = 0.50;
// Minimum messages to always keep (latest exchange)
const MIN_MESSAGES = 2;
// Hard cap on message count regardless of tokens
const MAX_MESSAGES = 100;

export class Conversation {
  private messages: Message[] = [];
  private harnessDir: string;
  private apiKey?: string;
  private systemPrompt: string = '';
  private systemPromptTokens: number = 0;
  private maxContextTokens: number = 200000;
  private modelOverride?: string;

  constructor(harnessDir: string, apiKey?: string) {
    this.harnessDir = harnessDir;
    this.apiKey = apiKey;
  }

  setModelOverride(modelId: string): void {
    this.modelOverride = modelId;
  }

  async init(): Promise<void> {
    const config = this.getConfig();
    const ctx = buildSystemPrompt(this.harnessDir, config);
    this.systemPrompt = ctx.systemPrompt;
    this.systemPromptTokens = ctx.budget.used_tokens;
    this.maxContextTokens = config.model.max_tokens;

    // Load persisted context if exists
    const contextPath = join(this.harnessDir, 'memory', 'context.md');
    if (existsSync(contextPath)) {
      const raw = readFileSync(contextPath, 'utf-8');
      this.messages = parseContextMd(raw);
    }
  }

  private getConfig(): HarnessConfig {
    const config = loadConfig(this.harnessDir);
    if (this.modelOverride) {
      return {
        ...config,
        model: { ...config.model, id: this.modelOverride },
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

  async send(userMessage: string): Promise<string> {
    this.messages.push({
      role: 'user',
      content: userMessage,
      tokens: estimateTokens(userMessage),
    });

    this.trimToTokenBudget();

    const config = this.getConfig();
    const model = getModel(config, this.apiKey);

    const result = await generateWithMessages({
      model,
      system: this.systemPrompt,
      messages: this.toModelMessages(),
    });

    this.messages.push({
      role: 'assistant',
      content: result.text,
      tokens: estimateTokens(result.text),
    });
    this.save();

    return result.text;
  }

  async *sendStream(userMessage: string): AsyncIterable<string> {
    this.messages.push({
      role: 'user',
      content: userMessage,
      tokens: estimateTokens(userMessage),
    });

    this.trimToTokenBudget();

    const config = this.getConfig();
    const model = getModel(config, this.apiKey);

    const { textStream } = streamWithMessages({
      model,
      system: this.systemPrompt,
      messages: this.toModelMessages(),
    });

    let fullResponse = '';

    for await (const chunk of textStream) {
      fullResponse += chunk;
      yield chunk;
    }

    this.messages.push({
      role: 'assistant',
      content: fullResponse,
      tokens: estimateTokens(fullResponse),
    });
    this.save();
  }

  save(): void {
    const contextPath = join(this.harnessDir, 'memory', 'context.md');
    const memoryDir = join(this.harnessDir, 'memory');
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }

    const lines = ['# Conversation Context', ''];
    for (const msg of this.messages) {
      lines.push(`### ${msg.role === 'user' ? 'User' : 'Assistant'}`);
      lines.push(msg.content);
      lines.push('');
    }

    writeFileSync(contextPath, lines.join('\n'), 'utf-8');
  }

  clear(): void {
    this.messages = [];
    const contextPath = join(this.harnessDir, 'memory', 'context.md');
    if (existsSync(contextPath)) {
      writeFileSync(contextPath, '', 'utf-8');
    }
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
 * Parse context.md back into Message array.
 * Format: ### User / ### Assistant sections.
 */
function parseContextMd(raw: string): Message[] {
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
