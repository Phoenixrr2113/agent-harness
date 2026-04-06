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
import { tool } from 'ai';
import { z } from 'zod';

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
      for await (const chunk of agent.stream('Stream test').textStream) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual(['Mock ', 'streamed ', 'response.']);
    });

    it('should write session after streaming completes', async () => {
      const agent = createHarness({ dir: testDir, apiKey: 'test-key' });

      for await (const _chunk of agent.stream('Stream session test').textStream) {
        // consume stream
      }

      const sessionsDir = join(testDir, 'memory', 'sessions');
      const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.md'));
      expect(files.length).toBe(1);
    });

    it('should resolve result promise with metadata after stream consumed', async () => {
      const agent = createHarness({ dir: testDir, apiKey: 'test-key' });
      await agent.boot();

      const streamResult = agent.stream('Stream metadata test');

      // Consume the stream first
      let fullText = '';
      for await (const chunk of streamResult.textStream) {
        fullText += chunk;
      }

      // Then await the result promise
      const result = await streamResult.result;
      expect(result.text).toBe('Mock streamed response.');
      expect(result.session_id).toBeTruthy();
      expect(result.usage.totalTokens).toBeGreaterThanOrEqual(0);
      expect(result.steps).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(result.toolCalls)).toBe(true);
    });

    it('should call onError hook when stream guardrail blocks', async () => {
      // Set up rate limits in config before creating the harness
      const configPath = join(testDir, 'config.yaml');
      const configContent = readFileSync(configPath, 'utf-8');
      writeFileSync(configPath, configContent + '\nrate_limits:\n  per_minute: 1\n');

      // Pre-fill rate limit events so the limit is already exceeded
      const now = Date.now();
      const events = Array.from({ length: 5 }, () => ({ key: 'llm-calls:minute', timestamp: now }));
      writeFileSync(
        join(testDir, 'memory', 'rate-limits.json'),
        JSON.stringify({ events, updated: new Date().toISOString() }),
      );

      const onError = vi.fn();
      const agent = createHarness({
        dir: testDir,
        apiKey: 'test-key',
        hooks: { onError },
      });
      await agent.boot();

      try {
        for await (const _chunk of agent.stream('blocked').textStream) {
          // should not reach here
        }
      } catch {
        // expected
      }

      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: expect.stringContaining('Guardrail') }),
        }),
      );
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

  describe('hooks', () => {
    it('should call onBoot hook after booting', async () => {
      const onBoot = vi.fn();
      const agent = createHarness({ dir: testDir, apiKey: 'test-key', hooks: { onBoot } });
      await agent.boot();

      expect(onBoot).toHaveBeenCalledOnce();
      expect(onBoot).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: expect.objectContaining({ name: 'test-agent' }),
          config: expect.objectContaining({ agent: expect.objectContaining({ name: 'test-agent' }) }),
          state: expect.objectContaining({ mode: 'active' }),
        }),
      );
    });

    it('should call onStateChange on boot (idle → active)', async () => {
      const onStateChange = vi.fn();
      const agent = createHarness({ dir: testDir, apiKey: 'test-key', hooks: { onStateChange } });
      await agent.boot();

      expect(onStateChange).toHaveBeenCalledWith(
        expect.objectContaining({ previous: 'idle', current: 'active' }),
      );
    });

    it('should call onSessionEnd after run', async () => {
      const onSessionEnd = vi.fn();
      const agent = createHarness({ dir: testDir, apiKey: 'test-key', hooks: { onSessionEnd } });
      await agent.run('Hook test');

      expect(onSessionEnd).toHaveBeenCalledOnce();
      expect(onSessionEnd).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Hook test',
          sessionId: expect.any(String),
          result: expect.objectContaining({ text: 'Mock response from the agent.' }),
        }),
      );
    });

    it('should call onShutdown before shutdown completes', async () => {
      let capturedMode: string | undefined;
      const onShutdown = vi.fn(({ state: s }: { state: { mode: string } }) => {
        capturedMode = s.mode;
      });
      const agent = createHarness({ dir: testDir, apiKey: 'test-key', hooks: { onShutdown } });
      await agent.boot();
      await agent.shutdown();

      expect(onShutdown).toHaveBeenCalledOnce();
      // onShutdown fires before state.mode is set to 'idle'
      expect(capturedMode).toBe('active');
    });

    it('should call onStateChange on shutdown (active → idle)', async () => {
      const onStateChange = vi.fn();
      const agent = createHarness({ dir: testDir, apiKey: 'test-key', hooks: { onStateChange } });
      await agent.boot();
      onStateChange.mockClear();
      await agent.shutdown();

      expect(onStateChange).toHaveBeenCalledWith(
        expect.objectContaining({ previous: 'active', current: 'idle' }),
      );
    });

    it('should call onError when run fails', async () => {
      // Override getModel to throw during generate
      const { getModel: mockGetModel } = await import('../src/llm/provider.js');
      const { MockLanguageModelV3 } = await import('ai/test');
      const failModel = new MockLanguageModelV3({
        provider: 'mock',
        modelId: 'mock-fail',
        doGenerate: async () => {
          throw new Error('API rate limited');
        },
      });
      (mockGetModel as ReturnType<typeof vi.fn>).mockReturnValueOnce(failModel);

      const onError = vi.fn();
      const agent = createHarness({ dir: testDir, apiKey: 'test-key', hooks: { onError } });

      await expect(agent.run('Fail test')).rejects.toThrow('API rate limited');
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: 'API rate limited' }),
          prompt: 'Fail test',
        }),
      );
    });

    it('should work with no hooks provided', async () => {
      const agent = createHarness({ dir: testDir, apiKey: 'test-key' });
      await agent.boot();
      const result = await agent.run('No hooks');
      await agent.shutdown();

      expect(result.text).toBe('Mock response from the agent.');
    });

    it('should call all hooks in correct order during full lifecycle', async () => {
      const callOrder: string[] = [];
      const hooks = {
        onBoot: vi.fn(() => { callOrder.push('onBoot'); }),
        onStateChange: vi.fn(({ current }: { current: string }) => { callOrder.push(`onStateChange:${current}`); }),
        onSessionEnd: vi.fn(() => { callOrder.push('onSessionEnd'); }),
        onShutdown: vi.fn(() => { callOrder.push('onShutdown'); }),
      };

      const agent = createHarness({ dir: testDir, apiKey: 'test-key', hooks });
      await agent.boot();
      await agent.run('Order test');
      await agent.shutdown();

      expect(callOrder).toEqual([
        'onStateChange:active',
        'onBoot',
        'onSessionEnd',
        'onShutdown',
        'onStateChange:idle',
      ]);
    });
  });

  describe('stream with tools', () => {
    it('should pass tools through to streaming and record session with steps', async () => {
      const agent = createHarness({ dir: testDir, apiKey: 'test-key' });

      // Write a tool definition file so buildToolSet picks it up
      const toolDir = join(testDir, 'tools');
      writeFileSync(
        join(toolDir, 'weather.md'),
        `---
id: weather
name: Weather API
status: active
---
# Weather API
Get current weather for a location.
## Operations
### GET /weather
- query: location (string, required)
`,
      );

      await agent.boot();

      const chunks: string[] = [];
      for await (const chunk of agent.stream('Get weather for NYC').textStream) {
        chunks.push(chunk);
      }

      // Should still produce text output (from mock)
      expect(chunks.join('')).toBe('Mock streamed response.');

      // Should have written a session
      const sessionsDir = join(testDir, 'memory', 'sessions');
      const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.md'));
      expect(files.length).toBe(1);
    });

    it('should call onSessionEnd hook after streaming', async () => {
      const onSessionEnd = vi.fn();
      const agent = createHarness({
        dir: testDir,
        apiKey: 'test-key',
        hooks: { onSessionEnd },
      });

      for await (const _chunk of agent.stream('Stream hook test').textStream) {
        // consume stream
      }

      expect(onSessionEnd).toHaveBeenCalledOnce();
      expect(onSessionEnd).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Stream hook test',
          sessionId: expect.any(String),
          result: expect.objectContaining({
            text: 'Mock streamed response.',
            session_id: expect.any(String),
            steps: expect.any(Number),
            toolCalls: expect.any(Array),
          }),
        }),
      );
    });

    it('should record health success after streaming', async () => {
      const { loadHealth } = await import('../src/runtime/health.js');
      const agent = createHarness({ dir: testDir, apiKey: 'test-key' });

      for await (const _chunk of agent.stream('Health test').textStream) {
        // consume
      }

      const health = loadHealth(testDir);
      expect(health.totalRuns).toBeGreaterThan(0);
    });
  });

  describe('run with programmatic tools', () => {
    it('should pass programmatic tools to run and include in toolSet', async () => {
      const myTool = tool({
        description: 'A test tool',
        parameters: z.object({ input: z.string() }),
        execute: async ({ input }) => `processed: ${input}`,
      });

      const agent = createHarness({
        dir: testDir,
        apiKey: 'test-key',
        toolExecutor: {
          programmaticTools: { myTool },
        },
      });

      // run() should succeed — tools are loaded but the mock model doesn't call them
      const result = await agent.run('Use the tool');
      expect(result.text).toBe('Mock response from the agent.');
      expect(result.steps).toBe(1);
      // No tool calls since mock model returns text directly
      expect(result.toolCalls).toEqual([]);
    });
  });

  describe('post-LLM recording resilience', () => {
    it('run() should return result even if session write fails', async () => {
      const { chmodSync } = await import('fs');
      const agent = createHarness({ dir: testDir, apiKey: 'test-key' });
      // Boot first (needs writable memory), then break sessions dir
      await agent.boot();

      const sessionsDir = join(testDir, 'memory', 'sessions');
      rmSync(sessionsDir, { recursive: true, force: true });
      chmodSync(join(testDir, 'memory'), 0o444);

      try {
        const result = await agent.run('Hello');
        // LLM result should be returned despite recording failure
        expect(result.text).toBe('Mock response from the agent.');
        expect(result.usage.totalTokens).toBeGreaterThan(0);
      } finally {
        chmodSync(join(testDir, 'memory'), 0o755);
        mkdirSync(sessionsDir, { recursive: true });
      }
    });

    it('stream() should yield all chunks even if session write fails', async () => {
      const { chmodSync } = await import('fs');
      const agent = createHarness({ dir: testDir, apiKey: 'test-key' });
      await agent.boot();

      const sessionsDir = join(testDir, 'memory', 'sessions');
      rmSync(sessionsDir, { recursive: true, force: true });
      chmodSync(join(testDir, 'memory'), 0o444);

      try {
        let fullText = '';
        for await (const chunk of agent.stream('Hello').textStream) {
          fullText += chunk;
        }
        expect(fullText).toBe('Mock streamed response.');
      } finally {
        chmodSync(join(testDir, 'memory'), 0o755);
        mkdirSync(sessionsDir, { recursive: true });
      }
    });

    it('run() should return result even if onSessionEnd hook throws', async () => {
      const agent = createHarness({
        dir: testDir,
        apiKey: 'test-key',
        hooks: {
          onSessionEnd: async () => {
            throw new Error('Hook exploded');
          },
        },
      });

      // Should not throw — hook error is swallowed
      const result = await agent.run('Hello');
      expect(result.text).toBe('Mock response from the agent.');
    });
  });
});
