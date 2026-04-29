import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'ex-cli-')); }
const cli = join(process.cwd(), 'dist/cli/index.js');

function runCli(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, NODE_OPTIONS: '' },
    encoding: 'utf-8',
    timeout: 30000,
  });
}

function makeHarness(dir: string): void {
  mkdirSync(join(dir, 'skills/foo'), { recursive: true });
  mkdirSync(join(dir, 'rules'), { recursive: true });
  writeFileSync(join(dir, 'IDENTITY.md'), `# Test ${Math.random()}`);
  writeFileSync(join(dir, 'skills/foo/SKILL.md'), `---\nname: foo\ndescription: foo desc ${Math.random()}\n---\nBody.`);
  writeFileSync(join(dir, 'rules/r.md'), `---\nname: r\ndescription: r ${Math.random()}\nstatus: active\n---\nRule.`);
  writeFileSync(join(dir, 'config.yaml'), 'model:\n  provider: ollama\n  id: qwen3:1.7b\n');
}

describe('harness export CLI', () => {
  it('exports to claude in a fresh harness', () => {
    const dir = tmp();
    makeHarness(dir);
    const result = runCli(['export', 'claude', '--harness', dir, '--target', join(dir, '.claude')]);
    expect(result.status, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
    expect(existsSync(join(dir, '.claude/skills/foo/SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, '.claude/CLAUDE.md'))).toBe(true);
  });

  it('--dry-run does not write', () => {
    const dir = tmp();
    makeHarness(dir);
    const result = runCli(['export', 'claude', '--harness', dir, '--target', join(dir, '.claude'), '--dry-run']);
    expect(result.status).toBe(0);
    expect(existsSync(join(dir, '.claude/skills/foo/SKILL.md'))).toBe(false);
  });

  it('rejects unknown provider', () => {
    const dir = tmp();
    makeHarness(dir);
    const result = runCli(['export', 'nonexistent', '--harness', dir]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unknown provider/i);
  });
});
