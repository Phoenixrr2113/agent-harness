import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// vi.hoisted runs before vi.mock hoisting — safe to define the mock model here
const { mockModel } = vi.hoisted(() => {
  // Dynamic import not available in hoisted block, so we use the provider interface directly
  return { mockModel: null as unknown };
});

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
          controller.enqueue({ type: 'text-delta' as const, id: '1', delta: 'Mock ' });
          controller.enqueue({ type: 'text-delta' as const, id: '1', delta: 'streamed ' });
          controller.enqueue({ type: 'text-delta' as const, id: '1', delta: 'response.' });
          controller.enqueue({ type: 'text-end' as const, id: '1' });
          controller.enqueue({
            type: 'finish' as const,
            usage: {
              inputTokens: { total: 80, noCache: 80, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 30, text: 30, reasoning: undefined },
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

import { createHarness } from '../src/core/harness.js';
import { resetProvider } from '../src/llm/provider.js';

describe('createHarness (programmatic API)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'harness-api-test-'));

    // Build a minimal harness structure
    mkdirSync(join(testDir, 'rules'), { recursive: true });
    mkdirSync(join(testDir, 'instincts'), { recursive: true });
    mkdirSync(join(testDir, 'skills'), { recursive: true });
    mkdirSync(join(testDir, 'playbooks'), { recursive: true });
    mkdirSync(join(testDir, 'workflows'), { recursive: true });
    mkdirSync(join(testDir, 'tools'), { recursive: true });
    mkdirSync(join(testDir, 'agents'), { recursive: true });
    mkdirSync(join(testDir, 'memory', 'sessions'), { recursive: true });
    mkdirSync(join(testDir, 'memory', 'journal'), { recursive: true });

    writeFileSync(
      join(testDir, 'config.yaml'),
      `agent:
  name: test-agent
model:
  provider: openrouter
  id: anthropic/claude-sonnet-4
  max_tokens: 200000
`
    );

    writeFileSync(
      join(testDir, 'CORE.md'),
      `# Test Agent

I am a test agent for integration testing.
`
    );

    writeFileSync(
      join(testDir, 'SYSTEM.md'),
      `# System

You are test-agent.
`
    );

    writeFileSync(
      join(testDir, 'state.md'),
      `# Agent State

## Mode
idle

## Goals

## Active Workflows

## Last Interaction
${new Date().toISOString()}

## Unfinished Business
`
    );

    writeFileSync(join(testDir, 'memory', 'scratch.md'), '');

    resetProvider();
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    resetProvider();
    vi.restoreAllMocks();
  });

  it('should throw if directory does not exist', () => {
    expect(() => createHarness({ dir: '/nonexistent/path/xyz' })).toThrow('Harness directory not found');
  });

  it('should create a harness agent with correct name', () => {
    const agent = createHarness({ dir: testDir, apiKey: 'test-key' });
    expect(agent.name).toBe('test-agent');
  });

  it('should expose the loaded config', () => {
    const agent = createHarness({ dir: testDir, apiKey: 'test-key' });
    expect(agent.config.agent.name).toBe('test-agent');
    expect(agent.config.model.id).toBe('anthropic/claude-sonnet-4');
  });

  it('should apply model override from options', () => {
    const agent = createHarness({
      dir: testDir,
      apiKey: 'test-key',
      model: 'openai/gpt-4o',
    });
    expect(agent.config.model.id).toBe('openai/gpt-4o');
  });

  it('should apply provider override from options', () => {
    const agent = createHarness({
      dir: testDir,
      apiKey: 'test-key',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    });
    expect(agent.config.model.provider).toBe('anthropic');
    expect(agent.config.model.id).toBe('claude-sonnet-4-20250514');
  });

  describe('boot', () => {
    it('should boot and build system prompt', async () => {
      const agent = createHarness({ dir: testDir, apiKey: 'test-key' });
      await agent.boot();

      const prompt = agent.getSystemPrompt();
      expect(prompt).toContain('Test Agent');
      expect(prompt.length).toBeGreaterThan(10);
    });

    it('should set state to active after boot', async () => {
      const agent = createHarness({ dir: testDir, apiKey: 'test-key' });
      await agent.boot();

      const state = agent.getState();
      expect(state.mode).toBe('active');
    });
  });

  describe('run', () => {
    it('should run a prompt and return result', async () => {
      const agent = createHarness({ dir: testDir, apiKey: 'test-key' });
      const result = await agent.run('Hello agent');

      expect(result.text).toBe('Mock response from the agent.');
      expect(result.usage.inputTokens).toBe(100);
      expect(result.usage.outputTokens).toBe(50);
      expect(result.session_id).toBeDefined();
      expect(result.steps).toBe(1);
    });

    it('should write a session record after run', async () => {
      const agent = createHarness({ dir: testDir, apiKey: 'test-key' });
      await agent.run('Test prompt');

      const sessionsDir = join(testDir, 'memory', 'sessions');
      const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.md'));
      expect(files.length).toBe(1);

      const sessionContent = readFileSync(join(sessionsDir, files[0]), 'utf-8');
      expect(sessionContent).toContain('Test prompt');
      expect(sessionContent).toContain('Mock response from the agent.');
    });

    it('should auto-boot if not booted', async () => {
      const agent = createHarness({ dir: testDir, apiKey: 'test-key' });
      // Don't call boot() — run should auto-boot
      const result = await agent.run('Auto-boot test');
      expect(result.text).toBe('Mock response from the agent.');
    });

    it('should update state after run', async () => {
      const agent = createHarness({ dir: testDir, apiKey: 'test-key' });
      const before = new Date().toISOString();
      await agent.run('State test');

      const state = agent.getState();
      expect(state.last_interaction >= before).toBe(true);
    });
  });

  describe('stream', () => {
    it('should stream response chunks', async () => {
      const agent = createHarness({ dir: testDir, apiKey: 'test-key' });
      await agent.boot();

      const chunks: string[] = [];
      for await (const chunk of agent.stream('Stream test')) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual(['Mock ', 'streamed ', 'response.']);
    });

    it('should write session after streaming completes', async () => {
      const agent = createHarness({ dir: testDir, apiKey: 'test-key' });

      for await (const _chunk of agent.stream('Stream session test')) {
        // consume stream
      }

      const sessionsDir = join(testDir, 'memory', 'sessions');
      const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.md'));
      expect(files.length).toBe(1);
    });
  });

  describe('shutdown', () => {
    it('should set state to idle', async () => {
      const agent = createHarness({ dir: testDir, apiKey: 'test-key' });
      await agent.boot();
      await agent.shutdown();

      const state = agent.getState();
      expect(state.mode).toBe('idle');
    });

    it('should be safe to call shutdown without boot', async () => {
      const agent = createHarness({ dir: testDir, apiKey: 'test-key' });
      // Should not throw
      await agent.shutdown();
    });
  });

  describe('lifecycle', () => {
    it('should support full boot -> run -> shutdown cycle', async () => {
      const agent = createHarness({ dir: testDir, apiKey: 'test-key' });

      await agent.boot();
      expect(agent.getState().mode).toBe('active');

      const result = await agent.run('Lifecycle test');
      expect(result.text).toBeDefined();

      await agent.shutdown();
      expect(agent.getState().mode).toBe('idle');
    });
  });
});
