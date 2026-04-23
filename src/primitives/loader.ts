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

  const l0Match = content.match(L0_REGEX);
  const l1Match = content.match(L1_REGEX);

  const l0 = l0Match ? l0Match[1].trim() : '';
  const l1 = l1Match ? l1Match[1].trim() : '';

  const body = content
    .replace(L0_REGEX, '')
    .replace(L1_REGEX, '')
    .trim();

  const doc: HarnessDocument = {
    path: filePath,
    frontmatter,
    l0,
    l1,
    body,
    raw,
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
        if (doc.frontmatter.status !== 'archived' && doc.frontmatter.status !== 'deprecated') {
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
        if (doc.frontmatter.status !== 'archived' && doc.frontmatter.status !== 'deprecated') {
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

// Load a file at a specific disclosure level
export function getAtLevel(doc: HarnessDocument, level: 0 | 1 | 2): string {
  switch (level) {
    case 0:
      return doc.l0 || doc.frontmatter.id;
    case 1:
      return doc.l1 || doc.l0 || doc.body.slice(0, 400);
    case 2:
      return doc.body;
  }
}
