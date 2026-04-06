import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import {
  exportHarness,
  writeBundle,
  readBundle,
  importBundle,
} from '../src/runtime/export.js';
import type { HarnessBundle } from '../src/runtime/export.js';

const TEST_DIR = join(__dirname, '__test_export__');
const IMPORT_DIR = join(__dirname, '__test_import__');

function setupHarness() {
  mkdirSync(join(TEST_DIR, 'rules'), { recursive: true });
  mkdirSync(join(TEST_DIR, 'instincts'), { recursive: true });
  mkdirSync(join(TEST_DIR, 'skills'), { recursive: true });
  mkdirSync(join(TEST_DIR, 'playbooks'), { recursive: true });
  mkdirSync(join(TEST_DIR, 'workflows'), { recursive: true });
  mkdirSync(join(TEST_DIR, 'tools'), { recursive: true });
  mkdirSync(join(TEST_DIR, 'agents'), { recursive: true });
  mkdirSync(join(TEST_DIR, 'memory', 'sessions'), { recursive: true });
  mkdirSync(join(TEST_DIR, 'memory', 'journal'), { recursive: true });

  writeFileSync(join(TEST_DIR, 'CORE.md'), '# Test Agent Core', 'utf-8');
  writeFileSync(join(TEST_DIR, 'SYSTEM.md'), '# System Instructions', 'utf-8');
  writeFileSync(
    join(TEST_DIR, 'config.yaml'),
    `agent:\n  name: test-agent\n  version: "1.0.0"\nmodel:\n  provider: openrouter\n  id: test-model\n  max_tokens: 200000\n`,
    'utf-8',
  );
  writeFileSync(
    join(TEST_DIR, 'state.md'),
    '# Agent State\n\n## Mode\nidle\n\n## Goals\n\n## Active Workflows\n\n## Last Interaction\n2026-04-01T00:00:00Z\n\n## Unfinished Business\n',
    'utf-8',
  );
  writeFileSync(join(TEST_DIR, 'memory', 'scratch.md'), 'some scratch notes', 'utf-8');

  // Add a rule primitive
  writeFileSync(
    join(TEST_DIR, 'rules', 'test-rule.md'),
    `---\nid: test-rule\ntags: [test]\nauthor: human\nstatus: active\n---\n<!-- L0: Test rule -->\n\n# Test Rule\nBe excellent.`,
    'utf-8',
  );

  // Add a session
  writeFileSync(
    join(TEST_DIR, 'memory', 'sessions', '2026-04-01-abcd1234.md'),
    '---\nid: 2026-04-01-abcd1234\ntags: [session]\n---\n# Session',
    'utf-8',
  );

  // Add a journal
  writeFileSync(
    join(TEST_DIR, 'memory', 'journal', '2026-04-01.md'),
    '---\nid: journal-2026-04-01\n---\n# Journal for 2026-04-01',
    'utf-8',
  );

  // Add metrics
  writeFileSync(
    join(TEST_DIR, 'memory', 'metrics.json'),
    JSON.stringify({ runs: [], updated: '2026-04-01T00:00:00Z' }),
    'utf-8',
  );
}

describe('export/import', () => {
  beforeEach(() => {
    setupHarness();
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync(IMPORT_DIR, { recursive: true, force: true });
  });

  it('should export all harness files', () => {
    const bundle = exportHarness(TEST_DIR);

    expect(bundle.version).toBe('1.0');
    expect(bundle.agent_name).toBe('test-agent');
    expect(bundle.metadata.primitives).toBe(1); // 1 rule
    expect(bundle.metadata.sessions).toBe(1);
    expect(bundle.metadata.journals).toBe(1);

    const paths = bundle.entries.map((e) => e.path);
    expect(paths).toContain('CORE.md');
    expect(paths).toContain('SYSTEM.md');
    expect(paths).toContain('config.yaml');
    expect(paths).toContain('state.md');
    expect(paths).toContain('rules/test-rule.md');
  });

  it('should exclude sessions when option set', () => {
    const bundle = exportHarness(TEST_DIR, { sessions: false });
    const paths = bundle.entries.map((e) => e.path);
    const sessionPaths = paths.filter((p) => p.includes('sessions'));
    expect(sessionPaths).toHaveLength(0);
    expect(bundle.metadata.sessions).toBe(0);
  });

  it('should exclude journals when option set', () => {
    const bundle = exportHarness(TEST_DIR, { journals: false });
    expect(bundle.metadata.journals).toBe(0);
  });

  it('should exclude state when option set', () => {
    const bundle = exportHarness(TEST_DIR, { state: false });
    const paths = bundle.entries.map((e) => e.path);
    expect(paths).not.toContain('state.md');
    expect(paths).not.toContain('memory/scratch.md');
  });

  it('should exclude metrics when option set', () => {
    const bundle = exportHarness(TEST_DIR, { metrics: false });
    const paths = bundle.entries.map((e) => e.path);
    const metricsPaths = paths.filter((p) => p.includes('metrics.json'));
    expect(metricsPaths).toHaveLength(0);
  });

  it('should write and read bundle from file', () => {
    const bundle = exportHarness(TEST_DIR);
    const outputPath = join(TEST_DIR, 'export.json');

    writeBundle(bundle, outputPath);
    expect(existsSync(outputPath)).toBe(true);

    const loaded = readBundle(outputPath);
    expect(loaded.agent_name).toBe('test-agent');
    expect(loaded.entries.length).toBe(bundle.entries.length);
  });

  it('should throw on invalid bundle file', () => {
    const invalidPath = join(TEST_DIR, 'invalid.json');
    writeFileSync(invalidPath, '{"not": "a bundle"}', 'utf-8');

    expect(() => readBundle(invalidPath)).toThrow('Invalid bundle format');
  });

  it('should throw on missing bundle file', () => {
    expect(() => readBundle('/nonexistent/path.json')).toThrow('Bundle not found');
  });

  it('should import bundle into new directory', () => {
    const bundle = exportHarness(TEST_DIR);
    mkdirSync(IMPORT_DIR, { recursive: true });

    const result = importBundle(IMPORT_DIR, bundle);
    expect(result.imported).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);

    // Verify imported files exist
    expect(existsSync(join(IMPORT_DIR, 'CORE.md'))).toBe(true);
    expect(readFileSync(join(IMPORT_DIR, 'CORE.md'), 'utf-8')).toBe('# Test Agent Core');
    expect(existsSync(join(IMPORT_DIR, 'rules', 'test-rule.md'))).toBe(true);
  });

  it('should skip existing files without overwrite', () => {
    mkdirSync(IMPORT_DIR, { recursive: true });
    writeFileSync(join(IMPORT_DIR, 'CORE.md'), 'ORIGINAL', 'utf-8');

    const bundle = exportHarness(TEST_DIR);
    const result = importBundle(IMPORT_DIR, bundle);

    expect(result.skipped).toBeGreaterThan(0);
    // CORE.md should not be overwritten
    expect(readFileSync(join(IMPORT_DIR, 'CORE.md'), 'utf-8')).toBe('ORIGINAL');
  });

  it('should overwrite files when option set', () => {
    mkdirSync(IMPORT_DIR, { recursive: true });
    writeFileSync(join(IMPORT_DIR, 'CORE.md'), 'ORIGINAL', 'utf-8');

    const bundle = exportHarness(TEST_DIR);
    const result = importBundle(IMPORT_DIR, bundle, { overwrite: true });

    expect(result.imported).toBe(bundle.entries.length);
    expect(result.skipped).toBe(0);
    expect(readFileSync(join(IMPORT_DIR, 'CORE.md'), 'utf-8')).toBe('# Test Agent Core');
  });

  it('should create parent directories during import', () => {
    const bundle: HarnessBundle = {
      version: '1.0',
      exported_at: new Date().toISOString(),
      agent_name: 'test',
      entries: [
        { path: 'deep/nested/dir/file.md', content: 'Hello' },
      ],
      metadata: { primitives: 0, sessions: 0, journals: 0 },
    };

    mkdirSync(IMPORT_DIR, { recursive: true });
    const result = importBundle(IMPORT_DIR, bundle);
    expect(result.imported).toBe(1);
    expect(existsSync(join(IMPORT_DIR, 'deep', 'nested', 'dir', 'file.md'))).toBe(true);
  });
});
