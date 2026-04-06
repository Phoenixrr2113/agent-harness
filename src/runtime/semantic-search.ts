import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { loadAllPrimitives, estimateTokens, getAtLevel } from '../primitives/loader.js';
import type { HarnessDocument, HarnessConfig } from '../core/types.js';
import { withFileLockSync } from './file-lock.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A stored embedding for a single primitive document. */
export interface EmbeddingRecord {
  /** Document ID from frontmatter */
  id: string;
  /** Path to the source markdown file */
  path: string;
  /** Primitive directory (rules, skills, etc.) */
  directory: string;
  /** Text that was embedded (L0 + L1 + tags) */
  embeddedText: string;
  /** The embedding vector */
  vector: number[];
  /** File modification time (to detect stale embeddings) */
  mtime: string;
  /** When the embedding was generated */
  createdAt: string;
}

/** Embedding store format — persisted as JSON. */
export interface EmbeddingStore {
  /** Model ID used for embeddings (invalidate cache if changed) */
  modelId: string;
  /** Embedding vector dimension */
  dimensions: number;
  /** Map of document ID → embedding record */
  records: Record<string, EmbeddingRecord>;
  /** Last full index time */
  lastIndexedAt: string;
}

/** Result of a semantic search query. */
export interface SemanticSearchResult {
  doc: HarnessDocument;
  directory: string;
  /** Cosine similarity score (0-1, higher is more relevant) */
  score: number;
  /** The embedded text that matched */
  embeddedText: string;
}

/** Function signature for embedding text → vector. */
export type EmbedFunction = (texts: string[]) => Promise<number[][]>;

/** Configuration for the semantic search module. */
export interface SemanticSearchConfig {
  /** Function to embed text (wraps Vercel AI SDK embed/embedMany) */
  embed: EmbedFunction;
  /** Embedding model identifier (for cache invalidation) */
  modelId: string;
  /** Maximum results to return (default: 10) */
  maxResults?: number;
  /** Minimum similarity threshold (default: 0.3) */
  minScore?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STORE_FILE = 'embeddings.json';
const STORE_DIR = 'memory';

// ─── Store Management ────────────────────────────────────────────────────────

/** Load the embedding store from disk. Returns null if not found or invalid. */
export function loadEmbeddingStore(harnessDir: string): EmbeddingStore | null {
  const storePath = join(harnessDir, STORE_DIR, STORE_FILE);
  if (!existsSync(storePath)) return null;

  try {
    const raw = readFileSync(storePath, 'utf-8');
    return JSON.parse(raw) as EmbeddingStore;
  } catch {
    return null;
  }
}

/** Save the embedding store to disk. */
export function saveEmbeddingStore(harnessDir: string, store: EmbeddingStore): void {
  const storeDir = join(harnessDir, STORE_DIR);
  if (!existsSync(storeDir)) {
    mkdirSync(storeDir, { recursive: true });
  }

  const storePath = join(storeDir, STORE_FILE);
  withFileLockSync(harnessDir, storePath, () => {
    writeFileSync(storePath, JSON.stringify(store), 'utf-8');
  });
}

// ─── Text Extraction ─────────────────────────────────────────────────────────

/**
 * Extract embeddable text from a document.
 * Combines: tags, L0 summary, L1 summary, and first 500 chars of body.
 * This gives a compact representation for embedding.
 */
export function extractEmbeddableText(doc: HarnessDocument): string {
  const parts: string[] = [];

  // Tags provide topical context
  if (doc.frontmatter.tags.length > 0) {
    parts.push(`Tags: ${doc.frontmatter.tags.join(', ')}`);
  }

  // L0 — one-liner
  if (doc.l0) {
    parts.push(doc.l0);
  }

  // L1 — paragraph summary
  if (doc.l1) {
    parts.push(doc.l1);
  }

  // Truncated body for additional context
  const bodyPreview = doc.body.slice(0, 500).trim();
  if (bodyPreview) {
    parts.push(bodyPreview);
  }

  return parts.join('\n').trim();
}

// ─── Indexing ────────────────────────────────────────────────────────────────

/**
 * Detect which primitives need re-embedding.
 * A primitive is stale if:
 * - It doesn't exist in the store
 * - Its file mtime has changed since last embedding
 * - The embedding model has changed
 */
export function detectStalePrimitives(
  harnessDir: string,
  store: EmbeddingStore | null,
  modelId: string,
  config?: HarnessConfig,
): Array<{ doc: HarnessDocument; directory: string }> {
  const stale: Array<{ doc: HarnessDocument; directory: string }> = [];
  const allPrimitives = loadAllPrimitives(harnessDir, config?.extensions?.directories);

  // If model changed, everything is stale
  const modelChanged = store !== null && store.modelId !== modelId;

  for (const [directory, docs] of allPrimitives) {
    for (const doc of docs) {
      if (doc.frontmatter.status !== 'active') continue;

      const id = doc.frontmatter.id;

      if (modelChanged || !store) {
        stale.push({ doc, directory });
        continue;
      }

      const existing = store.records[id];
      if (!existing) {
        stale.push({ doc, directory });
        continue;
      }

      // Check if file changed
      try {
        const stat = statSync(doc.path);
        if (stat.mtime.toISOString() !== existing.mtime) {
          stale.push({ doc, directory });
        }
      } catch {
        stale.push({ doc, directory });
      }
    }
  }

  return stale;
}

/**
 * Index (or re-index) all primitives that need embeddings.
 * Incrementally updates the store — only re-embeds stale documents.
 *
 * @param harnessDir - Harness directory path
 * @param config - Semantic search configuration with embed function
 * @param harnessConfig - Optional harness config for extension directories
 * @returns Updated embedding store
 */
export async function indexPrimitives(
  harnessDir: string,
  searchConfig: SemanticSearchConfig,
  harnessConfig?: HarnessConfig,
): Promise<EmbeddingStore> {
  let store = loadEmbeddingStore(harnessDir);

  const stale = detectStalePrimitives(harnessDir, store, searchConfig.modelId, harnessConfig);

  if (stale.length === 0 && store) {
    return store;
  }

  // Initialize store if needed
  if (!store || store.modelId !== searchConfig.modelId) {
    store = {
      modelId: searchConfig.modelId,
      dimensions: 0,
      records: {},
      lastIndexedAt: new Date().toISOString(),
    };
  }

  // Extract texts to embed
  const textsToEmbed: string[] = [];
  const docInfos: Array<{ doc: HarnessDocument; directory: string }> = [];

  for (const item of stale) {
    const text = extractEmbeddableText(item.doc);
    if (!text) continue;
    textsToEmbed.push(text);
    docInfos.push(item);
  }

  if (textsToEmbed.length === 0) {
    return store;
  }

  // Batch embed (chunked to avoid hitting rate limits)
  const batchSize = 50;
  for (let i = 0; i < textsToEmbed.length; i += batchSize) {
    const batch = textsToEmbed.slice(i, i + batchSize);
    const batchDocs = docInfos.slice(i, i + batchSize);

    const vectors = await searchConfig.embed(batch);

    for (let j = 0; j < vectors.length; j++) {
      const doc = batchDocs[j].doc;
      const vector = vectors[j];

      if (store.dimensions === 0 && vector.length > 0) {
        store.dimensions = vector.length;
      }

      let mtime: string;
      try {
        const stat = statSync(doc.path);
        mtime = stat.mtime.toISOString();
      } catch {
        mtime = new Date().toISOString();
      }

      store.records[doc.frontmatter.id] = {
        id: doc.frontmatter.id,
        path: doc.path,
        directory: batchDocs[j].directory,
        embeddedText: batch[j],
        vector,
        mtime,
        createdAt: new Date().toISOString(),
      };
    }
  }

  store.lastIndexedAt = new Date().toISOString();

  // Clean up deleted docs
  const allIds = new Set<string>();
  const allPrimitives = loadAllPrimitives(harnessDir, harnessConfig?.extensions?.directories);
  for (const [, docs] of allPrimitives) {
    for (const doc of docs) {
      allIds.add(doc.frontmatter.id);
    }
  }

  for (const id of Object.keys(store.records)) {
    if (!allIds.has(id)) {
      delete store.records[id];
    }
  }

  saveEmbeddingStore(harnessDir, store);
  return store;
}

// ─── Search ──────────────────────────────────────────────────────────────────

/**
 * Compute cosine similarity between two vectors.
 * Returns a value between -1 and 1 (1 = identical, 0 = orthogonal).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Perform semantic search over indexed primitives.
 *
 * @param harnessDir - Harness directory path
 * @param query - Natural language query
 * @param searchConfig - Search configuration with embed function
 * @param harnessConfig - Optional harness config
 * @returns Ranked search results by cosine similarity
 */
export async function semanticSearch(
  harnessDir: string,
  query: string,
  searchConfig: SemanticSearchConfig,
  harnessConfig?: HarnessConfig,
): Promise<SemanticSearchResult[]> {
  const store = loadEmbeddingStore(harnessDir);
  if (!store || Object.keys(store.records).length === 0) {
    return [];
  }

  const maxResults = searchConfig.maxResults ?? 10;
  const minScore = searchConfig.minScore ?? 0.3;

  // Embed the query
  const [queryVector] = await searchConfig.embed([query]);
  if (!queryVector || queryVector.length === 0) {
    return [];
  }

  // Score all documents
  const scored: Array<{ record: EmbeddingRecord; score: number }> = [];

  for (const record of Object.values(store.records)) {
    const score = cosineSimilarity(queryVector, record.vector);
    if (score >= minScore) {
      scored.push({ record, score });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Load the actual documents for results
  const allPrimitives = loadAllPrimitives(harnessDir, harnessConfig?.extensions?.directories);
  const docMap = new Map<string, { doc: HarnessDocument; directory: string }>();
  for (const [directory, docs] of allPrimitives) {
    for (const doc of docs) {
      docMap.set(doc.frontmatter.id, { doc, directory });
    }
  }

  const results: SemanticSearchResult[] = [];

  for (const { record, score } of scored.slice(0, maxResults)) {
    const entry = docMap.get(record.id);
    if (!entry) continue;

    results.push({
      doc: entry.doc,
      directory: entry.directory,
      score,
      embeddedText: record.embeddedText,
    });
  }

  return results;
}

/**
 * Get embedding stats for the harness.
 */
export function getEmbeddingStats(harnessDir: string): {
  indexed: number;
  modelId: string | null;
  dimensions: number;
  lastIndexedAt: string | null;
  storeSize: number;
} {
  const store = loadEmbeddingStore(harnessDir);
  if (!store) {
    return {
      indexed: 0,
      modelId: null,
      dimensions: 0,
      lastIndexedAt: null,
      storeSize: 0,
    };
  }

  const storePath = join(harnessDir, STORE_DIR, STORE_FILE);
  let storeSize = 0;
  try {
    storeSize = statSync(storePath).size;
  } catch {
    // Ignore
  }

  return {
    indexed: Object.keys(store.records).length,
    modelId: store.modelId,
    dimensions: store.dimensions,
    lastIndexedAt: store.lastIndexedAt,
    storeSize,
  };
}
