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
 * GitHub Contents API entry shape.
 * https://docs.github.com/en/rest/repos/contents
 */
interface GitHubContentItem {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  download_url: string | null;
  html_url: string;
}

/**
 * Maps a Source's declared `content:` types to the GitHub directories we
 * should scan for them. Multiple content types may map to the same dir.
 * `plugins` and `templates` are always allowed because layouts vary.
 */
const CONTENT_TYPE_TO_DIRS: Record<ContentType, string[]> = {
  skills: ['skills'],
  agents: ['agents'],
  rules: ['rules'],
  playbooks: ['playbooks'],
  hooks: ['hooks'],
  templates: ['templates'],
  mcp: [], // MCP servers come from registries, not GitHub repo dirs
  plugins: ['plugins'],
};

/** Hard cap on Contents API calls per discoverRemote invocation, across all sources. */
const MAX_API_CALLS_PER_DISCOVERY = 50;

const GITHUB_CONTENTS_TIMEOUT_MS = 10000;

/**
 * Fetch a single Contents API endpoint with timeout and standard headers.
 * Returns parsed JSON or null on any error (logged at warn level).
 */
async function fetchGitHubContents(
  owner: string,
  repo: string,
  path: string,
  sourceName: string,
): Promise<GitHubContentItem[] | null> {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'agent-harness',
  };
  // Authenticated requests get a higher rate limit (5000/hr vs 60/hr).
  // Optional — Contents API works fine without it for new users.
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_CONTENTS_TIMEOUT_MS);

  try {
    const response = await fetch(apiUrl, { headers, signal: controller.signal });
    if (!response.ok) {
      // 404 on a missing directory is expected (not all repos have all dirs).
      // Other statuses get logged so they're visible during discovery debugging.
      if (response.status !== 404) {
        log.warn(`GitHub Contents API ${response.status} for ${sourceName}/${path}`);
      }
      return null;
    }
    const data = (await response.json()) as GitHubContentItem[] | GitHubContentItem;
    // Endpoint returns an object for files, an array for directories.
    return Array.isArray(data) ? data : [data];
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      log.warn(`GitHub Contents API timeout for ${sourceName}/${path}`);
    } else {
      log.warn(
        `GitHub Contents API error for ${sourceName}/${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Score a candidate file against a search query.
 * Higher scores = better match. 0 means no match (skipped).
 */
function scoreContentMatch(itemName: string, itemPath: string, queryLower: string): number {
  const nameLower = itemName.toLowerCase();
  const pathLower = itemPath.toLowerCase();
  if (nameLower.includes(queryLower)) return 0.9;
  if (pathLower.includes(queryLower)) return 0.6;
  return 0;
}

/**
 * Convert a single matched Contents API entry into a SourceDiscoveryResult.
 * Returns null if the entry doesn't match the query or content-type filter.
 */
function buildResultFromContent(
  source: Source,
  item: GitHubContentItem,
  queryLower: string,
  typeFilter: ContentType | undefined,
): SourceDiscoveryResult | null {
  if (item.type !== 'file') return null;
  if (!item.name.endsWith('.md')) return null;
  if (!item.download_url) return null;

  const score = scoreContentMatch(item.name, item.path, queryLower);
  if (score === 0) return null;

  const inferredType = inferContentType(item.path, source.content);
  if (typeFilter && inferredType !== typeFilter) return null;

  return {
    source,
    name: item.name,
    description: `${item.path} in ${source.name}`,
    type: inferredType,
    url: item.download_url,
    score,
  };
}

/**
 * Fetch content listing from a GitHub source via the Contents API.
 *
 * Uses `GET /repos/{owner}/{repo}/contents/{path}` which works without
 * authentication (60 req/hr limit). Recurses one level into `plugins/*`
 * to discover wshobson-style nested layouts.
 *
 * Falls back to the legacy Code Search API only if `GITHUB_TOKEN` is set
 * AND `HARNESS_DISCOVER_USE_CODE_SEARCH=1` is opted in via env. Code Search
 * always requires auth (returns 401 unauthenticated as of 2023).
 *
 * @param source - GitHub source definition
 * @param query - Search query (case-insensitive substring match)
 * @param options - Discovery options
 * @returns Discovery results from the GitHub repo
 */
export async function fetchGitHubSource(
  source: Source,
  query: string,
  options?: SourceDiscoveryOptions,
  budget?: CallBudget,
): Promise<SourceDiscoveryResult[]> {
  // Parse GitHub URL to extract owner/repo
  const match = source.url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return [];

  const [, owner, repoRaw] = match;
  // Strip trailing .git or path fragments
  const repo = repoRaw.replace(/\.git$/, '').replace(/\/.*$/, '');

  // Optional opt-in to legacy Code Search path. Default is Contents API.
  if (process.env.GITHUB_TOKEN && process.env.HARNESS_DISCOVER_USE_CODE_SEARCH === '1') {
    log.debug(`[sources] using code search api for ${source.name} (GITHUB_TOKEN + opt-in detected)`);
    return fetchGitHubSourceViaCodeSearch(source, query, owner, repo, options);
  }

  log.debug(`[sources] using contents api for ${source.name}`);
  return fetchGitHubSourceViaContents(source, query, owner, repo, options, budget);
}

/**
 * A budget for Contents API calls. Shared across a single discoverRemote
 * invocation so multiple sources can't collectively exhaust the rate limit.
 */
interface CallBudget {
  remaining: number;
}

/**
 * Determine which top-level directories to scan for a given source.
 * Scopes by the source's declared `content:` types — if a source only
 * provides skills, we don't scan agents/, rules/, etc.
 */
function dirsForSource(source: Source): string[] {
  const dirs = new Set<string>();
  for (const ct of source.content) {
    for (const d of CONTENT_TYPE_TO_DIRS[ct] ?? []) {
      dirs.add(d);
    }
  }
  // If a source has no listed content types (shouldn't happen), fall back
  // to a safe default of skills+agents — the most common content types.
  if (dirs.size === 0) {
    dirs.add('skills');
    dirs.add('agents');
  }
  return Array.from(dirs);
}

/**
 * Discovery via the unauthenticated GitHub Contents API.
 *
 * Strategy (designed to fit within 60 req/hr unauth):
 * 1. Scan only the dirs the source advertises in its `content:` field.
 * 2. For plugins/, list topic names ONCE, filter topics by query match,
 *    only recurse into matching topics. Never enumerate all topics.
 * 3. Share a call budget across the whole discovery so a single source
 *    can't exhaust the rate limit for siblings.
 */
async function fetchGitHubSourceViaContents(
  source: Source,
  query: string,
  owner: string,
  repo: string,
  options?: SourceDiscoveryOptions,
  budget?: CallBudget,
): Promise<SourceDiscoveryResult[]> {
  const queryLower = query.toLowerCase();
  const typeFilter = options?.type;
  const maxResults = options?.maxResults ?? 10;
  const callBudget: CallBudget = budget ?? { remaining: MAX_API_CALLS_PER_DISCOVERY };
  const results: SourceDiscoveryResult[] = [];

  const dirsToScan = dirsForSource(source);

  // Scan top-level dirs in parallel — but only the ones this source declares.
  const topLevelTasks = dirsToScan.map((dir) => {
    if (callBudget.remaining <= 0) return Promise.resolve(null);
    callBudget.remaining--;
    return fetchGitHubContents(owner, repo, dir, source.name);
  });
  const topLevelLists = await Promise.all(topLevelTasks);

  for (let i = 0; i < dirsToScan.length; i++) {
    if (results.length >= maxResults) break;
    const dirName = dirsToScan[i];
    const items = topLevelLists[i];
    if (!items) continue;

    // Direct file matches first.
    for (const item of items) {
      if (results.length >= maxResults) break;
      const result = buildResultFromContent(source, item, queryLower, typeFilter);
      if (result) results.push(result);
    }

    // For plugins/, recurse selectively: only into topics whose name matches the query.
    if (dirName === 'plugins' && results.length < maxResults) {
      const matchingTopics = items.filter(
        (item) => item.type === 'dir' && item.name.toLowerCase().includes(queryLower),
      );
      for (const topic of matchingTopics) {
        if (results.length >= maxResults) break;
        if (callBudget.remaining <= 0) break;
        await scanPluginTopic(
          source,
          owner,
          repo,
          topic.path,
          queryLower,
          typeFilter,
          results,
          maxResults,
          callBudget,
        );
      }
    }
  }

  // Sort by score descending so the best matches come first.
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}

/**
 * Recurse one level into a single matching plugins/<topic>/ directory,
 * inspecting the harness primitive subdirs inside it (agents/, skills/, etc.).
 * Decrements the shared call budget. Stops on budget exhaustion or maxResults.
 */
async function scanPluginTopic(
  source: Source,
  owner: string,
  repo: string,
  topicPath: string,
  queryLower: string,
  typeFilter: ContentType | undefined,
  results: SourceDiscoveryResult[],
  maxResults: number,
  callBudget: CallBudget,
): Promise<void> {
  if (callBudget.remaining <= 0) return;
  callBudget.remaining--;
  const subDirs = await fetchGitHubContents(owner, repo, topicPath, source.name);
  if (!subDirs) return;

  for (const sub of subDirs) {
    if (results.length >= maxResults) return;
    if (callBudget.remaining <= 0) return;
    if (sub.type !== 'dir') continue;
    // Only descend into harness primitive subdirs.
    const validSubdir =
      sub.name === 'skills' ||
      sub.name === 'agents' ||
      sub.name === 'rules' ||
      sub.name === 'playbooks' ||
      sub.name === 'hooks';
    if (!validSubdir) continue;

    callBudget.remaining--;
    const files = await fetchGitHubContents(owner, repo, sub.path, source.name);
    if (!files) continue;

    for (const file of files) {
      if (results.length >= maxResults) return;
      const result = buildResultFromContent(source, file, queryLower, typeFilter);
      if (result) results.push(result);
    }
  }
}

/**
 * Legacy Code Search API path. Requires authentication (returns 401 unauthenticated
 * as of 2023). Kept as an opt-in fallback for power users with GITHUB_TOKEN who
 * want richer query semantics. Never the default.
 */
async function fetchGitHubSourceViaCodeSearch(
  source: Source,
  query: string,
  owner: string,
  repo: string,
  options?: SourceDiscoveryOptions,
): Promise<SourceDiscoveryResult[]> {
  const results: SourceDiscoveryResult[] = [];
  const apiUrl = `https://api.github.com/search/code?q=${encodeURIComponent(query)}+repo:${owner}/${repo}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_CONTENTS_TIMEOUT_MS);

  try {
    const response = await fetch(apiUrl, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'agent-harness',
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      log.warn(`GitHub Code Search API ${response.status} for ${source.name}`);
      return results;
    }

    const data = (await response.json()) as {
      items?: Array<{ name: string; path: string; html_url: string }>;
    };
    if (!data.items) return results;

    const maxResults = options?.maxResults ?? 10;
    const queryLower = query.toLowerCase();

    for (const item of data.items.slice(0, maxResults)) {
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
    log.warn(
      `Failed Code Search for ${source.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
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

  // Shared call budget across ALL sources for this discovery, so a single
  // big repo can't exhaust the GitHub rate limit for its siblings.
  const sharedBudget: CallBudget = { remaining: MAX_API_CALLS_PER_DISCOVERY };

  // Search each source in parallel
  const promises = filtered.map(async (source) => {
    if (source.type === 'github') {
      return fetchGitHubSource(source, query, options, sharedBudget);
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
