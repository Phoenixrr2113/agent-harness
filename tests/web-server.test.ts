import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createWebApp } from '../src/runtime/web-server.js';
import { scaffoldHarness } from '../src/cli/scaffold.js';

describe('web-server', () => {
  let harnessDir: string;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'web-server-test-'));
    harnessDir = join(base, 'test-agent');
    scaffoldHarness(harnessDir, 'test-agent');
  });

  afterEach(() => {
    if (existsSync(harnessDir)) {
      rmSync(harnessDir, { recursive: true, force: true });
    }
  });

  function fetch(app: ReturnType<typeof createWebApp>['app'], path: string, init?: RequestInit): Promise<Response> {
    return app.request(path, init);
  }

  describe('API routes', () => {
    it('GET /api/snapshot should return telemetry data', async () => {
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/snapshot');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.agent).toBeDefined();
      expect(data.agent.name).toBe('test-agent');
      expect(data.health).toBeDefined();
      expect(data.spending).toBeDefined();
      expect(data.sessions).toBeDefined();
      expect(data.storage).toBeDefined();
      expect(data.mcp).toBeDefined();
    });

    it('GET /api/config should return config', async () => {
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/config');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.agent.name).toBe('test-agent');
      expect(data.model).toBeDefined();
    });

    it('GET /api/state should return agent state', async () => {
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/state');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.mode).toBeDefined();
    });

    it('PUT /api/state should update agent state', async () => {
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'active' }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.mode).toBe('active');

      // Verify it persisted
      const res2 = await fetch(app, '/api/state');
      const data2 = await res2.json();
      expect(data2.mode).toBe('active');
    });

    it('GET /api/primitives should return grouped primitives', async () => {
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/primitives');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(typeof data).toBe('object');
    });

    it('GET /api/primitives/:type should return primitives of a type', async () => {
      // Create a rule
      writeFileSync(join(harnessDir, 'rules', 'test-rule.md'), '---\nid: test-rule\n---\n# Test Rule\n\nContent.');
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/primitives/rules');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(1);
    });

    it('GET /api/primitives/:type should return 404 for unknown type', async () => {
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/primitives/unknown');
      expect(res.status).toBe(404);
    });

    it('GET /api/primitives/:type/:file should return single primitive', async () => {
      writeFileSync(join(harnessDir, 'rules', 'my-rule.md'), '---\nid: my-rule\n---\n# My Rule\n\nContent.');
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/primitives/rules/my-rule');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.frontmatter.id).toBe('my-rule');
      expect(data.body).toContain('# My Rule');
    });

    it('GET /api/primitives/:type/:file should return 404 for missing file', async () => {
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/primitives/rules/nonexistent');
      expect(res.status).toBe(404);
    });

    it('PUT /api/primitives/:type/:file should update a primitive', async () => {
      writeFileSync(join(harnessDir, 'rules', 'edit-me.md'), '---\nid: edit-me\n---\n# Original');
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/primitives/rules/edit-me', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '---\nid: edit-me\n---\n# Updated Content\n\nNew body.' }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.body).toContain('# Updated Content');
    });

    it('PUT /api/primitives/:type/:file should reject invalid body', async () => {
      writeFileSync(join(harnessDir, 'rules', 'bad-edit.md'), '---\nid: bad-edit\n---\n# Rule');
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/primitives/rules/bad-edit', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wrong: 'field' }),
      });
      expect(res.status).toBe(400);
    });

    it('GET /api/sessions should return session list', async () => {
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/sessions');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
    });

    it('GET /api/sessions/:id should return 404 for missing session', async () => {
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/sessions/2024-01-01-fake');
      expect(res.status).toBe(404);
    });

    it('GET /api/sessions/:id should return session content', async () => {
      mkdirSync(join(harnessDir, 'memory', 'sessions'), { recursive: true });
      writeFileSync(join(harnessDir, 'memory', 'sessions', 'test-session.md'), '# Session\n\nContent.');
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/sessions/test-session');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe('test-session');
      expect(data.content).toContain('# Session');
    });

    it('GET /api/events/clients should return client count', async () => {
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/events/clients');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.count).toBe(0);
    });
  });

  describe('Dashboard', () => {
    it('GET / should return HTML dashboard', async () => {
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/');
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('test-agent');
      expect(html).toContain('Dashboard');
      // Dashboard JS calls api('snapshot') which fetches /api/snapshot
      expect(html).toContain("api('snapshot')");
      expect(html).toContain('EventSource');
    });

    it('GET / should include navigation and panels', async () => {
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/');
      const html = await res.text();
      // Sidebar navigation
      expect(html).toContain('data-p="dashboard"');
      expect(html).toContain('data-p="chat"');
      expect(html).toContain('data-p="files"');
      expect(html).toContain('data-p="mcp"');
      expect(html).toContain('data-p="settings"');
      // Panels
      expect(html).toContain('id="p-dashboard"');
      expect(html).toContain('id="p-chat"');
      expect(html).toContain('id="p-files"');
      expect(html).toContain('id="p-mcp"');
      expect(html).toContain('id="p-settings"');
    });
  });

  describe('Chat API', () => {
    it('POST /api/chat should reject empty message', async () => {
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('POST /api/chat should reject missing message field', async () => {
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      expect(res.status).toBe(400);
    });

    it('POST /api/chat/reset should return ok', async () => {
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/chat/reset', { method: 'POST' });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
    });
  });

  describe('MCP API', () => {
    it('GET /api/mcp should return MCP status', async () => {
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/mcp');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.serverCount).toBeDefined();
      expect(data.enabledCount).toBeDefined();
      expect(Array.isArray(data.servers)).toBe(true);
      expect(Array.isArray(data.errors)).toBe(true);
    });

    it('GET /api/mcp should detect invalid servers', async () => {
      // Append MCP config with an invalid server (stdio transport, no command)
      const configPath = join(harnessDir, 'config.yaml');
      const config = readFileSync(configPath, 'utf-8');
      writeFileSync(configPath, config + '\nmcp:\n  servers:\n    bad-server:\n      transport: stdio\n      enabled: true\n', 'utf-8');

      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/mcp');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.serverCount).toBe(1);
      // Should report error for missing command
      expect(data.errors.length).toBeGreaterThan(0);
      expect(data.errors[0].server).toBe('bad-server');
    });
  });

  describe('File Tree API', () => {
    it('GET /api/files should return file tree', async () => {
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/files');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
      // Should contain rules, instincts, etc.
      const names = data.map((n: { name: string }) => n.name);
      expect(names).toContain('rules');
      expect(names).toContain('instincts');
      expect(names).toContain('IDENTITY.md');
    });

    it('GET /api/files/* should read a file', async () => {
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/files/IDENTITY.md');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.path).toBe('IDENTITY.md');
      expect(data.content).toContain('test-agent');
      expect(data.size).toBeGreaterThan(0);
      expect(data.modified).toBeDefined();
    });

    it('GET /api/files/* should return 404 for missing file', async () => {
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/files/nonexistent.md');
      expect(res.status).toBe(404);
    });

    it('PUT /api/files/* should write a file in primitive dirs', async () => {
      writeFileSync(join(harnessDir, 'rules', 'test.md'), '# Test');
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/files/rules/test.md', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '# Updated Test' }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);

      // Verify written
      const content = readFileSync(join(harnessDir, 'rules', 'test.md'), 'utf-8');
      expect(content).toBe('# Updated Test');
    });

    it('PUT /api/files/* should reject writes outside allowed dirs', async () => {
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/files/memory/scratch.md', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hacked' }),
      });
      expect(res.status).toBe(403);
    });

    it('PUT /api/files/* should allow writing core files', async () => {
      const { app } = createWebApp(harnessDir);
      const originalIdentity = readFileSync(join(harnessDir, 'IDENTITY.md'), 'utf-8');
      const res = await fetch(app, '/api/files/IDENTITY.md', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: originalIdentity + '\n\n## Extra Section' }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe('Config Update API', () => {
    it('PUT /api/config should update and validate config', async () => {
      const { app } = createWebApp(harnessDir);
      const configContent = readFileSync(join(harnessDir, 'config.yaml'), 'utf-8');
      const res = await fetch(app, '/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: configContent }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.agent).toBe('test-agent');
    });

    it('PUT /api/config should reject missing content field', async () => {
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: 'wrong' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('SSE Broadcaster', () => {
    it('GET /api/events should return SSE stream', async () => {
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/events');
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    });

    it('broadcaster should track connected clients', async () => {
      const { broadcaster } = createWebApp(harnessDir);
      expect(broadcaster.clientCount).toBe(0);
    });
  });

  describe('CORS', () => {
    it('should include CORS headers', async () => {
      const { app } = createWebApp(harnessDir);
      const res = await fetch(app, '/api/config');
      // Hono CORS middleware adds these headers
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });
});
