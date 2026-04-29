import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runExport, defaultTargetFor } from '../../../src/runtime/export/runner.js';
import { registerAdapter, clearRegistry } from '../../../src/runtime/export/registry.js';
import type { ProviderAdapter, ExportContext } from '../../../src/runtime/export/types.js';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'rxr-')); }

function makeFakeHarness(dir: string): void {
  mkdirSync(join(dir, 'skills/foo'), { recursive: true });
  mkdirSync(join(dir, 'rules'), { recursive: true });
  writeFileSync(join(dir, 'IDENTITY.md'), '# I am a harness');
  writeFileSync(join(dir, 'skills/foo/SKILL.md'), `---\nname: foo\ndescription: foo desc ${Math.random()}\n---\nBody.`);
  writeFileSync(join(dir, 'rules/r1.md'), `---\nname: r1\ndescription: rule one ${Math.random()}\n---\nDo X.`);
}

describe('runExport', () => {
  beforeEach(() => clearRegistry());

  it('invokes the named adapter once', async () => {
    const dir = tmp();
    makeFakeHarness(dir);
    const exportAll = vi.fn(async () => ({ provider: 'claude' as const, written: ['.claude/x'], skipped: [], warnings: [] }));
    const adapter: ProviderAdapter = {
      name: 'claude',
      exportAll,
      detectDrift: async () => ({ provider: 'claude', findings: [] }),
    };
    registerAdapter(adapter);
    const reports = await runExport({ harnessDir: dir, providers: ['claude'], targetPath: '.claude' });
    expect(exportAll).toHaveBeenCalledTimes(1);
    expect(reports[0].written).toEqual(['.claude/x']);
  });

  it('throws on unknown provider', async () => {
    const dir = tmp();
    makeFakeHarness(dir);
    await expect(runExport({ harnessDir: dir, providers: ['nonexistent' as never], targetPath: '.x' }))
      .rejects.toThrow(/unknown provider/i);
  });

  it('respects dryRun by skipping exportAll', async () => {
    const dir = tmp();
    makeFakeHarness(dir);
    const exportAll = vi.fn();
    const detectDrift = vi.fn(async () => ({ provider: 'claude' as const, findings: [] }));
    registerAdapter({ name: 'claude', exportAll, detectDrift });
    const reports = await runExport({ harnessDir: dir, providers: ['claude'], targetPath: '.claude', dryRun: true });
    expect(exportAll).not.toHaveBeenCalled();
    expect(reports[0].written).toEqual([]);
    expect(reports[0].warnings.some((w) => /dry-run/i.test(w))).toBe(true);
  });

  it('uses defaultTargetFor when targetPath is omitted', async () => {
    const dir = tmp();
    makeFakeHarness(dir);
    let observedTargetDir = '';
    const exportAll = vi.fn(async (ctx: ExportContext) => {
      observedTargetDir = ctx.targetDir;
      return { provider: 'copilot' as const, written: [], skipped: [], warnings: [] };
    });
    registerAdapter({ name: 'copilot', exportAll, detectDrift: async () => ({ provider: 'copilot', findings: [] }) });
    await runExport({ harnessDir: dir, providers: ['copilot'] });
    // copilot's canonical target is .github, NOT .copilot
    expect(observedTargetDir).toBe('.github');
  });

  it('threads CLI version into ExportContext.harnessVersion (not "@unknown")', async () => {
    const dir = tmp();
    makeFakeHarness(dir);
    let observedVersion = '';
    const exportAll = vi.fn(async (ctx: ExportContext) => {
      observedVersion = ctx.harnessVersion;
      return { provider: 'claude' as const, written: [], skipped: [], warnings: [] };
    });
    registerAdapter({ name: 'claude', exportAll, detectDrift: async () => ({ provider: 'claude', findings: [] }) });
    await runExport({ harnessDir: dir, providers: ['claude'] });
    expect(observedVersion).toMatch(/^@agntk\/agent-harness@\d+\.\d+\.\d+/);
  });
});

describe('defaultTargetFor', () => {
  it('maps copilot to .github (not .copilot)', () => {
    expect(defaultTargetFor('copilot')).toBe('.github');
  });
  it('maps the rest to .<name>', () => {
    expect(defaultTargetFor('claude')).toBe('.claude');
    expect(defaultTargetFor('codex')).toBe('.codex');
    expect(defaultTargetFor('cursor')).toBe('.cursor');
    expect(defaultTargetFor('gemini')).toBe('.gemini');
    expect(defaultTargetFor('agents')).toBe('.agents');
  });
});

describe('detectProjectRoot', () => {
  it('returns harnessDir when no project sentinel exists at parent', async () => {
    const { detectProjectRoot } = await import('../../../src/runtime/export/runner.js');
    const dir = tmp();
    expect(detectProjectRoot(dir)).toBe(dir);
  });

  it('returns parent when AGENTS.md sits at parent', async () => {
    const { detectProjectRoot } = await import('../../../src/runtime/export/runner.js');
    const projectDir = tmp();
    const harnessDir = join(projectDir, '.harness');
    mkdirSync(harnessDir);
    writeFileSync(join(projectDir, 'AGENTS.md'), '# Existing project guidance');
    expect(detectProjectRoot(harnessDir)).toBe(projectDir);
  });

  it('returns parent when package.json sits at parent (subdirectory install)', async () => {
    const { detectProjectRoot } = await import('../../../src/runtime/export/runner.js');
    const projectDir = tmp();
    const harnessDir = join(projectDir, '.harness');
    mkdirSync(harnessDir);
    writeFileSync(join(projectDir, 'package.json'), '{"name":"my-project"}');
    expect(detectProjectRoot(harnessDir)).toBe(projectDir);
  });
});
