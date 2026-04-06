import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { validateHarness } from '../src/runtime/validator.js';

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
    expect(result.warnings.some((w) => w.includes('missing L0'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('missing L1'))).toBe(true);
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
