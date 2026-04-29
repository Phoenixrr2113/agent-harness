import { createHash } from 'crypto';
import matter from 'gray-matter';

export interface ProvenanceMarker {
  'harness-exported-from': string;
  'harness-exported-at': string;
  'harness-exported-by': string;
  'harness-content-hash': string;
}

export type ProvenanceMode = 'frontmatter' | 'markdown-comment';

export function computeContentHash(content: string): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

const COMMENT_DELIMITER_OPEN = '<!-- agent-harness-provenance';
const COMMENT_DELIMITER_CLOSE = '-->';

export function embedProvenance(content: string, marker: ProvenanceMarker, mode: ProvenanceMode): string {
  if (mode === 'frontmatter') {
    const fm = matter(content);
    const data = (fm.data ?? {}) as Record<string, unknown>;
    const metadata = (data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata))
      ? data.metadata as Record<string, unknown>
      : {};
    data.metadata = { ...metadata, ...marker };
    return matter.stringify(fm.content, data);
  }
  const lines = [
    COMMENT_DELIMITER_OPEN,
    ...Object.entries(marker).map(([k, v]) => `${k}: ${v}`),
    COMMENT_DELIMITER_CLOSE,
  ];
  return lines.join('\n') + '\n' + content;
}

export function extractProvenance(content: string, mode: ProvenanceMode): ProvenanceMarker | null {
  if (mode === 'frontmatter') {
    const fm = matter(content);
    const metadata = (fm.data?.metadata as Record<string, unknown>) ?? {};
    if (!metadata['harness-exported-from']) return null;
    return {
      'harness-exported-from': String(metadata['harness-exported-from']),
      'harness-exported-at': String(metadata['harness-exported-at'] ?? ''),
      'harness-exported-by': String(metadata['harness-exported-by'] ?? ''),
      'harness-content-hash': String(metadata['harness-content-hash'] ?? ''),
    };
  }
  if (!content.startsWith(COMMENT_DELIMITER_OPEN)) return null;
  const closeIdx = content.indexOf(COMMENT_DELIMITER_CLOSE);
  if (closeIdx < 0) return null;
  const block = content.slice(COMMENT_DELIMITER_OPEN.length, closeIdx);
  const m: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) m[key] = value;
  }
  if (!m['harness-exported-from']) return null;
  return {
    'harness-exported-from': m['harness-exported-from'],
    'harness-exported-at': m['harness-exported-at'] ?? '',
    'harness-exported-by': m['harness-exported-by'] ?? '',
    'harness-content-hash': m['harness-content-hash'] ?? '',
  };
}

export function hasProvenance(content: string): boolean {
  if (content.startsWith(COMMENT_DELIMITER_OPEN)) return true;
  return extractProvenance(content, 'frontmatter') !== null;
}

/**
 * Strip the provenance marker from content for hashing.
 * Hash MUST exclude the marker itself to avoid hash-of-hash recursion.
 */
export function stripProvenance(content: string, mode: ProvenanceMode): string {
  if (mode === 'markdown-comment') {
    if (!content.startsWith(COMMENT_DELIMITER_OPEN)) return content;
    const closeIdx = content.indexOf(COMMENT_DELIMITER_CLOSE);
    if (closeIdx < 0) return content;
    const after = content.slice(closeIdx + COMMENT_DELIMITER_CLOSE.length);
    return after.startsWith('\n') ? after.slice(1) : after;
  }
  // frontmatter mode: parse, remove provenance keys from metadata, restringify
  const fm = matter(content);
  const data = (fm.data ?? {}) as Record<string, unknown>;
  if (data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)) {
    const metadata = { ...(data.metadata as Record<string, unknown>) };
    delete metadata['harness-exported-from'];
    delete metadata['harness-exported-at'];
    delete metadata['harness-exported-by'];
    delete metadata['harness-content-hash'];
    if (Object.keys(metadata).length === 0) {
      delete data.metadata;
    } else {
      data.metadata = metadata;
    }
  }
  return matter.stringify(fm.content, data);
}
