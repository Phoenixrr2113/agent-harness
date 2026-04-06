import { tool as aiTool, jsonSchema, type ToolSet } from 'ai';
import { z } from 'zod';
import { loadTools, type ToolDefinition, type ToolOperation } from './tools.js';
import type { HarnessConfig } from '../core/types.js';
import { log } from '../core/logger.js';

// --- Types ---

/** Result of a single tool execution */
export interface ToolCallResult {
  toolName: string;
  input: Record<string, unknown>;
  output: unknown;
  durationMs: number;
  error: string | null;
}

/** Record of all tool calls in a run (for session recording) */
export interface ToolCallRecord {
  calls: ToolCallResult[];
  totalDurationMs: number;
}

/** A programmatic tool definition (not from markdown) */
export interface ProgrammaticTool {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}

/** Configuration for tool execution */
export interface ToolExecutorConfig {
  /** Maximum tool calls per run (default: 10) */
  maxToolCalls?: number;
  /** Timeout per tool call in ms (default: 30000) */
  toolTimeoutMs?: number;
  /** Whether to allow HTTP tool execution (default: true) */
  allowHttpExecution?: boolean;
  /** Additional programmatic tools */
  tools?: ProgrammaticTool[];
}

/** AI SDK ToolSet — record of named tool definitions */
export type AIToolSet = ToolSet;

// --- HTTP Execution ---

/**
 * Resolve a URL template by replacing `{param}` placeholders with input values.
 * E.g., `/repos/{owner}/{repo}/pulls` with { owner: 'a', repo: 'b' } → `/repos/a/b/pulls`
 */
export function resolveEndpoint(endpoint: string, input: Record<string, unknown>): string {
  return endpoint.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = input[key];
    if (value === undefined || value === null) {
      return `{${key}}`;
    }
    return encodeURIComponent(String(value));
  });
}

/**
 * Build a JSON Schema object for a tool operation's URL parameters.
 * Extracts `{param}` patterns from the endpoint URL and creates string properties for each.
 */
export function buildOperationSchema(operation: ToolOperation): Record<string, unknown> {
  const params: string[] = [];
  const paramRegex = /\{(\w+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = paramRegex.exec(operation.endpoint)) !== null) {
    params.push(match[1]);
  }

  const properties: Record<string, { type: string; description: string }> = {};
  for (const param of params) {
    properties[param] = { type: 'string', description: `Value for ${param}` };
  }

  // Add a body property for POST/PUT/PATCH
  if (['POST', 'PUT', 'PATCH'].includes(operation.method)) {
    properties['body'] = { type: 'string', description: 'Request body (JSON string)' };
  }

  // Add optional query parameters
  properties['query'] = { type: 'string', description: 'Query parameters (key=value&key2=value2)' };

  return {
    type: 'object',
    properties,
    required: params,
  };
}

/**
 * Execute an HTTP tool operation.
 * Resolves URL parameters, attaches auth headers, and makes the HTTP request.
 */
export async function executeHttpOperation(
  operation: ToolOperation,
  baseUrl: string,
  authHeaders: Record<string, string>,
  input: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  const resolvedPath = resolveEndpoint(operation.endpoint, input);
  let url = resolvedPath.startsWith('http') ? resolvedPath : `${baseUrl}${resolvedPath}`;

  // Append query parameters if provided
  const query = input['query'];
  if (typeof query === 'string' && query.length > 0) {
    const separator = url.includes('?') ? '&' : '?';
    url = `${url}${separator}${query}`;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...authHeaders,
  };

  const fetchOptions: RequestInit = {
    method: operation.method,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  };

  // Attach body for methods that support it
  if (['POST', 'PUT', 'PATCH'].includes(operation.method)) {
    const body = input['body'];
    if (typeof body === 'string') {
      fetchOptions.body = body;
    } else if (body !== undefined && body !== null) {
      fetchOptions.body = JSON.stringify(body);
    }
  }

  const response = await fetch(url, fetchOptions);

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${errorText.slice(0, 500)}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return response.json() as Promise<unknown>;
  }
  return response.text();
}

// --- Tool Conversion ---

/**
 * Sanitize a tool name for the AI SDK.
 * Tool names must be alphanumeric with underscores/hyphens only.
 */
function sanitizeToolName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 64);
}

/**
 * Extract a base URL from the tool's operations or body.
 * Looks for full URLs in operations, or common API URL patterns in the body.
 */
function extractBaseUrl(toolDef: ToolDefinition): string {
  // Check operations for full URLs
  for (const op of toolDef.operations) {
    if (op.endpoint.startsWith('http')) {
      try {
        const url = new URL(op.endpoint);
        return `${url.protocol}//${url.host}`;
      } catch {
        // not a valid URL
      }
    }
  }

  // Try to find API base URL in the document body
  const urlMatch = toolDef.doc.body.match(/(?:base[_ ]?url|api[_ ]?url|endpoint)\s*[:=]\s*`?(https?:\/\/[^\s`"']+)/i);
  if (urlMatch) {
    try {
      const url = new URL(urlMatch[1]);
      return `${url.protocol}//${url.host}`;
    } catch {
      // not a valid URL
    }
  }

  return '';
}

/**
 * Build auth headers from a tool's auth configuration.
 * Maps known env var patterns to standard header formats.
 */
export function buildAuthHeaders(toolDef: ToolDefinition): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const auth of toolDef.auth) {
    const value = process.env[auth.envVar];
    if (!value) continue;

    // Common patterns for auth header mapping (check specific patterns first)
    const envLower = auth.envVar.toLowerCase();
    if (envLower.includes('bot_token')) {
      headers['Authorization'] = `Bot ${value}`;
    } else if (envLower.includes('token') || envLower.includes('api_key') || envLower.includes('apikey')) {
      headers['Authorization'] = `Bearer ${value}`;
    } else {
      // Generic: use as Bearer token
      headers['Authorization'] = `Bearer ${value}`;
    }
  }

  return headers;
}

/**
 * Convert a single ToolDefinition (from markdown) into AI SDK tools.
 * Each operation becomes a separate tool entry.
 */
export function convertToolDefinition(
  toolDef: ToolDefinition,
  config: ToolExecutorConfig,
): AIToolSet {
  const tools: AIToolSet = {};
  const baseUrl = extractBaseUrl(toolDef);
  const allowHttp = config.allowHttpExecution !== false;
  const timeoutMs = config.toolTimeoutMs ?? 30_000;

  for (const operation of toolDef.operations) {
    const toolName = sanitizeToolName(`${toolDef.id}_${operation.name}`);
    const opSchema = buildOperationSchema(operation);

    tools[toolName] = aiTool({
      description: `[${toolDef.id}] ${operation.method} ${operation.endpoint} — ${toolDef.doc.l0}`,
      inputSchema: jsonSchema<Record<string, unknown>>(opSchema),
      execute: async (input) => {
        const typedInput = input;

        if (!allowHttp) {
          return { error: 'HTTP tool execution is disabled' };
        }

        // Check auth
        const missingAuth = toolDef.auth.filter((a) => !process.env[a.envVar]);
        if (missingAuth.length > 0) {
          return {
            error: `Missing required auth: ${missingAuth.map((a) => a.envVar).join(', ')}`,
          };
        }

        const authHeaders = buildAuthHeaders(toolDef);

        try {
          const result = await executeHttpOperation(
            operation,
            baseUrl,
            authHeaders,
            typedInput,
            timeoutMs,
          );
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error(`Tool ${toolName} execution failed: ${message}`);
          return { error: message };
        }
      },
    });
  }

  return tools;
}

/**
 * Convert a programmatic tool definition into an AI SDK tool.
 */
function convertProgrammaticTool(pt: ProgrammaticTool): AIToolSet {
  const toolName = sanitizeToolName(pt.name);

  return {
    [toolName]: aiTool({
      description: pt.description,
      inputSchema: pt.inputSchema,
      execute: async (input: unknown) => {
        try {
          return await pt.execute(input as Record<string, unknown>);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error(`Tool ${toolName} execution failed: ${message}`);
          return { error: message };
        }
      },
    }),
  };
}

// --- Public API ---

/**
 * Load all tools from the harness directory and convert them to AI SDK format.
 * Includes markdown-defined tools, programmatic tools from config, and MCP tools.
 *
 * Returns an empty object if no tools are configured.
 *
 * @param harnessDir - Path to the harness directory
 * @param config - Tool executor configuration
 * @param mcpTools - Pre-loaded MCP tools to merge (from McpManager.getTools())
 */
export function buildToolSet(
  harnessDir: string,
  config?: ToolExecutorConfig,
  mcpTools?: AIToolSet,
): AIToolSet {
  const executorConfig = config ?? {};
  const tools: AIToolSet = {};

  // Load markdown-defined tools
  const toolDefs = loadTools(harnessDir);
  for (const toolDef of toolDefs) {
    // Skip inactive tools
    if (toolDef.status !== 'active') continue;

    // Skip tools without operations
    if (toolDef.operations.length === 0) continue;

    const converted = convertToolDefinition(toolDef, executorConfig);
    Object.assign(tools, converted);
  }

  // Add programmatic tools
  if (executorConfig.tools) {
    for (const pt of executorConfig.tools) {
      const converted = convertProgrammaticTool(pt);
      Object.assign(tools, converted);
    }
  }

  // Merge MCP tools (from connected MCP servers)
  if (mcpTools) {
    Object.assign(tools, mcpTools);
  }

  return tools;
}

/**
 * Create a ToolCallRecord tracker for recording tool calls in a run.
 */
export function createToolCallTracker(): {
  record: (result: ToolCallResult) => void;
  getRecord: () => ToolCallRecord;
} {
  const calls: ToolCallResult[] = [];
  let totalDurationMs = 0;

  return {
    record(result: ToolCallResult) {
      calls.push(result);
      totalDurationMs += result.durationMs;
    },
    getRecord(): ToolCallRecord {
      return { calls: [...calls], totalDurationMs };
    },
  };
}

/**
 * Get a human-readable summary of tools available in the harness.
 */
export function getToolSetSummary(tools: AIToolSet): string[] {
  return Object.entries(tools).map(([name, t]) => {
    const desc = (t as { description?: string }).description ?? '';
    return `${name}: ${desc}`;
  });
}
