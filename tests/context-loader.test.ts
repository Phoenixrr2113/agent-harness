import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildSystemPrompt } from '../src/runtime/context-loader.js';
import type { HarnessConfig } from '../src/core/types.js';

describe('context assembly', () => {
  let testDir: string;
  let mockConfig: HarnessConfig;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'context-test-'));

    mockConfig = {
      agent: {
        name: 'test-agent',
        version: '0.1.0',
      },
      model: {
        provider: 'openrouter',
        id: 'anthropic/claude-sonnet-4',
        max_tokens: 10000, // Small budget for testing
      },
      runtime: {
        scratchpad_budget: 1000,
        timezone: 'America/New_York',
      },
      memory: {
        session_retention_days: 7,
        journal_retention_days: 365,
      },
      channels: {
        primary: 'cli',
      },
    };
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should load CORE.md first and always in full', () => {
    writeFileSync(
      join(testDir, 'CORE.md'),
      `# My Agent

I am an autonomous agent focused on testing.

## Values
- Testing first
- Quality over speed
`
    );

    const { systemPrompt, budget } = buildSystemPrompt(testDir, mockConfig);

    expect(systemPrompt).toContain('# CORE IDENTITY');
    expect(systemPrompt).toContain('# My Agent');
    expect(systemPrompt).toContain('autonomous agent focused on testing');
    expect(budget.loaded_files).toContain('CORE.md');
    expect(budget.used_tokens).toBeGreaterThan(0);
  });

  it('should load state.md', () => {
    writeFileSync(
      join(testDir, 'CORE.md'),
      '# Test Agent\n\nCore identity.'
    );

    writeFileSync(
      join(testDir, 'state.md'),
      `# Agent State

## Mode
working

## Goals
- Complete testing suite
`
    );

    const { systemPrompt, budget } = buildSystemPrompt(testDir, mockConfig);

    expect(systemPrompt).toContain('# CURRENT STATE');
    expect(systemPrompt).toContain('## Mode');
    expect(systemPrompt).toContain('working');
    expect(budget.loaded_files).toContain('state.md');
  });

  it('should load SYSTEM.md', () => {
    writeFileSync(
      join(testDir, 'CORE.md'),
      '# Test Agent'
    );

    writeFileSync(
      join(testDir, 'SYSTEM.md'),
      `# System Instructions

Boot sequence and operational guidelines.
`
    );

    const { systemPrompt, budget } = buildSystemPrompt(testDir, mockConfig);

    expect(systemPrompt).toContain('# SYSTEM');
    expect(systemPrompt).toContain('Boot sequence and operational guidelines');
    expect(budget.loaded_files).toContain('SYSTEM.md');
  });

  it('should load primitives in priority order', () => {
    writeFileSync(join(testDir, 'CORE.md'), '# Test Agent');

    // Create primitive directories
    for (const dir of ['rules', 'instincts', 'skills']) {
      mkdirSync(join(testDir, dir));
    }

    writeFileSync(
      join(testDir, 'rules', 'rule1.md'),
      `---
id: rule1
status: active
---

<!-- L0: Rule one summary. -->

# Rule 1

Full rule content.
`
    );

    writeFileSync(
      join(testDir, 'instincts', 'instinct1.md'),
      `---
id: instinct1
status: active
---

<!-- L0: Instinct one summary. -->

# Instinct 1

Full instinct content.
`
    );

    const { systemPrompt, budget } = buildSystemPrompt(testDir, mockConfig);

    expect(systemPrompt).toContain('# RULES');
    expect(systemPrompt).toContain('### rule1');
    expect(systemPrompt).toContain('# INSTINCTS');
    expect(systemPrompt).toContain('### instinct1');
  });

  it('should respect token budget and use progressive disclosure', () => {
    writeFileSync(join(testDir, 'CORE.md'), '# Test Agent\n\nCore identity.');

    const rulesDir = join(testDir, 'rules');
    mkdirSync(rulesDir);

    // Create many large primitives with large L1 summaries to exceed budget
    // targetBudget = 10000 * 0.15 = 1500 tokens. CORE uses ~8 tokens.
    // 20 rules with L1 ~100 tokens each = ~2000 tokens (exceeds remaining ~1492)
    for (let i = 1; i <= 20; i++) {
      const largeBody = 'x'.repeat(5000); // ~1250 tokens each at L2
      const largeL1 = `Medium summary ${i}: ${'detailed context about this important rule and its implications '.repeat(8)}`; // ~120 tokens at L1
      writeFileSync(
        join(rulesDir, `rule${i}.md`),
        `---
id: rule${i}
status: active
---

<!-- L0: Short summary ${i}. -->
<!-- L1: ${largeL1} -->

# Rule ${i}

${largeBody}
`
      );
    }

    const { systemPrompt, budget } = buildSystemPrompt(testDir, mockConfig);

    // Should load files but use progressive disclosure to stay within budget
    const targetBudget = mockConfig.model.max_tokens * 0.15; // 15% of 10000 = 1500
    expect(budget.used_tokens).toBeLessThan(targetBudget * 1.5); // Allow overage for edge cases

    // Should have loaded some files
    expect(budget.loaded_files.length).toBeGreaterThan(0);

    // When budget is constrained (L2 and L1 both too large), should use L0 summaries
    const l0Count = (systemPrompt.match(/Short summary/g) || []).length;
    expect(l0Count).toBeGreaterThan(0);
  });

  it('should load scratch.md if it has content', () => {
    writeFileSync(join(testDir, 'CORE.md'), '# Test Agent');

    mkdirSync(join(testDir, 'memory'), { recursive: true });
    writeFileSync(
      join(testDir, 'memory', 'scratch.md'),
      'Current working memory: investigating bug #123'
    );

    const { systemPrompt, budget } = buildSystemPrompt(testDir, mockConfig);

    expect(systemPrompt).toContain('# SCRATCH (Current Working Memory)');
    expect(systemPrompt).toContain('investigating bug #123');
    expect(budget.loaded_files).toContain('memory/scratch.md');
  });

  it('should skip empty scratch.md', () => {
    writeFileSync(join(testDir, 'CORE.md'), '# Test Agent');

    mkdirSync(join(testDir, 'memory'), { recursive: true });
    writeFileSync(join(testDir, 'memory', 'scratch.md'), '');

    const { systemPrompt, budget } = buildSystemPrompt(testDir, mockConfig);

    expect(systemPrompt).not.toContain('# SCRATCH');
    expect(budget.loaded_files).not.toContain('memory/scratch.md');
  });

  it('should calculate remaining tokens correctly', () => {
    writeFileSync(join(testDir, 'CORE.md'), '# Test Agent\n\nCore identity.');

    const { budget } = buildSystemPrompt(testDir, mockConfig);

    expect(budget.max_tokens).toBe(mockConfig.model.max_tokens);
    expect(budget.used_tokens).toBeGreaterThan(0);
    expect(budget.remaining).toBe(budget.max_tokens - budget.used_tokens);
  });

  it('should handle missing core files gracefully', () => {
    // No files created - all missing
    const { systemPrompt, budget } = buildSystemPrompt(testDir, mockConfig);

    // Should not crash
    expect(budget.max_tokens).toBe(mockConfig.model.max_tokens);
    expect(budget.used_tokens).toBeGreaterThanOrEqual(0);
    expect(budget.remaining).toBeLessThanOrEqual(mockConfig.model.max_tokens);
  });

  it('should separate sections with markdown dividers', () => {
    writeFileSync(join(testDir, 'CORE.md'), '# Test Agent');
    writeFileSync(join(testDir, 'SYSTEM.md'), '# System');
    writeFileSync(join(testDir, 'state.md'), '# State\n\n## Mode\nidle');

    const { systemPrompt } = buildSystemPrompt(testDir, mockConfig);

    // Should use --- as section separator
    const separators = (systemPrompt.match(/\n---\n/g) || []).length;
    expect(separators).toBeGreaterThan(0);
  });

  it('should track all loaded files in budget', () => {
    writeFileSync(join(testDir, 'CORE.md'), '# Test Agent');
    writeFileSync(join(testDir, 'SYSTEM.md'), '# System');
    writeFileSync(join(testDir, 'state.md'), '# State\n\n## Mode\nidle');

    const rulesDir = join(testDir, 'rules');
    mkdirSync(rulesDir);
    writeFileSync(
      join(rulesDir, 'rule1.md'),
      `---
id: rule1
status: active
---
Rule content`
    );

    const { budget } = buildSystemPrompt(testDir, mockConfig);

    expect(budget.loaded_files).toContain('CORE.md');
    expect(budget.loaded_files).toContain('SYSTEM.md');
    expect(budget.loaded_files).toContain('state.md');
    expect(budget.loaded_files.some(f => f.includes('rule1.md'))).toBe(true);
  });

  it('should use level 2 (full content) when plenty of budget remains', () => {
    // Use larger budget for this test
    mockConfig.model.max_tokens = 100000;

    writeFileSync(join(testDir, 'CORE.md'), '# Test Agent');

    const rulesDir = join(testDir, 'rules');
    mkdirSync(rulesDir);

    writeFileSync(
      join(rulesDir, 'rule1.md'),
      `---
id: rule1
status: active
---

<!-- L0: Short summary. -->
<!-- L1: Medium summary with details. -->

# Full Rule

This is the complete body content with all details and examples.
Multiple paragraphs of important information.
`
    );

    const { systemPrompt } = buildSystemPrompt(testDir, mockConfig);

    // With plenty of budget, should include full body
    expect(systemPrompt).toContain('# Full Rule');
    expect(systemPrompt).toContain('complete body content');
    expect(systemPrompt).toContain('Multiple paragraphs');
  });

  it('should fallback to lower levels when approaching budget limit', () => {
    // Very tight budget
    mockConfig.model.max_tokens = 2000;

    writeFileSync(join(testDir, 'CORE.md'), '# Test Agent\n\n' + 'x'.repeat(1000));

    const rulesDir = join(testDir, 'rules');
    mkdirSync(rulesDir);

    for (let i = 1; i <= 5; i++) {
      writeFileSync(
        join(rulesDir, `rule${i}.md`),
        `---
id: rule${i}
status: active
---

<!-- L0: Summary ${i}. -->
<!-- L1: Medium summary ${i} with more context about this rule. -->

# Rule ${i}

${'x'.repeat(2000)}
`
      );
    }

    const { systemPrompt, budget } = buildSystemPrompt(testDir, mockConfig);

    const targetBudget = mockConfig.model.max_tokens * 0.15;

    // Should still load files but at reduced levels
    expect(budget.used_tokens).toBeLessThan(targetBudget * 1.5);
    expect(budget.loaded_files.length).toBeGreaterThan(0);

    // Should see L0 summaries rather than full bodies
    expect(systemPrompt).toContain('Summary');
  });
});
