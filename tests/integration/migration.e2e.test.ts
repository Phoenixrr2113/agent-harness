import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { cpSync, mkdtempSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import matter from 'gray-matter';

const HARNESS_BIN = join(__dirname, '..', '..', 'dist', 'cli', 'index.js');
const FIXTURE = join(__dirname, '..', 'fixtures', 'old-harness');

function copyFixtureToTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mig-e2e-'));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

describe('e2e — old harness migration', () => {

  it('--check reports findings on the old harness', () => {
    const dir = copyFixtureToTmp();
    const result = spawnSync('node', [HARNESS_BIN, 'doctor', '--check', '-d', dir], { encoding: 'utf-8' });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/CORE\.md|SYSTEM\.md|state\.md|flat skill/i);
  });

  it('--migrate fully converts the fixture', () => {
    const dir = copyFixtureToTmp();

    const r1 = spawnSync('node', [HARNESS_BIN, 'doctor', '--migrate', '-d', dir], { encoding: 'utf-8' });
    expect(r1.status).toBe(0);

    // Identity rename
    expect(existsSync(join(dir, 'IDENTITY.md'))).toBe(true);
    expect(existsSync(join(dir, 'CORE.md'))).toBe(false);

    // System deletion
    expect(existsSync(join(dir, 'SYSTEM.md'))).toBe(false);

    // State move
    expect(existsSync(join(dir, 'memory', 'state.md'))).toBe(true);
    expect(existsSync(join(dir, 'state.md'))).toBe(false);

    // Skill bundling
    expect(existsSync(join(dir, 'skills', 'research', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, 'skills', 'research.md'))).toBe(false);

    // Skill frontmatter rewrite
    const skillRaw = readFileSync(join(dir, 'skills', 'research', 'SKILL.md'), 'utf-8');
    const { data, content } = matter(skillRaw);
    expect(data).not.toHaveProperty('id');
    expect(data).not.toHaveProperty('tags');
    expect((data.metadata as Record<string, unknown>)?.['harness-tags']).toBe('research,skill');
    expect(data['allowed-tools']).toBe('WebSearch Read');
    expect(content).not.toMatch(/<!--\s*L[01]:/);

    // Idempotency — running --migrate again should be a no-op
    const r2 = spawnSync('node', [HARNESS_BIN, 'doctor', '--migrate', '-d', dir], { encoding: 'utf-8' });
    expect(r2.status).toBe(0);
    expect(r2.stdout).toMatch(/no migrations needed|clean|0 findings/i);
  });
});
