import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, extname, basename } from 'path';
import matter from 'gray-matter';
import { FrontmatterSchema, CORE_PRIMITIVE_DIRS, type HarnessDocument, type Frontmatter } from '../core/types.js';

export interface ParseError {
  path: string;
  error: string;
}

export interface LoadResult {
  docs: HarnessDocument[];
  errors: ParseError[];
}

// Extract L0 and L1 from HTML comments at the top of the markdown body
// Format: <!-- L0: one-line summary -->
//         <!-- L1: paragraph summary -->
const L0_REGEX = /<!--\s*L0:\s*([\s\S]*?)\s*-->/;
const L1_REGEX = /<!--\s*L1:\s*([\s\S]*?)\s*-->/;

/**
 * Primitive kinds that support multi-file bundles (Agent Skills convention).
 * Each maps to its canonical entry filename. Other kinds (instincts, tools,
 * agents, intake) must be flat single-file primitives; a directory in those
 * kinds is a user error and reported as such.
 *
 * See: https://agentskills.io/specification — we follow it verbatim for
 * `skills/` and mirror the pattern for other bundle-capable kinds.
 */
export const BUNDLE_ENTRY_BY_KIND: Record<string, string> = {
  skills: 'SKILL.md',
  playbooks: 'PLAYBOOK.md',
  rules: 'RULE.md',
  workflows: 'WORKFLOW.md',
};

/**
 * Return the canonical entry filename for a primitive kind (by basename of its
 * directory), or null if bundling is not supported for that kind.
 */
export function bundleEntryNameFor(kind: string): string | null {
  return BUNDLE_ENTRY_BY_KIND[kind] ?? null;
}

export function parseHarnessDocument(filePath: string, bundleDir?: string): HarnessDocument {
  const raw = readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);

  const normalized = { ...data };
  for (const key of ['created', 'updated']) {
    if (normalized[key] instanceof Date) {
      normalized[key] = (normalized[key] as Date).toISOString().split('T')[0];
    }
  }

  let frontmatter: Frontmatter;
  try {
    frontmatter = FrontmatterSchema.parse(normalized);
  } catch {
    const fallbackId = bundleDir
      ? basename(bundleDir)
      : basename(filePath).replace(/\.md$/, '') || 'unknown';
    frontmatter = FrontmatterSchema.parse({ id: fallbackId });
  }

  // Strip L0/L1 HTML comments from the body — they are not assigned as fields.
  // The regex constants are kept so that migration tooling (task 6.3) can import them.
  const body = content
    .replace(L0_REGEX, '')
    .replace(L1_REGEX, '')
    .trim();

  // Derive canonical id: prefer frontmatter.id (already slugified by FrontmatterSchema
  // preprocess), else bundle dir name, else filename stem.
  const id = frontmatter.id ||
    (bundleDir ? basename(bundleDir) : basename(filePath).replace(/\.md$/, '')) ||
    'unknown';

  // Derive canonical name: prefer frontmatter.name (display name), else fall back to id.
  const name = typeof frontmatter.name === 'string' ? frontmatter.name : id;

  // Parse allowed-tools: the legacy FrontmatterSchema stores it as string[] already;
  // the new spec stores it as a space-separated string. Handle both.
  const rawAllowedTools = (frontmatter as Record<string, unknown>)['allowed-tools'];
  let allowedTools: string[] = [];
  if (typeof rawAllowedTools === 'string') {
    allowedTools = rawAllowedTools.split(/\s+/).filter(Boolean);
  } else if (Array.isArray(rawAllowedTools)) {
    allowedTools = rawAllowedTools.filter((t): t is string => typeof t === 'string');
  }

  const fm = frontmatter as Record<string, unknown>;

  const doc: HarnessDocument = {
    path: filePath,
    id,
    name,
    description: typeof fm.description === 'string' ? fm.description : undefined,
    license: typeof fm.license === 'string' ? fm.license : undefined,
    compatibility: typeof fm.compatibility === 'string' ? fm.compatibility : undefined,
    allowedTools,
    tags: Array.isArray(frontmatter.tags) ? frontmatter.tags as string[] : [],
    status: (frontmatter.status ?? 'active') as 'active' | 'archived' | 'deprecated' | 'draft',
    author: (frontmatter.author ?? 'human') as 'human' | 'agent' | 'infrastructure',
    created: typeof frontmatter.created === 'string' ? frontmatter.created : undefined,
    updated: typeof frontmatter.updated === 'string' ? frontmatter.updated : undefined,
    related: Array.isArray(frontmatter.related) ? frontmatter.related as string[] : [],
    schedule: typeof fm.schedule === 'string' ? fm.schedule : undefined,
    with: typeof fm.with === 'string' ? fm.with : undefined,
    channel: typeof fm.channel === 'string' ? fm.channel : undefined,
    duration_minutes: typeof fm.duration_minutes === 'number' ? fm.duration_minutes : undefined,
    max_retries: typeof fm.max_retries === 'number' ? fm.max_retries : undefined,
    retry_delay_ms: typeof fm.retry_delay_ms === 'number' ? fm.retry_delay_ms : undefined,
    durable: typeof fm.durable === 'boolean' ? fm.durable : undefined,
    model: (typeof fm.model === 'string' ? fm.model : undefined) as 'primary' | 'summary' | 'fast' | undefined,
    active_tools: Array.isArray(fm.active_tools) ? fm.active_tools as string[] : undefined,
    metadata: typeof fm.metadata === 'object' && fm.metadata !== null
      ? fm.metadata as Record<string, unknown>
      : undefined,
    body,
    raw,
    frontmatter,
  };
  if (bundleDir) doc.bundleDir = bundleDir;
  return doc;
}

/**
 * Find the entry-point markdown file for a bundled primitive, given its
 * containing kind (e.g. "skills" → looks for SKILL.md). Returns the full path
 * if present, or null if the bundle is malformed (no entry file).
 */
function findBundleEntry(bundleDir: string, kind: string): string | null {
  const entryName = bundleEntryNameFor(kind);
  if (!entryName) return null;
  const candidate = join(bundleDir, entryName);
  if (existsSync(candidate) && statSync(candidate).isFile()) {
    return candidate;
  }
  return null;
}

export function loadDirectory(dirPath: string): HarnessDocument[] {
  return loadDirectoryWithErrors(dirPath).docs;
}

export function loadDirectoryWithErrors(dirPath: string): LoadResult {
  if (!existsSync(dirPath)) return { docs: [], errors: [] };

  const kind = basename(dirPath);
  const entryName = bundleEntryNameFor(kind);
  const docs: HarnessDocument[] = [];
  const errors: ParseError[] = [];

  for (const entry of readdirSync(dirPath)) {
    if (entry.startsWith('_')) continue; // index files, _archive, etc.
    if (entry.startsWith('.')) continue; // hidden

    const entryPath = join(dirPath, entry);
    let stats;
    try {
      stats = statSync(entryPath);
    } catch {
      continue;
    }

    if (stats.isDirectory()) {
      // Bundled primitive. Only kinds listed in BUNDLE_ENTRY_BY_KIND support
      // bundling (skills/playbooks/rules/workflows). For other kinds, a
      // directory here is a user error — flag it so they don't silently
      // lose a primitive they thought was loaded.
      if (!entryName) {
        errors.push({
          path: entryPath,
          error: `Bundling is not supported for "${kind}" — use flat .md files only (bundle-capable kinds: ${Object.keys(BUNDLE_ENTRY_BY_KIND).join(', ')})`,
        });
        continue;
      }
      const entryFile = findBundleEntry(entryPath, kind);
      if (!entryFile) {
        errors.push({
          path: entryPath,
          error: `Bundle directory is missing its entry file (expected ${entryName})`,
        });
        continue;
      }
      try {
        const doc = parseHarnessDocument(entryFile, entryPath);
        if (doc.status !== 'archived' && doc.status !== 'deprecated') {
          docs.push(doc);
        }
      } catch (err) {
        errors.push({
          path: entryFile,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (stats.isFile() && extname(entry) === '.md') {
      // Flat primitive — single-file convention, backward compatible.
      try {
        const doc = parseHarnessDocument(entryPath);
        if (doc.status !== 'archived' && doc.status !== 'deprecated') {
          docs.push(doc);
        }
      } catch (err) {
        errors.push({
          path: entryPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { docs, errors };
}

export interface LoadAllResult {
  primitives: Map<string, HarnessDocument[]>;
  errors: ParseError[];
}

export function loadAllPrimitives(harnessDir: string, extraDirs?: string[]): Map<string, HarnessDocument[]> {
  return loadAllPrimitivesWithErrors(harnessDir, extraDirs).primitives;
}

export function loadAllPrimitivesWithErrors(harnessDir: string, extraDirs?: string[]): LoadAllResult {
  const primitives = new Map<string, HarnessDocument[]>();
  const allErrors: ParseError[] = [];

  const directories: string[] = [...CORE_PRIMITIVE_DIRS];
  if (extraDirs) {
    for (const dir of extraDirs) {
      if (!directories.includes(dir)) {
        directories.push(dir);
      }
    }
  }

  for (const dir of directories) {
    const { docs, errors } = loadDirectoryWithErrors(join(harnessDir, dir));
    primitives.set(dir, docs);
    allErrors.push(...errors);
  }

  return { primitives, errors: allErrors };
}

// Estimate token count (rough: 1 token ≈ 4 chars)
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

