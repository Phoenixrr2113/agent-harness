import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  discoverMcpServers,
  discoveredServersToYaml,
  filterUnsafeServers,
  getScannedTools,
} from '../src/runtime/mcp-discovery.js';
import type { DiscoveredMcpServer, DiscoveryOptions } from '../src/runtime/mcp-discovery.js';

describe('MCP auto-discovery', () => {
  let fakeHome: string;
  let opts: DiscoveryOptions;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'mcp-discover-test-'));
    opts = { homeDir: fakeHome, isMac: true };
  });

  afterEach(() => {
    if (existsSync(fakeHome)) {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  describe('discoverMcpServers', () => {
    it('should return empty results when no config files exist', () => {
      const result = discoverMcpServers(opts);
      expect(result.totalServers).toBe(0);
      expect(result.servers).toHaveLength(0);
      expect(result.sourcesFound).toBe(0);
      expect(result.sources.length).toBeGreaterThan(0);
      // All sources should report found: false
      for (const source of result.sources) {
        expect(source.found).toBe(false);
      }
    });

    it('should discover servers from Claude Desktop config', () => {
      const configDir = join(fakeHome, 'Library', 'Application Support', 'Claude');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'claude_desktop_config.json'), JSON.stringify({
        mcpServers: {
          filesystem: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          },
          'web-search': {
            command: 'node',
            args: ['./mcp-server.js'],
            env: { API_KEY: 'secret-value' },
          },
        },
      }));

      const result = discoverMcpServers(opts);
      const claudeSource = result.sources.find((s) => s.tool === 'Claude Desktop');

      expect(claudeSource?.found).toBe(true);
      expect(claudeSource?.servers).toHaveLength(2);
      expect(claudeSource?.servers[0].name).toBe('filesystem');
      expect(claudeSource?.servers[0].transport).toBe('stdio');
      expect(claudeSource?.servers[0].command).toBe('npx');
      expect(claudeSource?.servers[0].args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);

      // Verify API_KEY is redacted
      expect(claudeSource?.servers[1].env?.API_KEY).toBe('${API_KEY}');
    });

    it('should discover servers from Cursor config', () => {
      const cursorDir = join(fakeHome, '.cursor');
      mkdirSync(cursorDir, { recursive: true });
      writeFileSync(join(cursorDir, 'mcp.json'), JSON.stringify({
        mcpServers: {
          context7: {
            command: 'npx',
            args: ['-y', '@upstash/context7-mcp'],
          },
        },
      }));

      const result = discoverMcpServers(opts);
      const cursorSource = result.sources.find((s) => s.tool === 'Cursor');

      expect(cursorSource?.found).toBe(true);
      expect(cursorSource?.servers).toHaveLength(1);
      expect(cursorSource?.servers[0].name).toBe('context7');
    });

    it('should discover servers from VS Code config (uses "servers" key)', () => {
      const vscodeDir = join(fakeHome, 'Library', 'Application Support', 'Code', 'User');
      mkdirSync(vscodeDir, { recursive: true });
      writeFileSync(join(vscodeDir, 'mcp.json'), JSON.stringify({
        servers: {
          'my-server': {
            type: 'stdio',
            command: 'node',
            args: ['./server.js'],
          },
          'remote-api': {
            type: 'http',
            url: 'https://api.example.com/mcp',
          },
        },
      }));

      const result = discoverMcpServers(opts);
      const vscodeSource = result.sources.find((s) => s.tool === 'VS Code');

      expect(vscodeSource?.found).toBe(true);
      expect(vscodeSource?.servers).toHaveLength(2);
      expect(vscodeSource?.servers[0].name).toBe('my-server');
      expect(vscodeSource?.servers[0].transport).toBe('stdio');
      expect(vscodeSource?.servers[1].name).toBe('remote-api');
      expect(vscodeSource?.servers[1].transport).toBe('http');
      expect(vscodeSource?.servers[1].url).toBe('https://api.example.com/mcp');
    });

    it('should discover servers from Zed config (uses "context_servers" key)', () => {
      const zedDir = join(fakeHome, '.config', 'zed');
      mkdirSync(zedDir, { recursive: true });
      writeFileSync(join(zedDir, 'settings.json'), JSON.stringify({
        theme: 'dark',
        context_servers: {
          'local-server': {
            command: 'some-command',
            args: ['arg-1'],
          },
        },
      }));

      const result = discoverMcpServers(opts);
      const zedSource = result.sources.find((s) => s.tool === 'Zed');

      expect(zedSource?.found).toBe(true);
      expect(zedSource?.servers).toHaveLength(1);
      expect(zedSource?.servers[0].name).toBe('local-server');
      expect(zedSource?.servers[0].command).toBe('some-command');
    });

    it('should discover servers from Windsurf config', () => {
      const windsurfDir = join(fakeHome, '.codeium', 'windsurf');
      mkdirSync(windsurfDir, { recursive: true });
      writeFileSync(join(windsurfDir, 'mcp_config.json'), JSON.stringify({
        mcpServers: {
          github: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: { GITHUB_TOKEN: 'ghp_secret123' },
          },
        },
      }));

      const result = discoverMcpServers(opts);
      const windsurfSource = result.sources.find((s) => s.tool === 'Windsurf');

      expect(windsurfSource?.found).toBe(true);
      expect(windsurfSource?.servers).toHaveLength(1);
      expect(windsurfSource?.servers[0].name).toBe('github');
      // Token should be redacted
      expect(windsurfSource?.servers[0].env?.GITHUB_TOKEN).toBe('${GITHUB_TOKEN}');
    });

    it('should deduplicate servers by name (first seen wins)', () => {
      // Claude Desktop has "shared-server"
      const claudeDir = join(fakeHome, 'Library', 'Application Support', 'Claude');
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(join(claudeDir, 'claude_desktop_config.json'), JSON.stringify({
        mcpServers: {
          'shared-server': {
            command: 'npx',
            args: ['-y', 'server-v1'],
          },
        },
      }));

      // Cursor also has "shared-server"
      const cursorDir = join(fakeHome, '.cursor');
      mkdirSync(cursorDir, { recursive: true });
      writeFileSync(join(cursorDir, 'mcp.json'), JSON.stringify({
        mcpServers: {
          'shared-server': {
            command: 'npx',
            args: ['-y', 'server-v2'],
          },
        },
      }));

      const result = discoverMcpServers(opts);
      expect(result.totalServers).toBe(1);
      // First seen (Claude Desktop) wins
      expect(result.servers[0].args).toEqual(['-y', 'server-v1']);
    });

    it('should skip disabled servers', () => {
      const cursorDir = join(fakeHome, '.cursor');
      mkdirSync(cursorDir, { recursive: true });
      writeFileSync(join(cursorDir, 'mcp.json'), JSON.stringify({
        mcpServers: {
          enabled: { command: 'npx', args: ['server-a'] },
          disabled1: { command: 'npx', args: ['server-b'], disabled: true },
          disabled2: { command: 'npx', args: ['server-c'], enabled: false },
        },
      }));

      const result = discoverMcpServers(opts);
      const cursorSource = result.sources.find((s) => s.tool === 'Cursor');

      expect(cursorSource?.servers).toHaveLength(1);
      expect(cursorSource?.servers[0].name).toBe('enabled');
    });

    it('should handle JSONC (files with comments)', () => {
      const cursorDir = join(fakeHome, '.cursor');
      mkdirSync(cursorDir, { recursive: true });
      writeFileSync(join(cursorDir, 'mcp.json'), `{
        // This is a comment
        "mcpServers": {
          /* Block comment */
          "my-server": {
            "command": "npx",
            "args": ["-y", "my-server"]
          }
        }
      }`);

      const result = discoverMcpServers(opts);
      const cursorSource = result.sources.find((s) => s.tool === 'Cursor');

      expect(cursorSource?.found).toBe(true);
      expect(cursorSource?.servers).toHaveLength(1);
    });

    it('should handle malformed JSON gracefully', () => {
      const cursorDir = join(fakeHome, '.cursor');
      mkdirSync(cursorDir, { recursive: true });
      writeFileSync(join(cursorDir, 'mcp.json'), 'this is not json {{{');

      const result = discoverMcpServers(opts);
      const cursorSource = result.sources.find((s) => s.tool === 'Cursor');

      expect(cursorSource?.found).toBe(true);
      expect(cursorSource?.servers).toHaveLength(0);
      expect(cursorSource?.error).toBeDefined();
    });

    it('should handle config with no servers section', () => {
      const cursorDir = join(fakeHome, '.cursor');
      mkdirSync(cursorDir, { recursive: true });
      writeFileSync(join(cursorDir, 'mcp.json'), JSON.stringify({ someOther: 'config' }));

      const result = discoverMcpServers(opts);
      const cursorSource = result.sources.find((s) => s.tool === 'Cursor');

      expect(cursorSource?.found).toBe(true);
      expect(cursorSource?.servers).toHaveLength(0);
      expect(cursorSource?.error).toBeUndefined();
    });

    it('should infer http transport from url field', () => {
      const cursorDir = join(fakeHome, '.cursor');
      mkdirSync(cursorDir, { recursive: true });
      writeFileSync(join(cursorDir, 'mcp.json'), JSON.stringify({
        mcpServers: {
          'remote-api': {
            url: 'https://api.example.com/mcp',
            headers: { Authorization: 'Bearer token123' },
          },
        },
      }));

      const result = discoverMcpServers(opts);
      const cursorSource = result.sources.find((s) => s.tool === 'Cursor');

      expect(cursorSource?.servers).toHaveLength(1);
      expect(cursorSource?.servers[0].transport).toBe('http');
      expect(cursorSource?.servers[0].url).toBe('https://api.example.com/mcp');
      // Authorization header should be redacted
      expect(cursorSource?.servers[0].headers?.Authorization).toBe('${AUTHORIZATION}');
    });

    it('should infer sse transport from url containing /sse', () => {
      const cursorDir = join(fakeHome, '.cursor');
      mkdirSync(cursorDir, { recursive: true });
      writeFileSync(join(cursorDir, 'mcp.json'), JSON.stringify({
        mcpServers: {
          'sse-server': {
            url: 'https://api.example.com/sse',
          },
        },
      }));

      const result = discoverMcpServers(opts);
      const cursorSource = result.sources.find((s) => s.tool === 'Cursor');

      expect(cursorSource?.servers[0].transport).toBe('sse');
    });

    it('should discover Claude Code servers from nested projects structure', () => {
      writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify({
        projects: {
          '/home/user/project-a': {
            mcpServers: {
              'project-a-server': {
                type: 'stdio',
                command: 'npx',
                args: ['-y', 'server-a'],
              },
            },
          },
          '/home/user/project-b': {
            mcpServers: {
              'project-b-server': {
                type: 'http',
                url: 'https://api.b.com/mcp',
              },
            },
          },
          '/home/user/empty-project': {},
        },
      }));

      const result = discoverMcpServers(opts);
      const claudeCodeSource = result.sources.find((s) => s.tool === 'Claude Code');

      expect(claudeCodeSource?.found).toBe(true);
      expect(claudeCodeSource?.servers).toHaveLength(2);
      expect(claudeCodeSource?.servers[0].name).toBe('project-a-server');
      expect(claudeCodeSource?.servers[0].transport).toBe('stdio');
      expect(claudeCodeSource?.servers[0].command).toBe('npx');
      expect(claudeCodeSource?.servers[1].name).toBe('project-b-server');
      expect(claudeCodeSource?.servers[1].transport).toBe('http');
      expect(claudeCodeSource?.servers[1].url).toBe('https://api.b.com/mcp');
    });

    it('should deduplicate Claude Code servers across projects (first seen wins)', () => {
      writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify({
        mcpServers: {
          shared: {
            type: 'stdio',
            command: 'npx',
            args: ['top-level-version'],
          },
        },
        projects: {
          '/home/user/p1': {
            mcpServers: {
              shared: {
                type: 'stdio',
                command: 'npx',
                args: ['project-version'],
              },
            },
          },
        },
      }));

      const result = discoverMcpServers(opts);
      const claudeCodeSource = result.sources.find((s) => s.tool === 'Claude Code');

      expect(claudeCodeSource?.servers).toHaveLength(1);
      // Top-level wins over project-level
      expect(claudeCodeSource?.servers[0].args).toEqual(['top-level-version']);
    });
  });

  describe('secret redaction', () => {
    it('should redact API keys in env vars', () => {
      const cursorDir = join(fakeHome, '.cursor');
      mkdirSync(cursorDir, { recursive: true });
      writeFileSync(join(cursorDir, 'mcp.json'), JSON.stringify({
        mcpServers: {
          test: {
            command: 'npx',
            args: ['server'],
            env: {
              PATH: '/usr/bin',
              API_KEY: 'sk-secret-123',
              OPENAI_API_KEY: 'sk-openai-xyz',
              SECRET_TOKEN: 'token-abc',
              DATABASE_PASSWORD: 'pass123',
              REGION: 'us-east-1',
              NODE_ENV: 'production',
            },
          },
        },
      }));

      const result = discoverMcpServers(opts);
      const server = result.sources.find((s) => s.tool === 'Cursor')?.servers[0];

      expect(server?.env?.PATH).toBe('/usr/bin');
      expect(server?.env?.API_KEY).toBe('${API_KEY}');
      expect(server?.env?.OPENAI_API_KEY).toBe('${OPENAI_API_KEY}');
      expect(server?.env?.SECRET_TOKEN).toBe('${SECRET_TOKEN}');
      expect(server?.env?.DATABASE_PASSWORD).toBe('${DATABASE_PASSWORD}');
      expect(server?.env?.REGION).toBe('us-east-1');
      expect(server?.env?.NODE_ENV).toBe('production');
    });

    it('should redact Bearer tokens in args', () => {
      const cursorDir = join(fakeHome, '.cursor');
      mkdirSync(cursorDir, { recursive: true });
      writeFileSync(join(cursorDir, 'mcp.json'), JSON.stringify({
        mcpServers: {
          test: {
            command: 'npx',
            args: ['-y', 'mcp-remote', 'https://example.com', '--header', 'Authorization: Bearer secret123'],
          },
        },
      }));

      const result = discoverMcpServers(opts);
      const server = result.sources.find((s) => s.tool === 'Cursor')?.servers[0];

      expect(server?.args).toContain('Authorization: Bearer ${BEARER_TOKEN}');
      // Non-sensitive args preserved
      expect(server?.args).toContain('-y');
      expect(server?.args).toContain('mcp-remote');
      expect(server?.args).toContain('https://example.com');
    });
  });

  describe('discoveredServersToYaml', () => {
    it('should return empty string for no servers', () => {
      expect(discoveredServersToYaml([])).toBe('');
    });

    it('should produce valid YAML for stdio server', () => {
      const servers: DiscoveredMcpServer[] = [{
        name: 'test',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@my/server'],
      }];

      const yaml = discoveredServersToYaml(servers);
      expect(yaml).toContain('mcp:');
      expect(yaml).toContain('  servers:');
      expect(yaml).toContain('    test:');
      expect(yaml).toContain('      transport: stdio');
      expect(yaml).toContain('      command: npx');
      expect(yaml).toContain('      args: ["-y", "@my/server"]');
    });

    it('should produce valid YAML for http server', () => {
      const servers: DiscoveredMcpServer[] = [{
        name: 'api',
        transport: 'http',
        url: 'https://api.example.com/mcp',
        headers: { Authorization: '${TOKEN}' },
      }];

      const yaml = discoveredServersToYaml(servers);
      expect(yaml).toContain('      transport: http');
      expect(yaml).toContain('      url: "https://api.example.com/mcp"');
      expect(yaml).toContain('      headers:');
      expect(yaml).toContain('        Authorization: "${TOKEN}"');
    });

    it('should produce valid YAML for servers with env vars', () => {
      const servers: DiscoveredMcpServer[] = [{
        name: 'test',
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { MY_VAR: 'value', SECRET: '${SECRET}' },
      }];

      const yaml = discoveredServersToYaml(servers);
      expect(yaml).toContain('      env:');
      expect(yaml).toContain('        MY_VAR: "value"');
      expect(yaml).toContain('        SECRET: "${SECRET}"');
    });
  });

  describe('discoveredServersToYaml normalization', () => {
    it('normalizes absolute npx paths to bare "npx"', () => {
      const servers: DiscoveredMcpServer[] = [{
        name: 'test',
        transport: 'stdio',
        command: '/Users/foo/.nvm/versions/node/v22.22.1/bin/npx',
        args: ['-y', '@my/server'],
        env: { PATH: '/Users/foo/.nvm/versions/node/v22.22.1/bin:/usr/bin', OTHER: 'keep' },
      }];

      const yaml = discoveredServersToYaml(servers);
      expect(yaml).toContain('      command: npx');
      expect(yaml).not.toContain('/Users/foo');
      expect(yaml).not.toContain('/.nvm/');
      // PATH should be dropped when command was normalized
      expect(yaml).not.toMatch(/PATH:/);
      // Other env vars should be preserved
      expect(yaml).toContain('OTHER: "keep"');
    });

    it('also normalizes absolute node and python3 paths', () => {
      const servers: DiscoveredMcpServer[] = [
        { name: 'a', transport: 'stdio', command: '/opt/homebrew/bin/node', args: ['s.js'] },
        { name: 'b', transport: 'stdio', command: '/usr/local/bin/python3', args: ['s.py'] },
      ];
      const yaml = discoveredServersToYaml(servers);
      expect(yaml).toContain('      command: node');
      expect(yaml).toContain('      command: python3');
      expect(yaml).not.toContain('/opt/homebrew');
      expect(yaml).not.toContain('/usr/local');
    });

    it('leaves non-interpreter absolute paths alone', () => {
      const servers: DiscoveredMcpServer[] = [{
        name: 'custom',
        transport: 'stdio',
        command: '/opt/anaconda3/bin/supabase-mcp-server',
      }];
      const yaml = discoveredServersToYaml(servers);
      expect(yaml).toContain('      command: /opt/anaconda3/bin/supabase-mcp-server');
    });
  });

  describe('filterUnsafeServers', () => {
    it('drops unauth http/sse servers', () => {
      const servers: DiscoveredMcpServer[] = [
        { name: 'good-stdio', transport: 'stdio', command: 'npx' },
        { name: 'bad-http', transport: 'http', url: 'https://api.example.com/mcp' },
        { name: 'bad-sse', transport: 'sse', url: 'https://api.example.com/sse' },
        { name: 'good-http', transport: 'http', url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer xyz' } },
      ];
      const filtered = filterUnsafeServers(servers);
      const names = filtered.map((s) => s.name);
      expect(names).toContain('good-stdio');
      expect(names).toContain('good-http');
      expect(names).not.toContain('bad-http');
      expect(names).not.toContain('bad-sse');
    });

    it('drops servers with unresolved env var references', () => {
      const missing = '__MCP_DISCOVERY_TEST_VAR_DEFINITELY_UNSET__';
      delete process.env[missing];
      const servers: DiscoveredMcpServer[] = [
        { name: 'has-missing', transport: 'stdio', command: 'npx', env: { TOKEN: `\${${missing}}` } },
        { name: 'has-set', transport: 'stdio', command: 'npx', env: { HOME: '/tmp' } },
      ];
      const filtered = filterUnsafeServers(servers);
      const names = filtered.map((s) => s.name);
      expect(names).not.toContain('has-missing');
      expect(names).toContain('has-set');
    });
  });

  describe('getScannedTools', () => {
    it('should return list of all tool names', () => {
      const tools = getScannedTools();
      expect(tools).toContain('Claude Desktop');
      expect(tools).toContain('Claude Code');
      expect(tools).toContain('Cursor');
      expect(tools).toContain('Windsurf');
      expect(tools).toContain('VS Code');
      expect(tools).toContain('Zed');
      expect(tools).toContain('Cline');
      expect(tools).toContain('Roo Code');
      expect(tools).toContain('Copilot CLI');
      expect(tools.length).toBeGreaterThanOrEqual(9);
    });
  });
});
