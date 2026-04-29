import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildSystemPrompt, loadIdentity } from '../src/runtime/context-loader.js';
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

  it('should load IDENTITY.md first and always in full', () => {
    writeFileSync(
      join(testDir, 'IDENTITY.md'),
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
    expect(budget.loaded_files).toContain('IDENTITY.md');
    expect(budget.used_tokens).toBeGreaterThan(0);
  });

  it('should load state.md', () => {
    writeFileSync(
      join(testDir, 'IDENTITY.md'),
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

  it('should not load SYSTEM.md even when present', () => {
    writeFileSync(
      join(testDir, 'IDENTITY.md'),
      '# Test Agent'
    );

    writeFileSync(
      join(testDir, 'SYSTEM.md'),
      `# System Instructions

Boot sequence and operational guidelines.
`
    );

    const { systemPrompt, budget } = buildSystemPrompt(testDir, mockConfig);

    expect(systemPrompt).not.toContain('Boot sequence and operational guidelines');
    expect(budget.loaded_files).not.toContain('SYSTEM.md');
  });

  it('should load primitives in priority order', () => {
    writeFileSync(join(testDir, 'IDENTITY.md'), '# Test Agent');

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
    writeFileSync(join(testDir, 'IDENTITY.md'), '# Test Agent\n\nCore identity.');

    const rulesDir = join(testDir, 'rules');
    mkdirSync(rulesDir);

    // Create many large primitives with large L1 summaries to exceed budget
    // targetBudget = 10000 * 0.15 = 1500 tokens. CORE uses ~8 tokens.
    // 20 rules with L1 ~100 tokens each = ~2000 tokens (exceeds remaining ~1492)
    for (let i = 1; i <= 20; i++) {
      const largeBody = 'x'.repeat(5000); // ~1250 tokens each at L2
      writeFileSync(
        join(rulesDir, `rule${i}.md`),
        `---
id: rule${i}
status: active
description: "Short summary ${i}."
---

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
    writeFileSync(join(testDir, 'IDENTITY.md'), '# Test Agent');

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
    writeFileSync(join(testDir, 'IDENTITY.md'), '# Test Agent');

    mkdirSync(join(testDir, 'memory'), { recursive: true });
    writeFileSync(join(testDir, 'memory', 'scratch.md'), '');

    const { systemPrompt, budget } = buildSystemPrompt(testDir, mockConfig);

    expect(systemPrompt).not.toContain('# SCRATCH');
    expect(budget.loaded_files).not.toContain('memory/scratch.md');
  });

  it('should calculate remaining tokens correctly', () => {
    writeFileSync(join(testDir, 'IDENTITY.md'), '# Test Agent\n\nCore identity.');

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
    writeFileSync(join(testDir, 'IDENTITY.md'), '# Test Agent');
    writeFileSync(join(testDir, 'state.md'), '# State\n\n## Mode\nidle');

    const { systemPrompt } = buildSystemPrompt(testDir, mockConfig);

    // Should use --- as section separator
    const separators = (systemPrompt.match(/\n---\n/g) || []).length;
    expect(separators).toBeGreaterThan(0);
  });

  it('should track all loaded files in budget', () => {
    writeFileSync(join(testDir, 'IDENTITY.md'), '# Test Agent');
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

    expect(budget.loaded_files).toContain('IDENTITY.md');
    expect(budget.loaded_files).not.toContain('SYSTEM.md');
    expect(budget.loaded_files).toContain('state.md');
    expect(budget.loaded_files.some(f => f.includes('rule1.md'))).toBe(true);
  });

  it('should use level 2 (full content) when plenty of budget remains', () => {
    // Use larger budget for this test
    mockConfig.model.max_tokens = 100000;

    writeFileSync(join(testDir, 'IDENTITY.md'), '# Test Agent');

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

    writeFileSync(join(testDir, 'IDENTITY.md'), '# Test Agent\n\n' + 'x'.repeat(1000));

    const rulesDir = join(testDir, 'rules');
    mkdirSync(rulesDir);

    for (let i = 1; i <= 5; i++) {
      writeFileSync(
        join(rulesDir, `rule${i}.md`),
        `---
id: rule${i}
status: active
description: "Summary ${i}."
---

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

  it('should return empty parseErrors for valid harness', () => {
    writeFileSync(join(testDir, 'IDENTITY.md'), '# Test Agent');

    const result = buildSystemPrompt(testDir, mockConfig);

    expect(result.parseErrors).toEqual([]);
    // Warns about zero primitives since test has no rules/instincts/skills
    expect(result.warnings).toEqual([
      'No primitives found — add rules, instincts, or skills to improve agent behavior',
    ]);
  });

  it('should warn when primitives loaded at reduced level', () => {
    // Very tight budget forces L0 loading
    mockConfig.model.max_tokens = 2000;

    writeFileSync(join(testDir, 'IDENTITY.md'), '# Test Agent\n\n' + 'x'.repeat(1000));

    const rulesDir = join(testDir, 'rules');
    mkdirSync(rulesDir);

    for (let i = 1; i <= 5; i++) {
      writeFileSync(
        join(rulesDir, `rule${i}.md`),
        `---
id: rule${i}
status: active
description: "Summary ${i} with more context about this rule that goes on for a while to consume tokens."
---

# Rule ${i}

${'x'.repeat(2000)}
`,
      );
    }

    const result = buildSystemPrompt(testDir, mockConfig);

    // Should have a disclosure level warning
    expect(result.warnings.some((w) => w.includes('budget constraints'))).toBe(true);
  });

  it('should warn when context budget usage is high', () => {
    // Budget where IDENTITY.md alone takes >12% of max_tokens
    mockConfig.model.max_tokens = 200; // Very small
    writeFileSync(join(testDir, 'IDENTITY.md'), 'x'.repeat(200)); // ~50 tokens = 25% of 200

    const result = buildSystemPrompt(testDir, mockConfig);

    // 25% > 12% threshold
    expect(result.warnings.some((w) => w.includes('System prompt using'))).toBe(true);
  });
});

describe('loadIdentity', () => {
  it('loads IDENTITY.md when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-test-'));
    writeFileSync(join(dir, 'IDENTITY.md'), '# Test Agent\n\nIdentity content.', 'utf-8');

    const result = loadIdentity(dir);
    expect(result.content).toContain('Identity content.');
    expect(result.source).toBe('IDENTITY.md');

    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to CORE.md with deprecation warning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-test-'));
    writeFileSync(join(dir, 'CORE.md'), '# Old Agent\n\nLegacy content.', 'utf-8');

    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = loadIdentity(dir);

    expect(result.content).toContain('Legacy content.');
    expect(result.source).toBe('CORE.md');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/CORE\.md is deprecated/));

    warnSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('prefers IDENTITY.md when both exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-test-'));
    writeFileSync(join(dir, 'IDENTITY.md'), '# New', 'utf-8');
    writeFileSync(join(dir, 'CORE.md'), '# Old', 'utf-8');

    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = loadIdentity(dir);

    expect(result.content).toBe('# New');
    expect(result.source).toBe('IDENTITY.md');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/CORE\.md.* is being ignored/));

    warnSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty when neither exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-test-'));

    const result = loadIdentity(dir);
    expect(result.content).toBe('');
    expect(result.source).toBe('none');

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('buildSystemPrompt — uses loadIdentity', () => {
  let testDir: string;
  let mockConfig: HarnessConfig;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'sysprompt-test-'));
    mockConfig = {
      agent: { name: 'test-agent', version: '0.1.0' },
      model: { provider: 'openrouter', id: 'anthropic/claude-sonnet-4', max_tokens: 10000 },
      runtime: { scratchpad_budget: 1000, timezone: 'America/New_York' },
      memory: { session_retention_days: 7, journal_retention_days: 365 },
      channels: { primary: 'cli' },
    };
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('reads IDENTITY.md as the identity section', () => {
    writeFileSync(join(testDir, 'IDENTITY.md'), '# I am Edith.', 'utf-8');

    const result = buildSystemPrompt(testDir, mockConfig);
    expect(result.systemPrompt).toContain('# I am Edith.');
    expect(result.budget.loaded_files).toContain('IDENTITY.md');
  });

  it('falls back to CORE.md when IDENTITY.md is absent', () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(join(testDir, 'CORE.md'), '# I am a legacy agent.', 'utf-8');

    const result = buildSystemPrompt(testDir, mockConfig);
    expect(result.systemPrompt).toContain('# I am a legacy agent.');
    expect(result.budget.loaded_files).toContain('CORE.md');

    warnSpy.mockRestore();
  });
});

describe('buildSystemPrompt — does not read SYSTEM.md', () => {
  let testDir: string;
  let mockConfig: HarnessConfig;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'sysprompt-test-'));
    mockConfig = {
      agent: { name: 'test-agent', version: '0.1.0' },
      model: { provider: 'openrouter', id: 'anthropic/claude-sonnet-4', max_tokens: 10000 },
      runtime: { scratchpad_budget: 1000, timezone: 'America/New_York' },
      memory: { session_retention_days: 7, journal_retention_days: 365 },
      channels: { primary: 'cli' },
    };
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('ignores SYSTEM.md content if present', () => {
    writeFileSync(join(testDir, 'IDENTITY.md'), '# Identity content.', 'utf-8');
    writeFileSync(join(testDir, 'SYSTEM.md'), '# Old infrastructure docs.', 'utf-8');

    const result = buildSystemPrompt(testDir, mockConfig);
    expect(result.systemPrompt).toContain('# Identity content.');
    expect(result.systemPrompt).not.toContain('# Old infrastructure docs.');
  });
});
