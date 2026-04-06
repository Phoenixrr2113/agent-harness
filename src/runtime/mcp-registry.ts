import type { McpServerConfig } from './mcp.js';

// --- Types ---

/** Environment variable from registry server entry */
export interface RegistryEnvVar {
  name: string;
  description?: string;
  isRequired?: boolean;
  format?: string;
}

/** Package entry from registry server */
export interface RegistryPackage {
  registryType: 'npm' | 'pypi' | 'oci' | 'nuget' | 'mcpb';
  identifier: string;
  version: string;
  transport: { type: 'stdio' | 'streamable-http' | 'sse' };
  environmentVariables?: RegistryEnvVar[];
  runtimeHint?: 'npx' | 'uvx' | 'docker' | 'dnx';
  packageArguments?: unknown[];
  runtimeArguments?: unknown[];
}

/** Remote endpoint from registry server */
export interface RegistryRemote {
  transportType: 'streamable-http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

/** A single server entry from the MCP registry API */
export interface RegistryServer {
  $schema?: string;
  name: string;
  description?: string;
  title?: string;
  version: string;
  repository?: { url: string; source?: string; subfolder?: string };
  websiteUrl?: string;
  packages?: RegistryPackage[];
  remotes?: RegistryRemote[];
}

/** A server result from the registry search API */
export interface RegistrySearchResult {
  server: RegistryServer;
  _meta?: Record<string, unknown>;
}

/** Full search response from the registry */
export interface RegistrySearchResponse {
  servers: RegistrySearchResult[];
  metadata?: { nextCursor?: string; count?: number };
}

/** Resolved server config ready for installation */
export interface ResolvedServer {
  /** Display name for the server */
  name: string;
  /** Server description from registry */
  description?: string;
  /** Registry name (e.g. "io.github.foo/bar") */
  registryName: string;
  /** Source package info */
  package?: RegistryPackage;
  /** Source remote info */
  remote?: RegistryRemote;
  /** Generated harness config */
  config: McpServerConfig;
  /** Environment variables that need to be set */
  requiredEnv: RegistryEnvVar[];
  /** All environment variables (required + optional) */
  allEnv: RegistryEnvVar[];
}

// --- Constants ---

const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io';
const REGISTRY_API_VERSION = 'v0.1';
const DEFAULT_SEARCH_LIMIT = 10;

// --- Registry Client ---

/**
 * Search the MCP registry for servers matching a query.
 */
export async function searchRegistry(
  query: string,
  options?: { limit?: number; cursor?: string },
): Promise<RegistrySearchResponse> {
  const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
  const params = new URLSearchParams({
    search: query,
    limit: String(limit),
    version: 'latest',
  });
  if (options?.cursor) {
    params.set('cursor', options.cursor);
  }

  const url = `${REGISTRY_BASE}/${REGISTRY_API_VERSION}/servers?${params}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`MCP registry search failed (${response.status}): ${response.statusText}`);
  }

  const data = (await response.json()) as RegistrySearchResponse;
  return data;
}

/**
 * Get a specific server by its registry name and version.
 * Name must be URL-encoded (e.g. "io.github.foo/bar" -> "io.github.foo%2Fbar").
 */
export async function getRegistryServer(
  name: string,
  version: string = 'latest',
): Promise<RegistryServer> {
  const encodedName = encodeURIComponent(name);
  const encodedVersion = encodeURIComponent(version);
  const url = `${REGISTRY_BASE}/${REGISTRY_API_VERSION}/servers/${encodedName}/versions/${encodedVersion}`;
  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`MCP server "${name}" not found in registry`);
    }
    throw new Error(`MCP registry lookup failed (${response.status}): ${response.statusText}`);
  }

  const data = (await response.json()) as RegistryServer;
  return data;
}

// --- Runtime hint mapping ---

const RUNTIME_COMMANDS: Record<string, { command: string; prefix: string[] }> = {
  npx: { command: 'npx', prefix: ['-y'] },
  uvx: { command: 'uvx', prefix: [] },
  docker: { command: 'docker', prefix: ['run', '-i', '--rm'] },
  dnx: { command: 'dnx', prefix: [] },
};

/**
 * Derive a short config name from a registry server name.
 * "io.github.foo/bar-server" -> "bar-server"
 * "io.github.foo/mcp-something" -> "mcp-something"
 */
export function deriveConfigName(registryName: string): string {
  const parts = registryName.split('/');
  return parts[parts.length - 1];
}

/**
 * Resolve a registry server entry into a harness McpServerConfig.
 * Prefers npm stdio packages, falls back to pypi, then remotes.
 */
export function resolveServerConfig(server: RegistryServer): ResolvedServer {
  const name = deriveConfigName(server.name);

  // Strategy 1: Look for an npm stdio package
  const npmPkg = server.packages?.find((p) => p.registryType === 'npm' && p.transport.type === 'stdio');
  if (npmPkg) {
    return resolveStdioPackage(name, server, npmPkg, 'npx');
  }

  // Strategy 2: Look for any stdio package with runtimeHint
  const stdioPkg = server.packages?.find((p) => p.transport.type === 'stdio');
  if (stdioPkg) {
    const hint = stdioPkg.runtimeHint ?? (stdioPkg.registryType === 'pypi' ? 'uvx' : 'npx');
    return resolveStdioPackage(name, server, stdioPkg, hint);
  }

  // Strategy 3: Look for remotes (HTTP/SSE endpoints)
  if (server.remotes && server.remotes.length > 0) {
    const remote = server.remotes[0];
    return resolveRemote(name, server, remote);
  }

  // Strategy 4: Look for any package with HTTP transport
  const httpPkg = server.packages?.find(
    (p) => p.transport.type === 'streamable-http' || p.transport.type === 'sse',
  );
  if (httpPkg) {
    return resolveHttpPackage(name, server, httpPkg);
  }

  throw new Error(
    `Cannot resolve MCP server "${server.name}": no supported package or remote configuration found`,
  );
}

function resolveStdioPackage(
  name: string,
  server: RegistryServer,
  pkg: RegistryPackage,
  runtimeHint: string,
): ResolvedServer {
  const runtime = RUNTIME_COMMANDS[runtimeHint] ?? RUNTIME_COMMANDS['npx'];
  const args = [...runtime.prefix, pkg.identifier];

  const envVars = pkg.environmentVariables ?? [];
  const env: Record<string, string> = {};
  for (const ev of envVars) {
    env[ev.name] = `\${${ev.name}}`;
  }

  const config: McpServerConfig = {
    transport: 'stdio',
    command: runtime.command,
    args,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };

  return {
    name,
    description: server.description,
    registryName: server.name,
    package: pkg,
    config,
    requiredEnv: envVars.filter((e) => e.isRequired),
    allEnv: envVars,
  };
}

function resolveRemote(
  name: string,
  server: RegistryServer,
  remote: RegistryRemote,
): ResolvedServer {
  const transport = remote.transportType === 'sse' ? 'sse' as const : 'http' as const;

  const config: McpServerConfig = {
    transport,
    url: remote.url,
    ...(remote.headers && Object.keys(remote.headers).length > 0 ? { headers: remote.headers } : {}),
  };

  return {
    name,
    description: server.description,
    registryName: server.name,
    remote,
    config,
    requiredEnv: [],
    allEnv: [],
  };
}

function resolveHttpPackage(
  name: string,
  server: RegistryServer,
  pkg: RegistryPackage,
): ResolvedServer {
  // HTTP packages typically have a URL in the package identifier or need a remote
  const transport = pkg.transport.type === 'sse' ? 'sse' as const : 'http' as const;

  const envVars = pkg.environmentVariables ?? [];
  const config: McpServerConfig = {
    transport,
    url: pkg.identifier,
  };

  return {
    name,
    description: server.description,
    registryName: server.name,
    package: pkg,
    config,
    requiredEnv: envVars.filter((e) => e.isRequired),
    allEnv: envVars,
  };
}

/**
 * Search the registry and return the best match for a query.
 * If the query looks like a registry name (contains "/" or "."), try exact lookup first.
 * Otherwise, search and return the first result.
 */
export async function findServer(query: string): Promise<ResolvedServer | null> {
  // If it looks like an exact registry name, try direct lookup
  if (query.includes('/') || query.includes('io.')) {
    try {
      const server = await getRegistryServer(query);
      return resolveServerConfig(server);
    } catch {
      // Fall through to search
    }
  }

  // Search the registry
  const results = await searchRegistry(query, { limit: 5 });
  if (results.servers.length === 0) {
    return null;
  }

  // Return the first match
  return resolveServerConfig(results.servers[0].server);
}

/**
 * Search the registry and return all matches for display.
 */
export async function searchServers(
  query: string,
  options?: { limit?: number },
): Promise<ResolvedServer[]> {
  const results = await searchRegistry(query, { limit: options?.limit ?? DEFAULT_SEARCH_LIMIT });
  const resolved: ResolvedServer[] = [];

  for (const result of results.servers) {
    try {
      resolved.push(resolveServerConfig(result.server));
    } catch {
      // Skip servers that can't be resolved
    }
  }

  return resolved;
}
