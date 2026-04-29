import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import { cpSync, mkdtempSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const HARNESS_BIN = join(__dirname, '..', '..', 'dist', 'cli', 'index.js');
const FIXTURE = join(__dirname, '..', 'fixtures', 'old-harness-7-primitives');

describe('e2e — 7-primitive harness collapse', () => {
  beforeAll(() => {
    const buildResult = spawnSync('npm', ['run', 'build'], { encoding: 'utf-8', cwd: join(__dirname, '..', '..') });
    if (buildResult.status !== 0) throw new Error(`Build failed: ${buildResult.stderr}`);
  }, 60000);

  it('--migrate collapses all 5 old primitive types', () => {
    const dir = mkdtempSync(join(tmpdir(), 'collapse-e2e-'));
    cpSync(FIXTURE, dir, { recursive: true });

    const r = spawnSync('node', [HARNESS_BIN, 'doctor', '--migrate', '-d', dir], { encoding: 'utf-8' });
    expect(r.status).toBe(0);

    // Old directories should be gone
    expect(existsSync(join(dir, 'instincts'))).toBe(false);
    expect(existsSync(join(dir, 'playbooks'))).toBe(false);
    expect(existsSync(join(dir, 'workflows'))).toBe(false);
    expect(existsSync(join(dir, 'tools'))).toBe(false);
    expect(existsSync(join(dir, 'agents'))).toBe(false);

    // Migrated content
    expect(existsSync(join(dir, 'rules', 'lead-with-answer.md'))).toBe(true);
    expect(existsSync(join(dir, 'skills', 'ship-feature', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, 'skills', 'daily-reflection', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, 'skills', 'example-api', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, 'skills', 'example-api', 'scripts', 'call.sh'))).toBe(true);
    expect(existsSync(join(dir, 'skills', 'summarizer', 'SKILL.md'))).toBe(true);

    // Idempotence
    const r2 = spawnSync('node', [HARNESS_BIN, 'doctor', '--migrate', '-d', dir], { encoding: 'utf-8' });
    expect(r2.stdout).toMatch(/no migrations needed|clean|0 findings/i);
  });
});
