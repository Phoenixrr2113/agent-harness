import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  searchRegistry,
  getRegistryServer,
  resolveServerConfig,
  findServer,
  searchServers,
  deriveConfigName,
} from '../src/runtime/mcp-registry.js';
import type { RegistryServer, RegistrySearchResponse } from '../src/runtime/mcp-registry.js';

// Mock fetch for registry API calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// --- Helpers ---

function makeServer(overrides: Partial<RegistryServer> = {}): RegistryServer {
  return {
    name: 'io.github.test/mcp-example',
    description: 'Example MCP server',
    version: '1.0.0',
    ...overrides,
  };
}

function makeNpmServer(overrides: Partial<RegistryServer> = {}): RegistryServer {
  return makeServer({
    packages: [{
      registryType: 'npm',
      identifier: '@test/mcp-example',
      version: '1.0.0',
      transport: { type: 'stdio' },
      environmentVariables: [
        { name: 'EXAMPLE_KEY', isRequired: true, description: 'Required API key' },
        { name: 'OPTIONAL_VAR', isRequired: false },
      ],
    }],
    ...overrides,
  });
}

function makeSearchResponse(servers: RegistryServer[]): RegistrySearchResponse {
  return {
    servers: servers.map((server) => ({ server })),
    metadata: { count: servers.length },
  };
}

function mockFetchJson(data: unknown, status = 200): void {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
  });
}

// --- Tests ---

describe('mcp-registry', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('deriveConfigName', () => {
    it('should extract last segment from registry name', () => {
      expect(deriveConfigName('io.github.foo/bar-server')).toBe('bar-server');
    });

    it('should return name as-is when no slashes', () => {
      expect(deriveConfigName('simple-name')).toBe('simple-name');
    });

    it('should handle deeply nested names', () => {
      expect(deriveConfigName('io.github.org/deep/nested/name')).toBe('name');
    });

    it('should handle empty segments', () => {
      expect(deriveConfigName('trailing/')).toBe('');
    });
  });

  describe('resolveServerConfig', () => {
    it('should resolve npm stdio package', () => {
      const resolved = resolveServerConfig(makeNpmServer());

      expect(resolved.name).toBe('mcp-example');
      expect(resolved.registryName).toBe('io.github.test/mcp-example');
      expect(resolved.description).toBe('Example MCP server');
      expect(resolved.config.transport).toBe('stdio');
      expect(resolved.config.command).toBe('npx');
      expect(resolved.config.args).toEqual(['-y', '@test/mcp-example']);
      expect(resolved.config.env).toEqual({ EXAMPLE_KEY: '${EXAMPLE_KEY}', OPTIONAL_VAR: '${OPTIONAL_VAR}' });
      expect(resolved.requiredEnv).toHaveLength(1);
      expect(resolved.requiredEnv[0].name).toBe('EXAMPLE_KEY');
      expect(resolved.allEnv).toHaveLength(2);
      expect(resolved.package?.identifier).toBe('@test/mcp-example');
    });

    it('should resolve pypi package with uvx', () => {
      const server = makeServer({
        packages: [{
          registryType: 'pypi',
          identifier: 'mcp-python-server',
          version: '2.0.0',
          transport: { type: 'stdio' },
        }],
      });

      const resolved = resolveServerConfig(server);
      expect(resolved.config.command).toBe('uvx');
      expect(resolved.config.args).toEqual(['mcp-python-server']);
    });

    it('should resolve pypi package with explicit runtimeHint', () => {
      const server = makeServer({
        packages: [{
          registryType: 'pypi',
          identifier: 'mcp-python-server',
          version: '2.0.0',
          transport: { type: 'stdio' },
          runtimeHint: 'uvx',
        }],
      });

      const resolved = resolveServerConfig(server);
      expect(resolved.config.command).toBe('uvx');
      expect(resolved.config.args).toEqual(['mcp-python-server']);
    });

    it('should resolve docker package', () => {
      const server = makeServer({
        packages: [{
          registryType: 'oci',
          identifier: 'myorg/mcp-server:latest',
          version: '1.0.0',
          transport: { type: 'stdio' },
          runtimeHint: 'docker',
        }],
      });

      const resolved = resolveServerConfig(server);
      expect(resolved.config.command).toBe('docker');
      expect(resolved.config.args).toEqual(['run', '-i', '--rm', 'myorg/mcp-server:latest']);
    });

    it('should resolve remote streamable-http endpoint', () => {
      const server = makeServer({
        remotes: [{
          transportType: 'streamable-http',
          url: 'https://api.example.com/mcp',
          headers: { 'Authorization': 'Bearer ${API_KEY}' },
        }],
      });

      const resolved = resolveServerConfig(server);
      expect(resolved.config.transport).toBe('http');
      expect(resolved.config.url).toBe('https://api.example.com/mcp');
      expect(resolved.config.headers).toEqual({ 'Authorization': 'Bearer ${API_KEY}' });
      expect(resolved.requiredEnv).toHaveLength(0);
      expect(resolved.remote?.url).toBe('https://api.example.com/mcp');
    });

    it('should resolve SSE remote endpoint', () => {
      const server = makeServer({
        remotes: [{
          transportType: 'sse',
          url: 'https://api.example.com/sse',
        }],
      });

      const resolved = resolveServerConfig(server);
      expect(resolved.config.transport).toBe('sse');
      expect(resolved.config.url).toBe('https://api.example.com/sse');
    });

    it('should prefer npm stdio over pypi stdio', () => {
      const server = makeServer({
        packages: [
          {
            registryType: 'pypi',
            identifier: 'mcp-py',
            version: '1.0.0',
            transport: { type: 'stdio' },
          },
          {
            registryType: 'npm',
            identifier: '@test/mcp-npm',
            version: '1.0.0',
            transport: { type: 'stdio' },
          },
        ],
      });

      const resolved = resolveServerConfig(server);
      expect(resolved.config.command).toBe('npx');
      expect(resolved.config.args).toContain('@test/mcp-npm');
    });

    it('should prefer stdio over remotes', () => {
      const server = makeServer({
        packages: [{
          registryType: 'npm',
          identifier: '@test/mcp-server',
          version: '1.0.0',
          transport: { type: 'stdio' },
        }],
        remotes: [{
          transportType: 'streamable-http',
          url: 'https://remote.example.com',
        }],
      });

      const resolved = resolveServerConfig(server);
      expect(resolved.config.transport).toBe('stdio');
    });

    it('should fall back to http package when no stdio or remotes', () => {
      const server = makeServer({
        packages: [{
          registryType: 'npm',
          identifier: 'http-only-server',
          version: '1.0.0',
          transport: { type: 'streamable-http' },
        }],
      });

      const resolved = resolveServerConfig(server);
      expect(resolved.config.transport).toBe('http');
    });

    it('should not include env when no env vars', () => {
      const server = makeServer({
        packages: [{
          registryType: 'npm',
          identifier: '@test/no-env',
          version: '1.0.0',
          transport: { type: 'stdio' },
        }],
      });

      const resolved = resolveServerConfig(server);
      expect(resolved.config.env).toBeUndefined();
      expect(resolved.requiredEnv).toHaveLength(0);
      expect(resolved.allEnv).toHaveLength(0);
    });

    it('should throw for server with no resolvable config', () => {
      const server = makeServer(); // No packages, no remotes
      expect(() => resolveServerConfig(server)).toThrow('Cannot resolve');
    });

    it('should not include headers on remote when none provided', () => {
      const server = makeServer({
        remotes: [{
          transportType: 'streamable-http',
          url: 'https://open.example.com',
        }],
      });

      const resolved = resolveServerConfig(server);
      expect(resolved.config.headers).toBeUndefined();
    });
  });

  describe('searchRegistry', () => {
    it('should search with query and default limit', async () => {
      mockFetchJson(makeSearchResponse([makeNpmServer()]));

      const result = await searchRegistry('example');
      expect(result.servers).toHaveLength(1);
      expect(result.servers[0].server.name).toBe('io.github.test/mcp-example');

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('search=example');
      expect(calledUrl).toContain('limit=10'); // default limit
      expect(calledUrl).toContain('version=latest');
    });

    it('should pass custom limit', async () => {
      mockFetchJson(makeSearchResponse([]));
      await searchRegistry('test', { limit: 5 });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('limit=5');
    });

    it('should pass cursor for pagination', async () => {
      mockFetchJson(makeSearchResponse([]));
      await searchRegistry('test', { cursor: 'abc123' });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('cursor=abc123');
    });

    it('should throw on non-OK response', async () => {
      mockFetchJson({}, 500);
      await expect(searchRegistry('test')).rejects.toThrow('search failed');
    });
  });

  describe('getRegistryServer', () => {
    it('should fetch server by name with URL encoding', async () => {
      mockFetchJson(makeNpmServer());
      const result = await getRegistryServer('io.github.test/mcp-example');

      expect(result.name).toBe('io.github.test/mcp-example');
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain(encodeURIComponent('io.github.test/mcp-example'));
      expect(calledUrl).toContain('/versions/latest');
    });

    it('should support specific version', async () => {
      mockFetchJson(makeNpmServer());
      await getRegistryServer('io.github.test/mcp-example', '2.0.0');

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('/versions/2.0.0');
    });

    it('should throw descriptive error on 404', async () => {
      mockFetchJson({}, 404);
      await expect(getRegistryServer('nonexistent')).rejects.toThrow('not found');
    });

    it('should throw on other HTTP errors', async () => {
      mockFetchJson({}, 503);
      await expect(getRegistryServer('test')).rejects.toThrow('lookup failed');
    });
  });

  describe('findServer', () => {
    it('should try exact lookup for names with slash', async () => {
      mockFetchJson(makeNpmServer());
      const result = await findServer('io.github.test/mcp-example');

      expect(result).not.toBeNull();
      expect(result!.name).toBe('mcp-example');
      expect(result!.registryName).toBe('io.github.test/mcp-example');

      // Should have used exact lookup URL, not search
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('/servers/');
      expect(calledUrl).not.toContain('search=');
    });

    it('should try exact lookup for names with io. prefix', async () => {
      mockFetchJson(makeNpmServer({ name: 'io.github.test' }));
      const result = await findServer('io.github.test');
      expect(result).not.toBeNull();
    });

    it('should fall back to search if exact lookup fails', async () => {
      // First: exact lookup 404
      mockFetchJson({}, 404);
      // Second: search succeeds
      mockFetchJson(makeSearchResponse([makeNpmServer()]));

      const result = await findServer('io.github.test/mcp-example');
      expect(result).not.toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should use search for simple queries without slash', async () => {
      mockFetchJson(makeSearchResponse([makeNpmServer()]));
      const result = await findServer('example');

      expect(result).not.toBeNull();
      expect(result!.name).toBe('mcp-example');

      // Should have used search URL
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('search=');
    });

    it('should return null when no results found', async () => {
      mockFetchJson(makeSearchResponse([]));
      const result = await findServer('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('searchServers', () => {
    it('should return resolved servers', async () => {
      mockFetchJson(makeSearchResponse([
        makeNpmServer(),
        makeServer({
          name: 'io.github.other/remote-server',
          remotes: [{ transportType: 'streamable-http', url: 'https://example.com/mcp' }],
        }),
      ]));

      const results = await searchServers('test', { limit: 5 });
      expect(results).toHaveLength(2);
      expect(results[0].config.transport).toBe('stdio');
      expect(results[1].config.transport).toBe('http');
    });

    it('should skip servers that cannot be resolved', async () => {
      mockFetchJson(makeSearchResponse([
        makeNpmServer(),
        makeServer({ name: 'empty-server' }), // No packages/remotes
      ]));

      const results = await searchServers('test');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('mcp-example');
    });

    it('should use default limit', async () => {
      mockFetchJson(makeSearchResponse([]));
      await searchServers('test');

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('limit=10');
    });

    it('should pass custom limit', async () => {
      mockFetchJson(makeSearchResponse([]));
      await searchServers('test', { limit: 3 });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('limit=3');
    });
  });
});
