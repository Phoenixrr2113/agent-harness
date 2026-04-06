import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { collectSnapshot } from './telemetry.js';
import { loadConfig } from '../core/config.js';
import { loadState, saveState } from './state.js';
import { loadAllPrimitives, loadDirectory, parseHarnessDocument } from '../primitives/loader.js';
import { listSessions } from './sessions.js';
import { CORE_PRIMITIVE_DIRS } from '../core/types.js';
import { log } from '../core/logger.js';
import type { HarnessDocument } from '../core/types.js';
import type { Server } from 'http';

// --- Types ---

export interface WebServerOptions {
  harnessDir: string;
  port?: number;
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

// --- Hono App Factory ---

export function createWebApp(harnessDir: string): { app: Hono; broadcaster: SSEBroadcaster } {
  const app = new Hono();
  const broadcaster = new SSEBroadcaster();

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
          id: doc.frontmatter.id ?? basename(doc.path, '.md'),
          path: doc.path,
          l0: doc.l0,
          tags: doc.frontmatter.tags ?? [],
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
    return c.html(buildDashboardHtml());
  });

  return { app, broadcaster };
}

// --- Server Lifecycle ---

export function startWebServer(options: WebServerOptions): { server: Server; broadcaster: SSEBroadcaster } {
  const { harnessDir, port = 3000, onStart } = options;
  const { app, broadcaster } = createWebApp(harnessDir);

  const server = serve({
    fetch: app.fetch,
    port,
  }, () => {
    log.info(`Web server started on http://localhost:${port}`);
    onStart?.(port);
  });

  return { server: server as unknown as Server, broadcaster };
}

// --- Helpers ---

function serializeDoc(doc: HarnessDocument): Record<string, unknown> {
  return {
    path: doc.path,
    frontmatter: doc.frontmatter,
    l0: doc.l0,
    l1: doc.l1,
    body: doc.body,
  };
}

// --- Inline Dashboard HTML ---

function buildDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Harness Dashboard</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #c9d1d9; --text-muted: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --red: #f85149; --yellow: #d29922;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
    background: var(--bg); color: var(--text); padding: 1rem; }
  .header { display: flex; justify-content: space-between; align-items: center;
    border-bottom: 1px solid var(--border); padding-bottom: 1rem; margin-bottom: 1rem; }
  .header h1 { font-size: 1.4rem; color: var(--accent); }
  .status { font-size: 0.85rem; color: var(--text-muted); }
  .status .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    margin-right: 4px; vertical-align: middle; }
  .dot.ok { background: var(--green); } .dot.warn { background: var(--yellow); }
  .dot.err { background: var(--red); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 1rem; margin-bottom: 1.5rem; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 1rem; }
  .card h2 { font-size: 0.9rem; color: var(--text-muted); text-transform: uppercase;
    letter-spacing: 0.05em; margin-bottom: 0.75rem; }
  .metric { display: flex; justify-content: space-between; align-items: baseline;
    padding: 0.3rem 0; }
  .metric .label { color: var(--text-muted); font-size: 0.85rem; }
  .metric .value { font-size: 1rem; font-weight: 600; }
  .value.green { color: var(--green); } .value.red { color: var(--red); }
  .value.yellow { color: var(--yellow); }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th { text-align: left; color: var(--text-muted); padding: 0.4rem 0.5rem;
    border-bottom: 1px solid var(--border); }
  td { padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--border); }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 12px;
    font-size: 0.75rem; font-weight: 500; }
  .badge.green { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge.red { background: rgba(248,81,73,0.15); color: var(--red); }
  .badge.yellow { background: rgba(210,153,34,0.15); color: var(--yellow); }
  .events { max-height: 200px; overflow-y: auto; font-size: 0.8rem;
    font-family: monospace; background: var(--bg); padding: 0.5rem;
    border-radius: 4px; border: 1px solid var(--border); }
  .events .event { padding: 0.2rem 0; color: var(--text-muted); }
  .events .event .type { color: var(--accent); margin-right: 0.5rem; }
  .events .event .time { color: var(--text-muted); opacity: 0.6; margin-right: 0.5rem; }
  #error { display: none; background: rgba(248,81,73,0.1); border: 1px solid var(--red);
    color: var(--red); padding: 0.75rem; border-radius: 6px; margin-bottom: 1rem; }
  .refresh-btn { background: var(--surface); border: 1px solid var(--border);
    color: var(--accent); padding: 0.3rem 0.75rem; border-radius: 4px; cursor: pointer;
    font-size: 0.8rem; }
  .refresh-btn:hover { background: var(--border); }
</style>
</head>
<body>
<div class="header">
  <h1 id="title">Agent Harness</h1>
  <div>
    <span class="status" id="connection"><span class="dot warn"></span> Connecting...</span>
    <button class="refresh-btn" onclick="refresh()">Refresh</button>
  </div>
</div>
<div id="error"></div>

<div class="grid">
  <div class="card">
    <h2>Agent</h2>
    <div id="agent-info">Loading...</div>
  </div>
  <div class="card">
    <h2>Health</h2>
    <div id="health-info">Loading...</div>
  </div>
  <div class="card">
    <h2>Spending</h2>
    <div id="spending-info">Loading...</div>
  </div>
  <div class="card">
    <h2>Sessions</h2>
    <div id="sessions-info">Loading...</div>
  </div>
</div>

<div class="grid">
  <div class="card">
    <h2>Workflows</h2>
    <div id="workflows-info">Loading...</div>
  </div>
  <div class="card">
    <h2>Primitives</h2>
    <div id="primitives-info">Loading...</div>
  </div>
  <div class="card">
    <h2>MCP Servers</h2>
    <div id="mcp-info">Loading...</div>
  </div>
  <div class="card">
    <h2>Live Events</h2>
    <div class="events" id="events-log"></div>
  </div>
</div>

<script>
let eventSource;
const eventsLog = document.getElementById('events-log');

function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = msg; el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 5000);
}

function setConnection(ok) {
  const el = document.getElementById('connection');
  el.innerHTML = ok
    ? '<span class="dot ok"></span> Connected'
    : '<span class="dot err"></span> Disconnected';
}

function metric(label, value, cls) {
  return '<div class="metric"><span class="label">' + label + '</span>'
    + '<span class="value' + (cls ? ' ' + cls : '') + '">' + value + '</span></div>';
}

function badge(text, cls) {
  return '<span class="badge ' + cls + '">' + text + '</span>';
}

function fmt$(v) { return '$' + (v || 0).toFixed(2); }

function renderSnapshot(s) {
  document.getElementById('title').textContent = s.agent.name + ' Dashboard';
  document.title = s.agent.name + ' — Dashboard';

  // Agent
  document.getElementById('agent-info').innerHTML =
    metric('Name', s.agent.name) +
    metric('Version', s.agent.version) +
    metric('Mode', badge(s.agent.mode, s.agent.mode === 'idle' ? 'green' : 'yellow')) +
    metric('Last Active', new Date(s.agent.lastInteraction).toLocaleString());

  // Health
  const h = s.health;
  const hClass = h.status === 'healthy' ? 'green' : h.status === 'degraded' ? 'yellow' : 'red';
  document.getElementById('health-info').innerHTML =
    metric('Status', badge(h.status, hClass)) +
    metric('Uptime', h.uptimeSeconds ? Math.floor(h.uptimeSeconds / 60) + 'm' : 'N/A') +
    metric('Consecutive OK', h.consecutiveSuccesses || 0, 'green') +
    metric('Consecutive Fail', h.consecutiveFailures || 0, h.consecutiveFailures > 0 ? 'red' : '');

  // Spending
  const sp = s.spending;
  document.getElementById('spending-info').innerHTML =
    metric('Today', fmt$(sp.today.totalCost)) +
    metric('This Month', fmt$(sp.thisMonth.totalCost)) +
    metric('All Time', fmt$(sp.allTime.totalCost)) +
    metric('Tokens Today', (sp.today.totalInputTokens + sp.today.totalOutputTokens).toLocaleString());

  // Sessions
  document.getElementById('sessions-info').innerHTML =
    metric('Total', s.sessions.total) +
    metric('Total Tokens', s.sessions.totalTokens.toLocaleString()) +
    metric('Avg Tokens/Session', Math.round(s.sessions.avgTokensPerSession).toLocaleString()) +
    metric('Delegations', s.sessions.delegationCount);

  // Workflows
  const w = s.workflows;
  if (w.stats.length === 0) {
    document.getElementById('workflows-info').innerHTML =
      '<div style="color:var(--text-muted)">No workflow runs yet.</div>';
  } else {
    let html = metric('Total Runs', w.totalRuns) +
      metric('Success Rate', (w.overallSuccessRate * 100).toFixed(0) + '%',
        w.overallSuccessRate >= 0.9 ? 'green' : w.overallSuccessRate >= 0.7 ? 'yellow' : 'red');
    html += '<table><tr><th>Workflow</th><th>Runs</th><th>Rate</th></tr>';
    for (const ws of w.stats) {
      const rate = ws.runs > 0 ? ((ws.successes / ws.runs) * 100).toFixed(0) + '%' : 'N/A';
      html += '<tr><td>' + ws.id + '</td><td>' + ws.runs + '</td><td>' + rate + '</td></tr>';
    }
    html += '</table>';
    document.getElementById('workflows-info').innerHTML = html;
  }

  // Primitives (storage)
  const st = s.storage;
  document.getElementById('primitives-info').innerHTML =
    metric('Total Primitives', st.primitiveCount) +
    metric('Sessions', st.sessionCount) +
    metric('Journal Entries', st.journalCount) +
    metric('Weekly Summaries', st.weeklyCount);

  // MCP
  const m = s.mcp;
  if (m.serverCount === 0) {
    document.getElementById('mcp-info').innerHTML =
      '<div style="color:var(--text-muted)">No MCP servers configured.</div>';
  } else {
    let html = metric('Servers', m.serverCount) + metric('Enabled', m.enabledCount);
    html += '<table><tr><th>Name</th><th>Transport</th><th>Status</th></tr>';
    for (const srv of m.servers) {
      const status = srv.valid ? badge('OK', 'green') : badge(srv.error || 'Invalid', 'red');
      html += '<tr><td>' + srv.name + '</td><td>' + srv.transport + '</td><td>' + status + '</td></tr>';
    }
    html += '</table>';
    document.getElementById('mcp-info').innerHTML = html;
  }
}

function addEvent(type, data) {
  const time = new Date().toLocaleTimeString();
  const el = document.createElement('div');
  el.className = 'event';
  el.innerHTML = '<span class="time">' + time + '</span>'
    + '<span class="type">' + type + '</span>'
    + '<span>' + (typeof data === 'string' ? data : JSON.stringify(data)) + '</span>';
  eventsLog.prepend(el);
  // Keep max 50 events
  while (eventsLog.children.length > 50) eventsLog.removeChild(eventsLog.lastChild);
}

async function refresh() {
  try {
    const res = await fetch('/api/snapshot');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const snapshot = await res.json();
    renderSnapshot(snapshot);
  } catch (e) {
    showError('Failed to load: ' + e.message);
  }
}

function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/events');
  eventSource.addEventListener('connected', (e) => {
    setConnection(true);
    addEvent('connected', 'SSE stream established');
    refresh();
  });
  eventSource.addEventListener('file_change', (e) => {
    const data = JSON.parse(e.data);
    addEvent('file_change', data.path + ' (' + data.event + ')');
    // Auto-refresh on file changes
    refresh();
  });
  eventSource.addEventListener('index_rebuild', (e) => {
    const data = JSON.parse(e.data);
    addEvent('index_rebuild', data.directory);
  });
  eventSource.addEventListener('auto_process', (e) => {
    const data = JSON.parse(e.data);
    addEvent('auto_process', data.path + ': ' + (data.fixes || []).join(', '));
  });
  eventSource.addEventListener('config_change', () => {
    addEvent('config_change', 'Config reloaded');
    refresh();
  });
  eventSource.addEventListener('snapshot', (e) => {
    const snapshot = JSON.parse(e.data);
    renderSnapshot(snapshot);
  });
  eventSource.onerror = () => {
    setConnection(false);
    // Auto-reconnect is built into EventSource
  };
}

// Boot
refresh();
connectSSE();
// Periodic refresh every 30s as fallback
setInterval(refresh, 30000);
</script>
</body>
</html>`;
}
