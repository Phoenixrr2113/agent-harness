import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const HARNESS_BIN = join(__dirname, '..', '..', 'dist', 'cli', 'index.js');

describe('harness doctor --check / --migrate (integration)', () => {
  beforeAll(() => {
    // Build the dist before running these integration tests
    const buildResult = spawnSync('npm', ['run', 'build'], { encoding: 'utf-8', cwd: join(__dirname, '..', '..') });
    if (buildResult.status !== 0) {
      throw new Error(`Build failed: ${buildResult.stderr}`);
    }
  }, 60000);

  it('--check on clean harness reports no findings, exits 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-cli-test-'));
    writeFileSync(join(dir, 'IDENTITY.md'), '# Identity', 'utf-8');

    const result = spawnSync('node', [HARNESS_BIN, 'doctor', '--check', '-d', dir], { encoding: 'utf-8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/no migrations needed|clean|0 findings/i);
  });

  it('--check on legacy harness reports findings, exits non-zero', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-cli-test-'));
    writeFileSync(join(dir, 'CORE.md'), '# Old', 'utf-8');

    const result = spawnSync('node', [HARNESS_BIN, 'doctor', '--check', '-d', dir], { encoding: 'utf-8' });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/CORE\.md/);
  });

  it('--migrate fixes the legacy harness', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-cli-test-'));
    writeFileSync(join(dir, 'CORE.md'), '# Old', 'utf-8');

    const result = spawnSync('node', [HARNESS_BIN, 'doctor', '--migrate', '-d', dir], { encoding: 'utf-8' });
    expect(result.status).toBe(0);
    expect(existsSync(join(dir, 'IDENTITY.md'))).toBe(true);
    expect(existsSync(join(dir, 'CORE.md'))).toBe(false);
  });
});
