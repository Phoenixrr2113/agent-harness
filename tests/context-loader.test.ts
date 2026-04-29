import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildSystemPrompt, buildLoadedContext, loadIdentity } from '../src/runtime/context-loader.js';
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
        max_tokens: 10000,
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

    const systemPrompt = buildSystemPrompt(testDir, mockConfig);

    expect(systemPrompt).toContain('<identity>');
    expect(systemPrompt).toContain('# My Agent');
    expect(systemPrompt).toContain('autonomous agent focused on testing');
  });

  it('should load state from memory/state.md', () => {
    writeFileSync(
      join(testDir, 'IDENTITY.md'),
      '# Test Agent\n\nCore identity.'
    );

    mkdirSync(join(testDir, 'memory'), { recursive: true });
    writeFileSync(
      join(testDir, 'memory', 'state.md'),
      `# Agent State

## Mode
working

## Goals
- Complete testing suite
`
    );

    const systemPrompt = buildSystemPrompt(testDir, mockConfig);

    expect(systemPrompt).toContain('<state>');
    expect(systemPrompt).toContain('## Mode');
    expect(systemPrompt).toContain('working');
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

    const systemPrompt = buildSystemPrompt(testDir, mockConfig);

    expect(systemPrompt).not.toContain('Boot sequence and operational guidelines');
  });

  it('should load rules in <rules> block with full body, alphabetical', () => {
    writeFileSync(join(testDir, 'IDENTITY.md'), '# Test Agent');
    mkdirSync(join(testDir, 'rules'));

    writeFileSync(
      join(testDir, 'rules', 'beta-rule.md'),
      `---
name: beta-rule
description: Beta rule.
---

# Beta Rule

Beta full body.
`
    );

    writeFileSync(
      join(testDir, 'rules', 'alpha-rule.md'),
      `---
name: alpha-rule
description: Alpha rule.
---

# Alpha Rule

Alpha full body.
`
    );

    const systemPrompt = buildSystemPrompt(testDir, mockConfig);

    expect(systemPrompt).toContain('<rules>');
    expect(systemPrompt).toContain('## alpha-rule');
    expect(systemPrompt).toContain('## beta-rule');
    expect(systemPrompt).toContain('Alpha full body.');
    expect(systemPrompt).toContain('Beta full body.');
    // Alphabetical: alpha before beta
    expect(systemPrompt.indexOf('alpha-rule')).toBeLessThan(systemPrompt.indexOf('beta-rule'));
  });

  it('should handle missing core files gracefully', () => {
    // No files created - all missing
    const systemPrompt = buildSystemPrompt(testDir, mockConfig);

    // Should not crash and return empty string or minimal content
    expect(typeof systemPrompt).toBe('string');
  });

  it('should track loaded files in budget via buildLoadedContext', () => {
    writeFileSync(join(testDir, 'IDENTITY.md'), '# Test Agent');
    mkdirSync(join(testDir, 'memory'), { recursive: true });
    writeFileSync(join(testDir, 'memory', 'state.md'), '# Agent State\n\n## Mode\nidle');

    const rulesDir = join(testDir, 'rules');
    mkdirSync(rulesDir);
    writeFileSync(
      join(rulesDir, 'rule1.md'),
      `---
name: rule1
description: Rule one.
---
Rule content`
    );

    const { budget } = buildLoadedContext(testDir, mockConfig);

    expect(budget.loaded_files).toContain('IDENTITY.md');
    expect(budget.loaded_files).not.toContain('SYSTEM.md');
    expect(budget.loaded_files).toContain('memory/state.md');
    expect(budget.loaded_files.some(f => f.includes('rule1.md'))).toBe(true);
  });

  it('should calculate remaining tokens correctly via buildLoadedContext', () => {
    writeFileSync(join(testDir, 'IDENTITY.md'), '# Test Agent\n\nCore identity.');

    const { budget } = buildLoadedContext(testDir, mockConfig);

    expect(budget.max_tokens).toBe(mockConfig.model.max_tokens);
    expect(budget.used_tokens).toBeGreaterThan(0);
    expect(budget.remaining).toBe(budget.max_tokens - budget.used_tokens);
  });

  it('should return empty parseErrors for valid harness via buildLoadedContext', () => {
    writeFileSync(join(testDir, 'IDENTITY.md'), '# Test Agent');

    const result = buildLoadedContext(testDir, mockConfig);

    expect(result.parseErrors).toEqual([]);
  });

  it('should warn when context budget usage is high via buildLoadedContext', () => {
    // Budget where IDENTITY.md alone takes >12% of max_tokens
    mockConfig.model.max_tokens = 200; // Very small
    writeFileSync(join(testDir, 'IDENTITY.md'), 'x'.repeat(200)); // ~50 tokens = 25% of 200

    const result = buildLoadedContext(testDir, mockConfig);

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

    const systemPrompt = buildSystemPrompt(testDir, mockConfig);
    expect(systemPrompt).toContain('# I am Edith.');
    // buildLoadedContext tracks loaded_files
    const { budget } = buildLoadedContext(testDir, mockConfig);
    expect(budget.loaded_files).toContain('IDENTITY.md');
  });

  it('falls back to CORE.md when IDENTITY.md is absent', () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(join(testDir, 'CORE.md'), '# I am a legacy agent.', 'utf-8');

    const systemPrompt = buildSystemPrompt(testDir, mockConfig);
    expect(systemPrompt).toContain('# I am a legacy agent.');
    const { budget } = buildLoadedContext(testDir, mockConfig);
    expect(budget.loaded_files).toContain('CORE.md');

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

    const systemPrompt = buildSystemPrompt(testDir, mockConfig);
    expect(systemPrompt).toContain('# Identity content.');
    expect(systemPrompt).not.toContain('# Old infrastructure docs.');
  });
});

describe('system prompt — primitive collapse model', () => {
  it('always loads identity full body', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprompt-'));
    writeFileSync(join(dir, 'IDENTITY.md'), '# I am Edith.', 'utf-8');
    const result = buildSystemPrompt(dir, {} as HarnessConfig);
    expect(result).toContain('# I am Edith.');
    rmSync(dir, { recursive: true, force: true });
  });

  it('always loads every active rule full body', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprompt-'));
    mkdirSync(join(dir, 'rules'), { recursive: true });
    writeFileSync(
      join(dir, 'rules', 'never-x.md'),
      '---\nname: never-x\ndescription: Never do X.\n---\nNever do X.',
      'utf-8'
    );
    writeFileSync(
      join(dir, 'rules', 'always-y.md'),
      '---\nname: always-y\ndescription: Always do Y.\n---\nAlways do Y.',
      'utf-8'
    );
    const result = buildSystemPrompt(dir, {} as HarnessConfig);
    expect(result).toContain('Never do X.');
    expect(result).toContain('Always do Y.');
    rmSync(dir, { recursive: true, force: true });
  });

  it('includes skills as <available_skills> catalog with name + description', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprompt-'));
    mkdirSync(join(dir, 'skills', 'research'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'research', 'SKILL.md'),
      '---\nname: research\ndescription: Conducts research.\n---\nFull body — should NOT be in the catalog.',
      'utf-8'
    );
    const result = buildSystemPrompt(dir, {} as HarnessConfig);
    expect(result).toContain('<available_skills>');
    expect(result).toContain('<name>research</name>');
    expect(result).toContain('Conducts research.');
    expect(result).not.toContain('Full body — should NOT be in the catalog.');
    rmSync(dir, { recursive: true, force: true });
  });

  it('excludes lifecycle-triggered skills from the catalog', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprompt-'));
    mkdirSync(join(dir, 'skills', 'inject-state'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'inject-state', 'SKILL.md'),
      '---\nname: inject-state\ndescription: Injects state.\nmetadata:\n  harness-trigger: prepare-call\n---\nBody.',
      'utf-8'
    );
    const result = buildSystemPrompt(dir, {} as HarnessConfig);
    expect(result).not.toContain('<name>inject-state</name>');
    rmSync(dir, { recursive: true, force: true });
  });

  it('excludes scheduled skills from the catalog', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprompt-'));
    mkdirSync(join(dir, 'skills', 'morning-brief'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'morning-brief', 'SKILL.md'),
      '---\nname: morning-brief\ndescription: Morning brief.\nmetadata:\n  harness-schedule: "0 7 * * *"\n---\nBody.',
      'utf-8'
    );
    const result = buildSystemPrompt(dir, {} as HarnessConfig);
    expect(result).not.toContain('<name>morning-brief</name>');
    rmSync(dir, { recursive: true, force: true });
  });

  it('includes subagent-trigger skills in the catalog (model-invokable)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprompt-'));
    mkdirSync(join(dir, 'skills', 'summarizer'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'summarizer', 'SKILL.md'),
      '---\nname: summarizer\ndescription: Summarize text.\nmetadata:\n  harness-trigger: subagent\n---\nBody.',
      'utf-8'
    );
    const result = buildSystemPrompt(dir, {} as HarnessConfig);
    expect(result).toContain('<name>summarizer</name>');
    rmSync(dir, { recursive: true, force: true });
  });
});
