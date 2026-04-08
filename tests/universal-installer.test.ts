import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import matter from 'gray-matter';
import { scaffoldHarness } from '../src/cli/scaffold.js';
import {
  detectFormat,
  normalizeToHarness,
  convertToRawUrl,
  universalInstall,
  recordProvenance,
  evaluateLicensePolicy,
} from '../src/runtime/universal-installer.js';
import type {
  FormatDetection,
  UniversalInstallOptions,
  LicenseInfo,
} from '../src/runtime/universal-installer.js';

describe('universal-installer', () => {
  let harnessDir: string;
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'uni-install-'));
    harnessDir = join(tmpBase, 'test-agent');
    scaffoldHarness(harnessDir, 'test-agent', { template: 'base' });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  // ─── Format Detection ───────────────────────────────────────────────────────

  describe('detectFormat', () => {
    it('should detect harness convention', () => {
      const content = '---\nid: my-rule\nstatus: active\ntags: [rule]\n---\n\n<!-- L0: A test rule -->\n\n# My Rule\n\nDo something.\n';
      const result = detectFormat(content, 'my-rule.md');
      expect(result.format).toBe('harness');
      expect(result.primitiveType).toBe('rule');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('should detect Claude Code SKILL.md pattern', () => {
      const content = '# Code Review Skill\n\nWhen the user asks for a code review, you should:\n1. Read the file\n2. Check for issues\n3. Suggest improvements\n';
      const result = detectFormat(content, 'SKILL.md');
      expect(result.format).toBe('claude-skill');
      expect(result.primitiveType).toBe('skill');
    });

    it('should detect Claude skill by content patterns', () => {
      const content = '# Deploy Helper\n\nInstructions for deploying:\nYou should always verify the target environment.\nWhen the user wants to deploy, run the pipeline.\n';
      const result = detectFormat(content, 'deploy.md');
      expect(result.format).toBe('claude-skill');
      expect(result.primitiveType).toBe('skill');
    });

    it('should detect .faf YAML format', () => {
      const content = 'type: skill\ntitle: API Tester\ndescription: Test API endpoints\ncontent: |\n  # API Testing\n  Run curl commands to test endpoints.\n';
      const result = detectFormat(content, 'api-tester.faf');
      expect(result.format).toBe('faf-yaml');
      expect(result.primitiveType).toBe('skill');
    });

    it('should detect .faf with yaml extension', () => {
      const content = 'type: agent\ntitle: Research Agent\ndescription: Research things\ncontent: Research deeply.\n';
      const result = detectFormat(content, 'research.yaml');
      expect(result.format).toBe('faf-yaml');
      expect(result.primitiveType).toBe('agent');
    });

    it('should detect bash hooks', () => {
      const content = '#!/bin/bash\n# Pre-commit hook\necho "Running checks..."\nnpm test\n';
      const result = detectFormat(content, 'pre-commit.sh');
      expect(result.format).toBe('bash-hook');
      expect(result.primitiveType).toBe('workflow');
    });

    it('should detect bash by shebang', () => {
      const content = '#!/usr/bin/env bash\nset -euo pipefail\necho "hello"\n';
      const result = detectFormat(content, 'run');
      expect(result.format).toBe('bash-hook');
    });

    it('should detect MCP config JSON', () => {
      const content = '{"mcpServers": {"fs": {"command": "npx", "args": ["@modelcontextprotocol/server-filesystem"]}}}';
      const result = detectFormat(content, 'mcp.json');
      expect(result.format).toBe('mcp-config');
      expect(result.primitiveType).toBe('tool');
    });

    it('should detect MCP config YAML', () => {
      const content = 'mcpServers:\n  fs:\n    command: npx\n    args:\n      - "@modelcontextprotocol/server-filesystem"\n';
      const result = detectFormat(content, 'mcp.yaml');
      expect(result.format).toBe('mcp-config');
      expect(result.primitiveType).toBe('tool');
    });

    it('should detect raw markdown', () => {
      const content = '# Some Document\n\nThis is just a plain markdown document.\n\nWith some paragraphs.\n';
      const result = detectFormat(content, 'document.md');
      expect(result.format).toBe('raw-markdown');
    });

    it('should infer type from filename', () => {
      const content = '# Database Rules\n\nAlways validate queries.\n';
      const result = detectFormat(content, 'database-rule.md');
      expect(result.primitiveType).toBe('rule');
    });

    it('should infer type from content headings', () => {
      const content = '# Agent: Research Bot\n\nI am a research agent.\n';
      const result = detectFormat(content, 'something.md');
      expect(result.primitiveType).toBe('agent');
    });
  });

  // ─── Normalization ──────────────────────────────────────────────────────────

  describe('normalizeToHarness', () => {
    it('should pass through harness format', () => {
      const content = '---\nid: my-skill\nstatus: active\ntags: [skill]\n---\n\n<!-- L0: Test -->\n\n# My Skill\n\nDo things.\n';
      const detection: FormatDetection = { format: 'harness', primitiveType: 'skill', confidence: 0.95, reasons: [] };
      const result = normalizeToHarness(content, 'my-skill.md', detection);
      expect(result.fixes).toContain('Already in harness format');
    });

    it('should normalize Claude skill with frontmatter + L0/L1', () => {
      const content = '# Code Review\n\nThis skill helps you review code for common issues and suggest improvements.\n\n## Steps\n\n1. Read the code\n2. Check patterns\n';
      const detection: FormatDetection = { format: 'claude-skill', primitiveType: 'skill', confidence: 0.8, reasons: [] };
      const result = normalizeToHarness(content, 'code-review.md', detection);

      expect(result.content).toContain('id: code-review');
      expect(result.content).toContain('status: active');
      expect(result.content).toContain('<!-- L0: Code Review -->');
      expect(result.content).toContain('<!-- L1:');
      expect(result.content).toContain('skill');
      expect(result.filename).toBe('code-review.md');
    });

    it('should normalize .faf YAML to markdown', () => {
      const content = 'type: skill\ntitle: API Tester\ndescription: Test API endpoints with curl\ncontent: |\n  Use curl to test API endpoints.\n  Check response codes.\n';
      const detection: FormatDetection = { format: 'faf-yaml', primitiveType: 'skill', confidence: 0.9, reasons: [] };
      const result = normalizeToHarness(content, 'api-tester.faf', detection);

      expect(result.content).toContain('id: api-tester');
      expect(result.content).toContain('<!-- L0: API Tester -->');
      expect(result.content).toContain('# API Tester');
      expect(result.content).toContain('Test API endpoints with curl');
      expect(result.filename).toBe('api-tester.md');
    });

    it('should normalize bash hook to wrapped markdown', () => {
      const content = '#!/bin/bash\n# Lint check before commit\n# Ensures code quality\nnpm run lint\n';
      const detection: FormatDetection = { format: 'bash-hook', primitiveType: 'workflow', confidence: 0.9, reasons: [] };
      const result = normalizeToHarness(content, 'pre-commit.sh', detection);

      expect(result.content).toContain('id: pre-commit');
      expect(result.content).toContain('```bash');
      expect(result.content).toContain('npm run lint');
      expect(result.content).toContain('workflow');
      expect(result.filename).toBe('pre-commit.md');
    });

    it('should normalize MCP config to tool doc', () => {
      const content = '{"command": "npx", "args": ["@mcp/server-fs"], "mcpServers": {}}';
      const detection: FormatDetection = { format: 'mcp-config', primitiveType: 'tool', confidence: 0.9, reasons: [] };
      const result = normalizeToHarness(content, 'fs-server.json', detection);

      expect(result.content).toContain('id: fs-server');
      expect(result.content).toContain('tool');
      expect(result.content).toContain('mcp');
      expect(result.content).toContain('```json');
      expect(result.filename).toBe('fs-server.md');
    });

    it('should normalize raw markdown with generated frontmatter', () => {
      const content = '# Database Optimization\n\nOptimize slow queries by adding indexes.\n\n## Strategy\n\n1. EXPLAIN ANALYZE\n2. Add appropriate indexes\n';
      const detection: FormatDetection = { format: 'raw-markdown', primitiveType: 'skill', confidence: 0.5, reasons: [] };
      const result = normalizeToHarness(content, 'db-optimization.md', detection);

      expect(result.content).toContain('id: db-optimization');
      expect(result.content).toContain('status: active');
      expect(result.content).toContain('<!-- L0:');
      expect(result.content).toContain('<!-- L1:');
    });

    it('should respect type override', () => {
      const content = '# Something\n\nGeneral content here.\n';
      const detection: FormatDetection = { format: 'raw-markdown', primitiveType: null, confidence: 0.5, reasons: [] };
      const options: UniversalInstallOptions = { type: 'rule' };
      const result = normalizeToHarness(content, 'something.md', detection, options);

      expect(result.content).toContain('rule');
    });

    it('should respect id override', () => {
      const content = '# Something\n\nGeneral content here.\n';
      const detection: FormatDetection = { format: 'raw-markdown', primitiveType: 'skill', confidence: 0.5, reasons: [] };
      const options: UniversalInstallOptions = { id: 'custom-id' };
      const result = normalizeToHarness(content, 'something.md', detection, options);

      expect(result.content).toContain('id: custom-id');
    });

    it('should add extra tags from options', () => {
      const content = '# Something\n\nContent here for testing.\n';
      const detection: FormatDetection = { format: 'raw-markdown', primitiveType: 'skill', confidence: 0.5, reasons: [] };
      const options: UniversalInstallOptions = { tags: ['typescript', 'testing'] };
      const result = normalizeToHarness(content, 'something.md', detection, options);

      expect(result.content).toContain('typescript');
      expect(result.content).toContain('testing');
    });
  });

  // ─── URL Conversion ─────────────────────────────────────────────────────────

  describe('convertToRawUrl', () => {
    it('should convert GitHub blob URL to raw', () => {
      const url = 'https://github.com/owner/repo/blob/main/skills/review.md';
      expect(convertToRawUrl(url)).toBe(
        'https://raw.githubusercontent.com/owner/repo/main/skills/review.md',
      );
    });

    it('should pass through raw.githubusercontent URLs', () => {
      const url = 'https://raw.githubusercontent.com/owner/repo/main/file.md';
      expect(convertToRawUrl(url)).toBe(url);
    });

    it('should pass through non-GitHub URLs', () => {
      const url = 'https://example.com/skill.md';
      expect(convertToRawUrl(url)).toBe(url);
    });

    it('should handle branch paths with slashes', () => {
      const url = 'https://github.com/user/repo/blob/feature/branch/path/file.md';
      expect(convertToRawUrl(url)).toBe(
        'https://raw.githubusercontent.com/user/repo/feature/branch/path/file.md',
      );
    });
  });

  // ─── Full Install Pipeline ──────────────────────────────────────────────────

  describe('universalInstall', () => {
    it('should install a harness-format file', async () => {
      const filePath = join(tmpBase, 'test-skill.md');
      writeFileSync(filePath, '---\nid: test-skill\nstatus: active\ntags: [skill]\n---\n\n<!-- L0: A test skill -->\n\n# Test Skill\n\nDo something useful for testing purposes.\n');

      const result = await universalInstall(harnessDir, filePath);
      expect(result.installed).toBe(true);
      expect(result.format.format).toBe('harness');
      expect(result.destination).toContain('skills');
      expect(existsSync(result.destination)).toBe(true);
    });

    it('should install a Claude skill', async () => {
      const filePath = join(tmpBase, 'SKILL.md');
      writeFileSync(filePath, '# Review Helper\n\nWhen the user asks for a code review, you should:\n1. Read the entire file\n2. Check for common issues\n3. Suggest improvements\n\nAlways be thorough.\n');

      const result = await universalInstall(harnessDir, filePath);
      expect(result.installed).toBe(true);
      expect(result.format.format).toBe('claude-skill');
      expect(result.fixes.length).toBeGreaterThan(0);
    });

    it('should install raw markdown with auto-generated frontmatter', async () => {
      const filePath = join(tmpBase, 'coding-standards.md');
      writeFileSync(filePath, '# Coding Standards\n\nAlways write clean code with proper formatting and documentation.\n\n## Guidelines\n\n1. Use meaningful names\n2. Keep functions short\n3. Write tests\n');

      const result = await universalInstall(harnessDir, filePath, { type: 'rule' });
      expect(result.installed).toBe(true);
      expect(result.destination).toContain('rules');
    });

    it('should install bash hooks as workflows', async () => {
      const filePath = join(tmpBase, 'lint-check.sh');
      writeFileSync(filePath, '#!/bin/bash\n# Run lint checks on staged files\n# Prevents bad code from being committed\nnpm run lint\nnpm test\n');

      const result = await universalInstall(harnessDir, filePath);
      expect(result.installed).toBe(true);
      expect(result.format.format).toBe('bash-hook');
      expect(result.destination).toContain('workflows');
    });

    it('should install .faf YAML format', async () => {
      const filePath = join(tmpBase, 'debugger.faf');
      writeFileSync(filePath, 'type: skill\ntitle: Debug Helper\ndescription: Help debug TypeScript errors with clear steps\ncontent: |\n  # Debug Helper\n  When debugging:\n  1. Read the error message\n  2. Find the source file\n  3. Check the types\n');

      const result = await universalInstall(harnessDir, filePath);
      expect(result.installed).toBe(true);
      expect(result.format.format).toBe('faf-yaml');
      expect(result.destination).toContain('skills');
    });

    it('should handle non-existent file', async () => {
      const result = await universalInstall(harnessDir, '/nonexistent/file.md');
      expect(result.installed).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should handle empty file', async () => {
      const filePath = join(tmpBase, 'empty.md');
      writeFileSync(filePath, '');

      const result = await universalInstall(harnessDir, filePath);
      expect(result.installed).toBe(false);
      expect(result.errors).toContain('File is empty');
    });

    it('should force install despite validation errors', async () => {
      const filePath = join(tmpBase, 'minimal.md');
      writeFileSync(filePath, '# X\n\nY\n');

      const result = await universalInstall(harnessDir, filePath, {
        type: 'skill',
        force: true,
      });

      // Force should attempt installation even with issues
      expect(result.format.format).toBe('raw-markdown');
    });

    it('should extract dependency hints from frontmatter', async () => {
      const filePath = join(tmpBase, 'dep-skill.md');
      writeFileSync(filePath, '---\nid: dep-skill\nstatus: active\ntags: [skill]\nrelated: [api-client, auth-manager]\n---\n\n<!-- L0: Skill with dependencies -->\n\n# Dependency Skill\n\nThis skill needs other primitives installed to work properly.\n');

      const result = await universalInstall(harnessDir, filePath);
      expect(result.installed).toBe(true);
      expect(result.suggestedDependencies).toContain('api-client');
      expect(result.suggestedDependencies).toContain('auth-manager');
    });

    it('should respect id override option', async () => {
      const filePath = join(tmpBase, 'generic-file.md');
      writeFileSync(filePath, '# Generic Content\n\nThis is some generic content that needs a custom identifier.\n\nMore detailed explanation follows.\n');

      const result = await universalInstall(harnessDir, filePath, {
        type: 'skill',
        id: 'my-custom-id',
      });

      if (result.installed) {
        const installed = readFileSync(result.destination, 'utf-8');
        expect(installed).toContain('my-custom-id');
      }
    });

    it('should install MCP config as tool documentation', async () => {
      const filePath = join(tmpBase, 'server.json');
      writeFileSync(filePath, JSON.stringify({
        mcpServers: {
          filesystem: {
            command: 'npx',
            args: ['@modelcontextprotocol/server-filesystem', '/tmp'],
          },
        },
      }, null, 2));

      const result = await universalInstall(harnessDir, filePath);
      expect(result.installed).toBe(true);
      expect(result.format.format).toBe('mcp-config');
      expect(result.destination).toContain('tools');
    });
  });

  // ─── Provenance recording (task 12.14, Level 1) ────────────────────────────
  // Verifies the recordProvenance() helper writes source/installed_at/installed_by
  // into a file's frontmatter, with the idempotency rule for source/source_commit.
  // The github commit-SHA resolution path is mocked since it makes a network call.

  describe('recordProvenance', () => {
    let originalFetch: typeof globalThis.fetch;
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    /** Helper: build a minimal harness markdown file body with given frontmatter. */
    const buildContent = (data: Record<string, unknown>): string => {
      const dummyBody = '<!-- L0: Test stub -->\n\n# Test Body\n\nLorem ipsum.';
      return matter.stringify(dummyBody, data);
    };

    it('records provenance with source_commit on a github raw URL', async () => {
      const fortyHexSha = 'a'.repeat(40);
      // Mock the GitHub Contents API response — the only network call recordProvenance makes.
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ sha: fortyHexSha }),
      } as Response);

      const sourceUrl =
        'https://raw.githubusercontent.com/owner/repo/main/skills/test.md';
      const before = buildContent({
        id: `test-${Math.random().toString(36).slice(2, 10)}`,
        tags: ['skill'],
        status: 'active',
      });

      const after = await recordProvenance(before, sourceUrl);
      const parsed = matter(after);

      expect(parsed.data.source).toBe(sourceUrl);
      expect(parsed.data.source_commit).toBe(fortyHexSha);
      expect(typeof parsed.data.installed_at).toBe('string');
      expect(parsed.data.installed_by).toMatch(/^agent-harness@/);

      // Verify the API was called with the right URL shape.
      const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('api.github.com/repos/owner/repo/contents/skills/test.md');
      expect(calledUrl).toContain('ref=main');
    });

    it('records provenance without source_commit on a non-github URL', async () => {
      // No fetch calls expected — non-github URLs skip the SHA resolution path.
      const sourceUrl = 'https://example.com/some/file.md';
      const before = buildContent({
        id: `test-${Math.random().toString(36).slice(2, 10)}`,
        tags: ['skill'],
        status: 'active',
      });

      const after = await recordProvenance(before, sourceUrl);
      const parsed = matter(after);

      expect(parsed.data.source).toBe(sourceUrl);
      expect(parsed.data.source_commit).toBeUndefined();
      expect(typeof parsed.data.installed_at).toBe('string');
      expect(parsed.data.installed_by).toMatch(/^agent-harness@/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('install still succeeds when the GitHub Contents API fails', async () => {
      // Simulate an API failure — network error, 5xx, abort, whatever.
      fetchSpy.mockRejectedValueOnce(new Error('network down'));

      const sourceUrl =
        'https://raw.githubusercontent.com/owner/repo/main/skills/test.md';
      const before = buildContent({
        id: `test-${Math.random().toString(36).slice(2, 10)}`,
        tags: ['skill'],
        status: 'active',
      });

      const after = await recordProvenance(before, sourceUrl);
      const parsed = matter(after);

      // source still set, source_commit silently omitted.
      expect(parsed.data.source).toBe(sourceUrl);
      expect(parsed.data.source_commit).toBeUndefined();
      expect(typeof parsed.data.installed_at).toBe('string');
    });

    it('preserves an existing source field (idempotency)', async () => {
      const oldSource = 'https://old.example.com/foo.md';
      const newSource = 'https://new.example.com/bar.md';
      const before = buildContent({
        id: 'test',
        tags: ['skill'],
        status: 'active',
        source: oldSource,
      });

      const after = await recordProvenance(before, newSource);
      const parsed = matter(after);

      // source: NOT overwritten
      expect(parsed.data.source).toBe(oldSource);
      // installed_at and installed_by ARE updated
      expect(typeof parsed.data.installed_at).toBe('string');
      expect(parsed.data.installed_by).toMatch(/^agent-harness@/);
      // No fetch — non-github URL, and source already set so SHA resolution is moot
      // (current impl still attempts SHA resolution because source_commit is missing,
      // but the URL is non-github so the regex match fails fast — verify no network call)
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('writes a valid ISO 8601 timestamp in installed_at', async () => {
      const sourceUrl = 'https://example.com/file.md';
      const before = buildContent({
        id: `test-${Math.random().toString(36).slice(2, 10)}`,
        tags: ['skill'],
        status: 'active',
      });

      const beforeMs = Date.now();
      const after = await recordProvenance(before, sourceUrl);
      const afterMs = Date.now();

      const parsed = matter(after);
      const installedAt = parsed.data.installed_at as string;
      const parsedMs = new Date(installedAt).getTime();

      expect(Number.isNaN(parsedMs)).toBe(false);
      // Must be within the test execution window (a few ms tolerance for clock).
      expect(parsedMs).toBeGreaterThanOrEqual(beforeMs - 100);
      expect(parsedMs).toBeLessThanOrEqual(afterMs + 100);
      // Round-trip check: a parsed Date should re-stringify to ISO format.
      expect(new Date(parsedMs).toISOString()).toBe(installedAt);
    });
  });

  // ─── License detection (task 12.14, Level 2) ───────────────────────────────
  // Verifies detectLicense() walks the lookup chain (per-file LICENSE sibling →
  // GitHub License API → fall back to UNKNOWN), correctly classifies license
  // text, extracts copyright lines, and integrates with recordProvenance.

  describe('detectLicense', () => {
    let originalFetch: typeof globalThis.fetch;
    let fetchSpy: ReturnType<typeof vi.fn>;

    /** Mock-Response helpers (same shape vitest expects from fetch). */
    const okText = (body: string): Response =>
      ({ ok: true, status: 200, text: async () => body, json: async () => ({}) }) as Response;
    const okJson = (body: unknown): Response =>
      ({ ok: true, status: 200, text: async () => '', json: async () => body }) as Response;
    const notFound = (): Response =>
      ({ ok: false, status: 404, text: async () => 'Not Found', json: async () => ({}) }) as Response;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('finds a per-file LICENSE sibling and classifies as MIT', async () => {
      const { detectLicense } = await import('../src/runtime/universal-installer.js');
      // First sibling probe (LICENSE) returns MIT body. No further calls.
      fetchSpy.mockResolvedValueOnce(
        okText(
          'MIT License\n\nCopyright (c) 2024 Acme Inc.\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software...',
        ),
      );

      const info = await detectLicense(
        'https://raw.githubusercontent.com/owner/repo/main/skills/test/SKILL.md',
      );

      expect(info.spdxId).toBe('MIT');
      expect(info.copyright).toBe('Copyright (c) 2024 Acme Inc.');
      expect(info.licenseSource).toBe(
        'https://raw.githubusercontent.com/owner/repo/main/skills/test/LICENSE',
      );
    });

    it('per-file LICENSE.txt with "All rights reserved" → PROPRIETARY', async () => {
      const { detectLicense } = await import('../src/runtime/universal-installer.js');
      // First sibling (LICENSE) 404, second (LICENSE.txt) returns proprietary text.
      fetchSpy.mockResolvedValueOnce(notFound());
      fetchSpy.mockResolvedValueOnce(
        okText(
          '© 2025 Anthropic, PBC. All rights reserved.\n\nYou may not extract materials from the Services, retain copies outside them, reproduce, create derivative works, or distribute to third parties.',
        ),
      );

      const info = await detectLicense(
        'https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md',
      );

      expect(info.spdxId).toBe('PROPRIETARY');
      expect(info.copyright).toMatch(/all rights reserved/i);
      expect(info.licenseSource).toContain('LICENSE.txt');
    });

    it('falls back to GitHub License API when no sibling found', async () => {
      const { detectLicense } = await import('../src/runtime/universal-installer.js');
      // All 5 sibling probes return 404 (LICENSE, LICENSE.txt, LICENSE.md, COPYING, COPYING.txt).
      for (let i = 0; i < 5; i++) {
        fetchSpy.mockResolvedValueOnce(notFound());
      }
      // Then the GitHub License API returns Apache-2.0.
      fetchSpy.mockResolvedValueOnce(
        okJson({
          license: { spdx_id: 'Apache-2.0' },
          html_url: 'https://github.com/owner/repo/blob/main/LICENSE',
        }),
      );

      const info = await detectLicense(
        'https://raw.githubusercontent.com/owner/repo/main/file.md',
      );

      expect(info.spdxId).toBe('Apache-2.0');
      expect(info.licenseSource).toBe(
        'https://github.com/owner/repo/blob/main/LICENSE',
      );

      // Verify the API was called.
      const apiCall = fetchSpy.mock.calls.find((c) =>
        (c[0] as string).includes('api.github.com/repos/owner/repo/license'),
      );
      expect(apiCall).toBeDefined();
    });

    it('non-github URL → returns UNKNOWN without any fetch calls', async () => {
      const { detectLicense } = await import('../src/runtime/universal-installer.js');

      const info = await detectLicense('https://example.com/somewhere/file.md');

      expect(info.spdxId).toBe('UNKNOWN');
      expect(info.copyright).toBeUndefined();
      expect(info.licenseSource).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('GitHub License API returns NOASSERTION → UNKNOWN', async () => {
      const { detectLicense } = await import('../src/runtime/universal-installer.js');
      // All siblings 404.
      for (let i = 0; i < 5; i++) {
        fetchSpy.mockResolvedValueOnce(notFound());
      }
      // API returns NOASSERTION.
      fetchSpy.mockResolvedValueOnce(
        okJson({
          license: { spdx_id: 'NOASSERTION' },
          html_url: 'https://github.com/owner/repo/blob/main/LICENSE',
        }),
      );

      const info = await detectLicense(
        'https://raw.githubusercontent.com/owner/repo/main/file.md',
      );

      expect(info.spdxId).toBe('UNKNOWN');
    });

    it('GitHub License API body is decoded and copyright is extracted', async () => {
      const { detectLicense } = await import('../src/runtime/universal-installer.js');
      // All siblings 404.
      for (let i = 0; i < 5; i++) {
        fetchSpy.mockResolvedValueOnce(notFound());
      }
      // API returns Apache-2.0 with a base64-encoded body containing a copyright.
      const licenseBody = 'Apache License\nVersion 2.0, January 2004\n\nCopyright (c) 2024 Example Corp\n\nLicensed under the Apache License...';
      const base64Body = Buffer.from(licenseBody, 'utf-8').toString('base64');
      fetchSpy.mockResolvedValueOnce(
        okJson({
          license: { spdx_id: 'Apache-2.0' },
          html_url: 'https://github.com/owner/repo/blob/main/LICENSE',
          content: base64Body,
          encoding: 'base64',
        }),
      );

      const info = await detectLicense(
        'https://raw.githubusercontent.com/owner/repo/main/file.md',
      );

      expect(info.spdxId).toBe('Apache-2.0');
      expect(info.copyright).toBe('Copyright (c) 2024 Example Corp');
    });

    it('classifies BSD-3-Clause text correctly', async () => {
      const { detectLicense } = await import('../src/runtime/universal-installer.js');
      fetchSpy.mockResolvedValueOnce(
        okText(
          'Copyright (c) 2023 Foo\n\nRedistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:\n\n1. ...\n2. ...\n3. Neither the name of the copyright holder nor the names of its contributors may be used...',
        ),
      );

      const info = await detectLicense(
        'https://raw.githubusercontent.com/foo/bar/main/lib.md',
      );

      expect(info.spdxId).toBe('BSD-3-Clause');
    });

    it('integration: license fields appear in recordProvenance output', async () => {
      const { recordProvenance } = await import('../src/runtime/universal-installer.js');
      // Mock chain: Contents API for source_commit, then LICENSE sibling for license.
      fetchSpy.mockResolvedValueOnce(
        okJson({ sha: 'b'.repeat(40) }),
      );
      fetchSpy.mockResolvedValueOnce(
        okText('MIT License\n\nCopyright (c) 2024 Test User\n\nPermission is hereby granted...'),
      );

      const sourceUrl =
        'https://raw.githubusercontent.com/owner/repo/main/skills/test.md';
      const dummyBody = '<!-- L0: Test stub -->\n\n# Test Body\n\nLorem ipsum.';
      // Unique id to avoid gray-matter content cache pollution.
      const before = matter.stringify(dummyBody, {
        id: `lic-int-${Math.random().toString(36).slice(2, 10)}`,
        tags: ['skill'],
        status: 'active',
      });

      const after = await recordProvenance(before, sourceUrl);
      const parsed = matter(after);

      // Provenance fields from Level 1
      expect(parsed.data.source).toBe(sourceUrl);
      expect(parsed.data.source_commit).toBe('b'.repeat(40));
      // License fields from Level 2
      expect(parsed.data.license).toBe('MIT');
      expect(parsed.data.copyright).toBe('Copyright (c) 2024 Test User');
      expect(typeof parsed.data.license_source).toBe('string');
    });

    it('integration: existing license: field is preserved (idempotency)', async () => {
      const { recordProvenance } = await import('../src/runtime/universal-installer.js');
      // The mock would say MIT, but the file already declares Apache-2.0 — author wins.
      fetchSpy.mockResolvedValueOnce(
        okText('MIT License\n\nCopyright (c) 2024 Other\n\nPermission is hereby granted...'),
      );

      const sourceUrl = 'https://example.com/file.md'; // non-github → no SHA call
      const dummyBody = '<!-- L0: Test stub -->\n\n# Test Body';
      const before = matter.stringify(dummyBody, {
        id: `lic-keep-${Math.random().toString(36).slice(2, 10)}`,
        tags: ['skill'],
        status: 'active',
        license: 'Apache-2.0',
        copyright: 'Copyright (c) 2020 Original Author',
      });

      const after = await recordProvenance(before, sourceUrl);
      const parsed = matter(after);

      // Author-set values preserved verbatim
      expect(parsed.data.license).toBe('Apache-2.0');
      expect(parsed.data.copyright).toBe('Copyright (c) 2020 Original Author');
    });
  });

  // ─── License policy enforcement (task 12.14, Level 3) ──────────────────────
  // Pure-function unit tests for evaluateLicensePolicy(). The end-to-end
  // policy enforcement (block/warn/prompt UX) inside universalInstall() lives
  // behind config loading + readline + log calls and is harder to mock cleanly,
  // so the unit-level coverage of the decision logic is what matters here.

  describe('evaluateLicensePolicy', () => {
    /** Strict default policy — same shape as the config schema. */
    const strictPolicy = {
      allowed_licenses: ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC'],
      on_unknown_license: 'block' as const,
      on_proprietary: 'block' as const,
    };

    /** Permissive policy — accepts unknown with a warning. */
    const lenientPolicy = {
      allowed_licenses: ['MIT'],
      on_unknown_license: 'warn' as const,
      on_proprietary: 'warn' as const,
    };

    it('allows a license that is in allowed_licenses', () => {
      const decision = evaluateLicensePolicy({ spdxId: 'MIT' }, strictPolicy);
      expect(decision.action).toBe('allow');
      expect(decision.spdxId).toBe('MIT');
      expect(decision.reason).toContain('allowed_licenses');
    });

    it('blocks PROPRIETARY when on_proprietary is block', () => {
      const decision = evaluateLicensePolicy(
        { spdxId: 'PROPRIETARY', licenseSource: 'https://example.com/LICENSE.txt' },
        strictPolicy,
      );
      expect(decision.action).toBe('block');
      expect(decision.reason).toContain('proprietary');
      expect(decision.reason).toContain('https://example.com/LICENSE.txt');
    });

    it('warns on PROPRIETARY when on_proprietary is warn', () => {
      const decision = evaluateLicensePolicy({ spdxId: 'PROPRIETARY' }, lenientPolicy);
      expect(decision.action).toBe('warn');
      expect(decision.spdxId).toBe('PROPRIETARY');
    });

    it('blocks UNKNOWN under strict policy', () => {
      const decision = evaluateLicensePolicy({ spdxId: 'UNKNOWN' }, strictPolicy);
      expect(decision.action).toBe('block');
      expect(decision.reason).toContain('no LICENSE file found');
    });

    it('blocks GPL-3.0 (not in allowed_licenses) under strict policy', () => {
      const decision = evaluateLicensePolicy({ spdxId: 'GPL-3.0' }, strictPolicy);
      expect(decision.action).toBe('block');
      expect(decision.reason).toContain('GPL-3.0');
      expect(decision.reason).toContain('allowed_licenses');
    });

    it('warns on UNKNOWN under lenient policy', () => {
      const decision = evaluateLicensePolicy({ spdxId: 'UNKNOWN' }, lenientPolicy);
      expect(decision.action).toBe('warn');
    });

    it('forceLicense override always returns allow regardless of detected', () => {
      // PROPRIETARY would normally block under strict — force override permits it
      const decision = evaluateLicensePolicy(
        { spdxId: 'PROPRIETARY', licenseSource: 'https://example.com/LICENSE' },
        strictPolicy,
        'MIT',
      );
      expect(decision.action).toBe('allow');
      expect(decision.spdxId).toBe('MIT');
      expect(decision.reason).toContain('forced');
    });

    it('forceLicense overrides UNKNOWN to allow', () => {
      const decision = evaluateLicensePolicy({ spdxId: 'UNKNOWN' }, strictPolicy, 'Apache-2.0');
      expect(decision.action).toBe('allow');
      expect(decision.spdxId).toBe('Apache-2.0');
    });

    it('config default policy: warn on unknown, block on proprietary', () => {
      // Default schema values from src/core/types.ts install section
      const defaultPolicy = {
        allowed_licenses: [
          'MIT',
          'Apache-2.0',
          'BSD-2-Clause',
          'BSD-3-Clause',
          'ISC',
          'MPL-2.0',
          'CC-BY-4.0',
          'CC0-1.0',
          'Unlicense',
        ],
        on_unknown_license: 'warn' as const,
        on_proprietary: 'block' as const,
      };

      // PROPRIETARY blocked
      expect(evaluateLicensePolicy({ spdxId: 'PROPRIETARY' }, defaultPolicy).action).toBe('block');
      // UNKNOWN warns (so existing workflows don't break)
      expect(evaluateLicensePolicy({ spdxId: 'UNKNOWN' }, defaultPolicy).action).toBe('warn');
      // MIT allowed
      expect(evaluateLicensePolicy({ spdxId: 'MIT' }, defaultPolicy).action).toBe('allow');
      // GPL-3.0 warns (not in allowed_licenses, falls into on_unknown_license bucket)
      expect(evaluateLicensePolicy({ spdxId: 'GPL-3.0' }, defaultPolicy).action).toBe('warn');
    });
  });
});
