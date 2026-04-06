import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { validateMcpConfig, createMcpManager } from '../src/runtime/mcp.js';
import { CONFIG_DEFAULTS, type HarnessConfig } from '../src/core/types.js';
import { loadConfig } from '../src/core/config.js';
import { buildToolSet } from '../src/runtime/tool-executor.js';

function makeConfig(mcpServers: Record<string, unknown> = {}): HarnessConfig {
  return {
    ...CONFIG_DEFAULTS,
    mcp: { servers: mcpServers as HarnessConfig['mcp']['servers'] },
  };
}

describe('MCP integration', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
    mkdirSync(join(testDir, 'memory'), { recursive: true });
    mkdirSync(join(testDir, 'tools'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('validateMcpConfig', () => {
    it('should return no errors for empty config', () => {
      const errors = validateMcpConfig(makeConfig());
      expect(errors).toHaveLength(0);
    });

    it('should return no errors for valid stdio server', () => {
      const errors = validateMcpConfig(makeConfig({
        'test-server': {
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          enabled: true,
        },
      }));
      expect(errors).toHaveLength(0);
    });

    it('should return error for stdio without command', () => {
      const errors = validateMcpConfig(makeConfig({
        'test-server': {
          transport: 'stdio',
          enabled: true,
        },
      }));
      expect(errors).toHaveLength(1);
      expect(errors[0].server).toBe('test-server');
      expect(errors[0].error).toContain('command');
    });

    it('should return no errors for valid http server', () => {
      const errors = validateMcpConfig(makeConfig({
        'test-server': {
          transport: 'http',
          url: 'https://example.com/mcp',
          enabled: true,
        },
      }));
      expect(errors).toHaveLength(0);
    });

    it('should return error for http without url', () => {
      const errors = validateMcpConfig(makeConfig({
        'test-server': {
          transport: 'http',
          enabled: true,
        },
      }));
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toContain('url');
    });

    it('should return no errors for valid sse server', () => {
      const errors = validateMcpConfig(makeConfig({
        'test-server': {
          transport: 'sse',
          url: 'https://example.com/sse',
          enabled: true,
        },
      }));
      expect(errors).toHaveLength(0);
    });

    it('should return error for sse without url', () => {
      const errors = validateMcpConfig(makeConfig({
        'test-server': {
          transport: 'sse',
          enabled: true,
        },
      }));
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toContain('url');
    });

    it('should validate multiple servers', () => {
      const errors = validateMcpConfig(makeConfig({
        'good-stdio': {
          transport: 'stdio',
          command: 'node',
          enabled: true,
        },
        'bad-http': {
          transport: 'http',
          enabled: true,
        },
        'good-sse': {
          transport: 'sse',
          url: 'https://example.com/sse',
          enabled: true,
        },
      }));
      expect(errors).toHaveLength(1);
      expect(errors[0].server).toBe('bad-http');
    });
  });

  describe('createMcpManager', () => {
    it('should report no servers when config is empty', () => {
      const manager = createMcpManager(makeConfig());
      expect(manager.hasServers()).toBe(false);
    });

    it('should report servers when config has entries', () => {
      const manager = createMcpManager(makeConfig({
        'test-server': {
          transport: 'stdio',
          command: 'echo',
          enabled: true,
        },
      }));
      expect(manager.hasServers()).toBe(true);
    });

    it('should return empty tools when no servers connected', () => {
      const manager = createMcpManager(makeConfig());
      expect(manager.getTools()).toEqual({});
    });

    it('should close gracefully with no connections', async () => {
      const manager = createMcpManager(makeConfig());
      await expect(manager.close()).resolves.not.toThrow();
    });

    it('should skip disabled servers during connect', async () => {
      const manager = createMcpManager(makeConfig({
        'disabled-server': {
          transport: 'stdio',
          command: 'echo',
          enabled: false,
        },
      }));
      await manager.connect();

      const summaries = manager.getSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].name).toBe('disabled-server');
      expect(summaries[0].enabled).toBe(false);
      expect(summaries[0].connected).toBe(false);
    });

    it('should handle connection failure gracefully', async () => {
      // A server with an invalid command will fail to connect
      const manager = createMcpManager(makeConfig({
        'bad-server': {
          transport: 'stdio',
          command: '__nonexistent_command_that_should_fail__',
          enabled: true,
        },
      }));

      // Should not throw — failures are caught and logged
      await manager.connect();

      const summaries = manager.getSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].name).toBe('bad-server');
      expect(summaries[0].connected).toBe(false);
      expect(summaries[0].error).toBeDefined();
    });

    it('should include unchecked servers in summaries', () => {
      const manager = createMcpManager(makeConfig({
        'server-a': {
          transport: 'stdio',
          command: 'echo',
          enabled: true,
        },
      }));

      // Get summaries without connecting
      const summaries = manager.getSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].name).toBe('server-a');
      expect(summaries[0].connected).toBe(false);
    });
  });

  describe('config schema', () => {
    it('should accept config with mcp.servers section', () => {
      writeFileSync(
        join(testDir, 'config.yaml'),
        `
agent:
  name: mcp-test-agent

model:
  provider: openrouter
  id: anthropic/claude-sonnet-4

mcp:
  servers:
    filesystem:
      transport: stdio
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem"]
    api-server:
      transport: http
      url: https://example.com/mcp
      headers:
        Authorization: "Bearer secret"
      enabled: false
`);

      const config = loadConfig(testDir);
      expect(config.mcp.servers).toBeDefined();
      expect(config.mcp.servers['filesystem']).toBeDefined();
      expect(config.mcp.servers['filesystem'].transport).toBe('stdio');
      expect(config.mcp.servers['filesystem'].command).toBe('npx');
      expect(config.mcp.servers['filesystem'].args).toEqual(['-y', '@modelcontextprotocol/server-filesystem']);
      expect(config.mcp.servers['api-server']).toBeDefined();
      expect(config.mcp.servers['api-server'].transport).toBe('http');
      expect(config.mcp.servers['api-server'].url).toBe('https://example.com/mcp');
      expect(config.mcp.servers['api-server'].enabled).toBe(false);
    });

    it('should default mcp.servers to empty object', () => {
      writeFileSync(
        join(testDir, 'config.yaml'),
        `
agent:
  name: basic-agent

model:
  provider: openrouter
  id: anthropic/claude-sonnet-4
`);

      const config = loadConfig(testDir);
      expect(config.mcp.servers).toEqual({});
    });

    it('should accept mcp section with empty servers', () => {
      writeFileSync(
        join(testDir, 'config.yaml'),
        `
agent:
  name: basic-agent

model:
  provider: openrouter
  id: anthropic/claude-sonnet-4

mcp:
  servers: {}
`);

      const config = loadConfig(testDir);
      expect(config.mcp.servers).toEqual({});
    });
  });

  describe('buildToolSet with mcpTools parameter', () => {
    it('should return empty toolset when no tools configured', () => {
      const tools = buildToolSet(testDir);
      expect(Object.keys(tools)).toHaveLength(0);
    });

    it('should merge MCP tools into tool set', () => {
      const mcpTools = {
        'mcp-search': {
          type: 'function' as const,
          description: 'Search MCP',
          parameters: { type: 'object' as const, properties: {} },
          execute: vi.fn(),
        },
      };

      const tools = buildToolSet(testDir, undefined, mcpTools);
      expect(Object.keys(tools)).toContain('mcp-search');
    });

    it('should merge MCP tools alongside markdown tools', () => {
      // Write a simple tool markdown file
      writeFileSync(
        join(testDir, 'tools', 'test-api.md'),
        `---
id: test-api
tags: [api]
status: active
---
# Test API

## Auth
- TEST_API_KEY

## Operations
- GET /api/data
`);

      const mcpTools = {
        'mcp-tool': {
          type: 'function' as const,
          description: 'MCP Tool',
          parameters: { type: 'object' as const, properties: {} },
          execute: vi.fn(),
        },
      };

      const tools = buildToolSet(testDir, undefined, mcpTools);
      const toolNames = Object.keys(tools);

      // Should have both the markdown tool and the MCP tool
      expect(toolNames).toContain('mcp-tool');
      expect(toolNames.some((n) => n.startsWith('test-api'))).toBe(true);
    });
  });
});
