import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'doc-drift-')); }
const cli = join(process.cwd(), 'dist/cli/index.js');

function runCli(args: string[], cwd?: string) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, NODE_OPTIONS: '' },
    encoding: 'utf-8',
    timeout: 30000,
    cwd,
  });
}

function makeHarnessWithExport(dir: string): void {
  mkdirSync(join(dir, 'skills/foo'), { recursive: true });
  mkdirSync(join(dir, 'rules'), { recursive: true });
  writeFileSync(join(dir, 'IDENTITY.md'), `# Test ${Math.random()}`);
  writeFileSync(join(dir, 'CORE.md'), `# Core ${Math.random()}`);
  writeFileSync(join(dir, 'skills/foo/SKILL.md'), `---\nname: foo\ndescription: foo desc ${Math.random()}\n---\nBody.`);
  writeFileSync(join(dir, 'rules/r.md'), `---\nname: r\ndescription: r ${Math.random()}\nstatus: active\n---\nRule.`);
  writeFileSync(join(dir, 'config.yaml'), `model:
  provider: ollama
  id: qwen3:1.7b
export:
  enabled: true
  on_drift: warn
  targets:
    - provider: claude
      path: ".claude"
      auto: false
`);
}

describe('harness doctor --check-drift', () => {
  it('reports clean drift after fresh export', () => {
    const dir = tmp();
    makeHarnessWithExport(dir);
    // Run export first to populate the target — cwd=dir so relative .claude resolves inside the harness
    const exp = runCli(['export', 'claude', '--harness', dir, '--target', join(dir, '.claude')], dir);
    expect(exp.status, `export failed: ${exp.stderr}`).toBe(0);
    // Now run doctor with --check-drift; cwd=dir so the config's relative target ".claude" resolves correctly
    const doc = runCli(['doctor', '--check-drift', '-d', dir], dir);
    expect(doc.status, `doctor stderr: ${doc.stderr}\nstdout: ${doc.stdout}`).toBe(0);
    expect(doc.stdout).toMatch(/Drift check:/i);
    expect(doc.stdout).toMatch(/claude:\s+clean/i);
  });

  it('reports modified after external edit', () => {
    const dir = tmp();
    makeHarnessWithExport(dir);
    runCli(['export', 'claude', '--harness', dir, '--target', join(dir, '.claude')], dir);
    const skillPath = join(dir, '.claude/skills/foo/SKILL.md');
    writeFileSync(skillPath, readFileSync(skillPath, 'utf-8') + '\nedit');
    const doc = runCli(['doctor', '--check-drift', '-d', dir], dir);
    expect(doc.status, `doctor stderr: ${doc.stderr}\nstdout: ${doc.stdout}`).toBe(0);
    expect(doc.stdout).toMatch(/modified/i);
  });
});
