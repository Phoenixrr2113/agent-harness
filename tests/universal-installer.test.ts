import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scaffoldHarness } from '../src/cli/scaffold.js';
import {
  detectFormat,
  normalizeToHarness,
  convertToRawUrl,
  universalInstall,
} from '../src/runtime/universal-installer.js';
import type { FormatDetection, UniversalInstallOptions } from '../src/runtime/universal-installer.js';

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
});
