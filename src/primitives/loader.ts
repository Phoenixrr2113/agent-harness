import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, extname, basename } from 'path';
import matter from 'gray-matter';
import { FrontmatterSchema, CORE_PRIMITIVE_DIRS, type HarnessDocument, type Frontmatter } from '../core/types.js';
import { normalizeFrontmatter } from './normalize.js';

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
  rules: 'RULE.md',
};

/**
 * Return the canonical entry filename for a primitive kind (by basename of its
 * directory), or null if bundling is not supported for that kind.
 */
export function bundleEntryNameFor(kind: string): string | null {
  return BUNDLE_ENTRY_BY_KIND[kind] ?? null;
}

export function parseHarnessDocument(filePath: string, bundleDir?: string, kind?: string): HarnessDocument {
  const rawContent = readFileSync(filePath, 'utf-8');
  const { data, content } = matter(rawContent);

  // Normalize date-typed values from YAML (gray-matter parses YYYY-MM-DD as Date objects)
  const normalized: Record<string, unknown> = { ...data };
  for (const key of ['created', 'updated']) {
    const v = normalized[key];
    if (v instanceof Date) normalized[key] = v.toISOString().split('T')[0];
  }

  // Strict: schema parse failures throw and are reported by the caller.
  const frontmatter: Frontmatter = FrontmatterSchema.parse(normalized);

  // Strip L0/L1 markers from body (kept for migration; no longer extracted as fields)
  const body = content
    .replace(L0_REGEX, '')
    .replace(L1_REGEX, '')
    .trim();

  // Run normalization to derive canonical accessor fields (kind-aware)
  const resolvedKind = kind ?? 'unknown';
  const normalizedFields = normalizeFrontmatter(normalized, resolvedKind, bundleDir ?? filePath);

  // Override id with the FrontmatterSchema-derived value, which applies slugifyName
  // when name is present and id is absent — normalizeFrontmatter does not slugify.
  const id = frontmatter.id || normalizedFields.id;

  const doc: HarnessDocument = {
    path: filePath,
    body,
    raw: rawContent,
    frontmatter,
    ...normalizedFields,
    // id must come after spread to use the slugified FrontmatterSchema value
    id,
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
        const doc = parseHarnessDocument(entryFile, entryPath, kind);
        // Spec rule: skills/<name>/SKILL.md must have frontmatter name === <name>
        // (https://agentskills.io/specification#name-field)
        // We compare the slugified doc.id (derived from name) against the directory
        // basename so that display-name variants (e.g. "PR Review" → "pr-review")
        // still resolve correctly.
        const expectedName = basename(entryPath);
        if (kind === 'skills' && doc.id !== expectedName) {
          errors.push({
            path: entryFile,
            error: `Skill bundle name mismatch: parent directory is "${expectedName}" but frontmatter name is "${doc.name}". Per Agent Skills spec, name must match the parent directory.`,
          });
          continue;
        }
        if (doc.status !== 'archived' && doc.status !== 'deprecated') {
          docs.push(doc);
        }
      } catch (err) {
        // Provide a more actionable error for skill bundles that fail schema validation.
        // FrontmatterSchema requires id (derived from name), so a missing name field
        // produces an error about "id" — translate it to mention "name" for authors.
        const rawMessage = err instanceof Error ? err.message : String(err);
        const message =
          kind === 'skills' && rawMessage.includes('"id"')
            ? `Invalid skill frontmatter in ${basename(entryFile)}: "name" is required (missing or invalid). Per Agent Skills spec, each skill MUST have a name field. Run \`harness doctor --migrate\` for help. Details: ${rawMessage}`
            : rawMessage;
        errors.push({ path: entryFile, error: message });
      }
    } else if (stats.isFile() && extname(entry) === '.md') {
      // Per Agent Skills spec, skills MUST be bundles. Flat .md files in skills/
      // are an authoring error.
      if (kind === 'skills') {
        errors.push({
          path: entryPath,
          error: `Flat skill files are not supported per Agent Skills spec. Wrap as ${entry.replace('.md', '')}/SKILL.md. Run \`harness doctor --migrate\` to convert automatically.`,
        });
        continue;
      }
      // Flat primitives for non-skill kinds remain supported through this spec
      // (collapsed in spec #2).
      try {
        const doc = parseHarnessDocument(entryPath, undefined, kind);
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

