import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const HARNESS_BIN = join(__dirname, '..', '..', 'dist', 'cli', 'index.js');

/**
 * Create a minimal harness directory — just IDENTITY.md — so the doctor
 * check doesn't pull in pre-existing lint issues from the default skills
 * that ship with the base template.
 */
function makeMinimalHarness(parentDir: string): string {
  const harnessDir = join(parentDir, 'myagent');
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(
    join(harnessDir, 'IDENTITY.md'),
    '# myagent\n\nA minimal test harness.\n',
    'utf-8',
  );
  return harnessDir;
}

describe('harness skill new', () => {
  it('scaffolds a complete skill bundle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-new-'));
    const harnessDir = makeMinimalHarness(dir);

    const result = spawnSync(
      'node',
      [HARNESS_BIN, 'skill', 'new', 'my-test', '-d', harnessDir],
      { encoding: 'utf-8' },
    );
    expect(result.status).toBe(0);

    expect(existsSync(join(harnessDir, 'skills', 'my-test', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(harnessDir, 'skills', 'my-test', 'scripts', 'run.sh'))).toBe(true);
    expect(
      existsSync(join(harnessDir, 'skills', 'my-test', 'references', 'REFERENCE.md')),
    ).toBe(true);

    const skillContent = readFileSync(
      join(harnessDir, 'skills', 'my-test', 'SKILL.md'),
      'utf-8',
    );
    expect(skillContent).toContain('name: my-test');
    expect(skillContent).toContain('description:');
  });

  it('scaffolded skill passes harness doctor --check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-new-'));
    const harnessDir = makeMinimalHarness(dir);

    spawnSync('node', [HARNESS_BIN, 'skill', 'new', 'my-test', '-d', harnessDir], {
      encoding: 'utf-8',
    });

    const doctor = spawnSync(
      'node',
      [HARNESS_BIN, 'doctor', '--check', '-d', harnessDir],
      { encoding: 'utf-8' },
    );
    // doctor --check exits non-zero only on error-severity lints or migration findings.
    // The scaffolded skill template is designed to have no error-severity lints.
    expect(doctor.status).toBe(0);
  });
});

describe('harness skill validate', () => {
  it('passes a clean skill', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-validate-'));
    const harnessDir = makeMinimalHarness(dir);
    spawnSync('node', [HARNESS_BIN, 'skill', 'new', 'my-test', '-d', harnessDir], {
      encoding: 'utf-8',
    });
    const result = spawnSync(
      'node',
      [HARNESS_BIN, 'skill', 'validate', 'my-test', '-d', harnessDir],
      { encoding: 'utf-8' },
    );
    expect(result.status).toBe(0);
  });

  it('reports lint errors on a deliberately bad skill', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-validate-'));
    const harnessDir = makeMinimalHarness(dir);
    // Hand-create a bad skill: short description, no sections, and references a
    // non-existent script (triggers REFERENCED_FILE_MISSING, which is error severity)
    const bundleDir = join(harnessDir, 'skills', 'bad-skill');
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(
      join(bundleDir, 'SKILL.md'),
      '---\nname: bad-skill\ndescription: Bad.\n---\nRun scripts/does-not-exist.sh to do things.',
      'utf-8',
    );
    const result = spawnSync(
      'node',
      [HARNESS_BIN, 'skill', 'validate', 'bad-skill', '-d', harnessDir],
      { encoding: 'utf-8' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(
      /DESCRIPTION_TOO_SHORT|MISSING_RECOMMENDED_SECTIONS|REFERENCED_FILE_MISSING/,
    );
  });
});
