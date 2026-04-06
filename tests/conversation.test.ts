import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseJsonlContext, parseLegacyContext, Conversation } from '../src/runtime/conversation.js';
import { estimateTokens } from '../src/primitives/loader.js';

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
});
