import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { discoverProjectContext } from '../src/runtime/project-discovery.js';

describe('project-discovery', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'project-discover-test-'));
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return empty results for empty directory', () => {
    const result = discoverProjectContext({ dir: testDir });
    expect(result.signals).toHaveLength(0);
    expect(result.suggestions).toHaveLength(0);
  });

  it('should detect TypeScript from package.json', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      devDependencies: { typescript: '^5.0.0' },
    }));

    const result = discoverProjectContext({ dir: testDir });
    const ts = result.signals.find((s) => s.name === 'TypeScript');
    expect(ts).toBeDefined();
    expect(ts?.category).toBe('language');
  });

  it('should detect React and Next.js', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      dependencies: { react: '^18', next: '^14' },
    }));

    const result = discoverProjectContext({ dir: testDir });
    const names = result.signals.map((s) => s.name);
    expect(names).toContain('React');
    expect(names).toContain('Next.js');
  });

  it('should detect testing frameworks', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      devDependencies: { vitest: '^2', '@playwright/test': '^1' },
    }));

    const result = discoverProjectContext({ dir: testDir });
    const names = result.signals.map((s) => s.name);
    expect(names).toContain('Vitest');
    expect(names).toContain('Playwright');
  });

  it('should detect database libraries', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      dependencies: { '@prisma/client': '^5', redis: '^4' },
    }));

    const result = discoverProjectContext({ dir: testDir });
    const names = result.signals.map((s) => s.name);
    expect(names).toContain('Prisma');
    expect(names).toContain('Redis');
  });

  it('should detect Docker from Dockerfile', () => {
    writeFileSync(join(testDir, 'Dockerfile'), 'FROM node:20\nRUN npm install');

    const result = discoverProjectContext({ dir: testDir });
    const docker = result.signals.find((s) => s.name === 'Docker');
    expect(docker).toBeDefined();
    expect(docker?.category).toBe('runtime');
  });

  it('should detect GitHub Actions from .github directory', () => {
    mkdirSync(join(testDir, '.github', 'workflows'), { recursive: true });

    const result = discoverProjectContext({ dir: testDir });
    const gh = result.signals.find((s) => s.name === 'GitHub Actions');
    expect(gh).toBeDefined();
  });

  it('should detect Python projects', () => {
    writeFileSync(join(testDir, 'pyproject.toml'), '[tool.poetry]\nname = "my-project"');

    const result = discoverProjectContext({ dir: testDir });
    const py = result.signals.find((s) => s.name === 'Python');
    expect(py).toBeDefined();
    expect(py?.category).toBe('language');
  });

  it('should detect Rust projects', () => {
    writeFileSync(join(testDir, 'Cargo.toml'), '[package]\nname = "my-project"');

    const result = discoverProjectContext({ dir: testDir });
    expect(result.signals.find((s) => s.name === 'Rust')).toBeDefined();
  });

  it('should detect Go projects', () => {
    writeFileSync(join(testDir, 'go.mod'), 'module example.com/myproject\n\ngo 1.22');

    const result = discoverProjectContext({ dir: testDir });
    expect(result.signals.find((s) => s.name === 'Go')).toBeDefined();
  });

  it('should detect cloud platforms', () => {
    writeFileSync(join(testDir, 'vercel.json'), '{}');
    writeFileSync(join(testDir, 'wrangler.toml'), 'name = "worker"');

    const result = discoverProjectContext({ dir: testDir });
    const names = result.signals.map((s) => s.name);
    expect(names).toContain('Vercel');
    expect(names).toContain('Cloudflare Workers');
  });

  it('should generate rule suggestions for TypeScript projects', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      devDependencies: { typescript: '^5', vitest: '^2', eslint: '^9' },
    }));

    const result = discoverProjectContext({ dir: testDir });
    const ruleTypes = result.suggestions.filter((s) => s.type === 'rule');
    expect(ruleTypes.length).toBeGreaterThanOrEqual(2);

    const targets = ruleTypes.map((s) => s.target);
    expect(targets).toContain('rules/typescript-standards.md');
    expect(targets).toContain('rules/testing.md');
  });

  it('should generate MCP server suggestions', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      dependencies: { '@prisma/client': '^5' },
    }));

    const result = discoverProjectContext({ dir: testDir });
    const mcpSuggestions = result.suggestions.filter((s) => s.type === 'mcp-server');
    expect(mcpSuggestions.length).toBeGreaterThanOrEqual(1);
    expect(mcpSuggestions[0].target).toBe('postgres');
  });

  it('should deduplicate signals', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      dependencies: { prisma: '^5', '@prisma/client': '^5' },
    }));
    mkdirSync(join(testDir, 'prisma'));

    const result = discoverProjectContext({ dir: testDir });
    const prismaSignals = result.signals.filter((s) => s.name === 'Prisma');
    expect(prismaSignals).toHaveLength(1);
  });

  it('should detect Supabase directory', () => {
    mkdirSync(join(testDir, 'supabase'));

    const result = discoverProjectContext({ dir: testDir });
    expect(result.signals.find((s) => s.name === 'Supabase')).toBeDefined();
  });

  it('should handle malformed package.json', () => {
    writeFileSync(join(testDir, 'package.json'), '{ invalid json');

    const result = discoverProjectContext({ dir: testDir });
    // Should not throw, just skip the package.json signals
    expect(result.signals).toBeDefined();
  });
});
