import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scaffoldHarness } from '../src/cli/scaffold.js';
import { defineAgent } from '../src/runtime/define-agent.js';

describe('defineAgent', () => {
  let testDir: string;
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'define-agent-'));
    testDir = join(tmpBase, 'test-agent');
    scaffoldHarness(testDir, 'test-agent', { template: 'base' });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('should create an agent via builder pattern', () => {
    const agent = defineAgent(testDir).apiKey('test-key').build();
    expect(agent).toBeDefined();
    expect(agent.name).toBe('test-agent');
    expect(typeof agent.boot).toBe('function');
    expect(typeof agent.run).toBe('function');
    expect(typeof agent.stream).toBe('function');
    expect(typeof agent.shutdown).toBe('function');
  });

  it('should apply model override', () => {
    const agent = defineAgent(testDir)
      .model('openai/gpt-4o')
      .apiKey('test-key')
      .build();
    expect(agent.config.model.id).toBe('openai/gpt-4o');
  });

  it('should apply provider override', () => {
    const agent = defineAgent(testDir)
      .provider('openai')
      .build();
    expect(agent.config.model.provider).toBe('openai');
  });

  it('should chain multiple builder calls', () => {
    const agent = defineAgent(testDir)
      .model('anthropic/claude-sonnet-4')
      .provider('anthropic')
      .maxToolCalls(10)
      .toolTimeout(60000)
      .allowHttp(false)
      .build();

    expect(agent).toBeDefined();
    expect(agent.config.model.id).toBe('anthropic/claude-sonnet-4');
    expect(agent.config.model.provider).toBe('anthropic');
  });

  it('should apply config overrides', () => {
    const agent = defineAgent(testDir)
      .apiKey('test-key')
      .configure({
        runtime: { scratchpad_budget: 5000 },
      })
      .build();

    expect(agent.config.runtime.scratchpad_budget).toBe(5000);
  });

  it('should merge multiple configure calls', () => {
    const agent = defineAgent(testDir)
      .apiKey('test-key')
      .configure({ runtime: { scratchpad_budget: 5000 } })
      .configure({ memory: { session_retention_days: 14 } })
      .build();

    expect(agent.config.runtime.scratchpad_budget).toBe(5000);
    expect(agent.config.memory.session_retention_days).toBe(14);
  });

  it('should register lifecycle hooks', () => {
    const calls: string[] = [];
    const agent = defineAgent(testDir)
      .apiKey('test-key')
      .onBoot(async () => { calls.push('boot'); })
      .onSessionEnd(async () => { calls.push('session'); })
      .onError(async () => { calls.push('error'); })
      .onStateChange(async () => { calls.push('state'); })
      .onShutdown(async () => { calls.push('shutdown'); })
      .build();

    // Hooks are registered but not yet called (agent not booted)
    expect(agent).toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it('should chain multiple hooks of same type', () => {
    const calls: string[] = [];
    const agent = defineAgent(testDir)
      .apiKey('test-key')
      .onBoot(async () => { calls.push('boot1'); })
      .onBoot(async () => { calls.push('boot2'); })
      .build();

    // Both hooks should be registered (chained)
    expect(agent).toBeDefined();
  });

  it('should throw for non-existent directory', () => {
    expect(() => {
      defineAgent('/tmp/nonexistent-harness-dir-12345').build();
    }).toThrow('Harness directory not found');
  });

  it('should return builder for fluent chaining', () => {
    const builder = defineAgent(testDir);
    const result1 = builder.model('test');
    const result2 = result1.provider('test');
    const result3 = result2.apiKey('test');

    // Each call returns the builder itself
    expect(result1).toBe(builder);
    expect(result2).toBe(builder);
    expect(result3).toBe(builder);
  });
});
