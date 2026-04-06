import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  formatRegistryServer,
  installMcpServer,
  updateConfigWithServer,
  serverExistsInConfig,
  generateToolDocs,
} from '../src/runtime/mcp-installer.js';
import type { RegistryServer, RegistrySearchResponse } from '../src/runtime/mcp-registry.js';

// Mock fetch for registry API calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeRegistryResponse(servers: Array<{ server: Partial<RegistryServer> }>): RegistrySearchResponse {
  return {
    servers: servers.map((s) => ({
      server: {
        name: s.server.name ?? 'test/server',
        description: s.server.description ?? 'Test server',
        version: s.server.version ?? '1.0.0',
        ...s.server,
      } as RegistryServer,
    })),
    metadata: { count: servers.length },
  };
}

function mockFetchResponse(data: unknown, status = 200): void {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
  });
}

const baseConfig = `agent:
  name: test
  version: "0.1.0"
model:
  provider: openrouter
  id: anthropic/claude-sonnet-4
  max_tokens: 200000
`;

describe('MCP installer', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mcp-install-test-'));
    mkdirSync(join(testDir, 'memory'), { recursive: true });
    writeFileSync(join(testDir, 'CORE.md'), '# Test Agent\n');
    writeFileSync(join(testDir, 'state.md'), '# State\n## Mode\nidle\n');
    writeFileSync(join(testDir, 'config.yaml'), baseConfig);
    mockFetch.mockReset();
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('formatRegistryServer', () => {
    it('should format server with npm package', () => {
      const output = formatRegistryServer({
        server: {
          name: 'io.github.foo/bar-server',
          description: 'A test MCP server for testing',
          version: '1.0.0',
          packages: [{
            registryType: 'npm',
            identifier: '@foo/bar-mcp',
            version: '1.0.0',
            transport: { type: 'stdio' },
          }],
        } as RegistryServer,
      });

      expect(output).toContain('io.github.foo/bar-server');
      expect(output).toContain('v1.0.0');
      expect(output).toContain('@foo/bar-mcp');
      expect(output).toContain('A test MCP server for testing');
    });

    it('should format server with remote endpoint', () => {
      const output = formatRegistryServer({
        server: {
          name: 'test/remote',
          description: 'Remote server',
          version: '2.0.0',
          remotes: [{ transportType: 'streamable-http', url: 'https://api.example.com/mcp' }],
        } as RegistryServer,
      });

      expect(output).toContain('https://api.example.com/mcp');
    });

    it('should format server with required env vars', () => {
      const output = formatRegistryServer({
        server: {
          name: 'test/env',
          description: 'Server with env',
          version: '1.0.0',
          packages: [{
            registryType: 'npm',
            identifier: 'test-mcp',
            version: '1.0.0',
            transport: { type: 'stdio' },
            environmentVariables: [
              { name: 'API_KEY', isRequired: true },
              { name: 'OPTIONAL_VAR', isRequired: false },
            ],
          }],
        } as RegistryServer,
      });

      expect(output).toContain('requires: API_KEY');
      expect(output).not.toContain('OPTIONAL_VAR');
    });

    it('should truncate long descriptions', () => {
      const output = formatRegistryServer({
        server: {
          name: 'test/long',
          description: 'A'.repeat(200),
          version: '1.0.0',
        } as RegistryServer,
      });

      expect(output).toContain('...');
      expect(output.length).toBeLessThan(300);
    });
  });

  describe('updateConfigWithServer', () => {
    it('should add a stdio server to config', () => {
      updateConfigWithServer(testDir, 'my-server', {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@test/mcp-server'],
      });

      const config = readFileSync(join(testDir, 'config.yaml'), 'utf-8');
      expect(config).toContain('mcp:');
      expect(config).toContain('servers:');
      expect(config).toContain('my-server:');
      expect(config).toContain('transport: stdio');
      expect(config).toContain('npx');
      expect(config).toContain('@test/mcp-server');
    });

    it('should add an http server to config', () => {
      updateConfigWithServer(testDir, 'remote-api', {
        transport: 'http',
        url: 'https://api.example.com/mcp',
        headers: { Authorization: 'Bearer ${API_KEY}' },
      });

      const config = readFileSync(join(testDir, 'config.yaml'), 'utf-8');
      expect(config).toContain('remote-api:');
      expect(config).toContain('transport: http');
      expect(config).toContain('https://api.example.com/mcp');
      expect(config).toContain('Authorization');
    });

    it('should add env vars to config', () => {
      updateConfigWithServer(testDir, 'with-env', {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'test-server'],
        env: { API_KEY: '${API_KEY}', SECRET: '${SECRET}' },
      });

      const config = readFileSync(join(testDir, 'config.yaml'), 'utf-8');
      expect(config).toContain('env:');
      expect(config).toContain('API_KEY');
      expect(config).toContain('SECRET');
    });

    it('should preserve existing config when adding MCP', () => {
      updateConfigWithServer(testDir, 'new-server', {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'test'],
      });

      const config = readFileSync(join(testDir, 'config.yaml'), 'utf-8');
      // Original config still present
      expect(config).toContain('agent:');
      expect(config).toContain('name: test');
      expect(config).toContain('model:');
      // New MCP section added
      expect(config).toContain('new-server:');
    });

    it('should overwrite existing server entry', () => {
      updateConfigWithServer(testDir, 'srv', {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'old-pkg'],
      });
      updateConfigWithServer(testDir, 'srv', {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'new-pkg'],
      });

      const config = readFileSync(join(testDir, 'config.yaml'), 'utf-8');
      expect(config).toContain('new-pkg');
      expect(config).not.toContain('old-pkg');
    });
  });

  describe('serverExistsInConfig', () => {
    it('returns false when no MCP config', () => {
      expect(serverExistsInConfig(testDir, 'anything')).toBe(false);
    });

    it('returns true after server is added', () => {
      updateConfigWithServer(testDir, 'test-srv', {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'test'],
      });
      expect(serverExistsInConfig(testDir, 'test-srv')).toBe(true);
    });

    it('returns false for non-existent server', () => {
      updateConfigWithServer(testDir, 'exists', {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'test'],
      });
      expect(serverExistsInConfig(testDir, 'does-not-exist')).toBe(false);
    });
  });

  describe('generateToolDocs', () => {
    it('should create a tool doc markdown file', () => {
      const paths = generateToolDocs(testDir, 'my-server', ['tool1', 'tool2', 'tool3'], 'A great server');

      expect(paths).toHaveLength(1);
      expect(existsSync(paths[0])).toBe(true);

      const content = readFileSync(paths[0], 'utf-8');
      expect(content).toContain('# my-server MCP Server');
      expect(content).toContain('A great server');
      expect(content).toContain('**tool1**');
      expect(content).toContain('**tool2**');
      expect(content).toContain('**tool3**');
      expect(content).toContain('id: tool-my-server');
      expect(content).toContain('tags: [mcp, my-server]');
    });

    it('should create tools/ directory if not exists', () => {
      const toolsDir = join(testDir, 'tools');
      expect(existsSync(toolsDir)).toBe(false);

      generateToolDocs(testDir, 'srv', ['t1']);
      expect(existsSync(toolsDir)).toBe(true);
    });
  });

  describe('installMcpServer', () => {
    it('should install a server found via registry with npm package', async () => {
      // Mock registry search returning an npm stdio package
      mockFetchResponse(makeRegistryResponse([{
        server: {
          name: 'io.github.test/mcp-example',
          description: 'Example server',
          version: '1.0.0',
          packages: [{
            registryType: 'npm',
            identifier: '@test/mcp-example',
            version: '1.0.0',
            transport: { type: 'stdio' },
            environmentVariables: [
              { name: 'EXAMPLE_KEY', isRequired: true, description: 'Required key' },
            ],
          }],
        },
      }]));

      const result = await installMcpServer('mcp-example', {
        dir: testDir,
        skipTest: true,
        skipDocs: true,
      });

      expect(result.installed).toBe(true);
      expect(result.name).toBe('mcp-example');
      expect(result.server?.registryName).toBe('io.github.test/mcp-example');
      expect(result.server?.config.transport).toBe('stdio');
      expect(result.server?.config.command).toBe('npx');
      expect(result.pendingEnvVars).toHaveLength(1);
      expect(result.pendingEnvVars[0].name).toBe('EXAMPLE_KEY');

      // Verify config was updated
      const config = readFileSync(join(testDir, 'config.yaml'), 'utf-8');
      expect(config).toContain('mcp:');
      expect(config).toContain('mcp-example:');
      expect(config).toContain('@test/mcp-example');
    });

    it('should return error when server not found in registry', async () => {
      // Mock registry search — no results
      mockFetchResponse(makeRegistryResponse([]));

      const result = await installMcpServer('nonexistent-server', {
        dir: testDir,
        skipTest: true,
      });

      expect(result.installed).toBe(false);
      expect(result.error).toContain('No MCP server found');
    });

    it('should reject duplicate name without --force', async () => {
      // First install
      updateConfigWithServer(testDir, 'existing', {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'old-pkg'],
      });

      // Mock registry search
      mockFetchResponse(makeRegistryResponse([{
        server: {
          name: 'io.github.foo/existing',
          version: '1.0.0',
          packages: [{
            registryType: 'npm',
            identifier: 'existing-pkg',
            version: '1.0.0',
            transport: { type: 'stdio' },
          }],
        },
      }]));

      const result = await installMcpServer('existing', {
        dir: testDir,
        skipTest: true,
        name: 'existing',
      });

      expect(result.installed).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('should overwrite with --force', async () => {
      // First install
      updateConfigWithServer(testDir, 'existing', {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'old-pkg'],
      });

      // Mock registry search
      mockFetchResponse(makeRegistryResponse([{
        server: {
          name: 'io.github.foo/existing',
          version: '2.0.0',
          packages: [{
            registryType: 'npm',
            identifier: 'new-pkg',
            version: '2.0.0',
            transport: { type: 'stdio' },
          }],
        },
      }]));

      const result = await installMcpServer('existing', {
        dir: testDir,
        skipTest: true,
        force: true,
        name: 'existing',
      });

      expect(result.installed).toBe(true);
      const config = readFileSync(join(testDir, 'config.yaml'), 'utf-8');
      expect(config).toContain('new-pkg');
    });

    it('should use custom name override', async () => {
      mockFetchResponse(makeRegistryResponse([{
        server: {
          name: 'io.github.test/mcp-long-name',
          version: '1.0.0',
          packages: [{
            registryType: 'npm',
            identifier: '@test/mcp-long-name',
            version: '1.0.0',
            transport: { type: 'stdio' },
          }],
        },
      }]));

      const result = await installMcpServer('mcp-long-name', {
        dir: testDir,
        skipTest: true,
        name: 'short',
      });

      expect(result.installed).toBe(true);
      expect(result.name).toBe('short');

      const config = readFileSync(join(testDir, 'config.yaml'), 'utf-8');
      expect(config).toContain('short:');
    });

    it('should handle registry API errors gracefully', async () => {
      // Mock registry fetch failure
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await installMcpServer('test-server', {
        dir: testDir,
        skipTest: true,
      });

      // Should fail — no fallback to npm without registry
      expect(result.installed).toBe(false);
    });

    it('should install a pypi server with uvx runtime hint', async () => {
      mockFetchResponse(makeRegistryResponse([{
        server: {
          name: 'io.github.test/py-server',
          version: '1.0.0',
          packages: [{
            registryType: 'pypi',
            identifier: 'py-mcp-server',
            version: '1.0.0',
            transport: { type: 'stdio' },
          }],
        },
      }]));

      const result = await installMcpServer('py-server', {
        dir: testDir,
        skipTest: true,
      });

      expect(result.installed).toBe(true);
      expect(result.server?.config.command).toBe('uvx');

      const config = readFileSync(join(testDir, 'config.yaml'), 'utf-8');
      expect(config).toContain('uvx');
      expect(config).toContain('py-mcp-server');
    });

    it('should install a remote HTTP server', async () => {
      mockFetchResponse(makeRegistryResponse([{
        server: {
          name: 'io.github.test/remote-server',
          description: 'A remote MCP server',
          version: '1.0.0',
          remotes: [{
            transportType: 'streamable-http',
            url: 'https://api.example.com/mcp',
            headers: { Authorization: 'Bearer {key}' },
          }],
        },
      }]));

      const result = await installMcpServer('remote-server', {
        dir: testDir,
        skipTest: true,
      });

      expect(result.installed).toBe(true);
      expect(result.server?.config.transport).toBe('http');
      expect(result.server?.config.url).toBe('https://api.example.com/mcp');

      const config = readFileSync(join(testDir, 'config.yaml'), 'utf-8');
      expect(config).toContain('transport: http');
      expect(config).toContain('https://api.example.com/mcp');
    });
  });
});
