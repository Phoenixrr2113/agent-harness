import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { fixCapability, evaluateCapability, installCapability, processIntake } from '../src/runtime/intake.js';

const TEST_DIR = join(__dirname, '__test_intake__');
const INTAKE_DIR = join(TEST_DIR, 'intake');

function writeTestFile(name: string, content: string): string {
  const filePath = join(TEST_DIR, name);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function writeIntakeFile(name: string, content: string): string {
  if (!existsSync(INTAKE_DIR)) {
    mkdirSync(INTAKE_DIR, { recursive: true });
  }
  const filePath = join(INTAKE_DIR, name);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// --- fixCapability tests ---
describe('fixCapability', () => {
  it('should add missing id from filename', () => {
    const filePath = writeTestFile('my-cool-rule.md', `---
tags: [rule]
---
# Rule: My Cool Rule

This is a rule that does something useful and important.
`);
    const result = fixCapability(filePath);
    expect(result.fixes_applied).toContain('Added id: "my-cool-rule" (from filename)');
    expect(result.type).toBe('rule');

    // Verify file was rewritten
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('id: my-cool-rule');
  });

  it('should add missing status', () => {
    const filePath = writeTestFile('test-skill.md', `---
id: test-skill
tags: [skill]
---
# Skill: Test Skill

This is a skill with some useful content for testing purposes.
`);
    const result = fixCapability(filePath);
    expect(result.fixes_applied).toContain('Added status: "active"');

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('status: active');
  });

  it('should add missing type tag inferred from heading', () => {
    const filePath = writeTestFile('test-playbook.md', `---
id: test-playbook
status: active
---
# Playbook: Deployment Checklist

Follow these steps to deploy safely and correctly to production.
`);
    const result = fixCapability(filePath);
    expect(result.fixes_applied.some((f) => f.includes('Added tag: "playbook"'))).toBe(true);
    expect(result.type).toBe('playbook');

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('playbook');
  });

  it('should generate L0 from first heading', () => {
    const filePath = writeTestFile('test-rule.md', `---
id: test-rule
tags: [rule]
status: active
---
# Rule: Always Use Strict Mode

Enable strict mode in all TypeScript configurations to catch errors early.
`);
    const result = fixCapability(filePath);
    expect(result.fixes_applied.some((f) => f.includes('Generated L0'))).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('<!-- L0:');
    expect(content).toContain('Always Use Strict Mode');
  });

  it('should generate L1 from first paragraph', () => {
    const filePath = writeTestFile('test-instinct.md', `---
id: test-instinct
tags: [instinct]
status: active
---
# Instinct: Check Before Commit

Always run the full test suite and linter before committing code changes.
This prevents broken builds and ensures code quality standards are maintained.

## Details

More information about the instinct here.
`);
    const result = fixCapability(filePath);
    expect(result.fixes_applied.some((f) => f.includes('Generated L1'))).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('<!-- L1:');
    expect(content).toContain('Always run the full test suite');
  });

  it('should not overwrite existing L0/L1', () => {
    const filePath = writeTestFile('existing-l0.md', `---
id: existing
tags: [rule]
status: active
---
<!-- L0: Existing L0 summary -->
<!-- L1: Existing L1 summary -->
# Rule: Existing

This is a rule with existing L0 and L1 annotations already.
`);
    const result = fixCapability(filePath);
    // No L0/L1 fixes should have been applied
    expect(result.fixes_applied.some((f) => f.includes('L0'))).toBe(false);
    expect(result.fixes_applied.some((f) => f.includes('L1'))).toBe(false);
  });

  it('should fix multiple issues at once', () => {
    const filePath = writeTestFile('bare-minimum.md', `---
{}
---
# Workflow: Build Pipeline

Configure the build pipeline to run all checks in the correct order for CI.
`);
    const result = fixCapability(filePath);
    // Should have added id, status, type tag, L0, and L1
    expect(result.fixes_applied.length).toBeGreaterThanOrEqual(3);
    expect(result.type).toBe('workflow');
  });

  it('should return error for non-existent file', () => {
    const result = fixCapability('/nonexistent/path.md');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('File does not exist');
  });

  it('should return error for non-markdown file', () => {
    const filePath = join(TEST_DIR, 'test.txt');
    writeFileSync(filePath, 'not markdown', 'utf-8');
    const result = fixCapability(filePath);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('File must be a .md file');
  });

  it('should report error for body too short', () => {
    const filePath = writeTestFile('short.md', `---
id: short
tags: [rule]
---
tiny
`);
    const result = fixCapability(filePath);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('too short'))).toBe(true);
  });

  it('should truncate long L0 summaries', () => {
    const longHeading = 'A'.repeat(200);
    const filePath = writeTestFile('long-heading.md', `---
id: long-heading
tags: [rule]
status: active
---
# Rule: ${longHeading}

This rule has a very long heading that should be truncated in the L0 summary.
`);
    const result = fixCapability(filePath);
    const content = readFileSync(filePath, 'utf-8');
    const l0Match = content.match(/<!-- L0: (.+?) -->/);
    expect(l0Match).not.toBeNull();
    expect(l0Match![1].length).toBeLessThanOrEqual(120);
    expect(l0Match![1]).toContain('...');
  });

  it('should not modify file when no fixes needed', () => {
    const original = `---
id: perfect
tags: [rule]
status: active
---
<!-- L0: A perfectly formed rule document -->
<!-- L1: This rule is already perfect and needs no fixes whatsoever applied -->
# Rule: Perfect

This rule is perfectly formed and requires no auto-fixing at all.
`;
    const filePath = writeTestFile('perfect.md', original);
    const result = fixCapability(filePath);
    expect(result.fixes_applied).toHaveLength(0);
    // File should not have been rewritten
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toBe(original);
  });
});

// --- evaluateCapability tests ---
describe('evaluateCapability', () => {
  it('should validate a well-formed capability', () => {
    const filePath = writeTestFile('good-rule.md', `---
id: good-rule
tags: [rule]
status: active
---
<!-- L0: A good rule -->
<!-- L1: This is a good rule for testing -->
# Rule: Good Rule

This is a well-formed rule with all required fields.
`);
    const result = evaluateCapability(filePath);
    expect(result.valid).toBe(true);
    expect(result.type).toBe('rule');
    expect(result.errors).toHaveLength(0);
  });

  it('should detect type from tags', () => {
    const filePath = writeTestFile('tagged.md', `---
id: tagged
tags: [skill, experimental]
---
Some content that is long enough to pass the body length check.
`);
    const result = evaluateCapability(filePath);
    expect(result.type).toBe('skill');
  });

  it('should infer type from content heading', () => {
    const filePath = writeTestFile('inferred.md', `---
id: inferred
---
# Agent: My Agent

This agent does something useful and meaningful for the system.
`);
    const result = evaluateCapability(filePath);
    expect(result.type).toBe('agent');
  });

  it('should fallback id from filename when frontmatter id is missing', () => {
    // parseHarnessDocument falls back to deriving id from filename,
    // so evaluateCapability won't report "missing id" — the parser handles it.
    const filePath = writeTestFile('no-id.md', `---
tags: [rule]
---
# Rule: No ID

This rule is missing an id field but the parser derives one from the filename.
`);
    const result = evaluateCapability(filePath);
    expect(result.valid).toBe(true);
    expect(result.type).toBe('rule');
  });

  it('should warn on missing L0/L1', () => {
    const filePath = writeTestFile('no-summaries.md', `---
id: no-summaries
tags: [rule]
---
# Rule: No Summaries

This rule has no L0 or L1 summary annotations in the content.
`);
    const result = evaluateCapability(filePath);
    expect(result.warnings.some((w) => w.includes('L0'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('L1'))).toBe(true);
  });

  it('should fail on body too short', () => {
    const filePath = writeTestFile('short-body.md', `---
id: short-body
tags: [rule]
---
tiny
`);
    const result = evaluateCapability(filePath);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('too short'))).toBe(true);
  });
});

// --- evaluateCapability with dependency resolution ---
describe('evaluateCapability with harnessDir (dependency resolution)', () => {
  it('should warn on unresolved related: references', () => {
    writeFileSync(join(TEST_DIR, 'CORE.md'), '# Core', 'utf-8');
    const rulesDir = join(TEST_DIR, 'rules');
    mkdirSync(rulesDir, { recursive: true });

    const filePath = writeTestFile('dep-test.md', `---
id: dep-test
tags: [rule]
status: active
related:
  - nonexistent-skill
---
# Rule: Dep Test

This rule references a skill that does not exist in the harness.
`);
    const result = evaluateCapability(filePath, TEST_DIR);
    expect(result.warnings.some((w) => w.includes('nonexistent-skill') && w.includes('not found'))).toBe(true);
  });

  it('should not warn when related: references exist', () => {
    writeFileSync(join(TEST_DIR, 'CORE.md'), '# Core', 'utf-8');
    const rulesDir = join(TEST_DIR, 'rules');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      join(rulesDir, 'existing-rule.md'),
      `---\nid: existing-rule\ntags: [rule]\nstatus: active\n---\n# Rule: Existing\n\nContent here.`,
      'utf-8',
    );

    const filePath = writeTestFile('ref-resolved.md', `---
id: ref-resolved
tags: [rule]
status: active
related:
  - existing-rule
---
# Rule: Ref Resolved

This rule references an existing rule that should be found.
`);
    const result = evaluateCapability(filePath, TEST_DIR);
    expect(result.warnings.some((w) => w.includes('existing-rule') && w.includes('not found'))).toBe(false);
  });

  it('should warn on unresolved with: agent reference', () => {
    writeFileSync(join(TEST_DIR, 'CORE.md'), '# Core', 'utf-8');

    const filePath = writeTestFile('needs-agent.md', `---
id: needs-agent
tags: [workflow]
status: active
with: summarizer
---
# Workflow: Needs Agent

This workflow delegates to a summarizer agent that does not exist.
`);
    const result = evaluateCapability(filePath, TEST_DIR);
    expect(result.warnings.some((w) => w.includes('summarizer') && w.includes('agent'))).toBe(true);
  });

  it('should not warn when with: agent exists', () => {
    writeFileSync(join(TEST_DIR, 'CORE.md'), '# Core', 'utf-8');
    const agentsDir = join(TEST_DIR, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'summarizer.md'),
      `---\nid: summarizer\ntags: [agent]\nstatus: active\n---\n# Agent: Summarizer\n\nSummarizes content.`,
      'utf-8',
    );

    const filePath = writeTestFile('has-agent.md', `---
id: has-agent
tags: [workflow]
status: active
with: summarizer
---
# Workflow: Has Agent

This workflow delegates to a summarizer agent that exists.
`);
    const result = evaluateCapability(filePath, TEST_DIR);
    expect(result.warnings.some((w) => w.includes('summarizer') && w.includes('agent'))).toBe(false);
  });

  it('should work without harnessDir (no dependency check)', () => {
    const filePath = writeTestFile('no-dir.md', `---
id: no-dir
tags: [rule]
status: active
related:
  - nonexistent
---
# Rule: No Dir

This rule has a reference but no harnessDir so deps are not checked.
`);
    const result = evaluateCapability(filePath);
    // No warnings about unresolved references when harnessDir is not provided
    expect(result.warnings.some((w) => w.includes('nonexistent'))).toBe(false);
  });
});

// --- installCapability tests ---
describe('installCapability', () => {
  it('should install a valid capability to the correct directory', () => {
    // Create a minimal CORE.md so writeIndexFile doesn't fail
    writeFileSync(join(TEST_DIR, 'CORE.md'), '# Core', 'utf-8');

    const filePath = writeTestFile('my-skill.md', `---
id: my-skill
tags: [skill]
status: active
---
<!-- L0: A test skill -->
# Skill: My Skill

This skill does something useful for testing the install capability flow.
`);
    const result = installCapability(TEST_DIR, filePath);
    expect(result.installed).toBe(true);
    expect(result.destination).toContain('skills');
    expect(existsSync(result.destination)).toBe(true);

    // Check .processed backup
    expect(existsSync(join(TEST_DIR, 'intake', '.processed', 'my-skill.md'))).toBe(true);
  });

  it('should not install an invalid capability', () => {
    const filePath = writeTestFile('bad.md', `---
{}
---
short
`);
    const result = installCapability(TEST_DIR, filePath);
    expect(result.installed).toBe(false);
  });
});

// --- processIntake tests ---
describe('processIntake', () => {
  it('should process all files in intake directory', () => {
    writeFileSync(join(TEST_DIR, 'CORE.md'), '# Core', 'utf-8');

    writeIntakeFile('rule1.md', `---
id: rule1
tags: [rule]
status: active
---
<!-- L0: First rule -->
# Rule: Rule One

This is the first rule for testing the intake processing pipeline.
`);
    writeIntakeFile('rule2.md', `---
id: rule2
tags: [rule]
status: active
---
<!-- L0: Second rule -->
# Rule: Rule Two

This is the second rule for testing the intake processing pipeline.
`);

    const results = processIntake(TEST_DIR);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.result.installed)).toBe(true);

    // Intake files should be removed after successful install
    expect(existsSync(join(INTAKE_DIR, 'rule1.md'))).toBe(false);
    expect(existsSync(join(INTAKE_DIR, 'rule2.md'))).toBe(false);
  });

  it('should return empty array when no intake directory', () => {
    const results = processIntake(TEST_DIR);
    expect(results).toHaveLength(0);
  });

  it('should skip non-markdown and hidden files', () => {
    writeFileSync(join(TEST_DIR, 'CORE.md'), '# Core', 'utf-8');
    mkdirSync(INTAKE_DIR, { recursive: true });

    writeIntakeFile('.hidden.md', `---
id: hidden
tags: [rule]
---
# Rule: Hidden

This should be skipped because it starts with a dot character.
`);
    writeFileSync(join(INTAKE_DIR, 'readme.txt'), 'not a markdown file', 'utf-8');

    const results = processIntake(TEST_DIR);
    expect(results).toHaveLength(0);
  });
});
