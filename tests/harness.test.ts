import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock the LLM provider BEFORE importing harness
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: vi.fn().mockResolvedValue({
      text: 'Mock response from the agent.',
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
    streamText: vi.fn().mockReturnValue({
      textStream: (async function* () {
        yield 'Mock ';
        yield 'streamed ';
        yield 'response.';
      })(),
      usage: Promise.resolve({ inputTokens: 80, outputTokens: 30 }),
    }),
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

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
