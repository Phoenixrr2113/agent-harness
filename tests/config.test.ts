import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig } from '../src/core/config.js';

describe('config loading', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'config-test-'));
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should use defaults when no config file exists', () => {
    const config = loadConfig(testDir);

    expect(config.agent.name).toBeDefined();
    expect(config.model.provider).toBe('openrouter');
    expect(config.model.max_tokens).toBeGreaterThan(0);
    expect(config.runtime.scratchpad_budget).toBeGreaterThan(0);
    expect(config.memory.session_retention_days).toBeGreaterThan(0);
  });

  it('should load config.yaml if it exists', () => {
    writeFileSync(
      join(testDir, 'config.yaml'),
      `
agent:
  name: test-agent
  version: "1.0.0"

model:
  provider: openrouter
  id: anthropic/claude-sonnet-4
  max_tokens: 100000
`
    );

    const config = loadConfig(testDir);

    expect(config.agent.name).toBe('test-agent');
    expect(config.agent.version).toBe('1.0.0');
    expect(config.model.max_tokens).toBe(100000);
  });

  it('should support config.yml as alternative filename', () => {
    writeFileSync(
      join(testDir, 'config.yml'),
      `
agent:
  name: yml-agent
`
    );

    const config = loadConfig(testDir);
    expect(config.agent.name).toBe('yml-agent');
  });

  it('should support harness.yaml as alternative filename', () => {
    writeFileSync(
      join(testDir, 'harness.yaml'),
      `
agent:
  name: harness-agent
`
    );

    const config = loadConfig(testDir);
    expect(config.agent.name).toBe('harness-agent');
  });

  it('should deep merge config with defaults', () => {
    writeFileSync(
      join(testDir, 'config.yaml'),
      `
model:
  max_tokens: 50000
`
    );

    const config = loadConfig(testDir);

    // User-provided value
    expect(config.model.max_tokens).toBe(50000);

    // Default values should still be present
    expect(config.model.provider).toBe('openrouter');
    expect(config.runtime.scratchpad_budget).toBeGreaterThan(0);
    expect(config.memory.session_retention_days).toBeGreaterThan(0);
  });

  it('should apply overrides on top of file config', () => {
    writeFileSync(
      join(testDir, 'config.yaml'),
      `
agent:
  name: file-agent
model:
  max_tokens: 50000
`
    );

    const config = loadConfig(testDir, {
      model: {
        max_tokens: 100000,
      },
    } as any);

    expect(config.agent.name).toBe('file-agent');
    expect(config.model.max_tokens).toBe(100000); // Override wins
  });

  it('should handle empty config file gracefully', () => {
    writeFileSync(join(testDir, 'config.yaml'), '');

    const config = loadConfig(testDir);

    // Should fall back to all defaults
    expect(config.agent).toBeDefined();
    expect(config.model).toBeDefined();
    expect(config.runtime).toBeDefined();
    expect(config.memory).toBeDefined();
  });

  it('should handle config with only partial sections', () => {
    writeFileSync(
      join(testDir, 'config.yaml'),
      `
agent:
  name: partial-agent
`
    );

    const config = loadConfig(testDir);

    expect(config.agent.name).toBe('partial-agent');
    // Other sections should use defaults
    expect(config.model).toBeDefined();
    expect(config.runtime).toBeDefined();
    expect(config.memory).toBeDefined();
  });

  it('should prioritize config.yaml over other filenames', () => {
    // Create multiple config files
    writeFileSync(
      join(testDir, 'config.yaml'),
      `
agent:
  name: yaml-priority
`
    );
    writeFileSync(
      join(testDir, 'harness.yaml'),
      `
agent:
  name: harness-yaml
`
    );

    const config = loadConfig(testDir);

    // config.yaml should win
    expect(config.agent.name).toBe('yaml-priority');
  });

  it('should handle nested configuration merging', () => {
    writeFileSync(
      join(testDir, 'config.yaml'),
      `
runtime:
  timezone: Europe/London
`
    );

    const config = loadConfig(testDir);

    // Custom value
    expect(config.runtime.timezone).toBe('Europe/London');

    // Other runtime defaults should still exist
    expect(config.runtime.scratchpad_budget).toBeGreaterThan(0);
  });

  it('should preserve array values without merging', () => {
    writeFileSync(
      join(testDir, 'config.yaml'),
      `
agent:
  name: test-agent
  tags: [production, critical]
`
    );

    const config = loadConfig(testDir);

    expect(config.agent.name).toBe('test-agent');
    // Arrays should be replaced, not merged
    expect((config.agent as Record<string, unknown>).tags).toEqual(['production', 'critical']);
  });

  it('should default extensions.directories to empty array', () => {
    writeFileSync(
      join(testDir, 'config.yaml'),
      `agent:
  name: test-agent
model:
  id: test/model
`
    );

    const config = loadConfig(testDir);
    expect(config.extensions).toBeDefined();
    expect(config.extensions.directories).toEqual([]);
  });

  it('should load extension directories from config', () => {
    writeFileSync(
      join(testDir, 'config.yaml'),
      `agent:
  name: test-agent
model:
  id: test/model
extensions:
  directories:
    - protocols
    - templates
`
    );

    const config = loadConfig(testDir);
    expect(config.extensions.directories).toEqual(['protocols', 'templates']);
  });

  it('defaults workflows.durable_default to false', () => {
    const config = loadConfig(testDir);
    expect(config.workflows.durable_default).toBe(false);
  });

  it('defaults memory.workflow_retention_days to 30', () => {
    const config = loadConfig(testDir);
    expect(config.memory.workflow_retention_days).toBe(30);
  });

  it('respects workflows.durable_default override in config.yaml', () => {
    writeFileSync(
      join(testDir, 'config.yaml'),
      `agent: { name: t }\nmodel: { id: m }\nworkflows:\n  durable_default: true\n`,
    );
    const config = loadConfig(testDir);
    expect(config.workflows.durable_default).toBe(true);
  });
});
