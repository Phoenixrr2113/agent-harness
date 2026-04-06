import { createMCPClient, type MCPClient, type MCPClientConfig } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { ToolSet } from 'ai';
import type { HarnessConfig } from '../core/types.js';
import { log, getGlobalLogLevel } from '../core/logger.js';

// --- Types ---

/** Single MCP server configuration (mirrors config schema) */
export interface McpServerConfig {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

/** Result of connecting to an MCP server */
export interface McpServerConnection {
  name: string;
  client: MCPClient;
  toolCount: number;
  tools: ToolSet;
}

/** Summary of an MCP server for display */
export interface McpServerSummary {
  name: string;
  transport: string;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  toolNames: string[];
  error?: string;
}

/** Manages all MCP server connections for a harness */
export interface McpManager {
  /** Connect to all enabled MCP servers and load their tools */
  connect(): Promise<void>;
  /** Get merged tool set from all connected servers */
  getTools(): ToolSet;
  /** Get summary of all configured servers */
  getSummaries(): McpServerSummary[];
  /** Close all connected clients */
  close(): Promise<void>;
  /** Check if any servers are configured */
  hasServers(): boolean;
}

// --- Transport Factory ---

/**
 * Build an MCPClientConfig from a server config entry.
 * Maps transport type to the appropriate transport configuration.
 */
function buildClientConfig(name: string, serverConfig: McpServerConfig): MCPClientConfig {
  switch (serverConfig.transport) {
    case 'stdio': {
      if (!serverConfig.command) {
        throw new Error(`MCP server "${name}": stdio transport requires "command" field`);
      }
      // Suppress MCP server stderr noise unless --verbose (log level debug)
      const stderr = getGlobalLogLevel() === 'debug' ? 'inherit' as const : 'pipe' as const;
      return {
        transport: new Experimental_StdioMCPTransport({
          command: serverConfig.command,
          args: serverConfig.args,
          env: serverConfig.env ? { ...process.env, ...serverConfig.env } as Record<string, string> : undefined,
          cwd: serverConfig.cwd,
          stderr,
        }),
        name: `harness-mcp-${name}`,
      };
    }
    case 'http': {
      if (!serverConfig.url) {
        throw new Error(`MCP server "${name}": http transport requires "url" field`);
      }
      return {
        transport: {
          type: 'http' as const,
          url: serverConfig.url,
          headers: serverConfig.headers,
        },
        name: `harness-mcp-${name}`,
      };
    }
    case 'sse': {
      if (!serverConfig.url) {
        throw new Error(`MCP server "${name}": sse transport requires "url" field`);
      }
      return {
        transport: {
          type: 'sse' as const,
          url: serverConfig.url,
          headers: serverConfig.headers,
        },
        name: `harness-mcp-${name}`,
      };
    }
    default:
      throw new Error(`MCP server "${name}": unknown transport "${serverConfig.transport}"`);
  }
}

// --- Connection ---

/**
 * Connect to a single MCP server and load its tools.
 * Returns the connection with tool set, or throws on failure.
 */
async function connectToServer(name: string, serverConfig: McpServerConfig): Promise<McpServerConnection> {
  const clientConfig = buildClientConfig(name, serverConfig);
  const client = await createMCPClient(clientConfig);

  // Load tools with auto-discovery (no schema pre-definition needed)
  const tools = await client.tools();
  const toolCount = Object.keys(tools).length;

  return { name, client, toolCount, tools };
}

// --- Manager ---

/**
 * Create an MCP manager from harness config.
 * Manages lifecycle of all MCP server connections.
 */
export function createMcpManager(config: HarnessConfig): McpManager {
  const servers = config.mcp?.servers ?? {};
  const connections: McpServerConnection[] = [];
  const summaries: McpServerSummary[] = [];

  return {
    hasServers(): boolean {
      return Object.keys(servers).length > 0;
    },

    async connect(): Promise<void> {
      const entries = Object.entries(servers);

      if (entries.length === 0) {
        return;
      }

      log.info(`Connecting to ${entries.length} MCP server(s)...`);

      for (const [name, serverConfig] of entries) {
        const enabled = serverConfig.enabled !== false;

        if (!enabled) {
          summaries.push({
            name,
            transport: serverConfig.transport,
            enabled: false,
            connected: false,
            toolCount: 0,
            toolNames: [],
          });
          log.debug(`MCP server "${name}" is disabled, skipping`);
          continue;
        }

        try {
          const connection = await connectToServer(name, serverConfig);
          connections.push(connection);

          const toolNames = Object.keys(connection.tools);
          summaries.push({
            name,
            transport: serverConfig.transport,
            enabled: true,
            connected: true,
            toolCount: connection.toolCount,
            toolNames,
          });

          log.info(`MCP "${name}": connected, ${connection.toolCount} tool(s) [${toolNames.join(', ')}]`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          summaries.push({
            name,
            transport: serverConfig.transport,
            enabled: true,
            connected: false,
            toolCount: 0,
            toolNames: [],
            error: message,
          });

          log.warn(`MCP "${name}": connection failed — ${message}`);
        }
      }

      const totalTools = connections.reduce((sum, c) => sum + c.toolCount, 0);
      if (totalTools > 0) {
        log.info(`MCP: ${totalTools} tool(s) loaded from ${connections.length} server(s)`);
      }
    },

    getTools(): ToolSet {
      const merged: ToolSet = {};
      for (const connection of connections) {
        Object.assign(merged, connection.tools);
      }
      return merged;
    },

    getSummaries(): McpServerSummary[] {
      // Include unchecked servers that haven't been connected yet
      const serverNames = Object.keys(servers);
      const checkedNames = new Set(summaries.map((s) => s.name));

      for (const name of serverNames) {
        if (!checkedNames.has(name)) {
          const serverConfig = servers[name];
          summaries.push({
            name,
            transport: serverConfig.transport,
            enabled: serverConfig.enabled !== false,
            connected: false,
            toolCount: 0,
            toolNames: [],
          });
        }
      }

      return [...summaries];
    },

    async close(): Promise<void> {
      const closePromises = connections.map(async (connection) => {
        try {
          await connection.client.close();
          log.debug(`MCP "${connection.name}": closed`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(`MCP "${connection.name}": close failed — ${message}`);
        }
      });

      await Promise.all(closePromises);
      connections.length = 0;
    },
  };
}

/**
 * Load MCP tools from all enabled servers in config.
 * Convenience function for one-shot usage (connects, loads, returns tools + close fn).
 */
export async function loadMcpTools(config: HarnessConfig): Promise<{
  tools: ToolSet;
  summaries: McpServerSummary[];
  close: () => Promise<void>;
}> {
  const manager = createMcpManager(config);
  await manager.connect();

  return {
    tools: manager.getTools(),
    summaries: manager.getSummaries(),
    close: () => manager.close(),
  };
}

/**
 * Validate MCP server configurations without connecting.
 * Returns validation errors for each server.
 */
export function validateMcpConfig(config: HarnessConfig): Array<{ server: string; error: string }> {
  const errors: Array<{ server: string; error: string }> = [];
  const servers = config.mcp?.servers ?? {};

  for (const [name, serverConfig] of Object.entries(servers)) {
    if (serverConfig.transport === 'stdio') {
      if (!serverConfig.command) {
        errors.push({ server: name, error: 'stdio transport requires "command" field' });
      }
    } else if (serverConfig.transport === 'http' || serverConfig.transport === 'sse') {
      if (!serverConfig.url) {
        errors.push({ server: name, error: `${serverConfig.transport} transport requires "url" field` });
      }
    } else {
      errors.push({ server: name, error: `unknown transport "${serverConfig.transport}"` });
    }
  }

  return errors;
}
