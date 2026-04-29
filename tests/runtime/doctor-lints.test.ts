import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { skillLints } from '../../src/runtime/lints/skill-lints.js';
import { scriptLints } from '../../src/runtime/lints/script-lints.js';
import { loadAllPrimitives } from '../../src/primitives/loader.js';
import { runLints, applyFixes } from '../../src/runtime/doctor.js';

function loadFirstSkill(harnessDir: string) {
  const skills = loadAllPrimitives(harnessDir).get('skills') ?? [];
  return skills[0];
}

function makeSkillBundle(harnessDir: string, name: string, frontmatter: string, body: string): string {
  const dir = join(harnessDir, 'skills', name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'SKILL.md');
  writeFileSync(path, `---\n${frontmatter}\n---\n${body}`, 'utf-8');
  return dir;
}

describe('skillLints', () => {
  it('description-quality: flags vague descriptions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const bundleDir = makeSkillBundle(dir, 'foo', 'name: foo\ndescription: Helps with stuff.', 'Body.');
    const skill = loadFirstSkill(dir);
    const results = skillLints.descriptionQuality(skill, bundleDir);
    const warn = results.find((r) => r.severity === 'warn');
    expect(warn).toBeTruthy();
    expect(warn?.code).toMatch(/description/i);
  });

  it('description-quality: passes well-formed descriptions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const bundleDir = makeSkillBundle(dir, 'foo', 'name: foo\ndescription: Conducts deep research using web search and document analysis. Use when investigating a topic, gathering sources, or comparing options.', 'Body.');
    const skill = loadFirstSkill(dir);
    const results = skillLints.descriptionQuality(skill, bundleDir);
    expect(results).toHaveLength(0);
  });

  it('body-length: warns over 4000 tokens, errors over 6000', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const longBody = 'word '.repeat(5000); // ~5000 tokens (1 token ≈ 4 chars; 'word ' = 5 chars × 5000 = 25000 chars ≈ 6250 tokens)
    const bundleDir = makeSkillBundle(dir, 'foo', 'name: foo\ndescription: A test skill. Use when testing the linter.', longBody);
    const skill = loadFirstSkill(dir);
    const results = skillLints.bodyLength(skill, bundleDir);
    expect(results.some((r) => r.severity === 'error' || r.severity === 'warn')).toBe(true);
  });

  it('referenced-files-exist: errors when SKILL.md mentions a missing script', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const bundleDir = makeSkillBundle(
      dir,
      'foo',
      'name: foo\ndescription: A skill. Use when testing.',
      '## Available scripts\n\n- `scripts/run.sh` — Does the thing'
    );
    const skill = loadFirstSkill(dir);
    const results = skillLints.referencedFilesExist(skill, bundleDir);
    expect(results.find((r) => r.severity === 'error')).toBeTruthy();
  });

  it('required-sections: warns when SKILL.md lacks ## When to use AND any of Available scripts/Workflow/Gotchas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const bundleDir = makeSkillBundle(
      dir,
      'foo',
      'name: foo\ndescription: A skill. Use when testing.',
      '# Foo\n\nNo standard sections here.'
    );
    const skill = loadFirstSkill(dir);
    const results = skillLints.requiredSections(skill, bundleDir);
    expect(results.some((r) => r.severity === 'warn')).toBe(true);
  });
});

describe('scriptLints', () => {
  it('shebang: errors when script lacks shebang', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const path = join(dir, 'no-shebang.sh');
    writeFileSync(path, 'echo hello\n', 'utf-8');
    const results = await scriptLints.shebang(path);
    expect(results.find((r) => r.code === 'MISSING_SHEBANG')).toBeTruthy();
  });

  it('shebang: passes when script starts with #!', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const path = join(dir, 'has-shebang.sh');
    writeFileSync(path, '#!/usr/bin/env bash\necho hello\n', 'utf-8');
    const results = await scriptLints.shebang(path);
    expect(results).toHaveLength(0);
  });

  it('executable: errors when script lacks user-execute bit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const path = join(dir, 'not-exec.sh');
    writeFileSync(path, '#!/usr/bin/env bash\necho hi\n', 'utf-8');
    chmodSync(path, 0o644);
    const results = await scriptLints.executable(path);
    expect(results.find((r) => r.code === 'NOT_EXECUTABLE')).toBeTruthy();
    expect(results[0].fixable).toBe(true);
  });

  it('helpSupported: errors when --help fails OR lacks Usage:/Exit codes:', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const path = join(dir, 'no-help.sh');
    writeFileSync(path, '#!/usr/bin/env bash\necho hi\n', 'utf-8');
    chmodSync(path, 0o755);
    const results = await scriptLints.helpSupported(path);
    expect(results.find((r) => r.code === 'HELP_NOT_SUPPORTED' || r.code === 'HELP_INCOMPLETE')).toBeTruthy();
  }, 10000);

  it('helpSupported: passes when --help has Usage: and Exit codes:', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const path = join(dir, 'has-help.sh');
    writeFileSync(
      path,
      `#!/usr/bin/env bash\nif [ "\${1:-}" = "--help" ]; then\n  cat <<'EOF'\nUsage: this-script <args>\n\nDoes a thing.\n\nExit codes:\n  0 OK\n  1 error\nEOF\n  exit 0\nfi\n`,
      'utf-8'
    );
    chmodSync(path, 0o755);
    const results = await scriptLints.helpSupported(path);
    expect(results).toHaveLength(0);
  }, 10000);

  it('noInteractive: warns when script source contains read -p / read -r', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-'));
    const path = join(dir, 'interactive.sh');
    writeFileSync(path, '#!/usr/bin/env bash\nread -p "Enter name: " name\necho "Hi $name"\n', 'utf-8');
    const results = await scriptLints.noInteractive(path);
    expect(results.find((r) => r.severity === 'warn')).toBeTruthy();
  });
});

describe('runLints integration', () => {
  it('reports lint findings across multiple skills', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-int-'));
    makeSkillBundle(dir, 'too-short', 'name: too-short\ndescription: Bad.', 'Body.');
    const all = await runLints(dir);
    expect(all.some((r) => r.code === 'DESCRIPTION_TOO_SHORT')).toBe(true);
  });

  it('applyFixes can chmod +x scripts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-fix-'));
    const bundleDir = makeSkillBundle(
      dir,
      'foo',
      'name: foo\ndescription: A skill that has scripts. Use when testing fixes.',
      '## Available scripts\n\n- `scripts/run.sh` — Test'
    );
    const scriptDir = join(bundleDir, 'scripts');
    mkdirSync(scriptDir, { recursive: true });
    const scriptPath = join(scriptDir, 'run.sh');
    writeFileSync(
      scriptPath,
      '#!/usr/bin/env bash\nif [ "${1:-}" = "--help" ]; then\n  echo "Usage: run.sh"\n  echo "Exit codes:"\n  echo "  0 OK"\n  exit 0\nfi\necho hi\n',
      'utf-8'
    );
    chmodSync(scriptPath, 0o644);
    const lints = await runLints(dir);
    const { applied } = await applyFixes(dir, lints);
    expect(applied).toBeGreaterThan(0);
    expect(statSync(scriptPath).mode & 0o100).toBeTruthy();
  });
});
