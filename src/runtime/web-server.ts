import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { collectSnapshot } from './telemetry.js';
import { loadConfig } from '../core/config.js';
import { loadState, saveState } from './state.js';
import { loadAllPrimitives, loadDirectory, parseHarnessDocument } from '../primitives/loader.js';
import { listSessions } from './sessions.js';
import { validateMcpConfig } from './mcp.js';
import { Conversation } from './conversation.js';
import { CORE_PRIMITIVE_DIRS } from '../core/types.js';
import { log } from '../core/logger.js';
import type { HarnessDocument } from '../core/types.js';
import type { ConversationSendResult } from './conversation.js';
import type { Server } from 'http';

// --- Types ---

export interface WebServerOptions {
  harnessDir: string;
  port?: number;
  /** API key for LLM calls (chat) */
  apiKey?: string;
  /** Callback when server starts */
  onStart?: (port: number) => void;
}

export interface ServerSentEvent {
  type: string;
  data: unknown;
  timestamp: string;
}

// --- SSE Client Manager ---

type SSEClient = {
  id: string;
  controller: ReadableStreamDefaultController;
};

class SSEBroadcaster {
  private clients: SSEClient[] = [];
  private nextId = 0;

  addClient(controller: ReadableStreamDefaultController): string {
    const id = String(this.nextId++);
    this.clients.push({ id, controller });
    return id;
  }

  removeClient(id: string): void {
    this.clients = this.clients.filter((c) => c.id !== id);
  }

  broadcast(event: ServerSentEvent): void {
    const message = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    const encoder = new TextEncoder();
    const encoded = encoder.encode(message);

    for (const client of this.clients) {
      try {
        client.controller.enqueue(encoded);
      } catch {
        // Client disconnected — will be cleaned up
      }
    }
  }

  get clientCount(): number {
    return this.clients.length;
  }
}

// --- File Tree Helpers ---

interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
  size?: number;
  modified?: string;
}

function buildFileTree(baseDir: string, dirPath: string, maxDepth = 3, depth = 0): FileTreeNode[] {
  if (depth >= maxDepth || !existsSync(dirPath)) return [];

  const entries = readdirSync(dirPath);
  const nodes: FileTreeNode[] = [];

  for (const entry of entries) {
    if (entry.startsWith('.') && entry !== '.gitignore') continue;
    if (entry === 'node_modules') continue;

    const fullPath = join(dirPath, entry);
    const relPath = relative(baseDir, fullPath);

    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        nodes.push({
          name: entry,
          path: relPath,
          type: 'directory',
          children: buildFileTree(baseDir, fullPath, maxDepth, depth + 1),
        });
      } else {
        nodes.push({
          name: entry,
          path: relPath,
          type: 'file',
          size: stat.size,
          modified: stat.mtime.toISOString(),
        });
      }
    } catch {
      // Skip inaccessible files
    }
  }

  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// --- Hono App Factory ---

export interface CreateWebAppOptions {
  apiKey?: string;
}

export function createWebApp(harnessDir: string, options?: CreateWebAppOptions): { app: Hono; broadcaster: SSEBroadcaster } {
  const app = new Hono();
  const broadcaster = new SSEBroadcaster();
  let conversation: Conversation | null = null;

  // CORS for local development
  app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT'],
    allowHeaders: ['Content-Type'],
  }));

  // --- API Routes ---

  // Full telemetry snapshot
  app.get('/api/snapshot', (c) => {
    try {
      const snapshot = collectSnapshot(harnessDir);
      return c.json(snapshot);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to collect snapshot' }, 500);
    }
  });

  // Current config
  app.get('/api/config', (c) => {
    try {
      const config = loadConfig(harnessDir);
      return c.json(config);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to load config' }, 500);
    }
  });

  // Agent state
  app.get('/api/state', (c) => {
    try {
      const state = loadState(harnessDir);
      return c.json(state);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to load state' }, 500);
    }
  });

  // Update agent state (partial)
  app.put('/api/state', async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const current = loadState(harnessDir);
      const updated = { ...current, ...body };
      saveState(harnessDir, updated);
      return c.json(updated);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to update state' }, 500);
    }
  });

  // All primitives grouped by directory
  app.get('/api/primitives', (c) => {
    try {
      const config = loadConfig(harnessDir);
      const extDirs = config.extensions?.directories ?? [];
      const all = loadAllPrimitives(harnessDir, extDirs);
      const result: Record<string, Array<{ id: string; path: string; l0: string | null; tags: string[] }>> = {};

      for (const [dir, docs] of all.entries()) {
        result[dir] = docs.map((doc) => ({
          id: doc.id,
          path: doc.path,
          l0: doc.description ?? doc.id,
          tags: doc.tags,
        }));
      }

      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to load primitives' }, 500);
    }
  });

  // Primitives of a specific type
  app.get('/api/primitives/:type', (c) => {
    const type = c.req.param('type');
    if (!(CORE_PRIMITIVE_DIRS as readonly string[]).includes(type) && type !== 'intake') {
      return c.json({ error: `Unknown primitive type: ${type}` }, 404);
    }

    try {
      const dirPath = join(harnessDir, type);
      if (!existsSync(dirPath)) {
        return c.json([]);
      }

      const docs = loadDirectory(dirPath);
      return c.json(docs.map(serializeDoc));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to load primitives' }, 500);
    }
  });

  // Single primitive by type and filename
  app.get('/api/primitives/:type/:file', (c) => {
    const type = c.req.param('type');
    const file = c.req.param('file');
    const filePath = join(harnessDir, type, file.endsWith('.md') ? file : `${file}.md`);

    if (!existsSync(filePath)) {
      return c.json({ error: `Primitive not found: ${type}/${file}` }, 404);
    }

    try {
      const doc = parseHarnessDocument(filePath);
      return c.json(serializeDoc(doc));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to parse primitive' }, 500);
    }
  });

  // Update a primitive's content
  app.put('/api/primitives/:type/:file', async (c) => {
    const type = c.req.param('type');
    const file = c.req.param('file');
    const filePath = join(harnessDir, type, file.endsWith('.md') ? file : `${file}.md`);

    if (!existsSync(filePath)) {
      return c.json({ error: `Primitive not found: ${type}/${file}` }, 404);
    }

    try {
      const body = await c.req.json() as { content: string };
      if (typeof body.content !== 'string') {
        return c.json({ error: 'Request body must have a "content" string field' }, 400);
      }
      writeFileSync(filePath, body.content, 'utf-8');
      const doc = parseHarnessDocument(filePath);
      return c.json(serializeDoc(doc));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to update primitive' }, 500);
    }
  });

  // Session list
  app.get('/api/sessions', (c) => {
    try {
      const sessions = listSessions(harnessDir);
      return c.json(sessions);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to list sessions' }, 500);
    }
  });

  // Read a session file
  app.get('/api/sessions/:id', (c) => {
    const id = c.req.param('id');
    const sessionsDir = join(harnessDir, 'memory', 'sessions');
    const filePath = join(sessionsDir, `${id}.md`);

    if (!existsSync(filePath)) {
      return c.json({ error: `Session not found: ${id}` }, 404);
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      return c.json({ id, content });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to read session' }, 500);
    }
  });

  // --- Chat API ---

  // Send a message and get a response
  app.post('/api/chat', async (c) => {
    try {
      const body = await c.req.json() as { message: string };
      if (typeof body.message !== 'string' || !body.message.trim()) {
        return c.json({ error: 'Request body must have a non-empty "message" string field' }, 400);
      }

      // Initialize conversation on first message
      if (!conversation) {
        conversation = new Conversation(harnessDir, options?.apiKey);
        await conversation.init();
      }

      const result: ConversationSendResult = await conversation.send(body.message);

      // Broadcast to SSE clients
      broadcaster.broadcast({
        type: 'chat_response',
        data: { text: result.text, usage: result.usage, steps: result.steps },
        timestamp: new Date().toISOString(),
      });

      return c.json({
        text: result.text,
        usage: result.usage,
        steps: result.steps,
        toolCalls: result.toolCalls,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Chat error' }, 500);
    }
  });

  // Reset conversation (clear history)
  app.post('/api/chat/reset', (c) => {
    conversation = null;
    return c.json({ ok: true });
  });

  // --- MCP Status API ---

  app.get('/api/mcp', (c) => {
    try {
      const config = loadConfig(harnessDir);
      const errors = validateMcpConfig(config);
      const errorServerNames = new Set(errors.map((e) => e.server));

      const servers = Object.entries(config.mcp.servers).map(([name, server]) => ({
        name,
        transport: server.transport,
        enabled: server.enabled,
        valid: !errorServerNames.has(name),
        command: server.command,
        url: server.url,
        error: errors.find((e) => e.server === name)?.error,
      }));

      return c.json({
        serverCount: servers.length,
        enabledCount: servers.filter((s) => s.enabled).length,
        servers,
        errors,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'MCP status error' }, 500);
    }
  });

  // --- File Tree API ---

  // Get full file tree
  app.get('/api/files', (c) => {
    try {
      const tree = buildFileTree(harnessDir, harnessDir);
      return c.json(tree);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to build file tree' }, 500);
    }
  });

  // Read a file by relative path (supports nested paths via wildcard)
  app.get('/api/files/*', (c) => {
    const relPath = c.req.path.replace('/api/files/', '');
    if (!relPath) {
      return c.json({ error: 'File path required' }, 400);
    }

    const filePath = join(harnessDir, relPath);

    // Security: prevent path traversal
    if (!filePath.startsWith(harnessDir)) {
      return c.json({ error: 'Access denied: path traversal detected' }, 403);
    }
    if (!existsSync(filePath)) {
      return c.json({ error: 'File not found' }, 404);
    }

    try {
      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        return c.json({ error: 'Path is a directory, not a file' }, 400);
      }
      const content = readFileSync(filePath, 'utf-8');
      return c.json({ path: relPath, content, size: stat.size, modified: stat.mtime.toISOString() });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to read file' }, 500);
    }
  });

  // Write a file (only within primitive dirs + core files)
  app.put('/api/files/*', async (c) => {
    const relPath = c.req.path.replace('/api/files/', '');
    if (!relPath) {
      return c.json({ error: 'File path required' }, 400);
    }

    const filePath = join(harnessDir, relPath);
    if (!filePath.startsWith(harnessDir)) {
      return c.json({ error: 'Access denied: path traversal detected' }, 403);
    }

    // Only allow editing within primitive dirs + top-level md/yaml files
    const allowedPrefixes = ['rules/', 'instincts/', 'skills/', 'playbooks/', 'workflows/', 'tools/', 'agents/'];
    const allowedFiles = ['CORE.md', 'SYSTEM.md', 'state.md', 'config.yaml'];
    const isAllowed = allowedPrefixes.some((p) => relPath.startsWith(p)) || allowedFiles.includes(relPath);
    if (!isAllowed) {
      return c.json({ error: 'Cannot edit files outside primitive directories and core files' }, 403);
    }

    try {
      const body = await c.req.json() as { content: string };
      if (typeof body.content !== 'string') {
        return c.json({ error: 'Request body must have a "content" string field' }, 400);
      }
      writeFileSync(filePath, body.content, 'utf-8');
      return c.json({ ok: true, path: relPath });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to write file' }, 500);
    }
  });

  // --- Config Update API ---

  app.put('/api/config', async (c) => {
    try {
      const configPath = join(harnessDir, 'config.yaml');
      const body = await c.req.json() as { content: string };
      if (typeof body.content !== 'string') {
        return c.json({ error: 'Request body must have a "content" string field' }, 400);
      }
      writeFileSync(configPath, body.content, 'utf-8');

      // Validate by reloading
      const config = loadConfig(harnessDir);

      broadcaster.broadcast({
        type: 'config_change',
        data: { model: config.model.id },
        timestamp: new Date().toISOString(),
      });

      return c.json({ ok: true, agent: config.agent.name });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to update config' }, 500);
    }
  });

  // SSE Events stream
  app.get('/api/events', (c) => {
    const stream = new ReadableStream({
      start(controller) {
        const clientId = broadcaster.addClient(controller);

        // Send initial connection event
        const encoder = new TextEncoder();
        const connectMsg = `event: connected\ndata: ${JSON.stringify({ clientId, timestamp: new Date().toISOString() })}\n\n`;
        controller.enqueue(encoder.encode(connectMsg));

        // Handle client disconnect via abort signal
        c.req.raw.signal.addEventListener('abort', () => {
          broadcaster.removeClient(clientId);
        });
      },
      cancel() {
        // Stream cancelled
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  });

  // SSE client count (for monitoring)
  app.get('/api/events/clients', (c) => {
    return c.json({ count: broadcaster.clientCount });
  });

  // --- Dashboard HTML ---
  app.get('/', (c) => {
    return c.html(buildDashboardHtml(harnessDir));
  });

  return { app, broadcaster };
}

// --- Server Lifecycle ---

export async function startWebServer(options: WebServerOptions): Promise<{ server: Server; broadcaster: SSEBroadcaster }> {
  const { harnessDir, port: preferredPort = 3000, apiKey, onStart } = options;
  const { app, broadcaster } = createWebApp(harnessDir, { apiKey });
  const maxAttempts = 10;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = preferredPort + attempt;
    try {
      const server = await new Promise<Server>((resolve, reject) => {
        const s = serve({ fetch: app.fetch, port }, () => {
          log.info(`Web server started on http://localhost:${port}`);
          onStart?.(port);
          resolve(s as unknown as Server);
        });
        (s as unknown as Server).on('error', reject);
      });
      return { server, broadcaster };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE' && attempt < maxAttempts - 1) {
        log.warn(`Port ${port} in use, trying ${port + 1}...`);
        continue;
      }
      throw err;
    }
  }

  throw new Error(`No available port found (tried ${preferredPort}-${preferredPort + maxAttempts - 1})`);
}

// --- Helpers ---

function serializeDoc(doc: HarnessDocument): Record<string, unknown> {
  return {
    path: doc.path,
    frontmatter: doc.frontmatter,
    id: doc.id,
    name: doc.name,
    description: doc.description,
    body: doc.body,
  };
}

// --- Inline Dashboard HTML ---

function buildDashboardHtml(harnessDir: string): string {
  let agentName = 'Agent';
  try {
    const config = loadConfig(harnessDir);
    agentName = config.agent.name;
  } catch { /* ignore */ }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(agentName)} Dashboard</title>
<style>
:root{--bg:#0d1117;--surface:#161b22;--border:#30363d;--text:#c9d1d9;--dim:#8b949e;--accent:#58a6ff;--green:#3fb950;--red:#f85149;--yellow:#d29922;--font:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--font);background:var(--bg);color:var(--text);font-size:13px;line-height:1.5}
.layout{display:grid;grid-template-columns:200px 1fr;grid-template-rows:44px 1fr;height:100vh}
.topbar{grid-column:1/-1;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 16px;gap:12px}
.topbar h1{font-size:14px;font-weight:600;color:var(--accent)}
.topbar .status{font-size:11px;color:var(--dim);display:flex;align-items:center;gap:4px}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block}
.dot.ok{background:var(--green)}.dot.warn{background:var(--yellow)}.dot.err{background:var(--red)}
.sidebar{background:var(--surface);border-right:1px solid var(--border);overflow-y:auto;padding-top:8px}
.nav{display:block;padding:6px 16px;color:var(--dim);cursor:pointer;border:none;background:none;width:100%;text-align:left;font:inherit;font-size:12px}
.nav:hover{background:var(--border);color:var(--text)}.nav.active{color:var(--accent);background:rgba(88,166,255,.1)}
.main{overflow-y:auto;padding:16px}
.panel{display:none}.panel.active{display:block}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin-bottom:16px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px}
.card h3{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.m{display:flex;justify-content:space-between;padding:2px 0;font-size:12px}
.m .l{color:var(--dim)}.m .v{font-weight:600}
.v.g{color:var(--green)}.v.r{color:var(--red)}.v.y{color:var(--yellow)}
.badge{display:inline-block;padding:1px 6px;border-radius:10px;font-size:10px;font-weight:500}
.badge.g{background:rgba(63,185,80,.15);color:var(--green)}
.badge.r{background:rgba(248,81,73,.15);color:var(--red)}
.badge.y{background:rgba(210,153,34,.15);color:var(--yellow)}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;color:var(--dim);padding:4px 6px;border-bottom:1px solid var(--border);font-size:10px;text-transform:uppercase}
td{padding:4px 6px;border-bottom:1px solid var(--border)}
.events{max-height:180px;overflow-y:auto;font-size:11px;font-family:monospace;background:var(--bg);padding:6px;border-radius:4px;border:1px solid var(--border)}
.events .ev{padding:1px 0;color:var(--dim)}.events .ev .t{color:var(--accent);margin-right:6px}
.chat-wrap{display:flex;flex-direction:column;height:calc(100vh - 76px)}
.chat-msgs{flex:1;overflow-y:auto;padding:8px 0}
.msg{padding:6px 0}.msg .role{font-size:10px;font-weight:600;margin-bottom:1px}
.msg .role.user{color:var(--accent)}.msg .role.assistant{color:var(--green)}
.msg .body{white-space:pre-wrap;word-wrap:break-word}.msg .meta{font-size:10px;color:var(--dim);margin-top:2px}
.chat-bar{display:flex;gap:6px;padding:8px 0;border-top:1px solid var(--border)}
.chat-bar input{flex:1;background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:8px 10px;color:var(--text);font:inherit;outline:none}
.chat-bar input:focus{border-color:var(--accent)}
.chat-bar button{background:var(--accent);color:#fff;border:none;border-radius:4px;padding:8px 16px;cursor:pointer;font:inherit;font-weight:600}
.chat-bar button:disabled{opacity:.5;cursor:not-allowed}
.editor-wrap{display:grid;grid-template-columns:220px 1fr;gap:12px;height:calc(100vh - 76px)}
.tree{font-size:11px;overflow-y:auto}
.tree .d{cursor:pointer;padding:2px 0}.tree .d::before{content:'\\25b8 ';color:var(--dim)}.tree .d.open::before{content:'\\25be '}
.tree .f{padding:2px 0 2px 14px;cursor:pointer;color:var(--dim)}.tree .f:hover{color:var(--accent)}
.tree .ch{padding-left:14px;display:none}.tree .d.open+.ch{display:block}
.ed-area{display:flex;flex-direction:column}
.ed-head{padding:6px 0;font-size:11px;color:var(--dim);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}
.ed-ta{flex:1;background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:10px;color:var(--text);font:inherit;font-size:11px;resize:none;outline:none;tab-size:2}
.ed-ta:focus{border-color:var(--accent)}
.save-btn{background:var(--green);color:var(--bg);border:none;border-radius:3px;padding:3px 10px;cursor:pointer;font:inherit;font-size:10px;font-weight:600}
.config-block{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px;white-space:pre-wrap;font-size:11px;font-family:monospace;overflow-x:auto;min-height:200px}
.toast-box{position:fixed;bottom:16px;right:16px;z-index:1000}
.toast{background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:8px 12px;margin-top:6px;font-size:11px}
</style>
</head>
<body>
<div class="layout">
<div class="topbar">
  <h1 id="title">${escapeHtml(agentName)}</h1>
  <div class="status"><span class="dot warn" id="sdot"></span><span id="stxt">connecting</span></div>
  <div style="flex:1"></div>
  <div class="status"><span class="dot ok" style="animation:pulse 2s infinite"></span>live</div>
</div>
<div class="sidebar">
  <button class="nav active" data-p="dashboard">Dashboard</button>
  <button class="nav" data-p="chat">Chat</button>
  <button class="nav" data-p="files">Files</button>
  <button class="nav" data-p="mcp">MCP Servers</button>
  <button class="nav" data-p="settings">Settings</button>
</div>
<div class="main">

<!-- Dashboard -->
<div class="panel active" id="p-dashboard">
  <div class="grid" id="dash-cards"></div>
  <div class="grid">
    <div class="card"><h3>Health Checks</h3><div id="dash-health"></div></div>
    <div class="card"><h3>MCP Servers</h3><div id="dash-mcp"></div></div>
    <div class="card"><h3>Live Events</h3><div class="events" id="evlog"></div></div>
  </div>
</div>

<!-- Chat -->
<div class="panel" id="p-chat">
  <div class="chat-wrap">
    <div style="display:flex;justify-content:space-between;align-items:center;padding-bottom:6px">
      <strong>Chat</strong>
      <button class="save-btn" onclick="resetChat()">Reset</button>
    </div>
    <div class="chat-msgs" id="chat-msgs"></div>
    <div class="chat-bar">
      <input type="text" id="chat-in" placeholder="Type a message..." autocomplete="off">
      <button id="chat-btn">Send</button>
    </div>
  </div>
</div>

<!-- Files -->
<div class="panel" id="p-files">
  <div class="editor-wrap">
    <div class="tree" id="ftree"></div>
    <div class="ed-area">
      <div class="ed-head"><span id="ed-path">Select a file</span><button class="save-btn" id="ed-save" style="display:none" onclick="saveFile()">Save</button></div>
      <textarea class="ed-ta" id="ed-ta" disabled placeholder="Select a file..."></textarea>
    </div>
  </div>
</div>

<!-- MCP -->
<div class="panel" id="p-mcp">
  <h2 style="margin-bottom:12px">MCP Servers</h2>
  <div id="mcp-detail"></div>
</div>

<!-- Settings -->
<div class="panel" id="p-settings">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
    <h2>config.yaml</h2>
    <button class="save-btn" onclick="saveConfig()">Save Config</button>
  </div>
  <textarea class="config-block" id="cfg-ta" style="width:100%;min-height:400px;resize:vertical"></textarea>
</div>

</div>
</div>
<div class="toast-box" id="toasts"></div>
<style>@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}</style>
<script>
(function(){
let curPanel='dashboard',curFile=null,sending=false;

// Nav
document.querySelectorAll('.nav').forEach(b=>{b.addEventListener('click',()=>{
  document.querySelectorAll('.nav').forEach(n=>n.classList.remove('active'));b.classList.add('active');
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  const p=b.dataset.p;document.getElementById('p-'+p).classList.add('active');curPanel=p;
  if(p==='dashboard')loadDash();if(p==='files')loadTree();if(p==='mcp')loadMcp();if(p==='settings')loadCfg();
})});

// Helpers
async function api(path,opts){const r=await fetch('/api/'+path,opts);if(!r.ok){const e=await r.json().catch(()=>({error:r.statusText}));throw new Error(e.error||r.statusText)}return r.json()}
function toast(m){const e=document.createElement('div');e.className='toast';e.textContent=m;document.getElementById('toasts').appendChild(e);setTimeout(()=>e.remove(),4000)}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
function mt(l,v,c){return '<div class="m"><span class="l">'+esc(l)+'</span><span class="v'+(c?' '+c:'')+'">'+v+'</span></div>'}
function bg(t,c){return '<span class="badge '+c+'">'+esc(t)+'</span>'}
function f$(v){return '$'+(v||0).toFixed(2)}

// Dashboard
async function loadDash(){try{
  const s=await api('snapshot');
  document.getElementById('title').textContent=s.agent.name;document.title=s.agent.name+' Dashboard';
  const c=document.getElementById('dash-cards');c.innerHTML='';
  function card(l,v,sub){c.innerHTML+='<div class="card"><h3>'+esc(l)+'</h3><div style="font-size:18px;font-weight:700">'+esc(String(v))+'</div>'+(sub?'<div style="font-size:10px;color:var(--dim);margin-top:2px">'+esc(sub)+'</div>':'')+'</div>'}
  card('Status',s.health.status,s.agent.mode);
  card('Sessions',s.sessions.total,s.sessions.totalTokens.toLocaleString()+' tokens');
  card('Today',f$(s.spending.today.total_cost_usd),s.spending.today.entries+' calls');
  card('Monthly',f$(s.spending.thisMonth.total_cost_usd));
  card('Workflows',s.workflows.totalRuns+' runs',s.workflows.overallSuccessRate.toFixed(0)+'% success');
  card('Primitives',s.storage.primitiveCount,s.storage.sessionCount+' sessions');
  card('MCP',s.mcp.enabledCount+'/'+s.mcp.serverCount+' servers');
  card('Last Active',s.agent.lastInteraction==='never'?'never':new Date(s.agent.lastInteraction).toLocaleString());
  // Health dot
  const dot=document.getElementById('sdot');const txt=document.getElementById('stxt');
  dot.className='dot '+(s.health.status==='healthy'?'ok':s.health.status==='degraded'?'warn':'err');
  txt.textContent=s.health.status;
  // Health checks
  const hh=document.getElementById('dash-health');
  hh.innerHTML=s.health.checks.length===0?'<span style="color:var(--dim)">No checks</span>':
    '<table><tr><th>Check</th><th>Status</th><th>Message</th></tr>'+s.health.checks.map(c=>'<tr><td>'+esc(c.name)+'</td><td>'+bg(c.status,c.status==='pass'?'g':c.status==='warn'?'y':'r')+'</td><td>'+esc(c.message)+'</td></tr>').join('')+'</table>';
  // MCP summary
  const mm=document.getElementById('dash-mcp');
  mm.innerHTML=s.mcp.servers.length===0?'<span style="color:var(--dim)">None configured</span>':
    '<table><tr><th>Name</th><th>Transport</th><th>Status</th></tr>'+s.mcp.servers.map(s=>'<tr><td>'+esc(s.name)+'</td><td>'+esc(s.transport)+'</td><td>'+(s.enabled?(s.valid?bg('ok','g'):bg('error','r')):bg('disabled','y'))+'</td></tr>').join('')+'</table>';
}catch(e){toast('Dashboard: '+e.message)}}

// Chat
const chatIn=document.getElementById('chat-in'),chatBtn=document.getElementById('chat-btn'),chatMsgs=document.getElementById('chat-msgs');
function addMsg(role,text,meta){const d=document.createElement('div');d.className='msg';d.innerHTML='<div class="role '+role+'">'+role+'</div><div class="body">'+esc(text)+'</div>'+(meta?'<div class="meta">'+esc(meta)+'</div>':'');chatMsgs.appendChild(d);chatMsgs.scrollTop=chatMsgs.scrollHeight}
async function sendChat(){const m=chatIn.value.trim();if(!m||sending)return;sending=true;chatBtn.disabled=true;chatIn.value='';addMsg('user',m);
  try{const r=await api('chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:m})});addMsg('assistant',r.text,r.usage?r.usage.totalTokens+' tokens, '+r.steps+' step(s)':'');if(r.toolCalls&&r.toolCalls.length>0)addMsg('assistant','Tools: '+r.toolCalls.map(t=>t.toolName).join(', '))}catch(e){addMsg('assistant','Error: '+e.message)}
  sending=false;chatBtn.disabled=false;chatIn.focus()}
chatBtn.addEventListener('click',sendChat);chatIn.addEventListener('keydown',e=>{if(e.key==='Enter')sendChat()});
async function resetChat(){try{await api('chat/reset',{method:'POST'});chatMsgs.innerHTML='';toast('Chat reset')}catch(e){toast('Reset error: '+e.message)}}
window.resetChat=resetChat;

// Files
async function loadTree(){try{const tree=await api('files');const el=document.getElementById('ftree');el.innerHTML=renderTree(tree);bindTree(el)}catch(e){toast('File tree: '+e.message)}}
function renderTree(nodes){return nodes.map(n=>{if(n.type==='directory')return '<div class="d" data-p="'+esc(n.path)+'">'+esc(n.name)+'</div><div class="ch">'+renderTree(n.children||[])+'</div>';return '<div class="f" data-p="'+esc(n.path)+'">'+esc(n.name)+'</div>'}).join('')}
function bindTree(el){el.querySelectorAll('.d').forEach(d=>d.addEventListener('click',()=>d.classList.toggle('open')));el.querySelectorAll('.f').forEach(f=>f.addEventListener('click',()=>openFile(f.dataset.p)))}
async function openFile(path){try{const f=await api('files/'+path);curFile=path;document.getElementById('ed-path').textContent=path;document.getElementById('ed-ta').value=f.content;document.getElementById('ed-ta').disabled=false;document.getElementById('ed-save').style.display='inline-block'}catch(e){toast('Open: '+e.message)}}
async function saveFile(){if(!curFile)return;try{await api('files/'+curFile,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:document.getElementById('ed-ta').value})});toast('Saved: '+curFile)}catch(e){toast('Save: '+e.message)}}
window.saveFile=saveFile;

// MCP
async function loadMcp(){try{const d=await api('mcp');const el=document.getElementById('mcp-detail');
  if(d.servers.length===0){el.innerHTML='<p style="color:var(--dim)">No MCP servers configured.</p>';return}
  el.innerHTML='<table><tr><th>Name</th><th>Transport</th><th>Enabled</th><th>Valid</th><th>Details</th></tr>'+d.servers.map(s=>'<tr><td>'+esc(s.name)+'</td><td>'+esc(s.transport)+'</td><td>'+(s.enabled?bg('yes','g'):bg('no','y'))+'</td><td>'+(s.valid?bg('valid','g'):bg('invalid','r'))+'</td><td style="font-size:10px;color:var(--dim)">'+esc(s.command||s.url||'')+'</td></tr>').join('')+'</table>';
  if(d.errors.length>0)el.innerHTML+='<h3 style="margin:12px 0 6px;color:var(--red)">Errors</h3><ul>'+d.errors.map(e=>'<li style="color:var(--red);font-size:11px">'+esc(e.server+': '+e.error)+'</li>').join('')+'</ul>'}catch(e){toast('MCP: '+e.message)}}

// Settings
async function loadCfg(){try{const f=await api('files/config.yaml');document.getElementById('cfg-ta').value=f.content}catch(e){toast('Config: '+e.message)}}
async function saveConfig(){try{await api('config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:document.getElementById('cfg-ta').value})});toast('Config saved and reloaded')}catch(e){toast('Config save: '+e.message)}}
window.saveConfig=saveConfig;

// SSE
const evlog=document.getElementById('evlog');
function addEv(type,data){const t=new Date().toLocaleTimeString();const e=document.createElement('div');e.className='ev';e.innerHTML='<span style="color:var(--dim);opacity:.6;margin-right:4px">'+t+'</span><span class="t">'+type+'</span>'+esc(typeof data==='string'?data:JSON.stringify(data));evlog.prepend(e);while(evlog.children.length>50)evlog.removeChild(evlog.lastChild)}
function connectSSE(){const es=new EventSource('/api/events');
  es.addEventListener('connected',()=>{document.getElementById('sdot').className='dot ok';document.getElementById('stxt').textContent='connected';addEv('connected','SSE established');loadDash()});
  es.addEventListener('file_change',e=>{const d=JSON.parse(e.data);addEv('file_change',d.path+' ('+d.event+')');if(curPanel==='dashboard')loadDash();if(curPanel==='files')loadTree()});
  es.addEventListener('index_rebuild',e=>{addEv('index_rebuild',JSON.parse(e.data).directory)});
  es.addEventListener('auto_process',e=>{const d=JSON.parse(e.data);addEv('auto_process',d.path+': '+(d.fixes||[]).join(', '))});
  es.addEventListener('config_change',()=>{addEv('config_change','reloaded');if(curPanel==='dashboard')loadDash();if(curPanel==='settings')loadCfg()});
  es.addEventListener('chat_response',e=>{addEv('chat',JSON.parse(e.data).text?.slice(0,60)||'...')});
  es.onerror=()=>{document.getElementById('sdot').className='dot err';document.getElementById('stxt').textContent='disconnected'}}

loadDash();connectSSE();setInterval(()=>{if(curPanel==='dashboard')loadDash()},30000);
})();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
