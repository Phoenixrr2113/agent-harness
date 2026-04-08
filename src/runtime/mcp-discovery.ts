import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';

// --- Types ---

/** A discovered MCP server from an external tool's config */
export interface DiscoveredMcpServer {
  /** Server name (key from the source config) */
  name: string;
  /** Transport type inferred from config */
  transport: 'stdio' | 'http' | 'sse';
  /** Command for stdio transport */
  command?: string;
  /** Args for stdio transport */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Working directory */
  cwd?: string;
  /** URL for http/sse transport */
  url?: string;
  /** Headers for http/sse transport */
  headers?: Record<string, string>;
}

/** Result of scanning a single tool's config */
export interface DiscoverySource {
  /** Tool name (e.g. "Claude Desktop", "Cursor") */
  tool: string;
  /** Config file path that was scanned */
  configPath: string;
  /** Whether the config file exists */
  found: boolean;
  /** Servers discovered from this tool */
  servers: DiscoveredMcpServer[];
  /** Error encountered while reading/parsing */
  error?: string;
}

/** Aggregated discovery results */
export interface DiscoveryResult {
  /** All sources scanned */
  sources: DiscoverySource[];
  /** Deduplicated servers (by name, preferring first seen) */
  servers: DiscoveredMcpServer[];
  /** Total sources that had config files */
  sourcesFound: number;
  /** Total unique servers discovered */
  totalServers: number;
}

// --- Known tool config locations ---

interface ToolConfig {
  tool: string;
  /** Function returning config file path for the current platform */
  path: () => string;
  /** JSON key containing server definitions */
  rootKey: string;
  /** Whether servers use explicit 'type' field instead of inferring transport */
  usesTypeField?: boolean;
  /** Custom extraction for non-standard config structures. Returns merged server map. */
  extractServers?: (root: Record<string, unknown>) => Record<string, unknown>;
}

function vscodeGlobalStoragePath(h: string, mac: boolean, extensionId: string): string {
  if (mac) {
    return join(h, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', extensionId);
  }
  return join(h, '.config', 'Code', 'User', 'globalStorage', extensionId);
}

/** Claude Code extractServers — handles nested projects.<path>.mcpServers */
function extractClaudeCodeServers(root: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  // Check top-level mcpServers
  const topLevel = root.mcpServers;
  if (topLevel && typeof topLevel === 'object' && !Array.isArray(topLevel)) {
    Object.assign(merged, topLevel);
  }
  // Check per-project mcpServers under projects.<path>.mcpServers
  const projects = root.projects;
  if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
    for (const projectData of Object.values(projects as Record<string, unknown>)) {
      if (!projectData || typeof projectData !== 'object' || Array.isArray(projectData)) continue;
      const proj = projectData as Record<string, unknown>;
      const projServers = proj.mcpServers;
      if (projServers && typeof projServers === 'object' && !Array.isArray(projServers)) {
        for (const [name, config] of Object.entries(projServers as Record<string, unknown>)) {
          if (!(name in merged)) {
            merged[name] = config;
          }
        }
      }
    }
  }
  return merged;
}

/**
 * Build the list of tool configs for the given home directory and platform.
 * Evaluated lazily so tests can control the home/platform values.
 */
function buildToolConfigs(h: string, mac: boolean): ToolConfig[] {
  return [
    {
      tool: 'Claude Desktop',
      path: () => mac
        ? join(h, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : join(h, '.config', 'Claude', 'claude_desktop_config.json'),
      rootKey: 'mcpServers',
    },
    {
      tool: 'Claude Code',
      path: () => join(h, '.claude.json'),
      rootKey: 'mcpServers',
      usesTypeField: true,
      extractServers: extractClaudeCodeServers,
    },
    {
      tool: 'Cursor',
      path: () => join(h, '.cursor', 'mcp.json'),
      rootKey: 'mcpServers',
    },
    {
      tool: 'Windsurf',
      path: () => join(h, '.codeium', 'windsurf', 'mcp_config.json'),
      rootKey: 'mcpServers',
    },
    {
      tool: 'Copilot CLI',
      path: () => join(h, '.copilot', 'mcp-config.json'),
      rootKey: 'mcpServers',
    },
    {
      tool: 'Cline',
      path: () => join(vscodeGlobalStoragePath(h, mac, 'saoudrizwan.claude-dev'), 'settings', 'cline_mcp_settings.json'),
      rootKey: 'mcpServers',
    },
    {
      tool: 'Roo Code',
      path: () => join(vscodeGlobalStoragePath(h, mac, 'rooveterinaryinc.roo-cline'), 'settings', 'mcp_settings.json'),
      rootKey: 'mcpServers',
    },
    {
      tool: 'VS Code',
      path: () => mac
        ? join(h, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
        : join(h, '.config', 'Code', 'User', 'mcp.json'),
      rootKey: 'servers',
      usesTypeField: true,
    },
    {
      tool: 'Zed',
      path: () => join(h, '.config', 'zed', 'settings.json'),
      rootKey: 'context_servers',
    },
  ];
}

// --- Parsing ---

/**
 * Infer transport type from a server config object.
 * Most tools use 'command' = stdio, 'url' = http/sse.
 * VS Code uses explicit 'type' field.
 */
function inferTransport(
  serverObj: Record<string, unknown>,
  usesTypeField?: boolean,
): 'stdio' | 'http' | 'sse' {
  if (usesTypeField && typeof serverObj.type === 'string') {
    const t = serverObj.type.toLowerCase();
    if (t === 'sse') return 'sse';
    if (t === 'http') return 'http';
    if (t === 'stdio') return 'stdio';
  }

  if (typeof serverObj.command === 'string') return 'stdio';
  if (typeof serverObj.url === 'string' || typeof serverObj.serverUrl === 'string') {
    // If the URL looks like an SSE endpoint
    const url = (serverObj.url ?? serverObj.serverUrl) as string;
    if (url.includes('/sse') || serverObj.type === 'sse') return 'sse';
    return 'http';
  }

  // Default to stdio if we can't determine
  return 'stdio';
}

/**
 * Parse a server config object into a DiscoveredMcpServer.
 */
function parseServer(
  name: string,
  serverObj: Record<string, unknown>,
  usesTypeField?: boolean,
): DiscoveredMcpServer {
  const transport = inferTransport(serverObj, usesTypeField);
  const server: DiscoveredMcpServer = { name, transport };

  if (transport === 'stdio') {
    if (typeof serverObj.command === 'string') server.command = serverObj.command;
    if (Array.isArray(serverObj.args)) {
      server.args = serverObj.args
        .filter((a): a is string => typeof a === 'string')
        .map((a) => redactArgValue(a));
    }
    if (serverObj.env && typeof serverObj.env === 'object' && !Array.isArray(serverObj.env)) {
      server.env = redactEnv(filterStringRecord(serverObj.env as Record<string, unknown>));
    }
    if (typeof serverObj.cwd === 'string') server.cwd = serverObj.cwd;
  } else {
    const url = serverObj.url ?? serverObj.serverUrl;
    if (typeof url === 'string') server.url = url;
    if (serverObj.headers && typeof serverObj.headers === 'object' && !Array.isArray(serverObj.headers)) {
      // Redact auth headers
      const headers = filterStringRecord(serverObj.headers as Record<string, unknown>);
      for (const [k, v] of Object.entries(headers)) {
        if (SECRET_PATTERNS.test(k) || SECRET_PATTERNS.test(v)) {
          headers[k] = `\${${k.toUpperCase().replace(/[^A-Z0-9]/g, '_')}}`;
        }
      }
      server.headers = headers;
    }
  }

  return server;
}

/** Filter an object to only string values */
function filterStringRecord(obj: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') result[k] = v;
  }
  return result;
}

/** Patterns that indicate a secret value in env vars */
const SECRET_PATTERNS = /(?:api[_-]?key|secret|token|password|bearer|auth)/i;
/** Patterns for non-secret env vars that are always safe to copy */
const SAFE_ENV_KEYS = /^(?:PATH|HOME|NODE_ENV|NODE_OPTIONS|SHELL|LANG|LC_\w+|TZ|TERM|EDITOR)$/;

/** Pattern for Bearer tokens or similar auth values in args */
const BEARER_PATTERN = /^(Authorization:\s*Bearer\s+)\S+$/i;
const TOKEN_ARG_PATTERN = /^(--(?:token|api-key|secret|password)[=:])\S+$/i;

/**
 * Redact sensitive values that may appear in command args.
 * E.g., "Authorization: Bearer abc123" → "Authorization: Bearer ${BEARER_TOKEN}"
 */
function redactArgValue(arg: string): string {
  const bearerMatch = BEARER_PATTERN.exec(arg);
  if (bearerMatch) return `${bearerMatch[1]}\${BEARER_TOKEN}`;

  const tokenMatch = TOKEN_ARG_PATTERN.exec(arg);
  if (tokenMatch) return `${tokenMatch[1]}\${TOKEN}`;

  return arg;
}

/**
 * Redact sensitive env values, replacing them with a placeholder.
 * Safe keys (PATH, HOME, etc.) are kept. Keys matching secret patterns
 * get their values replaced with "${KEY_NAME}" for the user to fill in.
 */
function redactEnv(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (SAFE_ENV_KEYS.test(k)) {
      result[k] = v;
    } else if (SECRET_PATTERNS.test(k)) {
      result[k] = `\${${k}}`;
    } else {
      // For non-secret, non-safe keys, keep the value
      result[k] = v;
    }
  }
  return result;
}

/**
 * Read and parse a JSON config file safely.
 * Handles JSONC (comments) by stripping them outside of string literals.
 * Also handles control characters that some tools leave in their configs.
 */
function readJsonSafe(filePath: string): unknown {
  let raw = readFileSync(filePath, 'utf-8');

  // Strip control characters (except \n, \r, \t) that break JSON.parse
  // Some tools write configs with embedded control chars in string values.
  raw = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

  // Strip JSONC comments outside of string literals.
  // Walk character by character to avoid stripping // inside strings.
  let result = '';
  let inString = false;
  let escape = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];

    if (escape) {
      result += ch;
      escape = false;
      i++;
      continue;
    }

    if (inString) {
      if (ch === '\\') {
        escape = true;
        result += ch;
      } else if (ch === '"') {
        inString = false;
        result += ch;
      } else {
        result += ch;
      }
      i++;
      continue;
    }

    // Not in a string
    if (ch === '"') {
      inString = true;
      result += ch;
      i++;
    } else if (ch === '/' && i + 1 < raw.length && raw[i + 1] === '/') {
      // Single-line comment — skip to end of line
      while (i < raw.length && raw[i] !== '\n') i++;
    } else if (ch === '/' && i + 1 < raw.length && raw[i + 1] === '*') {
      // Multi-line comment — skip to */
      i += 2;
      while (i + 1 < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i += 2; // skip */
    } else {
      result += ch;
      i++;
    }
  }

  return JSON.parse(result);
}

// --- Discovery ---

/**
 * Scan a single tool's config file for MCP server definitions.
 */
function scanTool(toolConfig: ToolConfig): DiscoverySource {
  const configPath = toolConfig.path();
  const source: DiscoverySource = {
    tool: toolConfig.tool,
    configPath,
    found: false,
    servers: [],
  };

  if (!existsSync(configPath)) {
    return source;
  }

  source.found = true;

  try {
    const parsed = readJsonSafe(configPath);
    if (!parsed || typeof parsed !== 'object') {
      source.error = 'Config file is not a JSON object';
      return source;
    }

    const root = parsed as Record<string, unknown>;

    // Use custom extractor if provided, otherwise look up rootKey directly
    const serversObj = toolConfig.extractServers
      ? toolConfig.extractServers(root)
      : root[toolConfig.rootKey];

    if (!serversObj || typeof serversObj !== 'object' || Array.isArray(serversObj)) {
      // No servers section found — not an error, just nothing configured
      return source;
    }

    const entries = Object.entries(serversObj as Record<string, unknown>);
    for (const [name, value] of entries) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;

      const serverObj = value as Record<string, unknown>;

      // Skip disabled servers
      if (serverObj.disabled === true || serverObj.enabled === false) continue;

      try {
        const server = parseServer(name, serverObj, toolConfig.usesTypeField);
        // Only include servers that have enough info to be useful
        if (server.command || server.url) {
          source.servers.push(server);
        }
      } catch {
        // Skip individual servers that fail to parse
      }
    }
  } catch (err) {
    source.error = err instanceof Error ? err.message : String(err);
  }

  return source;
}

/** Options for discovery — primarily used for testing */
export interface DiscoveryOptions {
  /** Override home directory (default: os.homedir()) */
  homeDir?: string;
  /** Override platform detection (default: os.platform() === 'darwin') */
  isMac?: boolean;
}

/**
 * Scan all known tool config locations for MCP servers.
 * Returns deduplicated results with source tracking.
 */
export function discoverMcpServers(options?: DiscoveryOptions): DiscoveryResult {
  const h = options?.homeDir ?? homedir();
  const mac = options?.isMac ?? platform() === 'darwin';
  const toolConfigs = buildToolConfigs(h, mac);

  const sources: DiscoverySource[] = [];
  const seenNames = new Set<string>();
  const uniqueServers: DiscoveredMcpServer[] = [];

  for (const toolConfig of toolConfigs) {
    const source = scanTool(toolConfig);
    sources.push(source);

    // Dedupe by server name (first seen wins)
    for (const server of source.servers) {
      if (!seenNames.has(server.name)) {
        seenNames.add(server.name);
        uniqueServers.push(server);
      }
    }
  }

  return {
    sources,
    servers: uniqueServers,
    sourcesFound: sources.filter((s) => s.found).length,
    totalServers: uniqueServers.length,
  };
}

/** Binary basenames that are safe to strip from absolute paths — PATH will resolve them */
const NORMALIZABLE_BINARIES = new Set(['npx', 'node', 'python', 'python3']);

/**
 * If `command` is an absolute path whose basename is a well-known interpreter
 * (npx/node/python/python3), return just the basename. Otherwise return as-is.
 *
 * This prevents leaking user-specific paths like
 * `/Users/foo/.nvm/versions/node/v22/bin/npx` into scaffolds.
 */
function normalizeCommand(command: string): string {
  if (!command.startsWith('/')) return command;
  const base = command.substring(command.lastIndexOf('/') + 1);
  if (NORMALIZABLE_BINARIES.has(base)) return base;
  return command;
}

/** Check if an http/sse server has any form of Authorization configured */
function hasAuthConfigured(server: DiscoveredMcpServer): boolean {
  if (server.headers) {
    for (const k of Object.keys(server.headers)) {
      if (k.toLowerCase() === 'authorization') return true;
    }
  }
  return false;
}

/** Find ${VAR} placeholders in a string. Returns var names. */
function findEnvPlaceholders(value: string): string[] {
  const matches = value.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/gi);
  return Array.from(matches, (m) => m[1]);
}

/**
 * Filter out servers that won't work on this machine:
 * - http/sse servers with no Authorization header (will 401 silently)
 * - servers referencing env vars that aren't set in the current process
 *
 * Logs a warning to stderr for each skipped server explaining why.
 */
export function filterUnsafeServers(servers: DiscoveredMcpServer[]): DiscoveredMcpServer[] {
  const result: DiscoveredMcpServer[] = [];
  for (const server of servers) {
    // Drop unauth http/sse
    if (server.transport === 'http' || server.transport === 'sse') {
      if (!hasAuthConfigured(server)) {
        console.warn(`[mcp-discovery] skipping ${server.name}: ${server.transport} transport with no Authorization header`);
        continue;
      }
    }

    // Drop servers with unresolved env var references
    let missingVar: string | undefined;
    if (server.env) {
      for (const v of Object.values(server.env)) {
        for (const varName of findEnvPlaceholders(v)) {
          if (!(varName in process.env) || !process.env[varName]) {
            missingVar = varName;
            break;
          }
        }
        if (missingVar) break;
      }
    }
    if (!missingVar && server.headers) {
      for (const v of Object.values(server.headers)) {
        for (const varName of findEnvPlaceholders(v)) {
          if (!(varName in process.env) || !process.env[varName]) {
            missingVar = varName;
            break;
          }
        }
        if (missingVar) break;
      }
    }
    if (missingVar) {
      console.warn(`[mcp-discovery] skipping ${server.name}: required env var ${missingVar} not set`);
      continue;
    }

    result.push(server);
  }
  return result;
}

/**
 * Convert discovered servers to the harness config YAML format.
 * Returns a string that can be appended to config.yaml.
 *
 * Normalizes absolute paths to well-known binaries (npx/node/python) to bare
 * names so the YAML is portable across machines. When the command is normalized,
 * any PATH env var entry is dropped — it was only needed to find the absolute
 * binary location.
 */
export function discoveredServersToYaml(servers: DiscoveredMcpServer[]): string {
  if (servers.length === 0) return '';

  const lines: string[] = ['mcp:', '  servers:'];

  for (const server of servers) {
    lines.push(`    ${server.name}:`);
    lines.push(`      transport: ${server.transport}`);

    if (server.transport === 'stdio') {
      let normalizedCommand: string | undefined;
      if (server.command) {
        normalizedCommand = normalizeCommand(server.command);
        lines.push(`      command: ${normalizedCommand}`);
      }
      const wasNormalized = !!server.command && normalizedCommand !== server.command;
      if (server.args && server.args.length > 0) {
        lines.push(`      args: [${server.args.map((a) => `"${a}"`).join(', ')}]`);
      }
      // When the command was normalized to a bare binary name, drop PATH —
      // the system PATH will resolve it. Custom env vars are still kept.
      const filteredEnv = server.env
        ? Object.fromEntries(Object.entries(server.env).filter(([k]) => !(wasNormalized && k === 'PATH')))
        : undefined;
      if (filteredEnv && Object.keys(filteredEnv).length > 0) {
        lines.push('      env:');
        for (const [k, v] of Object.entries(filteredEnv)) {
          lines.push(`        ${k}: "${v}"`);
        }
      }
      if (server.cwd) lines.push(`      cwd: "${server.cwd}"`);
    } else {
      if (server.url) lines.push(`      url: "${server.url}"`);
      if (server.headers && Object.keys(server.headers).length > 0) {
        lines.push('      headers:');
        for (const [k, v] of Object.entries(server.headers)) {
          lines.push(`        ${k}: "${v}"`);
        }
      }
    }
  }

  return lines.join('\n');
}

/** Get the list of tools that are scanned (for display purposes) */
export function getScannedTools(): string[] {
  // Tool names are the same regardless of home/platform
  return buildToolConfigs('', true).map((t) => t.tool);
}
