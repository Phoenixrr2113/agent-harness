import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scaffoldHarness } from '../src/cli/scaffold.js';
import {
  extractEmbeddableText,
  cosineSimilarity,
  loadEmbeddingStore,
  saveEmbeddingStore,
  detectStalePrimitives,
  indexPrimitives,
  semanticSearch,
  getEmbeddingStats,
} from '../src/runtime/semantic-search.js';
import { parseHarnessDocument } from '../src/primitives/loader.js';
import type { EmbedFunction, EmbeddingStore } from '../src/runtime/semantic-search.js';

/** Mock embed function: creates a simple hash-based vector. */
function createMockEmbed(dim: number = 8): EmbedFunction {
  return async (texts: string[]): Promise<number[][]> => {
    return texts.map((text) => {
      // Simple hash-based vector for testing
      const vector = new Array<number>(dim).fill(0);
      for (let i = 0; i < text.length; i++) {
        vector[i % dim] += text.charCodeAt(i) / 1000;
      }
      // Normalize
      const mag = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
      if (mag > 0) {
        for (let i = 0; i < dim; i++) {
          vector[i] /= mag;
        }
      }
      return vector;
    });
  };
}

describe('semantic-search', () => {
  let harnessDir: string;
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'semantic-'));
    harnessDir = join(tmpBase, 'test-agent');
    scaffoldHarness(harnessDir, 'test-agent', { template: 'base' });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  describe('extractEmbeddableText', () => {
    it('should combine tags, L0, L1, and body preview', () => {
      const filePath = join(tmpBase, 'test-doc.md');
      writeFileSync(filePath, '---\nid: test-doc\ntags: [security, rules]\n---\n\n<!-- L0: Security rule for API keys -->\n<!-- L1: Always validate API keys at the boundary -->\n\n# Security Rule\n\nNever commit API keys to version control.\n');
      const doc = parseHarnessDocument(filePath);

      const text = extractEmbeddableText(doc);
      expect(text).toContain('security');
      expect(text).toContain('API keys');
    });

    it('should handle docs with no tags', () => {
      const filePath = join(tmpBase, 'no-tags.md');
      writeFileSync(filePath, '---\nid: no-tags\ntags: []\ndescription: "Simple doc"\n---\n\nContent here.\n');
      const doc = parseHarnessDocument(filePath);

      const text = extractEmbeddableText(doc);
      expect(text).toContain('Simple doc');
      expect(text).not.toContain('Tags:');
    });

    it('should truncate body to 500 chars', () => {
      const longBody = 'A'.repeat(1000);
      const filePath = join(tmpBase, 'long-doc.md');
      writeFileSync(filePath, `---\nid: long-doc\ntags: []\n---\n\n<!-- L0: Long doc -->\n\n${longBody}\n`);
      const doc = parseHarnessDocument(filePath);

      const text = extractEmbeddableText(doc);
      // Body should be truncated
      expect(text.length).toBeLessThan(600);
    });
  });

  describe('cosineSimilarity', () => {
    it('should return 1 for identical vectors', () => {
      const v = [1, 2, 3, 4];
      expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
    });

    it('should return 0 for orthogonal vectors', () => {
      const a = [1, 0, 0, 0];
      const b = [0, 1, 0, 0];
      expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
    });

    it('should return -1 for opposite vectors', () => {
      const a = [1, 0];
      const b = [-1, 0];
      expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
    });

    it('should return 0 for empty vectors', () => {
      expect(cosineSimilarity([], [])).toBe(0);
    });

    it('should return 0 for mismatched dimensions', () => {
      expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    });

    it('should handle zero vectors', () => {
      expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    });
  });

  describe('loadEmbeddingStore / saveEmbeddingStore', () => {
    it('should return null when no store exists', () => {
      const store = loadEmbeddingStore(harnessDir);
      expect(store).toBeNull();
    });

    it('should persist and reload store', () => {
      const store: EmbeddingStore = {
        modelId: 'test-model',
        dimensions: 8,
        records: {
          'test-id': {
            id: 'test-id',
            path: '/test/path.md',
            directory: 'rules',
            embeddedText: 'test text',
            vector: [1, 2, 3, 4, 5, 6, 7, 8],
            mtime: '2025-01-01T00:00:00.000Z',
            createdAt: '2025-01-01T00:00:00.000Z',
          },
        },
        lastIndexedAt: '2025-01-01T00:00:00.000Z',
      };

      saveEmbeddingStore(harnessDir, store);
      const loaded = loadEmbeddingStore(harnessDir);

      expect(loaded).not.toBeNull();
      expect(loaded!.modelId).toBe('test-model');
      expect(loaded!.records['test-id'].vector).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });
  });

  describe('detectStalePrimitives', () => {
    it('should detect all primitives as stale when no store exists', () => {
      const stale = detectStalePrimitives(harnessDir, null, 'test-model');
      expect(stale.length).toBeGreaterThan(0);
    });

    it('should detect model change as stale', () => {
      const store: EmbeddingStore = {
        modelId: 'old-model',
        dimensions: 8,
        records: {},
        lastIndexedAt: '2025-01-01T00:00:00.000Z',
      };

      const stale = detectStalePrimitives(harnessDir, store, 'new-model');
      expect(stale.length).toBeGreaterThan(0);
    });
  });

  describe('indexPrimitives', () => {
    it('should index all active primitives', async () => {
      const embed = createMockEmbed();
      const store = await indexPrimitives(harnessDir, {
        embed,
        modelId: 'mock-model',
      });

      expect(store.modelId).toBe('mock-model');
      expect(Object.keys(store.records).length).toBeGreaterThan(0);
      expect(store.dimensions).toBe(8);
    });

    it('should skip re-embedding when up to date', async () => {
      const embed = createMockEmbed();
      let embedCallCount = 0;
      const countingEmbed: EmbedFunction = async (texts) => {
        embedCallCount++;
        return embed(texts);
      };

      // First index
      await indexPrimitives(harnessDir, { embed: countingEmbed, modelId: 'mock-model' });
      const firstCount = embedCallCount;

      // Second index — should not re-embed
      await indexPrimitives(harnessDir, { embed: countingEmbed, modelId: 'mock-model' });

      // Should not have called embed again (or at most for any newly stale items)
      expect(embedCallCount).toBe(firstCount);
    });

    it('should re-embed when model changes', async () => {
      const embed = createMockEmbed();

      const store1 = await indexPrimitives(harnessDir, { embed, modelId: 'model-v1' });
      const count1 = Object.keys(store1.records).length;

      const store2 = await indexPrimitives(harnessDir, { embed, modelId: 'model-v2' });
      const count2 = Object.keys(store2.records).length;

      expect(store2.modelId).toBe('model-v2');
      expect(count2).toBeGreaterThanOrEqual(count1);
    });
  });

  describe('semanticSearch', () => {
    it('should return results sorted by similarity', async () => {
      const embed = createMockEmbed();

      // Add some rules to search
      writeFileSync(
        join(harnessDir, 'rules', 'security.md'),
        '---\nid: security-rule\ntags: [security, api]\nstatus: active\n---\n\n<!-- L0: Security rules for API keys -->\n\nNever expose API keys in public code.\n',
      );
      writeFileSync(
        join(harnessDir, 'rules', 'coding.md'),
        '---\nid: coding-rule\ntags: [code, standards]\nstatus: active\n---\n\n<!-- L0: Coding standards for TypeScript -->\n\nAlways use strict mode and explicit types.\n',
      );

      // Index first
      await indexPrimitives(harnessDir, { embed, modelId: 'mock-model' });

      // Search
      const results = await semanticSearch(
        harnessDir,
        'API key security',
        { embed, modelId: 'mock-model', minScore: 0 },
      );

      expect(results.length).toBeGreaterThan(0);
      // Results should be sorted by score descending
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it('should return empty for unindexed harness', async () => {
      const embed = createMockEmbed();

      const results = await semanticSearch(
        harnessDir,
        'anything',
        { embed, modelId: 'mock-model' },
      );

      expect(results).toHaveLength(0);
    });

    it('should respect maxResults', async () => {
      const embed = createMockEmbed();

      await indexPrimitives(harnessDir, { embed, modelId: 'mock-model' });

      const results = await semanticSearch(
        harnessDir,
        'test query',
        { embed, modelId: 'mock-model', maxResults: 2, minScore: 0 },
      );

      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('should filter by minScore', async () => {
      const embed = createMockEmbed();

      await indexPrimitives(harnessDir, { embed, modelId: 'mock-model' });

      // Very high threshold should return no results
      const results = await semanticSearch(
        harnessDir,
        'completely unrelated query xyz123',
        { embed, modelId: 'mock-model', minScore: 0.99 },
      );

      // With a high enough threshold and a random query, we expect few or no results
      // Note: mock hash-based embeddings may produce some false positives
      expect(results.length).toBeLessThan(3);
    });
  });

  describe('getEmbeddingStats', () => {
    it('should return zeros when no store exists', () => {
      const stats = getEmbeddingStats(harnessDir);
      expect(stats.indexed).toBe(0);
      expect(stats.modelId).toBeNull();
    });

    it('should return stats after indexing', async () => {
      const embed = createMockEmbed();
      await indexPrimitives(harnessDir, { embed, modelId: 'mock-model' });

      const stats = getEmbeddingStats(harnessDir);
      expect(stats.indexed).toBeGreaterThan(0);
      expect(stats.modelId).toBe('mock-model');
      expect(stats.dimensions).toBe(8);
      expect(stats.storeSize).toBeGreaterThan(0);
    });
  });
});
