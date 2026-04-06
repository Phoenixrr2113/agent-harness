import { existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { loadDirectory } from '../primitives/loader.js';
import type { HarnessDocument } from '../core/types.js';

export interface ToolAuth {
  envVar: string;
  present: boolean;
}

export interface ToolOperation {
  name: string;
  method: string;
  endpoint: string;
}

export interface ToolDefinition {
  id: string;
  doc: HarnessDocument;
  tags: string[];
  status: string;
  auth: ToolAuth[];
  operations: ToolOperation[];
  rateLimits: string[];
  gotchas: string[];
}

export interface ToolSummary {
  id: string;
  l0: string;
  tags: string[];
  status: string;
  authReady: boolean;
  operationCount: number;
}

/**
 * Extract environment variable names from authentication section.
 * Looks for `ENV_VAR_NAME` patterns (all-caps with underscores) in the auth section.
 */
function extractAuth(body: string): ToolAuth[] {
  const authSection = body.match(/## Authentication\s*\n([\s\S]*?)(?=\n## |\n$|$)/i);
  if (!authSection) return [];

  const envVarPattern = /`([A-Z][A-Z0-9_]+)`/g;
  const vars: ToolAuth[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = envVarPattern.exec(authSection[1])) !== null) {
    const envVar = match[1];
    if (!seen.has(envVar)) {
      seen.add(envVar);
      vars.push({
        envVar,
        present: process.env[envVar] !== undefined && process.env[envVar] !== '',
      });
    }
  }

  return vars;
}

/**
 * Extract operations from Common Operations / Operations sections.
 * Looks for lines with HTTP method + endpoint patterns.
 */
function extractOperations(body: string): ToolOperation[] {
  const opsSection = body.match(/## (?:Common )?Operations\s*\n([\s\S]*?)(?=\n## |\n$|$)/i);
  if (!opsSection) return [];

  const ops: ToolOperation[] = [];
  const lines = opsSection[1].split('\n');
  let currentSection = '';

  for (const line of lines) {
    const headingMatch = line.match(/^### (.+)/);
    if (headingMatch) {
      currentSection = headingMatch[1].trim();
      continue;
    }

    // Match patterns like: `GET /repos/{owner}/{repo}/pulls`
    // or: POST /sendMessage
    const opMatch = line.match(/`?(GET|POST|PUT|DELETE|PATCH)\s+(\S+?)`?(?:\s|$)/);
    if (opMatch) {
      const name = currentSection
        ? `${currentSection}: ${opMatch[2].split('/').pop() || opMatch[2]}`
        : opMatch[2].split('/').pop() || opMatch[2];
      ops.push({
        name,
        method: opMatch[1],
        endpoint: opMatch[2],
      });
    }
  }

  return ops;
}

/**
 * Extract rate limit lines from Rate Limits section.
 */
function extractRateLimits(body: string): string[] {
  const section = body.match(/## Rate Limits\s*\n([\s\S]*?)(?=\n## |\n$|$)/i);
  if (!section) return [];

  return section[1]
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.replace(/^- /, '').trim());
}

/**
 * Extract gotchas/caveats from Gotchas section.
 */
function extractGotchas(body: string): string[] {
  const section = body.match(/## Gotchas\s*\n([\s\S]*?)(?=\n## |\n$|$)/i);
  if (!section) return [];

  return section[1]
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.replace(/^- /, '').trim());
}

/**
 * Parse a tool document into a structured ToolDefinition.
 */
export function parseToolDefinition(doc: HarnessDocument): ToolDefinition {
  return {
    id: doc.frontmatter.id,
    doc,
    tags: doc.frontmatter.tags,
    status: doc.frontmatter.status,
    auth: extractAuth(doc.body),
    operations: extractOperations(doc.body),
    rateLimits: extractRateLimits(doc.body),
    gotchas: extractGotchas(doc.body),
  };
}

/**
 * Load all tool definitions from the tools/ directory.
 */
export function loadTools(harnessDir: string): ToolDefinition[] {
  const toolsDir = join(harnessDir, 'tools');
  if (!existsSync(toolsDir)) return [];

  const docs = loadDirectory(toolsDir);
  return docs.map(parseToolDefinition);
}

/**
 * Get a specific tool definition by ID.
 */
export function getToolById(harnessDir: string, toolId: string): ToolDefinition | null {
  const tools = loadTools(harnessDir);
  return tools.find((t) => t.id === toolId) ?? null;
}

/**
 * List tools with summary info (without full document content).
 */
export function listToolSummaries(harnessDir: string): ToolSummary[] {
  const tools = loadTools(harnessDir);
  return tools.map((t) => ({
    id: t.id,
    l0: t.doc.l0,
    tags: t.tags,
    status: t.status,
    authReady: t.auth.length === 0 || t.auth.every((a) => a.present),
    operationCount: t.operations.length,
  }));
}

/**
 * Check auth status for a specific tool or all tools.
 */
export function checkToolAuth(harnessDir: string, toolId?: string): Array<{ tool: string; auth: ToolAuth[] }> {
  const tools = toolId
    ? [getToolById(harnessDir, toolId)].filter((t): t is ToolDefinition => t !== null)
    : loadTools(harnessDir);

  return tools.map((t) => ({
    tool: t.id,
    auth: t.auth,
  }));
}
