import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runExport } from '../../../src/runtime/export/runner.js';
import { registerAdapter, clearRegistry } from '../../../src/runtime/export/registry.js';
import type { ProviderAdapter } from '../../../src/runtime/export/types.js';

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
});
