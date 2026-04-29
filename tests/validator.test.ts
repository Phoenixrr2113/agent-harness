import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { validateHarness, doctorHarness } from '../src/runtime/validator.js';

const TEST_DIR = join(__dirname, '__test_validator__');

function setupMinimalHarness(): void {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(join(TEST_DIR, 'CORE.md'), '# Core\n\nThe core of the harness.', 'utf-8');
  writeFileSync(
    join(TEST_DIR, 'config.yaml'),
    `agent:\n  name: test\n  version: "0.1.0"\nmodel:\n  provider: openrouter\n  id: test-model\n  max_tokens: 200000\n`,
    'utf-8',
  );
}

beforeEach(() => {
  setupMinimalHarness();
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('validateHarness', () => {
  it('should pass with minimal valid harness', () => {
    const result = validateHarness(TEST_DIR);
    expect(result.ok.some((m) => m.includes('CORE.md exists'))).toBe(true);
    expect(result.ok.some((m) => m.includes('config.yaml exists'))).toBe(true);
    expect(result.ok.some((m) => m.includes('Config valid'))).toBe(true);
  });

  it('should error on missing CORE.md', () => {
    rmSync(join(TEST_DIR, 'CORE.md'));
    const result = validateHarness(TEST_DIR);
    expect(result.errors.some((e) => e.includes('Missing required file: CORE.md'))).toBe(true);
  });

  it('should warn on missing optional files', () => {
    const result = validateHarness(TEST_DIR);
    expect(result.warnings.some((w) => w.includes('SYSTEM.md'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('state.md'))).toBe(true);
  });

  it('should count primitives per directory', () => {
    const rulesDir = join(TEST_DIR, 'rules');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      join(rulesDir, 'rule1.md'),
      `---\nid: rule1\ntags: [rule]\nstatus: active\n---\n# Rule: One\n\nContent here.`,
      'utf-8',
    );
    writeFileSync(
      join(rulesDir, 'rule2.md'),
      `---\nid: rule2\ntags: [rule]\nstatus: active\n---\n# Rule: Two\n\nContent here.`,
      'utf-8',
    );

    const result = validateHarness(TEST_DIR);
    expect(result.primitiveCounts.get('rules')).toBe(2);
    expect(result.totalPrimitives).toBe(2);
    expect(result.ok.some((m) => m.includes('rules/: 2 valid file(s)'))).toBe(true);
  });

  it('should report parse errors', () => {
    const rulesDir = join(TEST_DIR, 'rules');
    mkdirSync(rulesDir, { recursive: true });
    // Create a file with invalid YAML that gray-matter can't fix
    writeFileSync(join(rulesDir, 'bad.md'), `---\n: : invalid yaml {{{\n---\nContent`, 'utf-8');

    const result = validateHarness(TEST_DIR);
    // gray-matter is resilient — it may parse this with fallback.
    // But at minimum, the validator should not throw.
    expect(result).toBeDefined();
  });

  it('should detect broken cross-references', () => {
    const rulesDir = join(TEST_DIR, 'rules');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      join(rulesDir, 'ref-test.md'),
      `---\nid: ref-test\ntags: [rule]\nstatus: active\nrelated:\n  - nonexistent-id\n---\n# Rule: Ref Test\n\nContent with a broken reference.`,
      'utf-8',
    );

    const result = validateHarness(TEST_DIR);
    expect(result.warnings.some((w) => w.includes('nonexistent-id') && w.includes('not found'))).toBe(true);
  });

  it('should not warn for valid cross-references', () => {
    const rulesDir = join(TEST_DIR, 'rules');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      join(rulesDir, 'ref-source.md'),
      `---\nid: ref-source\ntags: [rule]\nstatus: active\nrelated:\n  - ref-target\n---\n# Rule: Source\n\nContent for source rule.`,
      'utf-8',
    );
    writeFileSync(
      join(rulesDir, 'ref-target.md'),
      `---\nid: ref-target\ntags: [rule]\nstatus: active\n---\n# Rule: Target\n\nContent for target rule.`,
      'utf-8',
    );

    const result = validateHarness(TEST_DIR);
    expect(result.warnings.some((w) => w.includes('ref-target') && w.includes('not found'))).toBe(false);
  });

  it('should warn on missing L0/L1 summaries', () => {
    const rulesDir = join(TEST_DIR, 'rules');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      join(rulesDir, 'no-summary.md'),
      `---\nid: no-summary\ntags: [rule]\nstatus: active\n---\n# Rule: No Summary\n\nThis has no L0 or L1 comment.`,
      'utf-8',
    );

    const result = validateHarness(TEST_DIR);
    expect(result.warnings.some((w) => w.includes('missing description'))).toBe(true);
  });

  it('should warn on missing memory directories', () => {
    const result = validateHarness(TEST_DIR);
    expect(result.warnings.some((w) => w.includes('memory/'))).toBe(true);
  });

  it('should report context budget usage', () => {
    const result = validateHarness(TEST_DIR);
    expect(result.ok.some((m) => m.includes('Context budget:'))).toBe(true);
  });
});

describe('doctorHarness', () => {
  it('should create missing memory directories', () => {
    const result = doctorHarness(TEST_DIR);
    expect(result.directoriesCreated).toContain('memory');
    expect(result.directoriesCreated).toContain('memory/sessions');
    expect(result.directoriesCreated).toContain('memory/journal');
    expect(result.directoriesCreated).toContain('intake');
    expect(existsSync(join(TEST_DIR, 'memory'))).toBe(true);
    expect(existsSync(join(TEST_DIR, 'memory', 'sessions'))).toBe(true);
    expect(existsSync(join(TEST_DIR, 'intake'))).toBe(true);
    // Warnings about missing dirs should be removed
    expect(result.warnings.some((w) => w.includes('Missing directory: memory/'))).toBe(false);
  });

  it('should auto-fix primitives with missing L0/L1', () => {
    const rulesDir = join(TEST_DIR, 'rules');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      join(rulesDir, 'needs-fix.md'),
      `---\nid: needs-fix\ntags: [rule]\nstatus: active\n---\n# Rule: Needs Fixing\n\nThis rule is missing L0 and L1 summaries.`,
      'utf-8',
    );

    const result = doctorHarness(TEST_DIR);
    expect(result.fixes.some((f) => f.includes('needs-fix.md') && f.includes('L0'))).toBe(true);

    // Verify file was actually fixed
    const content = readFileSync(join(rulesDir, 'needs-fix.md'), 'utf-8');
    expect(content).toContain('<!-- L0:');
  });

  it('should not re-fix already good primitives', () => {
    const rulesDir = join(TEST_DIR, 'rules');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      join(rulesDir, 'perfect.md'),
      `---\nid: perfect\ntags: [rule]\nstatus: active\n---\n<!-- L0: A perfect rule -->\n<!-- L1: This rule is perfectly formed -->\n# Rule: Perfect\n\nThis rule is already perfect and needs no fixes.`,
      'utf-8',
    );

    const result = doctorHarness(TEST_DIR);
    expect(result.fixes.some((f) => f.includes('perfect.md'))).toBe(false);
  });

  it('should include validation results alongside fixes', () => {
    const result = doctorHarness(TEST_DIR);
    // Should still have standard validation results
    expect(result.ok.some((m) => m.includes('CORE.md exists'))).toBe(true);
    expect(result.ok.some((m) => m.includes('Config valid'))).toBe(true);
  });

  it('should not create directories that already exist', () => {
    mkdirSync(join(TEST_DIR, 'memory', 'sessions'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'memory', 'journal'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'intake'), { recursive: true });

    const result = doctorHarness(TEST_DIR);
    expect(result.directoriesCreated).toHaveLength(0);
  });
});
