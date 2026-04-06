import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import YAML from 'yaml';
import type { HarnessConfig } from '../core/types.js';
import { loadConfig } from '../core/config.js';
import type { McpServerConfig } from './mcp.js';
import { createMcpManager, validateMcpConfig } from './mcp.js';
import type { ResolvedServer, RegistryEnvVar, RegistryServer, RegistrySearchResponse } from './mcp-registry.js';
import { findServer, searchServers, searchRegistry, getRegistryServer } from './mcp-registry.js';
import { log } from '../core/logger.js';

// Re-export registry types and functions for consumers
export { searchRegistry, getRegistryServer };
export type { RegistryServer, RegistrySearchResponse, RegistryEnvVar, ResolvedServer };
export type { RegistryPackage, RegistryRemote, RegistrySearchResult } from './mcp-registry.js';

// --- Types ---

/** Result of installing an MCP server */
export interface McpInstallResult {
  /** Whether installation succeeded */
  installed: boolean;
  /** Server config name in config.yaml */
  name: string;
  /** The resolved server details */
  server?: ResolvedServer;
  /** Connection test results */
  connectionTest?: {
    connected: boolean;
    toolCount: number;
    toolNames: string[];
    error?: string;
  };
  /** Generated tool doc paths */
  generatedDocs: string[];
  /** Env vars that need user configuration */
  pendingEnvVars: RegistryEnvVar[];
  /** Error message if installation failed */
  error?: string;
}

/** Options for the install command */
export interface McpInstallOptions {
  /** Harness directory */
  dir: string;
  /** Skip connection testing */
  skipTest?: boolean;
  /** Skip tool doc generation */
  skipDocs?: boolean;
  /** Force overwrite if server already exists */
  force?: boolean;
  /** Custom name override for the server in config */
  name?: string;
}

// --- Config Update ---

const CONFIG_FILENAMES = ['config.yaml', 'config.yml', 'harness.yaml', 'harness.yml'];

/**
 * Find the config file path in a harness directory.
 */
function findConfigPath(dir: string): string {
  for (const filename of CONFIG_FILENAMES) {
    const configPath = join(dir, filename);
    if (existsSync(configPath)) {
      return configPath;
    }
  }
  return join(dir, 'config.yaml');
}

/**
 * Add or update an MCP server entry in the config file.
 * Preserves existing config structure and comments where possible.
 */
export function updateConfigWithServer(
  dir: string,
  serverName: string,
  serverConfig: McpServerConfig,
): void {
  const configPath = findConfigPath(dir);
  const content = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';

  // Parse existing YAML, preserving structure
  const doc = YAML.parseDocument(content);

  // Ensure mcp.servers exists
  if (!doc.has('mcp')) {
    doc.set('mcp', doc.createNode({ servers: {} }));
  }
  const mcp = doc.get('mcp') as YAML.YAMLMap;
  if (!mcp.has('servers')) {
    mcp.set('servers', doc.createNode({}));
  }
  const servers = mcp.get('servers') as YAML.YAMLMap;

  // Build the server config node
  const configNode: Record<string, unknown> = {
    transport: serverConfig.transport,
  };

  if (serverConfig.transport === 'stdio') {
    if (serverConfig.command) configNode['command'] = serverConfig.command;
    if (serverConfig.args && serverConfig.args.length > 0) configNode['args'] = serverConfig.args;
    if (serverConfig.env && Object.keys(serverConfig.env).length > 0) configNode['env'] = serverConfig.env;
    if (serverConfig.cwd) configNode['cwd'] = serverConfig.cwd;
  } else {
    if (serverConfig.url) configNode['url'] = serverConfig.url;
    if (serverConfig.headers && Object.keys(serverConfig.headers).length > 0) {
      configNode['headers'] = serverConfig.headers;
    }
  }

  // Set the server entry (add or overwrite)
  servers.set(serverName, doc.createNode(configNode));

  // Write back
  writeFileSync(configPath, doc.toString(), 'utf-8');
}

/**
 * Check if a server name already exists in the config.
 */
export function serverExistsInConfig(dir: string, serverName: string): boolean {
  try {
    const config = loadConfig(dir);
    return Boolean(config.mcp?.servers?.[serverName]);
  } catch {
    return false;
  }
}

// --- Tool Doc Generation ---

/**
 * Generate a tools/*.md knowledge doc from a connected MCP server's tools.
 * Creates one file per MCP server with descriptions of all available tools.
 */
export function generateToolDocs(
  dir: string,
  serverName: string,
  toolNames: string[],
  description?: string,
): string[] {
  const toolsDir = join(dir, 'tools');
  if (!existsSync(toolsDir)) {
    mkdirSync(toolsDir, { recursive: true });
  }

  const docPath = join(toolsDir, `${serverName}.md`);
  const lines: string[] = [
    '---',
    `id: tool-${serverName}`,
    `created: ${new Date().toISOString().split('T')[0]}`,
    `tags: [mcp, ${serverName}]`,
    '---',
    '',
    `# ${serverName} MCP Server`,
    '',
  ];

  if (description) {
    lines.push(description, '');
  }

  lines.push('## Available Tools', '');

  for (const toolName of toolNames) {
    lines.push(`- **${toolName}**`);
  }

  lines.push('', `> Auto-generated by \`harness mcp install ${serverName}\``);

  writeFileSync(docPath, lines.join('\n'), 'utf-8');
  return [docPath];
}

// --- Connection Test ---

/**
 * Test an MCP server connection and return tool info.
 */
async function testConnection(
  dir: string,
  serverName: string,
  serverConfig: McpServerConfig,
): Promise<{ connected: boolean; toolCount: number; toolNames: string[]; error?: string }> {
  // Build a minimal config for testing just this server
  const config = loadConfig(dir);
  const testConfig: HarnessConfig = {
    ...config,
    mcp: { servers: { [serverName]: { ...serverConfig, enabled: serverConfig.enabled ?? true } } },
  };

  // Validate first
  const validationErrors = validateMcpConfig(testConfig);
  if (validationErrors.length > 0) {
    return {
      connected: false,
      toolCount: 0,
      toolNames: [],
      error: validationErrors.map((e) => e.error).join('; '),
    };
  }

  const manager = createMcpManager(testConfig);
  try {
    await manager.connect();
    const summaries = manager.getSummaries();
    const summary = summaries.find((s) => s.name === serverName);

    if (summary?.connected) {
      return {
        connected: true,
        toolCount: summary.toolCount,
        toolNames: summary.toolNames,
      };
    }

    return {
      connected: false,
      toolCount: 0,
      toolNames: [],
      error: summary?.error ?? 'Connection failed',
    };
  } catch (err) {
    return {
      connected: false,
      toolCount: 0,
      toolNames: [],
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await manager.close();
  }
}

// --- Main Install Flow ---

/**
 * Install an MCP server by name or search query.
 *
 * Flow:
 * 1. Search the MCP registry for the server
 * 2. Resolve the best package/transport configuration
 * 3. Add/update the server entry in config.yaml
 * 4. Optionally test the connection
 * 5. Optionally generate tools/*.md knowledge docs
 */
export async function installMcpServer(
  query: string,
  options: McpInstallOptions,
): Promise<McpInstallResult> {
  const { dir, skipTest, skipDocs, force, name: nameOverride } = options;

  // Step 1: Find the server in the registry
  log.info(`Searching MCP registry for "${query}"...`);
  let resolved: ResolvedServer | null;
  try {
    resolved = await findServer(query);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      installed: false,
      name: query,
      generatedDocs: [],
      pendingEnvVars: [],
      error: `Registry lookup failed: ${message}`,
    };
  }

  if (!resolved) {
    return {
      installed: false,
      name: query,
      generatedDocs: [],
      pendingEnvVars: [],
      error: `No MCP server found matching "${query}" in the registry`,
    };
  }

  const serverName = nameOverride ?? resolved.name;

  // Step 2: Check if already exists
  if (!force && serverExistsInConfig(dir, serverName)) {
    return {
      installed: false,
      name: serverName,
      server: resolved,
      generatedDocs: [],
      pendingEnvVars: resolved.requiredEnv,
      error: `Server "${serverName}" already exists in config. Use --force to overwrite.`,
    };
  }

  // Step 3: Write to config.yaml
  log.info(`Adding "${serverName}" to config.yaml...`);
  updateConfigWithServer(dir, serverName, resolved.config);

  const result: McpInstallResult = {
    installed: true,
    name: serverName,
    server: resolved,
    generatedDocs: [],
    pendingEnvVars: resolved.requiredEnv,
  };

  // Step 4: Test connection (optional)
  if (!skipTest) {
    log.info(`Testing connection to "${serverName}"...`);
    result.connectionTest = await testConnection(dir, serverName, resolved.config);
  }

  // Step 5: Generate tool docs (optional)
  if (!skipDocs && result.connectionTest?.connected && result.connectionTest.toolNames.length > 0) {
    log.info(`Generating tool docs for "${serverName}"...`);
    result.generatedDocs = generateToolDocs(
      dir,
      serverName,
      result.connectionTest.toolNames,
      resolved.description,
    );
  }

  return result;
}

/**
 * List available servers from the registry for a given query.
 */
export async function listRegistryServers(
  query: string,
  options?: { limit?: number },
): Promise<ResolvedServer[]> {
  return searchServers(query, options);
}

/**
 * Format a registry search result for CLI display.
 */
export function formatRegistryServer(entry: { server: RegistryServer }): string {
  const s = entry.server;
  const lines: string[] = [];

  lines.push(`  ${s.name} (v${s.version})`);
  if (s.title) lines.push(`    ${s.title}`);
  if (s.description) {
    const desc = s.description.length > 100 ? s.description.slice(0, 97) + '...' : s.description;
    lines.push(`    ${desc}`);
  }

  // Show packages
  const npmPkgs = (s.packages ?? []).filter((p) => p.registryType === 'npm');
  const pypiPkgs = (s.packages ?? []).filter((p) => p.registryType === 'pypi');
  if (npmPkgs.length > 0) {
    lines.push(`    npm: ${npmPkgs.map((p) => p.identifier).join(', ')}`);
  }
  if (pypiPkgs.length > 0) {
    lines.push(`    pypi: ${pypiPkgs.map((p) => p.identifier).join(', ')}`);
  }

  // Show remotes
  if (s.remotes && s.remotes.length > 0) {
    lines.push(`    remote: ${s.remotes[0].transportType} ${s.remotes[0].url}`);
  }

  // Show required env vars
  const allEnvVars = (s.packages ?? [])
    .flatMap((p) => p.environmentVariables ?? [])
    .filter((v) => v.isRequired);
  if (allEnvVars.length > 0) {
    lines.push(`    requires: ${allEnvVars.map((v) => v.name).join(', ')}`);
  }

  return lines.join('\n');
}
