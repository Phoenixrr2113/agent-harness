import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../src/llm/provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm/provider.js')>();
  const { MockLanguageModelV3 } = await import('ai/test');
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: 'Mock response from the agent.' }],
      finishReason: { type: 'stop' as const },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 50, text: 50, reasoning: undefined },
      },
    }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'text-start' as const, id: '1' });
          controller.enqueue({ type: 'text-delta' as const, id: '1', delta: 'Streamed chat.' });
          controller.enqueue({ type: 'text-end' as const, id: '1' });
          controller.enqueue({
            type: 'finish' as const,
            usage: {
              inputTokens: { total: 60, noCache: 60, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 20, text: 20, reasoning: undefined },
            },
            finishReason: { type: 'stop' as const },
          });
          controller.close();
        },
      }),
    }),
  });
  return {
    ...actual,
    getModel: vi.fn().mockReturnValue(model),
  };
});

import { parseJsonlContext, parseLegacyContext, isSkillContent, Conversation } from '../src/runtime/conversation.js';
import { estimateTokens } from '../src/primitives/loader.js';
import { tool } from 'ai';
import { z } from 'zod';

describe('conversation persistence', () => {
  describe('parseJsonlContext', () => {
    it('should parse valid JSON-lines', () => {
      const raw = [
        '{"role":"user","content":"Hello"}',
        '{"role":"assistant","content":"Hi there"}',
      ].join('\n');

      const messages = parseJsonlContext(raw);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('Hello');
      expect(messages[0].tokens).toBe(estimateTokens('Hello'));
      expect(messages[1].role).toBe('assistant');
      expect(messages[1].content).toBe('Hi there');
    });

    it('should return empty array for empty string', () => {
      expect(parseJsonlContext('')).toEqual([]);
      expect(parseJsonlContext('  \n  ')).toEqual([]);
    });

    it('should skip malformed lines', () => {
      const raw = [
        '{"role":"user","content":"Hello"}',
        'not-json',
        '{"role":"assistant","content":"Reply"}',
      ].join('\n');

      const messages = parseJsonlContext(raw);
      expect(messages).toHaveLength(2);
    });

    it('should skip lines missing required fields', () => {
      const raw = [
        '{"role":"user","content":"Hello"}',
        '{"role":"user"}',
        '{"content":"no role"}',
        '{}',
      ].join('\n');

      const messages = parseJsonlContext(raw);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Hello');
    });

    it('should handle content with newlines (escaped in JSON)', () => {
      const raw = '{"role":"user","content":"Line 1\\nLine 2\\nLine 3"}';
      const messages = parseJsonlContext(raw);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Line 1\nLine 2\nLine 3');
    });

    it('should skip blank lines between entries', () => {
      const raw = [
        '{"role":"user","content":"A"}',
        '',
        '{"role":"assistant","content":"B"}',
        '',
      ].join('\n');

      const messages = parseJsonlContext(raw);
      expect(messages).toHaveLength(2);
    });
  });

  describe('parseLegacyContext', () => {
    it('should parse legacy ### User / ### Assistant format', () => {
      const raw = [
        '# Conversation Context',
        '',
        '### User',
        'Hello there',
        '',
        '### Assistant',
        'Hi! How can I help?',
        '',
      ].join('\n');

      const messages = parseLegacyContext(raw);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('Hello there');
      expect(messages[1].role).toBe('assistant');
      expect(messages[1].content).toBe('Hi! How can I help?');
    });

    it('should handle multi-line content in legacy format', () => {
      const raw = [
        '### User',
        'Line 1',
        'Line 2',
        'Line 3',
        '',
        '### Assistant',
        'Response line 1',
        'Response line 2',
        '',
      ].join('\n');

      const messages = parseLegacyContext(raw);
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('Line 1\nLine 2\nLine 3');
      expect(messages[1].content).toBe('Response line 1\nResponse line 2');
    });

    it('should return empty array for empty content', () => {
      expect(parseLegacyContext('')).toEqual([]);
      expect(parseLegacyContext('# Conversation Context\n')).toEqual([]);
    });
  });
});

describe('Conversation class', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'conv-test-'));
    mkdirSync(join(testDir, 'memory'), { recursive: true });
    mkdirSync(join(testDir, 'rules'), { recursive: true });
    mkdirSync(join(testDir, 'instincts'), { recursive: true });
    mkdirSync(join(testDir, 'skills'), { recursive: true });
    mkdirSync(join(testDir, 'memory', 'sessions'), { recursive: true });

    // Minimal config
    writeFileSync(
      join(testDir, 'config.yaml'),
      `agent:
  name: test-agent
model:
  id: test/model
  max_tokens: 200000
`
    );

    writeFileSync(join(testDir, 'CORE.md'), '# Test Agent\n\nI am a test.\n');
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('save and load (JSON-lines)', () => {
    it('should save context in JSON-lines format', async () => {
      const conv = new Conversation(testDir, undefined, { recordSessions: false });
      await conv.init();

      // Manually push messages and save (since send() requires LLM)
      const history = (conv as unknown as { messages: Array<{ role: string; content: string; tokens: number }> }).messages;
      history.push(
        { role: 'user', content: 'Hello', tokens: estimateTokens('Hello') },
        { role: 'assistant', content: 'Hi there!', tokens: estimateTokens('Hi there!') },
      );
      conv.save();

      const jsonlPath = join(testDir, 'memory', 'context.jsonl');
      expect(existsSync(jsonlPath)).toBe(true);

      const raw = readFileSync(jsonlPath, 'utf-8');
      const lines = raw.split('\n');
      expect(lines).toHaveLength(2);

      const first = JSON.parse(lines[0]);
      expect(first).toEqual({ role: 'user', content: 'Hello' });
      const second = JSON.parse(lines[1]);
      expect(second).toEqual({ role: 'assistant', content: 'Hi there!' });
    });

    it('should load context from JSON-lines on init', async () => {
      // Write JSON-lines context file
      const jsonlPath = join(testDir, 'memory', 'context.jsonl');
      const lines = [
        JSON.stringify({ role: 'user', content: 'Previous message' }),
        JSON.stringify({ role: 'assistant', content: 'Previous reply' }),
      ];
      writeFileSync(jsonlPath, lines.join('\n'), 'utf-8');

      const conv = new Conversation(testDir, undefined, { recordSessions: false });
      await conv.init();

      const history = conv.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({ role: 'user', content: 'Previous message' });
      expect(history[1]).toEqual({ role: 'assistant', content: 'Previous reply' });
    });

    it('should migrate legacy context.md to JSON-lines on load', async () => {
      // Write legacy markdown context
      const legacyPath = join(testDir, 'memory', 'context.md');
      writeFileSync(legacyPath, [
        '# Conversation Context',
        '',
        '### User',
        'Old message',
        '',
        '### Assistant',
        'Old reply',
        '',
      ].join('\n'), 'utf-8');

      const conv = new Conversation(testDir, undefined, { recordSessions: false });
      await conv.init();

      // Should have loaded legacy content
      const history = conv.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0].content).toBe('Old message');
      expect(history[1].content).toBe('Old reply');

      // Should have created JSON-lines file (auto-migration)
      const jsonlPath = join(testDir, 'memory', 'context.jsonl');
      expect(existsSync(jsonlPath)).toBe(true);

      const raw = readFileSync(jsonlPath, 'utf-8');
      const parsed = raw.split('\n').map((l) => JSON.parse(l));
      expect(parsed[0]).toEqual({ role: 'user', content: 'Old message' });
      expect(parsed[1]).toEqual({ role: 'assistant', content: 'Old reply' });
    });

    it('should prefer JSON-lines over legacy when both exist', async () => {
      // Write both files with different content
      const jsonlPath = join(testDir, 'memory', 'context.jsonl');
      writeFileSync(jsonlPath, JSON.stringify({ role: 'user', content: 'jsonl message' }), 'utf-8');

      const legacyPath = join(testDir, 'memory', 'context.md');
      writeFileSync(legacyPath, '### User\nlegacy message\n', 'utf-8');

      const conv = new Conversation(testDir, undefined, { recordSessions: false });
      await conv.init();

      const history = conv.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].content).toBe('jsonl message');
    });
  });

  describe('clear', () => {
    it('should clear both JSON-lines and legacy files', async () => {
      const jsonlPath = join(testDir, 'memory', 'context.jsonl');
      const legacyPath = join(testDir, 'memory', 'context.md');
      writeFileSync(jsonlPath, '{"role":"user","content":"test"}', 'utf-8');
      writeFileSync(legacyPath, '### User\ntest\n', 'utf-8');

      const conv = new Conversation(testDir, undefined, { recordSessions: false });
      await conv.init();
      conv.clear();

      expect(readFileSync(jsonlPath, 'utf-8')).toBe('');
      expect(readFileSync(legacyPath, 'utf-8')).toBe('');
      expect(conv.getHistory()).toEqual([]);
    });
  });

  describe('constructor options', () => {
    it('should accept recordSessions option', () => {
      const conv1 = new Conversation(testDir);
      const conv2 = new Conversation(testDir, undefined, { recordSessions: false });
      // Just verify construction doesn't throw
      expect(conv1).toBeInstanceOf(Conversation);
      expect(conv2).toBeInstanceOf(Conversation);
    });

    it('should accept tools option', () => {
      const myTool = tool({
        description: 'Test tool',
        parameters: z.object({ input: z.string() }),
        execute: async ({ input }) => `result: ${input}`,
      });

      const conv = new Conversation(testDir, undefined, {
        tools: { myTool },
        maxToolSteps: 3,
      });
      expect(conv).toBeInstanceOf(Conversation);
    });

    it('should accept tools via setTools()', async () => {
      const conv = new Conversation(testDir, undefined, { recordSessions: false });
      await conv.init();

      const myTool = tool({
        description: 'Test tool',
        parameters: z.object({ input: z.string() }),
        execute: async ({ input }) => `result: ${input}`,
      });

      // setTools should not throw
      conv.setTools({ myTool });
      expect(conv).toBeInstanceOf(Conversation);
    });
  });

  describe('token stats', () => {
    it('should report accurate token stats after loading messages', async () => {
      const jsonlPath = join(testDir, 'memory', 'context.jsonl');
      const lines = [
        JSON.stringify({ role: 'user', content: 'Hello world' }),
        JSON.stringify({ role: 'assistant', content: 'Greetings!' }),
      ];
      writeFileSync(jsonlPath, lines.join('\n'), 'utf-8');

      const conv = new Conversation(testDir, undefined, { recordSessions: false });
      await conv.init();

      const stats = conv.getTokenStats();
      expect(stats.messageCount).toBe(2);
      expect(stats.messageTokens).toBe(
        estimateTokens('Hello world') + estimateTokens('Greetings!')
      );
      expect(stats.budget).toBeGreaterThan(0);
    });
  });

  describe('sendStream', () => {
    it('should stream text chunks and resolve result with metadata', async () => {
      const conv = new Conversation(testDir, undefined, { recordSessions: false });
      await conv.init();

      const streamResult = conv.sendStream('Stream hello');

      let fullText = '';
      for await (const chunk of streamResult.textStream) {
        fullText += chunk;
      }

      expect(fullText).toBe('Streamed chat.');

      const result = await streamResult.result;
      expect(result.text).toBe('Streamed chat.');
      expect(result.steps).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(result.toolCalls)).toBe(true);
    });

    it('should add streamed response to conversation history', async () => {
      const conv = new Conversation(testDir, undefined, { recordSessions: false });
      await conv.init();

      const streamResult = conv.sendStream('Hi there');
      for await (const _chunk of streamResult.textStream) {
        // consume
      }
      await streamResult.result;

      const history = conv.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({ role: 'user', content: 'Hi there' });
      expect(history[1]).toEqual({ role: 'assistant', content: 'Streamed chat.' });
    });

    it('should record session after stream consumed', async () => {
      const conv = new Conversation(testDir);
      await conv.init();

      const streamResult = conv.sendStream('Record me');
      for await (const _chunk of streamResult.textStream) {
        // consume
      }
      await streamResult.result;

      const sessionsDir = join(testDir, 'memory', 'sessions');
      const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.md'));
      expect(files.length).toBe(1);
    });
  });

  describe('send', () => {
    it('should return ConversationSendResult with text, usage, steps, and toolCalls', async () => {
      const conv = new Conversation(testDir, undefined, { recordSessions: false });
      await conv.init();

      const result = await conv.send('Hello agent');
      expect(result.text).toBe('Mock response from the agent.');
      expect(result.usage).toBeDefined();
      expect(result.usage.totalTokens).toBeGreaterThan(0);
      expect(result.steps).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(result.toolCalls)).toBe(true);
    });

    it('should add user and assistant messages to history', async () => {
      const conv = new Conversation(testDir, undefined, { recordSessions: false });
      await conv.init();

      await conv.send('First message');
      const history = conv.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({ role: 'user', content: 'First message' });
      expect(history[1]).toEqual({ role: 'assistant', content: 'Mock response from the agent.' });
    });

    it('should persist context to disk after send', async () => {
      const conv = new Conversation(testDir, undefined, { recordSessions: false });
      await conv.init();

      await conv.send('Persist me');

      const jsonlPath = join(testDir, 'memory', 'context.jsonl');
      expect(existsSync(jsonlPath)).toBe(true);
      const raw = readFileSync(jsonlPath, 'utf-8');
      const lines = raw.split('\n').filter(Boolean);
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual({ role: 'user', content: 'Persist me' });
      expect(JSON.parse(lines[1])).toEqual({ role: 'assistant', content: 'Mock response from the agent.' });
    });

    it('should record a session when recordSessions is true', async () => {
      const conv = new Conversation(testDir);
      await conv.init();

      await conv.send('Session test');

      const sessionsDir = join(testDir, 'memory', 'sessions');
      const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.md'));
      expect(files.length).toBe(1);

      const sessionContent = readFileSync(join(sessionsDir, files[0]), 'utf-8');
      expect(sessionContent).toContain('Session test');
    });

    it('should accumulate multiple exchanges in history', async () => {
      const conv = new Conversation(testDir, undefined, { recordSessions: false });
      await conv.init();

      await conv.send('Message 1');
      await conv.send('Message 2');

      const history = conv.getHistory();
      expect(history).toHaveLength(4);
      expect(history[0].content).toBe('Message 1');
      expect(history[1].content).toBe('Mock response from the agent.');
      expect(history[2].content).toBe('Message 2');
      expect(history[3].content).toBe('Mock response from the agent.');
    });
  });

  describe('input validation', () => {
    it('send() should reject empty messages', async () => {
      const conv = new Conversation(testDir, undefined, { recordSessions: false });
      await conv.init();

      await expect(conv.send('')).rejects.toThrow('Message cannot be empty');
      await expect(conv.send('   ')).rejects.toThrow('Message cannot be empty');
    });

    it('sendStream() should reject empty messages', async () => {
      const conv = new Conversation(testDir, undefined, { recordSessions: false });
      await conv.init();

      expect(() => conv.sendStream('')).toThrow('Message cannot be empty');
      expect(() => conv.sendStream('  \n  ')).toThrow('Message cannot be empty');
    });

    it('setModelOverride should reject empty strings', () => {
      const conv = new Conversation(testDir, undefined, { recordSessions: false });
      expect(() => conv.setModelOverride('')).toThrow('modelId cannot be empty');
      expect(() => conv.setModelOverride('  ')).toThrow('modelId cannot be empty');
    });

    it('setProviderOverride should reject empty strings', () => {
      const conv = new Conversation(testDir, undefined, { recordSessions: false });
      expect(() => conv.setProviderOverride('')).toThrow('provider cannot be empty');
    });
  });

  describe('skill content compaction protection', () => {
    it('isSkillContent returns true for messages containing <skill_content', () => {
      expect(isSkillContent({ content: '<skill_content name="research">\n# Research\nBody.\n</skill_content>' })).toBe(true);
      expect(isSkillContent({ content: 'prefix <skill_content name="x">...</skill_content> suffix' })).toBe(true);
    });

    it('isSkillContent returns false for ordinary messages', () => {
      expect(isSkillContent({ content: 'Hello there' })).toBe(false);
      expect(isSkillContent({ content: '' })).toBe(false);
      expect(isSkillContent({ content: 'skill_content without angle bracket' })).toBe(false);
    });

    it('does not drop messages containing <skill_content during token budget trim', async () => {
      const conv = new Conversation(testDir, undefined, { recordSessions: false });
      await conv.init();

      const history = (conv as unknown as { messages: Array<{ role: 'user' | 'assistant'; content: string; tokens: number }> }).messages;

      // Fill with old messages that will exceed budget
      const skillMsg = '<skill_content name="research">\n# Research\nBody.\n</skill_content>';
      history.push(
        { role: 'user', content: 'old request', tokens: 10 },
        { role: 'assistant', content: skillMsg, tokens: 50 },
        { role: 'user', content: 'newer request', tokens: 10 },
      );

      // Access private method via cast to exercise the protection
      const trimMethod = (conv as unknown as { trimToTokenBudget(): void }).trimToTokenBudget.bind(conv);

      // Override budget to a very tight value so trimming is forced
      const getBudget = (conv as unknown as { getMessageBudget(): number }).getMessageBudget.bind(conv);
      const originalGetBudget = getBudget;
      (conv as unknown as { getMessageBudget(): number }).getMessageBudget = () => 15;

      trimMethod();

      // Restore
      (conv as unknown as { getMessageBudget(): number }).getMessageBudget = originalGetBudget;

      const remaining = conv.getHistory();
      expect(remaining.some((m) => m.content.includes('<skill_content'))).toBe(true);
    });
  });

  describe('save resilience', () => {
    it('send() should return response even if context save fails', async () => {
      const { chmodSync } = await import('fs');
      const conv = new Conversation(testDir, undefined, { recordSessions: false });
      await conv.init();

      // Make memory dir read-only after init so save() fails
      chmodSync(join(testDir, 'memory'), 0o444);

      try {
        const response = await conv.send('Hello');
        // Response should still be returned despite save failure
        expect(response.text).toBe('Mock response from the agent.');
        expect(response.usage.totalTokens).toBeGreaterThan(0);
        // Message should still be in memory (even if not persisted)
        const history = conv.getHistory();
        expect(history.length).toBe(2);
        expect(history[0].content).toBe('Hello');
        expect(history[1].content).toBe('Mock response from the agent.');
      } finally {
        chmodSync(join(testDir, 'memory'), 0o755);
      }
    });
  });
});
