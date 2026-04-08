import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  fetchGitHubSource,
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
      const results = discoverSources(harnessDir, 'wshobson');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name.toLowerCase()).toContain('wshobson');
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

  // ─── Remote Discovery (mocked) ─────────────────────────────────────────────
  // These tests verify the Contents API switch from task 12.1 deterministically,
  // without hitting the live GitHub API. They mock globalThis.fetch with
  // pre-canned Contents API responses and assert the call shapes + result mapping.

  describe('fetchGitHubSource (Contents API)', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;
    let originalFetch: typeof globalThis.fetch;

    /** Build a Response stub matching the GitHub Contents API shape. */
    const okJson = (body: unknown): Response =>
      ({
        ok: true,
        status: 200,
        json: async () => body,
      }) as Response;

    const notFound = (): Response =>
      ({
        ok: false,
        status: 404,
        json: async () => ({ message: 'Not Found' }),
      }) as Response;

    /** A single Contents API file entry, fully populated. */
    const fileEntry = (name: string, path: string) => ({
      name,
      path,
      type: 'file' as const,
      download_url: `https://raw.githubusercontent.com/owner/repo/main/${path}`,
      html_url: `https://github.com/owner/repo/blob/main/${path}`,
    });

    /** A single Contents API directory entry. */
    const dirEntry = (name: string, path: string) => ({
      name,
      path,
      type: 'dir' as const,
      download_url: null,
      html_url: `https://github.com/owner/repo/tree/main/${path}`,
    });

    beforeEach(() => {
      // Ensure the legacy Code Search opt-in is OFF for these tests.
      delete process.env.HARNESS_DISCOVER_USE_CODE_SEARCH;
      delete process.env.GITHUB_TOKEN;

      originalFetch = globalThis.fetch;
      fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('returns results from unauthenticated Contents API (no GITHUB_TOKEN)', async () => {
      const source: Source = {
        name: 'Anthropic Skills',
        url: 'https://github.com/anthropics/skills',
        type: 'github',
        content: ['skills'],
        tags: ['skills', 'official'],
      };

      // The source declares content: [skills], so we should ONLY scan skills/.
      fetchSpy.mockResolvedValueOnce(
        okJson([
          fileEntry('pdf-extraction.md', 'skills/pdf-extraction.md'),
          fileEntry('docx-writer.md', 'skills/docx-writer.md'),
          fileEntry('canvas-design.md', 'skills/canvas-design.md'),
        ]),
      );

      const results = await fetchGitHubSource(source, 'pdf');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('api.github.com/repos/anthropics/skills/contents/skills');

      // Should NOT have sent an Authorization header (no token configured).
      const calledOptions = fetchSpy.mock.calls[0][1] as { headers: Record<string, string> };
      expect(calledOptions.headers.Authorization).toBeUndefined();

      // Only pdf-extraction.md matches the "pdf" query.
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.name === 'pdf-extraction.md')).toBe(true);
      expect(results[0].url).toContain('raw.githubusercontent.com');
      expect(results[0].source.name).toBe('Anthropic Skills');
    });

    it('only scans dirs the source declares in its content[] field', async () => {
      const source: Source = {
        name: 'Hooks-only Source',
        url: 'https://github.com/owner/hooks-repo',
        type: 'github',
        content: ['hooks'],
        tags: ['hooks'],
      };

      fetchSpy.mockResolvedValue(okJson([fileEntry('lifecycle.md', 'hooks/lifecycle.md')]));

      await fetchGitHubSource(source, 'lifecycle');

      // Should only scan hooks/, not skills/, agents/, rules/, etc.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('/contents/hooks');
    });

    it('recurses selectively into matching plugins/<topic>/ subdirs only', async () => {
      const source: Source = {
        name: 'wshobson/agents',
        url: 'https://github.com/wshobson/agents',
        type: 'github',
        content: ['agents', 'plugins'],
        tags: ['agents', 'plugins'],
      };

      // First call: contents of agents/ (top-level, may be empty for wshobson).
      fetchSpy.mockResolvedValueOnce(okJson([]));
      // Second call: contents of plugins/ — list of topic dirs. Two topics, only
      // one matches the query "writing".
      fetchSpy.mockResolvedValueOnce(
        okJson([
          dirEntry('content-writing', 'plugins/content-writing'),
          dirEntry('database-ops', 'plugins/database-ops'),
          dirEntry('cybersecurity', 'plugins/cybersecurity'),
        ]),
      );
      // Third call: contents of plugins/content-writing/ — primitive subdirs.
      fetchSpy.mockResolvedValueOnce(
        okJson([
          dirEntry('agents', 'plugins/content-writing/agents'),
          dirEntry('skills', 'plugins/content-writing/skills'),
        ]),
      );
      // Fourth call: contents of plugins/content-writing/agents/.
      fetchSpy.mockResolvedValueOnce(
        okJson([
          fileEntry('content-writer.md', 'plugins/content-writing/agents/content-writer.md'),
          fileEntry('seo-optimizer.md', 'plugins/content-writing/agents/seo-optimizer.md'),
        ]),
      );
      // Fifth call: contents of plugins/content-writing/skills/.
      fetchSpy.mockResolvedValueOnce(
        okJson([
          fileEntry('persuasive-writing.md', 'plugins/content-writing/skills/persuasive-writing.md'),
        ]),
      );

      const results = await fetchGitHubSource(source, 'writing');

      // Critical assertion: did NOT recurse into database-ops or cybersecurity.
      // Should only have called: agents/, plugins/, content-writing/, c-w/agents, c-w/skills = 5 calls.
      expect(fetchSpy).toHaveBeenCalledTimes(5);

      const calledUrls = fetchSpy.mock.calls.map((c) => c[0] as string);
      expect(calledUrls.some((u) => u.includes('content-writing'))).toBe(true);
      expect(calledUrls.some((u) => u.includes('database-ops'))).toBe(false);
      expect(calledUrls.some((u) => u.includes('cybersecurity'))).toBe(false);

      // Should have found the writing-related primitives in the matching topic.
      expect(results.length).toBeGreaterThan(0);
      const names = results.map((r) => r.name);
      expect(names).toContain('persuasive-writing.md');
    });

    it('returns empty array (does not throw) when the repo is 404', async () => {
      const source: Source = {
        name: 'Dead Repo',
        url: 'https://github.com/dead/dead',
        type: 'github',
        content: ['skills'],
        tags: [],
      };

      fetchSpy.mockResolvedValue(notFound());

      const results = await fetchGitHubSource(source, 'anything');

      expect(results).toEqual([]);
      // 404 is not a hard error — it's expected for missing dirs.
      expect(fetchSpy).toHaveBeenCalled();
    });

    it('passes Authorization header when GITHUB_TOKEN is set', async () => {
      process.env.GITHUB_TOKEN = 'ghp_testtoken';

      const source: Source = {
        name: 'Authed Source',
        url: 'https://github.com/owner/repo',
        type: 'github',
        content: ['skills'],
        tags: [],
      };

      fetchSpy.mockResolvedValueOnce(okJson([fileEntry('foo.md', 'skills/foo.md')]));

      await fetchGitHubSource(source, 'foo');

      const calledOptions = fetchSpy.mock.calls[0][1] as { headers: Record<string, string> };
      expect(calledOptions.headers.Authorization).toBe('Bearer ghp_testtoken');

      delete process.env.GITHUB_TOKEN;
    });
  });
});
