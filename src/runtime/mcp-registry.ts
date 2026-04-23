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

// --- Canonical alias map ---
// The MCP registry does not carry the `@modelcontextprotocol/server-*`
// packages that Anthropic publishes on npm, so plain registry search for
// names like "filesystem" or "github" returns third-party clones. This map
// resolves well-known single-word aliases to the canonical npm packages
// directly, bypassing the registry. Users can still pass a full `org/name`
// to `harness mcp install` to hit the registry for non-canonical choices.

interface KnownAlias {
  name: string;
  description: string;
  npmPackage: string;
  /** For servers that require an absolute path as the primary arg (filesystem). */
  requiresPath?: boolean;
  /** Env vars the server expects to read, with descriptions. */
  env?: Array<{ name: string; description?: string; isRequired?: boolean }>;
  /** Suggested tools.include filter — keeps the surface tight. */
  defaultTools?: string[];
}

const KNOWN_ALIASES: Record<string, KnownAlias> = {
  filesystem: {
    name: 'filesystem',
    description: 'Read, list, and search files in a specified directory',
    npmPackage: '@modelcontextprotocol/server-filesystem',
    requiresPath: true,
    defaultTools: ['read_text_file', 'list_directory', 'search_files', 'get_file_info'],
  },
  github: {
    name: 'github',
    description: 'GitHub API — repos, issues, pull requests, files',
    npmPackage: '@modelcontextprotocol/server-github',
    env: [{
      name: 'GITHUB_PERSONAL_ACCESS_TOKEN',
      description: 'GitHub personal access token',
      isRequired: true,
    }],
    defaultTools: ['get_pull_request', 'get_file_contents', 'list_commits', 'get_pull_request_files'],
  },
  fetch: {
    name: 'fetch',
    description: 'HTTP fetch with content extraction',
    npmPackage: '@modelcontextprotocol/server-fetch',
  },
  memory: {
    name: 'memory',
    description: 'Knowledge-graph memory',
    npmPackage: '@modelcontextprotocol/server-memory',
  },
  time: {
    name: 'time',
    description: 'Time and timezone utilities',
    npmPackage: '@modelcontextprotocol/server-time',
  },
  'sequential-thinking': {
    name: 'sequential-thinking',
    description: 'Structured sequential reasoning tool',
    npmPackage: '@modelcontextprotocol/server-sequential-thinking',
  },
};

/**
 * Build a ResolvedServer from a known alias without hitting the registry.
 * The resulting config runs the canonical npm package via npx.
 */
function resolveAlias(alias: KnownAlias, pathArg?: string): ResolvedServer {
  const args: string[] = ['-y', alias.npmPackage];
  if (alias.requiresPath) {
    args.push(pathArg ?? process.cwd());
  }
  const envVars: RegistryEnvVar[] = (alias.env ?? []).map((e) => ({
    name: e.name,
    description: e.description,
    isRequired: e.isRequired,
  }));
  const config: McpServerConfig = {
    transport: 'stdio',
    command: 'npx',
    args,
    enabled: true,
  };
  if (alias.defaultTools && alias.defaultTools.length > 0) {
    config.tools = { include: alias.defaultTools };
  }
  return {
    name: alias.name,
    description: alias.description,
    registryName: `alias:${alias.name}`,
    config,
    requiredEnv: envVars.filter((e) => e.isRequired),
    allEnv: envVars,
  };
}

/**
 * Look up a known alias (case-insensitive). Returns null if not a known name.
 * Exposed so callers (e.g. `harness init` auto-wiring) can reuse the same map.
 */
export function resolveKnownAlias(query: string, pathArg?: string): ResolvedServer | null {
  const key = query.toLowerCase();
  const alias = KNOWN_ALIASES[key];
  if (!alias) return null;
  return resolveAlias(alias, pathArg);
}

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
  // Curated aliases win over the registry for single-word canonical names
  // like "filesystem" and "github" — the registry doesn't carry the
  // @modelcontextprotocol/server-* packages so plain search returns
  // third-party clones.
  const alias = resolveKnownAlias(query);
  if (alias) return alias;

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
