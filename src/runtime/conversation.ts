import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getModel, generateWithMessages, streamWithMessages } from '../llm/provider.js';
import { loadConfig } from '../core/config.js';
import { buildSystemPrompt } from './context-loader.js';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import type { HarnessConfig } from '../core/types.js';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export class Conversation {
  private messages: Message[] = [];
  private harnessDir: string;
  private apiKey?: string;
  private systemPrompt: string = '';
  private maxHistory: number;
  private modelOverride?: string;

  constructor(harnessDir: string, apiKey?: string, maxHistory: number = 20) {
    this.harnessDir = harnessDir;
    this.apiKey = apiKey;
    this.maxHistory = maxHistory;
  }

  setModelOverride(modelId: string): void {
    this.modelOverride = modelId;
  }

  async init(): Promise<void> {
    const config = this.getConfig();
    const ctx = buildSystemPrompt(this.harnessDir, config);
    this.systemPrompt = ctx.systemPrompt;

    // Load persisted context if exists
    const contextPath = join(this.harnessDir, 'memory', 'context.md');
    if (existsSync(contextPath)) {
      const raw = readFileSync(contextPath, 'utf-8');
      const lines = raw.split('\n');
      let currentRole: 'user' | 'assistant' | null = null;
      let currentContent: string[] = [];

      for (const line of lines) {
        if (line.startsWith('### User')) {
          if (currentRole && currentContent.length > 0) {
            this.messages.push({ role: currentRole, content: currentContent.join('\n').trim() });
          }
          currentRole = 'user';
          currentContent = [];
        } else if (line.startsWith('### Assistant')) {
          if (currentRole && currentContent.length > 0) {
            this.messages.push({ role: currentRole, content: currentContent.join('\n').trim() });
          }
          currentRole = 'assistant';
          currentContent = [];
        } else if (currentRole) {
          currentContent.push(line);
        }
      }
      if (currentRole && currentContent.length > 0) {
        this.messages.push({ role: currentRole, content: currentContent.join('\n').trim() });
      }
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

  private toModelMessages(): ModelMessage[] {
    return this.messages.map((m): ModelMessage => ({
      role: m.role,
      content: m.content,
    }));
  }

  async send(userMessage: string): Promise<string> {
    this.messages.push({ role: 'user', content: userMessage });

    // Trim to maxHistory
    while (this.messages.length > this.maxHistory) {
      this.messages.shift();
    }

    const config = this.getConfig();
    const model = getModel(config, this.apiKey);

    const result = await generateWithMessages({
      model,
      system: this.systemPrompt,
      messages: this.toModelMessages(),
    });

    this.messages.push({ role: 'assistant', content: result.text });
    this.save();

    return result.text;
  }

  async *sendStream(userMessage: string): AsyncIterable<string> {
    this.messages.push({ role: 'user', content: userMessage });

    while (this.messages.length > this.maxHistory) {
      this.messages.shift();
    }

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

    this.messages.push({ role: 'assistant', content: fullResponse });
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

  getHistory(): Message[] {
    return [...this.messages];
  }
}
