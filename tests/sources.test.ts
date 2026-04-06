import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scaffoldHarness } from '../src/cli/scaffold.js';
import {
  loadShippedSources,
  loadUserSources,
  saveUserSources,
  loadAllSources,
  addSource,
  removeSource,
  discoverSources,
  getSourcesForType,
  getSourcesSummary,
} from '../src/runtime/sources.js';
import type { Source, ContentType } from '../src/runtime/sources.js';

describe('sources', () => {
  let harnessDir: string;
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'sources-'));
    harnessDir = join(tmpBase, 'test-agent');
    scaffoldHarness(harnessDir, 'test-agent', { template: 'base' });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  describe('loadShippedSources', () => {
    it('should load sources from the shipped sources.yaml', () => {
      const sources = loadShippedSources();
      expect(sources.length).toBeGreaterThan(0);

      // Should contain MCP Official Registry
      const mcp = sources.find((s) => s.name === 'MCP Official Registry');
      expect(mcp).toBeDefined();
      expect(mcp!.type).toBe('registry');
      expect(mcp!.content).toContain('mcp');
    });

    it('should have valid structure for all sources', () => {
      const sources = loadShippedSources();
      for (const source of sources) {
        expect(source.name).toBeTruthy();
        expect(source.url).toBeTruthy();
        expect(source.type).toBeTruthy();
        expect(Array.isArray(source.content)).toBe(true);
        expect(Array.isArray(source.tags)).toBe(true);
      }
    });

    it('should include GitHub sources', () => {
      const sources = loadShippedSources();
      const github = sources.filter((s) => s.type === 'github');
      expect(github.length).toBeGreaterThan(0);
    });

    it('should include registry sources', () => {
      const sources = loadShippedSources();
      const registries = sources.filter((s) => s.type === 'registry');
      expect(registries.length).toBeGreaterThan(0);
    });
  });

  describe('loadUserSources / saveUserSources', () => {
    it('should return empty array when no user sources exist', () => {
      const sources = loadUserSources(harnessDir);
      expect(sources).toEqual([]);
    });

    it('should persist and reload user sources', () => {
      const testSources: Source[] = [{
        name: 'My Custom Source',
        url: 'https://github.com/test/repo',
        type: 'github',
        content: ['skills'],
        tags: ['custom'],
        description: 'A custom source',
      }];

      saveUserSources(harnessDir, testSources);
      const loaded = loadUserSources(harnessDir);

      expect(loaded).toHaveLength(1);
      expect(loaded[0].name).toBe('My Custom Source');
      expect(loaded[0].url).toBe('https://github.com/test/repo');
      expect(loaded[0].content).toEqual(['skills']);
    });

    it('should create memory directory if needed', () => {
      const newDir = join(tmpBase, 'new-agent');
      mkdirSync(newDir);

      saveUserSources(newDir, [{
        name: 'Test',
        url: 'https://example.com',
        type: 'api',
        content: ['mcp'],
        tags: [],
      }]);

      expect(existsSync(join(newDir, 'memory', 'sources.yaml'))).toBe(true);
    });
  });

  describe('loadAllSources', () => {
    it('should merge shipped and user sources', () => {
      saveUserSources(harnessDir, [{
        name: 'User Source',
        url: 'https://github.com/user/repo',
        type: 'github',
        content: ['agents'],
        tags: ['user'],
      }]);

      const all = loadAllSources(harnessDir);
      const shipped = loadShippedSources();

      // Should have at least all shipped + 1 user source
      expect(all.length).toBeGreaterThanOrEqual(shipped.length + 1);

      // User source should be present
      const user = all.find((s) => s.name === 'User Source');
      expect(user).toBeDefined();
    });

    it('should deduplicate by name (user overrides shipped)', () => {
      // Add a user source with the same name as a shipped one
      saveUserSources(harnessDir, [{
        name: 'MCP Official Registry',
        url: 'https://custom.mcp.io',
        type: 'registry',
        content: ['mcp'],
        tags: ['custom'],
        description: 'Custom override',
      }]);

      const all = loadAllSources(harnessDir);
      const mcpEntries = all.filter(
        (s) => s.name.toLowerCase() === 'mcp official registry',
      );

      // Should only have one entry, and it should be the user override
      expect(mcpEntries).toHaveLength(1);
      expect(mcpEntries[0].url).toBe('https://custom.mcp.io');
    });
  });

  describe('addSource', () => {
    it('should add a new source', () => {
      const added = addSource(harnessDir, {
        name: 'New Source',
        url: 'https://github.com/new/source',
        type: 'github',
        content: ['skills', 'agents'],
        description: 'A new source',
      });

      expect(added).not.toBeNull();
      expect(added!.name).toBe('New Source');

      const sources = loadUserSources(harnessDir);
      expect(sources).toHaveLength(1);
    });

    it('should return null for duplicate name', () => {
      addSource(harnessDir, {
        name: 'Duplicate',
        url: 'https://example.com/1',
        type: 'github',
        content: ['skills'],
      });

      const duplicate = addSource(harnessDir, {
        name: 'Duplicate',
        url: 'https://example.com/2',
        type: 'github',
        content: ['agents'],
      });

      expect(duplicate).toBeNull();

      const sources = loadUserSources(harnessDir);
      expect(sources).toHaveLength(1);
    });

    it('should set default tags when not provided', () => {
      const added = addSource(harnessDir, {
        name: 'No Tags',
        url: 'https://example.com',
        type: 'api',
        content: ['mcp'],
      });

      expect(added!.tags).toEqual([]);
    });
  });

  describe('removeSource', () => {
    it('should remove an existing source', () => {
      addSource(harnessDir, {
        name: 'To Remove',
        url: 'https://example.com',
        type: 'github',
        content: ['skills'],
      });

      const removed = removeSource(harnessDir, 'To Remove');
      expect(removed).toBe(true);

      const sources = loadUserSources(harnessDir);
      expect(sources).toHaveLength(0);
    });

    it('should return false for nonexistent source', () => {
      const removed = removeSource(harnessDir, 'Nonexistent');
      expect(removed).toBe(false);
    });

    it('should be case-insensitive', () => {
      addSource(harnessDir, {
        name: 'Case Test',
        url: 'https://example.com',
        type: 'github',
        content: ['skills'],
      });

      const removed = removeSource(harnessDir, 'case test');
      expect(removed).toBe(true);
    });
  });

  describe('discoverSources', () => {
    it('should find sources matching a query', () => {
      const results = discoverSources(harnessDir, 'mcp');
      expect(results.length).toBeGreaterThan(0);

      // MCP results should be returned
      const mcpResults = results.filter((r) => r.type === 'mcp');
      expect(mcpResults.length).toBeGreaterThan(0);
    });

    it('should find sources by name', () => {
      const results = discoverSources(harnessDir, 'VibeGuard');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toContain('VibeGuard');
    });

    it('should filter by content type', () => {
      const results = discoverSources(harnessDir, 'hooks', { type: 'hooks' });
      for (const r of results) {
        expect(r.type).toBe('hooks');
      }
    });

    it('should respect maxResults', () => {
      const results = discoverSources(harnessDir, 'skills', { maxResults: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('should rank by relevance', () => {
      const results = discoverSources(harnessDir, 'security');
      if (results.length >= 2) {
        expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
      }
    });

    it('should find user-added sources', () => {
      addSource(harnessDir, {
        name: 'My Custom Rules',
        url: 'https://github.com/me/rules',
        type: 'github',
        content: ['rules'],
        tags: ['security', 'custom'],
        description: 'My security rules',
      });

      const results = discoverSources(harnessDir, 'security');
      const custom = results.find((r) => r.name === 'My Custom Rules');
      expect(custom).toBeDefined();
    });

    it('should filter by source names', () => {
      const results = discoverSources(harnessDir, 'skills', {
        sourceNames: ['wshobson'],
      });
      for (const r of results) {
        expect(r.source.name.toLowerCase()).toContain('wshobson');
      }
    });

    it('should return empty for no matches', () => {
      const results = discoverSources(harnessDir, 'zzz_no_match_xxx_123');
      expect(results).toHaveLength(0);
    });
  });

  describe('getSourcesForType', () => {
    it('should return sources providing MCP content', () => {
      const sources = getSourcesForType(harnessDir, 'mcp');
      expect(sources.length).toBeGreaterThan(0);
      for (const s of sources) {
        expect(s.content).toContain('mcp');
      }
    });

    it('should return sources providing skills', () => {
      const sources = getSourcesForType(harnessDir, 'skills');
      expect(sources.length).toBeGreaterThan(0);
    });

    it('should return empty for rare type', () => {
      // Plugins might have few or no sources
      const sources = getSourcesForType(harnessDir, 'playbooks');
      // May be 0 — that's ok, just verify no crash
      expect(Array.isArray(sources)).toBe(true);
    });
  });

  describe('getSourcesSummary', () => {
    it('should return all content type categories', () => {
      const summary = getSourcesSummary(harnessDir);
      expect(summary.skills).toBeDefined();
      expect(summary.agents).toBeDefined();
      expect(summary.rules).toBeDefined();
      expect(summary.playbooks).toBeDefined();
      expect(summary.hooks).toBeDefined();
      expect(summary.templates).toBeDefined();
      expect(summary.mcp).toBeDefined();
      expect(summary.plugins).toBeDefined();
    });

    it('should have MCP sources', () => {
      const summary = getSourcesSummary(harnessDir);
      expect(summary.mcp.length).toBeGreaterThan(0);
    });
  });
});
