import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scaffoldHarness } from '../src/cli/scaffold.js';
import { startServe } from '../src/runtime/serve.js';
import type { ServeResult } from '../src/runtime/serve.js';

describe('serve', () => {
  let harnessDir: string;
  let tmpBase: string;
  let serveResult: ServeResult | undefined;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'serve-test-'));
    harnessDir = join(tmpBase, 'test-agent');
    scaffoldHarness(harnessDir, 'test-agent', { template: 'base' });
  });

  afterEach(() => {
    if (serveResult) {
      serveResult.stop();
      serveResult = undefined;
    }
    if (existsSync(tmpBase)) {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  function startServer(port: number, opts?: { webhookSecret?: string }): ServeResult {
    serveResult = startServe({
      harnessDir,
      port,
      webhookSecret: opts?.webhookSecret,
    });
    return serveResult;
  }

  describe('health check', () => {
    it('should return ok status', async () => {
      const { port } = startServer(0);

      // Wait for server to start
      await new Promise((r) => setTimeout(r, 100));

      const addr = serveResult!.server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;

      const res = await fetch(`http://localhost:${actualPort}/api/health`);
      expect(res.ok).toBe(true);

      const body = await res.json() as { status: string; harnessDir: string };
      expect(body.status).toBe('ok');
      expect(body.harnessDir).toBe(harnessDir);
    });
  });

  describe('agent info', () => {
    it('should return agent configuration', async () => {
      startServer(0);
      await new Promise((r) => setTimeout(r, 100));

      const addr = serveResult!.server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : 0;

      const res = await fetch(`http://localhost:${actualPort}/api/info`);
      expect(res.ok).toBe(true);

      const body = await res.json() as { name: string };
      expect(body.name).toBe('test-agent');
    });
  });

  describe('run endpoint', () => {
    it('should reject empty prompt', async () => {
      startServer(0);
      await new Promise((r) => setTimeout(r, 100));

      const addr = serveResult!.server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : 0;

      const res = await fetch(`http://localhost:${actualPort}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('prompt');
    });
  });

  describe('webhook management', () => {
    it('should register a webhook', async () => {
      startServer(0);
      await new Promise((r) => setTimeout(r, 100));

      const addr = serveResult!.server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : 0;

      const res = await fetch(`http://localhost:${actualPort}/api/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com/webhook',
          events: ['run_complete'],
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as { id: string; url: string; events: string[] };
      expect(body.id).toBeTruthy();
      expect(body.url).toBe('https://example.com/webhook');
      expect(body.events).toEqual(['run_complete']);
    });

    it('should list webhooks', async () => {
      startServer(0);
      await new Promise((r) => setTimeout(r, 100));

      const addr = serveResult!.server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : 0;

      // Register one
      await fetch(`http://localhost:${actualPort}/api/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/hook' }),
      });

      const res = await fetch(`http://localhost:${actualPort}/api/webhooks`);
      expect(res.ok).toBe(true);

      const body = await res.json() as Array<{ id: string; url: string }>;
      expect(body).toHaveLength(1);
      expect(body[0].url).toBe('https://example.com/hook');
    });

    it('should delete a webhook', async () => {
      startServer(0);
      await new Promise((r) => setTimeout(r, 100));

      const addr = serveResult!.server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : 0;

      // Register
      const createRes = await fetch(`http://localhost:${actualPort}/api/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/delete-me' }),
      });
      const { id } = await createRes.json() as { id: string };

      // Delete
      const delRes = await fetch(`http://localhost:${actualPort}/api/webhooks/${id}`, {
        method: 'DELETE',
      });
      expect(delRes.ok).toBe(true);

      // Verify deleted
      const listRes = await fetch(`http://localhost:${actualPort}/api/webhooks`);
      const list = await listRes.json() as Array<{ id: string }>;
      expect(list).toHaveLength(0);
    });

    it('should reject invalid URL', async () => {
      startServer(0);
      await new Promise((r) => setTimeout(r, 100));

      const addr = serveResult!.server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : 0;

      const res = await fetch(`http://localhost:${actualPort}/api/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'not-a-url' }),
      });

      expect(res.status).toBe(400);
    });

    it('should toggle webhook active state', async () => {
      startServer(0);
      await new Promise((r) => setTimeout(r, 100));

      const addr = serveResult!.server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : 0;

      // Register
      const createRes = await fetch(`http://localhost:${actualPort}/api/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/toggle' }),
      });
      const { id } = await createRes.json() as { id: string };

      // Toggle off
      const patchRes = await fetch(`http://localhost:${actualPort}/api/webhooks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false }),
      });
      expect(patchRes.ok).toBe(true);

      const body = await patchRes.json() as { active: boolean };
      expect(body.active).toBe(false);
    });

    it('should require auth when webhookSecret is set', async () => {
      startServer(0, { webhookSecret: 'test-secret' });
      await new Promise((r) => setTimeout(r, 100));

      const addr = serveResult!.server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : 0;

      // Without auth
      const noAuthRes = await fetch(`http://localhost:${actualPort}/api/webhooks`);
      expect(noAuthRes.status).toBe(401);

      // With auth
      const authRes = await fetch(`http://localhost:${actualPort}/api/webhooks`, {
        headers: { Authorization: 'Bearer test-secret' },
      });
      expect(authRes.ok).toBe(true);
    });

    it('should persist webhooks to disk', async () => {
      startServer(0);
      await new Promise((r) => setTimeout(r, 100));

      const addr = serveResult!.server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : 0;

      await fetch(`http://localhost:${actualPort}/api/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/persist' }),
      });

      const filePath = join(harnessDir, 'memory', 'webhooks.json');
      expect(existsSync(filePath)).toBe(true);

      const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(raw.webhooks).toHaveLength(1);
    });
  });

  describe('dashboard passthrough', () => {
    it('should serve the dashboard at root', async () => {
      startServer(0);
      await new Promise((r) => setTimeout(r, 100));

      const addr = serveResult!.server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : 0;

      const res = await fetch(`http://localhost:${actualPort}/`);
      expect(res.ok).toBe(true);

      const html = await res.text();
      expect(html).toContain('Dashboard');
    });
  });

  describe('fireEvent', () => {
    it('should have a fireEvent function', () => {
      startServer(0);
      expect(typeof serveResult!.fireEvent).toBe('function');
    });
  });
});
