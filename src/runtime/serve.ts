import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve as honoServe } from '@hono/node-server';
import type { Server } from 'http';
import { createWebApp } from './web-server.js';
import { log } from '../core/logger.js';
import { loadConfig } from '../core/config.js';
import { Conversation } from './conversation.js';
import { withFileLockSync } from './file-lock.js';
import type { HarnessConfig } from '../core/types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ServeOptions {
  harnessDir: string;
  port?: number;
  apiKey?: string;
  /** Secret for authenticating incoming webhooks */
  webhookSecret?: string;
  /** Enable CORS for all origins (default: true) */
  corsEnabled?: boolean;
}

export interface WebhookRegistration {
  /** Unique webhook ID */
  id: string;
  /** URL to send events to */
  url: string;
  /** Events to subscribe to (e.g., ['session_end', 'state_change']) */
  events: string[];
  /** Optional secret for signing payloads */
  secret?: string;
  /** Whether this webhook is active */
  active: boolean;
  /** Created timestamp */
  createdAt: string;
}

export interface WebhookPayload {
  event: string;
  timestamp: string;
  data: unknown;
  webhookId: string;
}

export interface WebhookStore {
  webhooks: WebhookRegistration[];
}

export interface ServeResult {
  server: Server;
  port: number;
  /** Function to fire a webhook event */
  fireEvent: (event: string, data: unknown) => Promise<void>;
  /** Function to stop the server */
  stop: () => void;
}

// ─── Webhook Store ──────────────────────────────────────────────────────────

const WEBHOOK_FILE = 'webhooks.json';

function loadWebhooks(harnessDir: string): WebhookStore {
  const filePath = join(harnessDir, 'memory', WEBHOOK_FILE);
  if (!existsSync(filePath)) return { webhooks: [] };

  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as WebhookStore;
  } catch {
    return { webhooks: [] };
  }
}

function saveWebhooks(harnessDir: string, store: WebhookStore): void {
  const memDir = join(harnessDir, 'memory');
  if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });

  const filePath = join(memDir, WEBHOOK_FILE);
  withFileLockSync(harnessDir, filePath, () => {
    writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8');
  });
}

// ─── Webhook Delivery ───────────────────────────────────────────────────────

/**
 * Fire an event to all subscribed webhooks.
 * Non-blocking — logs failures but never throws.
 */
async function fireWebhookEvent(
  harnessDir: string,
  event: string,
  data: unknown,
): Promise<void> {
  const store = loadWebhooks(harnessDir);
  const subscribers = store.webhooks.filter(
    (w) => w.active && (w.events.includes('*') || w.events.includes(event)),
  );

  if (subscribers.length === 0) return;

  const payload: Omit<WebhookPayload, 'webhookId'> = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };

  const deliveries = subscribers.map(async (webhook) => {
    try {
      const body = JSON.stringify({ ...payload, webhookId: webhook.id });
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Harness-Event': event,
        'X-Webhook-ID': webhook.id,
      };

      // HMAC signing if secret is configured
      if (webhook.secret) {
        const crypto = await import('crypto');
        const hmac = crypto.createHmac('sha256', webhook.secret);
        hmac.update(body);
        headers['X-Harness-Signature'] = `sha256=${hmac.digest('hex')}`;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        log.warn(`Webhook ${webhook.id} delivery failed: HTTP ${response.status}`);
      }
    } catch (err) {
      log.warn(`Webhook ${webhook.id} delivery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  await Promise.allSettled(deliveries);
}

// ─── Server Factory ─────────────────────────────────────────────────────────

/**
 * Create and start the harness API server.
 *
 * Includes:
 * - All dashboard endpoints from web-server.ts
 * - Webhook registration and management API
 * - Prompt execution endpoint (POST /api/run)
 * - Health check endpoint (GET /api/health)
 * - Version information endpoint (GET /api/info)
 *
 * Usage:
 * ```typescript
 * const result = startServe({
 *   harnessDir: './my-harness',
 *   port: 8080,
 *   webhookSecret: 'my-secret',
 * });
 *
 * // Fire events to registered webhooks
 * await result.fireEvent('custom_event', { key: 'value' });
 *
 * // Stop the server
 * result.stop();
 * ```
 */
export function startServe(options: ServeOptions): ServeResult {
  const {
    harnessDir,
    port = 8080,
    apiKey,
    webhookSecret,
  } = options;

  // Build the base web app (dashboard + primitives + sessions + chat + SSE)
  const { app: baseApp, broadcaster } = createWebApp(harnessDir, { apiKey });

  // Create a new Hono app that wraps the base with additional endpoints
  const app = new Hono();
  app.use('*', cors());

  // ── Authentication middleware for webhook management ──
  const requireAuth = (secret: string | undefined) => {
    return async (c: { req: { header: (name: string) => string | undefined }; json: (body: unknown, status: number) => Response }, next: () => Promise<void>): Promise<Response | void> => {
      if (!secret) return next();
      const auth = c.req.header('Authorization');
      if (!auth || auth !== `Bearer ${secret}`) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      return next();
    };
  };

  // ── Health Check ──
  app.get('/api/health', (c) => {
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      harnessDir,
    });
  });

  // ── Agent Info ──
  app.get('/api/info', (c) => {
    try {
      const config = loadConfig(harnessDir);
      return c.json({
        name: config.agent.name,
        version: config.agent.version,
        model: config.model.id,
        provider: config.model.provider,
      });
    } catch {
      return c.json({ error: 'Failed to load config' }, 500);
    }
  });

  // ── Run prompt ──
  app.post('/api/run', async (c) => {
    const body = await c.req.json<{ prompt?: string; model?: string }>().catch(() => ({} as { prompt?: string; model?: string }));
    if (!body.prompt || body.prompt.trim().length === 0) {
      return c.json({ error: 'prompt is required' }, 400);
    }

    try {
      const { createHarness } = await import('../core/harness.js');
      const harness = createHarness({
        dir: harnessDir,
        model: body.model,
        apiKey,
      });

      await harness.boot();
      const result = await harness.run(body.prompt);
      await harness.shutdown();

      // Fire webhook
      await fireWebhookEvent(harnessDir, 'run_complete', {
        prompt: body.prompt,
        text: result.text,
      });

      return c.json({
        text: result.text,
        usage: result.usage,
        steps: result.steps,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await fireWebhookEvent(harnessDir, 'run_error', {
        prompt: body.prompt,
        error: message,
      });
      return c.json({ error: message }, 500);
    }
  });

  // ── Webhook Registration API ──

  // List registered webhooks
  app.get('/api/webhooks', requireAuth(webhookSecret) as never, (c) => {
    const store = loadWebhooks(harnessDir);
    return c.json(store.webhooks.map((w) => ({
      id: w.id,
      url: w.url,
      events: w.events,
      active: w.active,
      createdAt: w.createdAt,
    })));
  });

  // Register a new webhook
  app.post('/api/webhooks', requireAuth(webhookSecret) as never, async (c) => {
    const body = await c.req.json<{
      url?: string;
      events?: string[];
      secret?: string;
    }>().catch(() => ({} as { url?: string; events?: string[]; secret?: string }));

    if (!body.url) {
      return c.json({ error: 'url is required' }, 400);
    }

    // Validate URL
    try {
      new URL(body.url);
    } catch {
      return c.json({ error: 'Invalid URL' }, 400);
    }

    const store = loadWebhooks(harnessDir);
    const id = `wh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const webhook: WebhookRegistration = {
      id,
      url: body.url,
      events: body.events ?? ['*'],
      secret: body.secret,
      active: true,
      createdAt: new Date().toISOString(),
    };

    store.webhooks.push(webhook);
    saveWebhooks(harnessDir, store);

    return c.json({ id, url: webhook.url, events: webhook.events }, 201);
  });

  // Delete a webhook
  app.delete('/api/webhooks/:id', requireAuth(webhookSecret) as never, (c) => {
    const id = c.req.param('id');
    const store = loadWebhooks(harnessDir);
    const index = store.webhooks.findIndex((w) => w.id === id);

    if (index === -1) {
      return c.json({ error: 'Webhook not found' }, 404);
    }

    store.webhooks.splice(index, 1);
    saveWebhooks(harnessDir, store);

    return c.json({ deleted: id });
  });

  // Toggle webhook active/inactive
  app.patch('/api/webhooks/:id', requireAuth(webhookSecret) as never, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<{ active?: boolean }>().catch(() => ({} as { active?: boolean }));

    const store = loadWebhooks(harnessDir);
    const webhook = store.webhooks.find((w) => w.id === id);

    if (!webhook) {
      return c.json({ error: 'Webhook not found' }, 404);
    }

    if (body.active !== undefined) {
      webhook.active = body.active;
    }

    saveWebhooks(harnessDir, store);
    return c.json({ id, active: webhook.active });
  });

  // Test a webhook (sends a test event)
  app.post('/api/webhooks/:id/test', requireAuth(webhookSecret) as never, async (c) => {
    const id = c.req.param('id');
    const store = loadWebhooks(harnessDir);
    const webhook = store.webhooks.find((w) => w.id === id);

    if (!webhook) {
      return c.json({ error: 'Webhook not found' }, 404);
    }

    try {
      const body = JSON.stringify({
        event: 'test',
        timestamp: new Date().toISOString(),
        data: { message: 'Webhook test from harness serve' },
        webhookId: webhook.id,
      });

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Harness-Event': 'test',
        'X-Webhook-ID': webhook.id,
      };

      if (webhook.secret) {
        const crypto = await import('crypto');
        const hmac = crypto.createHmac('sha256', webhook.secret);
        hmac.update(body);
        headers['X-Harness-Signature'] = `sha256=${hmac.digest('hex')}`;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timer);

      return c.json({
        success: response.ok,
        status: response.status,
        statusText: response.statusText,
      });
    } catch (err) {
      return c.json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── Mount base web app routes ──
  app.route('/', baseApp);

  // Start server
  const server = honoServe({ fetch: app.fetch, port }) as Server;

  const stop = (): void => {
    server.close();
  };

  return {
    server,
    port,
    fireEvent: (event: string, data: unknown) => fireWebhookEvent(harnessDir, event, data),
    stop,
  };
}
