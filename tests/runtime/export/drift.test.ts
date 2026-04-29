import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runDrift, runExport } from '../../../src/runtime/export/runner.js';
import '../../../src/runtime/export/index.js';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'drift-')); }

function makeHarness(dir: string): void {
  mkdirSync(join(dir, 'skills/foo'), { recursive: true });
  mkdirSync(join(dir, 'rules'), { recursive: true });
  writeFileSync(join(dir, 'IDENTITY.md'), `# Test ${Math.random()}`);
  writeFileSync(join(dir, 'skills/foo/SKILL.md'), `---\nname: foo\ndescription: foo ${Math.random()}\n---\nBody.`);
  writeFileSync(join(dir, 'rules/r.md'), `---\nname: r\ndescription: r ${Math.random()}\nstatus: active\n---\nRule.`);
}

describe('runDrift', () => {
  it('reports no findings on a clean export', async () => {
    const dir = tmp();
    makeHarness(dir);
    const targetDir = join(dir, '.claude');
    await runExport({ harnessDir: dir, providers: ['claude'], targetPath: targetDir });
    const findings = await runDrift(dir, ['claude'], targetDir);
    expect(findings[0].findings.filter((f) => f.kind === 'modified')).toHaveLength(0);
  });

  it('reports modified finding after external edit on SKILL.md', async () => {
    const dir = tmp();
    makeHarness(dir);
    const targetDir = join(dir, '.claude');
    await runExport({ harnessDir: dir, providers: ['claude'], targetPath: targetDir });
    const skillPath = join(targetDir, 'skills/foo/SKILL.md');
    writeFileSync(skillPath, readFileSync(skillPath, 'utf-8') + '\nedit');
    const findings = await runDrift(dir, ['claude'], targetDir);
    expect(findings[0].findings.some((f) => f.kind === 'modified')).toBe(true);
  });

  it('reports orphan finding when source skill is removed', async () => {
    const dir = tmp();
    makeHarness(dir);
    const targetDir = join(dir, '.claude');
    await runExport({ harnessDir: dir, providers: ['claude'], targetPath: targetDir });
    // Simulate source removal: delete the source skill before drift check
    const { rmSync } = await import('fs');
    rmSync(join(dir, 'skills/foo'), { recursive: true });
    const findings = await runDrift(dir, ['claude'], targetDir);
    expect(findings[0].findings.some((f) => f.kind === 'orphan')).toBe(true);
  });

  it('handles multi-provider drift in one call', async () => {
    const dir = tmp();
    makeHarness(dir);
    await runExport({ harnessDir: dir, providers: ['claude'], targetPath: join(dir, '.claude') });
    await runExport({ harnessDir: dir, providers: ['copilot'], targetPath: join(dir, '.github') });
    const claudeDrift = await runDrift(dir, ['claude'], join(dir, '.claude'));
    const copilotDrift = await runDrift(dir, ['copilot'], join(dir, '.github'));
    expect(claudeDrift[0].findings.length).toBeLessThanOrEqual(1); // possibly 0
    expect(copilotDrift[0].findings.length).toBeLessThanOrEqual(1);
  });
});
