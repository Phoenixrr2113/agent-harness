import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { withFileLockSync } from './file-lock.js';
import { log } from '../core/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SourceType = 'github' | 'registry' | 'api';

export type ContentType = 'skills' | 'agents' | 'rules' | 'playbooks' | 'hooks' | 'templates' | 'mcp' | 'plugins';

export interface Source {
  /** Display name */
  name: string;
  /** URL — GitHub repo, registry API, or endpoint */
  url: string;
  /** Source type */
  type: SourceType;
  /** Content types provided */
  content: ContentType[];
  /** Searchable tags */
  tags: string[];
  /** Description of the source */
  description?: string;
  /** Optional stats (e.g., { skills: 31, agents: 19 }) */
  stats?: Record<string, number>;
}

export interface SourcesFile {
  version: string;
  sources: Source[];
}

export interface SourceDiscoveryResult {
  /** Source the item came from */
  source: Source;
  /** Item name/title */
  name: string;
  /** Item description */
  description: string;
  /** Item type (skill, agent, rule, etc.) */
  type: ContentType;
  /** URL to the item (file or page) */
  url: string;
  /** Match relevance score (0-1) */
  score: number;
}

export interface SourceDiscoveryOptions {
  /** Filter by content type */
  type?: ContentType;
  /** Maximum results */
  maxResults?: number;
  /** Only search these sources (by name) */
  sourceNames?: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const USER_SOURCES_FILE = 'sources.yaml';
const SOURCES_DIR = 'memory';

// ─── Source Loading ──────────────────────────────────────────────────────────

/**
 * Get the path to the shipped sources.yaml bundled with the package.
 */
function getShippedSourcesPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'sources.yaml');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  // Fallback
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'sources.yaml');
}

/**
 * Load the shipped sources.yaml from the package root.
 */
export function loadShippedSources(): Source[] {
  const path = getShippedSourcesPath();
  if (!existsSync(path)) return [];

  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = parseYaml(raw) as { version?: string; sources?: Array<Record<string, unknown>> };
    return normalizeSources(parsed.sources ?? []);
  } catch (err) {
    log.warn(`Failed to load shipped sources: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Load user-added sources from the harness memory directory.
 */
export function loadUserSources(harnessDir: string): Source[] {
  const userPath = join(harnessDir, SOURCES_DIR, USER_SOURCES_FILE);
  if (!existsSync(userPath)) return [];

  try {
    const raw = readFileSync(userPath, 'utf-8');
    const parsed = parseYaml(raw) as { version?: string; sources?: Array<Record<string, unknown>> };
    return normalizeSources(parsed.sources ?? []);
  } catch (err) {
    log.warn(`Failed to load user sources: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Save user sources to the harness memory directory.
 */
export function saveUserSources(harnessDir: string, sources: Source[]): void {
  const memDir = join(harnessDir, SOURCES_DIR);
  if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });

  const userPath = join(memDir, USER_SOURCES_FILE);
  const data: SourcesFile = { version: '1.0', sources };

  withFileLockSync(harnessDir, userPath, () => {
    writeFileSync(userPath, stringifyYaml(data), 'utf-8');
  });
}

/**
 * Load all sources: shipped + user-added, deduplicated by name.
 */
export function loadAllSources(harnessDir: string): Source[] {
  const shipped = loadShippedSources();
  const user = loadUserSources(harnessDir);

  // User sources override shipped sources with the same name
  const byName = new Map<string, Source>();
  for (const s of shipped) {
    byName.set(s.name.toLowerCase(), s);
  }
  for (const s of user) {
    byName.set(s.name.toLowerCase(), s);
  }

  return Array.from(byName.values());
}

// ─── Source Management ───────────────────────────────────────────────────────

/**
 * Add a new source to the user's sources list.
 * Returns the added source, or null if it already exists.
 */
export function addSource(
  harnessDir: string,
  source: Omit<Source, 'tags'> & { tags?: string[] },
): Source | null {
  const userSources = loadUserSources(harnessDir);

  // Check for duplicate by name
  const exists = userSources.find(
    (s) => s.name.toLowerCase() === source.name.toLowerCase(),
  );
  if (exists) return null;

  const normalized: Source = {
    name: source.name,
    url: source.url,
    type: source.type,
    content: source.content,
    tags: source.tags ?? [],
    description: source.description,
    stats: source.stats,
  };

  userSources.push(normalized);
  saveUserSources(harnessDir, userSources);
  return normalized;
}

/**
 * Remove a source by name from the user's sources list.
 * Returns true if removed, false if not found.
 */
export function removeSource(harnessDir: string, name: string): boolean {
  const userSources = loadUserSources(harnessDir);
  const index = userSources.findIndex(
    (s) => s.name.toLowerCase() === name.toLowerCase(),
  );

  if (index === -1) return false;

  userSources.splice(index, 1);
  saveUserSources(harnessDir, userSources);
  return true;
}

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * Search all sources for content matching a query.
 *
 * This performs local matching against source metadata (name, description,
 * tags, content types). For deeper search, each source type has its own
 * fetcher (GitHub API, registry API, etc.).
 *
 * @param harnessDir - Harness directory
 * @param query - Search query (text or content type)
 * @param options - Discovery options
 * @returns Ranked results from all matching sources
 */
export function discoverSources(
  harnessDir: string,
  query: string,
  options?: SourceDiscoveryOptions,
): SourceDiscoveryResult[] {
  const sources = loadAllSources(harnessDir);
  const results: SourceDiscoveryResult[] = [];
  const maxResults = options?.maxResults ?? 20;
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 1);

  for (const source of sources) {
    // Filter by source names if specified
    if (options?.sourceNames && options.sourceNames.length > 0) {
      const matches = options.sourceNames.some(
        (n) => source.name.toLowerCase().includes(n.toLowerCase()),
      );
      if (!matches) continue;
    }

    // Filter by content type
    if (options?.type && !source.content.includes(options.type)) {
      continue;
    }

    // Score the source against the query
    const score = computeSourceScore(source, queryLower, queryWords);

    if (score > 0) {
      // For each content type this source provides, create a result
      const types = options?.type
        ? [options.type]
        : source.content;

      for (const type of types) {
        results.push({
          source,
          name: source.name,
          description: source.description ?? '',
          type,
          url: source.url,
          score,
        });
      }
    }
  }

  // Sort by score descending, then by name
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });

  return results.slice(0, maxResults);
}

/**
 * Get all sources that provide a specific content type.
 */
export function getSourcesForType(
  harnessDir: string,
  type: ContentType,
): Source[] {
  const sources = loadAllSources(harnessDir);
  return sources.filter((s) => s.content.includes(type));
}

/**
 * Get a summary of all known sources grouped by content type.
 */
export function getSourcesSummary(harnessDir: string): Record<ContentType, Source[]> {
  const sources = loadAllSources(harnessDir);
  const summary: Record<string, Source[]> = {};

  const allTypes: ContentType[] = ['skills', 'agents', 'rules', 'playbooks', 'hooks', 'templates', 'mcp', 'plugins'];
  for (const type of allTypes) {
    summary[type] = sources.filter((s) => s.content.includes(type));
  }

  return summary as Record<ContentType, Source[]>;
}

// ─── Remote Discovery (GitHub) ───────────────────────────────────────────────

/**
 * Fetch content listing from a GitHub source.
 * Uses the GitHub API to list files in the repository.
 *
 * @param source - GitHub source definition
 * @param query - Search query
 * @param options - Discovery options
 * @returns Discovery results from the GitHub repo
 */
export async function fetchGitHubSource(
  source: Source,
  query: string,
  options?: SourceDiscoveryOptions,
): Promise<SourceDiscoveryResult[]> {
  const results: SourceDiscoveryResult[] = [];

  // Parse GitHub URL to extract owner/repo
  const match = source.url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return results;

  const [, owner, repo] = match;
  const apiUrl = `https://api.github.com/search/code?q=${encodeURIComponent(query)}+repo:${owner}/${repo}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(apiUrl, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'agent-harness',
      },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      log.warn(`GitHub API error for ${source.name}: ${response.status}`);
      return results;
    }

    const data = await response.json() as {
      items?: Array<{
        name: string;
        path: string;
        html_url: string;
      }>;
    };

    if (!data.items) return results;

    const maxResults = options?.maxResults ?? 10;
    const queryLower = query.toLowerCase();

    for (const item of data.items.slice(0, maxResults)) {
      // Determine content type from file path/name
      const type = inferContentType(item.path, source.content);
      if (options?.type && type !== options.type) continue;

      const nameScore = item.name.toLowerCase().includes(queryLower) ? 0.9 : 0.5;

      results.push({
        source,
        name: item.name,
        description: `${item.path} in ${source.name}`,
        type,
        url: item.html_url,
        score: nameScore,
      });
    }
  } catch (err) {
    log.warn(`Failed to fetch GitHub source ${source.name}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return results;
}

/**
 * Perform a full remote discovery across all sources.
 * Searches GitHub repos and registries in parallel.
 *
 * @param harnessDir - Harness directory
 * @param query - Search query
 * @param options - Discovery options
 * @returns All discovery results, merged and ranked
 */
export async function discoverRemote(
  harnessDir: string,
  query: string,
  options?: SourceDiscoveryOptions,
): Promise<SourceDiscoveryResult[]> {
  const sources = loadAllSources(harnessDir);
  const maxResults = options?.maxResults ?? 20;

  // Filter sources
  let filtered = sources;
  if (options?.type) {
    filtered = sources.filter((s) => s.content.includes(options.type!));
  }
  if (options?.sourceNames && options.sourceNames.length > 0) {
    filtered = filtered.filter((s) =>
      options.sourceNames!.some((n) =>
        s.name.toLowerCase().includes(n.toLowerCase()),
      ),
    );
  }

  // Search each source in parallel
  const promises = filtered.map(async (source) => {
    if (source.type === 'github') {
      return fetchGitHubSource(source, query, options);
    }
    // Registry sources use the existing MCP registry search
    // API sources would need custom handlers
    return [] as SourceDiscoveryResult[];
  });

  const results = await Promise.allSettled(promises);
  const allResults: SourceDiscoveryResult[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allResults.push(...result.value);
    }
  }

  // Sort by score, deduplicate by URL
  allResults.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const deduped: SourceDiscoveryResult[] = [];
  for (const r of allResults) {
    if (!seen.has(r.url)) {
      seen.add(r.url);
      deduped.push(r);
    }
  }

  return deduped.slice(0, maxResults);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeSources(raw: Array<Record<string, unknown>>): Source[] {
  return raw
    .filter((s) => s.name && s.url && s.type)
    .map((s) => ({
      name: String(s.name),
      url: String(s.url),
      type: String(s.type) as SourceType,
      content: Array.isArray(s.content)
        ? (s.content as string[]).map((c) => String(c) as ContentType)
        : [],
      tags: Array.isArray(s.tags) ? (s.tags as string[]).map(String) : [],
      description: s.description ? String(s.description) : undefined,
      stats: s.stats && typeof s.stats === 'object'
        ? s.stats as Record<string, number>
        : undefined,
    }));
}

function computeSourceScore(
  source: Source,
  queryLower: string,
  queryWords: string[],
): number {
  let score = 0;

  // Exact name match
  if (source.name.toLowerCase() === queryLower) {
    score += 1.0;
  } else if (source.name.toLowerCase().includes(queryLower)) {
    score += 0.8;
  }

  // Description match
  const desc = (source.description ?? '').toLowerCase();
  if (desc.includes(queryLower)) {
    score += 0.5;
  }

  // Tag match
  for (const tag of source.tags) {
    if (tag.toLowerCase() === queryLower) {
      score += 0.7;
    } else if (tag.toLowerCase().includes(queryLower)) {
      score += 0.3;
    }
  }

  // Content type match
  for (const ct of source.content) {
    if (ct === queryLower) {
      score += 0.8;
    }
  }

  // Word overlap
  if (queryWords.length > 0 && score === 0) {
    let wordHits = 0;
    const allText = `${source.name} ${source.description ?? ''} ${source.tags.join(' ')} ${source.content.join(' ')}`.toLowerCase();
    for (const word of queryWords) {
      if (allText.includes(word)) wordHits++;
    }
    if (wordHits > 0) {
      score += (wordHits / queryWords.length) * 0.5;
    }
  }

  return Math.min(score, 1.0);
}

function inferContentType(filePath: string, sourceContentTypes: ContentType[]): ContentType {
  const pathLower = filePath.toLowerCase();

  if (pathLower.includes('skill') || pathLower.includes('SKILL.md')) return 'skills';
  if (pathLower.includes('agent')) return 'agents';
  if (pathLower.includes('rule')) return 'rules';
  if (pathLower.includes('playbook')) return 'playbooks';
  if (pathLower.includes('hook')) return 'hooks';
  if (pathLower.includes('template')) return 'templates';
  if (pathLower.includes('mcp') || pathLower.includes('server')) return 'mcp';
  if (pathLower.includes('plugin')) return 'plugins';

  // Default to the first content type of the source
  return sourceContentTypes[0] ?? 'skills';
}
