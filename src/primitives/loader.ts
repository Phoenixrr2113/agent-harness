import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, extname } from 'path';
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

export function parseHarnessDocument(filePath: string): HarnessDocument {
  const raw = readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);

  // Parse frontmatter with defaults
  // Normalize dates: gray-matter converts date strings to Date objects
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
    // Fallback: create minimal frontmatter from filename
    const id = filePath.split('/').pop()?.replace('.md', '') || 'unknown';
    frontmatter = FrontmatterSchema.parse({ id });
  }

  // Extract L0 and L1 from content
  const l0Match = content.match(L0_REGEX);
  const l1Match = content.match(L1_REGEX);

  const l0 = l0Match ? l0Match[1].trim() : '';
  const l1 = l1Match ? l1Match[1].trim() : '';

  // Body is the content without L0/L1 comments
  const body = content
    .replace(L0_REGEX, '')
    .replace(L1_REGEX, '')
    .trim();

  return {
    path: filePath,
    frontmatter,
    l0,
    l1,
    body,
    raw,
  };
}

export function loadDirectory(dirPath: string): HarnessDocument[] {
  return loadDirectoryWithErrors(dirPath).docs;
}

export function loadDirectoryWithErrors(dirPath: string): LoadResult {
  if (!existsSync(dirPath)) return { docs: [], errors: [] };

  const files = readdirSync(dirPath);
  const docs: HarnessDocument[] = [];
  const errors: ParseError[] = [];

  for (const file of files) {
    if (extname(file) !== '.md') continue;
    if (file.startsWith('_')) continue; // Skip index files
    if (file.startsWith('.')) continue; // Skip hidden files

    const filePath = join(dirPath, file);
    try {
      const doc = parseHarnessDocument(filePath);
      if (doc.frontmatter.status !== 'archived' && doc.frontmatter.status !== 'deprecated') {
        docs.push(doc);
      }
    } catch (err) {
      errors.push({
        path: filePath,
        error: err instanceof Error ? err.message : String(err),
      });
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
