import { existsSync } from 'fs';
import { join } from 'path';
import { loadDirectory } from '../primitives/loader.js';
import { getPrimitiveDirs } from '../core/types.js';
import type { HarnessConfig, HarnessDocument } from '../core/types.js';

export interface SearchOptions {
  /** Filter by tag (case-insensitive) */
  tag?: string;
  /** Filter by primitive type directory (e.g., "rules", "skills") */
  type?: string;
  /** Filter by status (e.g., "active", "draft") */
  status?: string;
  /** Filter by author (e.g., "human", "agent") */
  author?: string;
}

export interface SearchResult {
  doc: HarnessDocument;
  directory: string;
  matchReason: string;
}

/**
 * Search primitives across all directories by query text and/or filters.
 * Query matches against: id, tags, L0 summary, L1 summary, body content.
 */
export function searchPrimitives(
  harnessDir: string,
  query?: string,
  options?: SearchOptions,
  config?: HarnessConfig,
): SearchResult[] {
  const results: SearchResult[] = [];
  const dirs = getPrimitiveDirs(config);
  const queryLower = query?.toLowerCase();

  for (const dir of dirs) {
    // Filter by type directory if specified
    if (options?.type) {
      const typeNorm = options.type.toLowerCase();
      // Accept both singular ("rule") and plural ("rules")
      if (dir !== typeNorm && dir !== typeNorm + 's' && dir.replace(/s$/, '') !== typeNorm) {
        continue;
      }
    }

    const fullPath = join(harnessDir, dir);
    if (!existsSync(fullPath)) continue;

    const docs = loadDirectory(fullPath);

    for (const doc of docs) {
      // Filter by status
      if (options?.status && doc.frontmatter.status !== options.status) continue;

      // Filter by author
      if (options?.author && doc.frontmatter.author !== options.author) continue;

      // Filter by tag
      if (options?.tag) {
        const tagLower = options.tag.toLowerCase();
        const hasTag = doc.frontmatter.tags.some((t) => t.toLowerCase() === tagLower);
        if (!hasTag) continue;
      }

      // Match query text
      if (queryLower) {
        const matchReason = matchDocument(doc, queryLower);
        if (!matchReason) continue;
        results.push({ doc, directory: dir, matchReason });
      } else {
        // No query — return all matching filters
        results.push({ doc, directory: dir, matchReason: 'filter match' });
      }
    }
  }

  return results;
}

function matchDocument(doc: HarnessDocument, queryLower: string): string | null {
  // Check id
  if (doc.frontmatter.id.toLowerCase().includes(queryLower)) {
    return `id: ${doc.frontmatter.id}`;
  }

  // Check tags
  for (const tag of doc.frontmatter.tags) {
    if (tag.toLowerCase().includes(queryLower)) {
      return `tag: ${tag}`;
    }
  }

  // Check L0
  if (doc.l0.toLowerCase().includes(queryLower)) {
    return `L0: ${doc.l0.slice(0, 80)}`;
  }

  // Check L1
  if (doc.l1.toLowerCase().includes(queryLower)) {
    return `L1 match`;
  }

  // Check body content
  const bodyLower = doc.body.toLowerCase();
  const idx = bodyLower.indexOf(queryLower);
  if (idx !== -1) {
    const start = Math.max(0, idx - 20);
    const end = Math.min(bodyLower.length, idx + queryLower.length + 30);
    const snippet = doc.body.slice(start, end).replace(/\n/g, ' ').trim();
    return `body: ...${snippet}...`;
  }

  return null;
}
