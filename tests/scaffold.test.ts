import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scaffoldHarness, listTemplates, generateCoreMd, generateSystemMd } from '../src/cli/scaffold.js';

describe('harness init (scaffolding)', () => {
  let testDir: string;
  let agentDir: string;

  beforeEach(() => {
    // Create a unique temp directory for each test
    testDir = mkdtempSync(join(tmpdir(), 'harness-test-'));
    agentDir = join(testDir, 'test-agent');
  });

  afterEach(() => {
    // Clean up
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should create all required directories', () => {
    scaffoldHarness(agentDir, 'test-agent');

    const expectedDirs = [
      'rules',
      'skills',
      'intake',
      'memory',
      'memory/sessions',
      'memory/journal',
    ];

    for (const dir of expectedDirs) {
      const dirPath = join(agentDir, dir);
      expect(existsSync(dirPath), `Directory ${dir} should exist`).toBe(true);
    }

    // Legacy primitive directories from pre-spec-#2 collapse must NOT be created
    const legacyDirs = ['instincts', 'playbooks', 'workflows', 'tools', 'agents'];
    for (const dir of legacyDirs) {
      expect(
        existsSync(join(agentDir, dir)),
        `Legacy directory ${dir}/ should NOT be created (collapsed in spec #2)`,
      ).toBe(false);
    }
  });

  it('should create all core files', () => {
    scaffoldHarness(agentDir, 'test-agent');

    const expectedFiles = [
      'IDENTITY.md',
      'config.yaml',
      'memory/state.md',
      '.gitignore',
      'memory/scratch.md',
    ];

    for (const file of expectedFiles) {
      const filePath = join(agentDir, file);
      expect(existsSync(filePath), `File ${file} should exist`).toBe(true);
    }

    // These files must NOT be created
    expect(existsSync(join(agentDir, 'CORE.md')), 'CORE.md must not be created').toBe(false);
    expect(existsSync(join(agentDir, 'SYSTEM.md')), 'SYSTEM.md must not be created').toBe(false);
    expect(existsSync(join(agentDir, 'state.md')), 'top-level state.md must not be created').toBe(false);
  });

  it('should create default primitives', () => {
    scaffoldHarness(agentDir, 'test-agent');

    const expectedPrimitives = [
      'rules/operations.md',
      'rules/lead-with-answer.md',
      'rules/read-before-edit.md',
      'rules/search-before-create.md',
      'skills/research/SKILL.md',
      'skills/ship-feature/SKILL.md',
    ];

    for (const file of expectedPrimitives) {
      const filePath = join(agentDir, file);
      expect(existsSync(filePath), `Primitive ${file} should exist`).toBe(true);
    }
  });

  it('should create .gitkeep files in memory directories', () => {
    scaffoldHarness(agentDir, 'test-agent');

    expect(existsSync(join(agentDir, 'memory/sessions/.gitkeep'))).toBe(true);
    expect(existsSync(join(agentDir, 'memory/journal/.gitkeep'))).toBe(true);
  });

  it('should include agent name in IDENTITY.md', () => {
    scaffoldHarness(agentDir, 'test-agent');

    const identityContent = readFileSync(join(agentDir, 'IDENTITY.md'), 'utf-8');
    expect(identityContent).toContain('test-agent');
    expect(identityContent).toContain('Purpose');
    expect(identityContent).toContain('Values');
    expect(identityContent).toContain('Ethics');
  });

  it('should create memory/state.md with correct structure', () => {
    scaffoldHarness(agentDir, 'test-agent');

    const stateContent = readFileSync(join(agentDir, 'memory/state.md'), 'utf-8');
    expect(stateContent).toContain('## Mode');
    expect(stateContent).toContain('## Goals');
    expect(stateContent).toContain('## Active Workflows');
    expect(stateContent).toContain('## Last Interaction');
    expect(stateContent).toContain('## Unfinished Business');
    expect(stateContent).toContain('idle');
  });

  it('should create valid YAML frontmatter in all primitives', () => {
    scaffoldHarness(agentDir, 'test-agent');

    const flatPrimitives = [
      'rules/operations.md',
      'rules/lead-with-answer.md',
      'rules/read-before-edit.md',
      'rules/search-before-create.md',
    ];

    for (const file of flatPrimitives) {
      const content = readFileSync(join(agentDir, file), 'utf-8');

      // Should start with frontmatter
      expect(content.startsWith('---\n'), `${file} should have frontmatter`).toBe(true);

      // Should have required fields
      expect(content).toContain('id:');
      expect(content).toContain('tags:');
      expect(content).toContain('author:');
      expect(content).toContain('status:');
    }

    // Skills use bundle format with metadata.harness-* fields
    const skillContent = readFileSync(join(agentDir, 'skills/research/SKILL.md'), 'utf-8');
    expect(skillContent.startsWith('---\n'), 'skills/research/SKILL.md should have frontmatter').toBe(true);
    expect(skillContent).toContain('harness-tags:');
    expect(skillContent).toContain('harness-status:');
    expect(skillContent).toContain('harness-author:');

    // ship-feature is now a skill bundle
    const shipFeatureContent = readFileSync(join(agentDir, 'skills/ship-feature/SKILL.md'), 'utf-8');
    expect(shipFeatureContent.startsWith('---\n'), 'skills/ship-feature/SKILL.md should have frontmatter').toBe(true);
    expect(shipFeatureContent).toContain('harness-tags:');
  });

  it('should create .gitignore that excludes ephemeral files', () => {
    scaffoldHarness(agentDir, 'test-agent');

    const gitignoreContent = readFileSync(join(agentDir, '.gitignore'), 'utf-8');
    expect(gitignoreContent).toContain('memory/scratch.md');
    expect(gitignoreContent).toContain('memory/sessions/*');
    expect(gitignoreContent).toContain('memory/journal/*');
    expect(gitignoreContent).toContain('.workflow-data/');
    expect(gitignoreContent).toContain('.env');
    // Should preserve .gitkeep files
    expect(gitignoreContent).toContain('!memory/sessions/.gitkeep');
    expect(gitignoreContent).toContain('!memory/journal/.gitkeep');
  });

  it('should throw error if target already contains a harness', () => {
    scaffoldHarness(agentDir, 'test-agent');

    expect(() => {
      scaffoldHarness(agentDir, 'test-agent');
    }).toThrow(/already contains a harness/);
  });

  it('D2: should scaffold into an empty existing directory without erroring', () => {
    // mkdir foo && cd foo && harness init . — common real-world pattern
    mkdirSync(agentDir, { recursive: true });
    expect(() => scaffoldHarness(agentDir, 'test-agent')).not.toThrow();
    expect(existsSync(join(agentDir, 'IDENTITY.md'))).toBe(true);
  });

  it('D2: should scaffold into an existing dir with non-harness files (preserves them)', () => {
    mkdirSync(agentDir, { recursive: true });
    // Use files the scaffold itself does NOT write (it writes README.md, .gitignore, etc.)
    writeFileSync(join(agentDir, 'src.ts'), 'console.log(1);');
    writeFileSync(join(agentDir, 'tsconfig.json'), '{}');
    expect(() => scaffoldHarness(agentDir, 'test-agent')).not.toThrow();
    // Pre-existing files outside the scaffold's footprint are preserved
    expect(readFileSync(join(agentDir, 'src.ts'), 'utf-8')).toBe('console.log(1);');
    expect(existsSync(join(agentDir, 'tsconfig.json'))).toBe(true);
    // Harness scaffolded alongside
    expect(existsSync(join(agentDir, 'IDENTITY.md'))).toBe(true);
  });

  it('should set correct author for different primitive types', () => {
    scaffoldHarness(agentDir, 'test-agent');

    // Rules should be human-authored
    const ruleContent = readFileSync(join(agentDir, 'rules/operations.md'), 'utf-8');
    expect(ruleContent).toContain('author: human');

    // Former instincts (now in rules/) are agent-authored
    const formerInstinctContent = readFileSync(join(agentDir, 'rules/lead-with-answer.md'), 'utf-8');
    expect(formerInstinctContent).toContain('author: agent');

    // Skills use bundle format — author is in metadata.harness-author
    const skillContent = readFileSync(join(agentDir, 'skills/research/SKILL.md'), 'utf-8');
    expect(skillContent).toContain('harness-author: human');

    // Former playbooks (now in skills/) have author in metadata.harness-author
    const shipFeatureContent = readFileSync(join(agentDir, 'skills/ship-feature/SKILL.md'), 'utf-8');
    expect(shipFeatureContent).toContain('harness-author: human');
  });

  it('should create empty scratch.md', () => {
    scaffoldHarness(agentDir, 'test-agent');

    const scratchContent = readFileSync(join(agentDir, 'memory/scratch.md'), 'utf-8');
    expect(scratchContent).toBe('');
  });

  it('should create config.yaml with agent name', () => {
    scaffoldHarness(agentDir, 'test-agent');

    const configContent = readFileSync(join(agentDir, 'config.yaml'), 'utf-8');
    expect(configContent).toContain('name: test-agent');
    expect(configContent).toContain('model:');
    expect(configContent).toContain('runtime:');
    expect(configContent).toContain('memory:');
  });

  describe('templates', () => {
    it('should list available templates', () => {
      const templates = listTemplates();
      expect(templates).toContain('base');
      expect(templates).toContain('assistant');
      expect(templates).toContain('code-reviewer');
    });

    it('should scaffold with assistant template', () => {
      scaffoldHarness(agentDir, 'my-assistant', { template: 'assistant' });

      const identity = readFileSync(join(agentDir, 'IDENTITY.md'), 'utf-8');
      expect(identity).toContain('my-assistant');
      expect(identity).toContain('personal assistant');
      expect(identity).toContain('Reliability');

      expect(existsSync(join(agentDir, 'SYSTEM.md'))).toBe(false);

      const config = readFileSync(join(agentDir, 'config.yaml'), 'utf-8');
      expect(config).toContain('name: my-assistant');
      expect(config).toContain('session_retention_days: 14');
    });

    it('should scaffold with code-reviewer template', () => {
      scaffoldHarness(agentDir, 'my-reviewer', { template: 'code-reviewer' });

      const identity = readFileSync(join(agentDir, 'IDENTITY.md'), 'utf-8');
      expect(identity).toContain('my-reviewer');
      expect(identity).toContain('code review');
      expect(identity).toContain('Security-first');

      expect(existsSync(join(agentDir, 'SYSTEM.md'))).toBe(false);

      const config = readFileSync(join(agentDir, 'config.yaml'), 'utf-8');
      expect(config).toContain('name: my-reviewer');
      expect(config).toContain('scratchpad_budget: 15000');
    });

    it('should use custom purpose in IDENTITY.md', () => {
      scaffoldHarness(agentDir, 'my-bot', { purpose: 'I help developers write better tests.' });

      const identity = readFileSync(join(agentDir, 'IDENTITY.md'), 'utf-8');
      expect(identity).toContain('my-bot');
      expect(identity).toContain('I help developers write better tests.');
    });

    it('should use custom coreContent when provided', () => {
      const customCore = '# Custom Agent\n\nThis is a fully custom IDENTITY.md.';
      scaffoldHarness(agentDir, 'custom-agent', { coreContent: customCore });

      const identity = readFileSync(join(agentDir, 'IDENTITY.md'), 'utf-8');
      expect(identity).toBe(customCore);
      // Should NOT contain the template boilerplate
      expect(identity).not.toContain('Values');
      expect(identity).not.toContain('Ethics');
    });

    it('should prefer coreContent over purpose', () => {
      const customCore = '# Override\n\nCustom content wins.';
      scaffoldHarness(agentDir, 'priority-test', {
        purpose: 'This should be ignored',
        coreContent: customCore,
      });

      const identity = readFileSync(join(agentDir, 'IDENTITY.md'), 'utf-8');
      expect(identity).toBe(customCore);
      expect(identity).not.toContain('This should be ignored');
    });

    it('should fall back to base template for unknown template name', () => {
      scaffoldHarness(agentDir, 'test-agent', { template: 'nonexistent' });

      // Should still create files using inline fallbacks
      expect(existsSync(join(agentDir, 'IDENTITY.md'))).toBe(true);
      expect(existsSync(join(agentDir, 'SYSTEM.md'))).toBe(false);
      expect(existsSync(join(agentDir, 'config.yaml'))).toBe(true);
    });

    it('should substitute {{AGENT_NAME}} in all template files', () => {
      scaffoldHarness(agentDir, 'agent-x', { template: 'assistant' });

      const identity = readFileSync(join(agentDir, 'IDENTITY.md'), 'utf-8');
      const config = readFileSync(join(agentDir, 'config.yaml'), 'utf-8');

      // Should contain the substituted name, not the placeholder
      expect(identity).not.toContain('{{AGENT_NAME}}');
      expect(config).not.toContain('{{AGENT_NAME}}');

      expect(identity).toContain('agent-x');
      expect(config).toContain('name: agent-x');
    });
  });

  describe('generateSystemMd', () => {
    it('should generate system content from directory structure', () => {
      scaffoldHarness(agentDir, 'sys-agent');

      const systemMd = generateSystemMd(agentDir, 'sys-agent');

      expect(systemMd).toContain('# System');
      expect(systemMd).toContain('sys-agent');
      expect(systemMd).toContain('## Boot Sequence');
      expect(systemMd).toContain('## Directory Structure');
      expect(systemMd).toContain('## File Ownership');
      expect(systemMd).toContain('## Context Loading Strategy');

      // Boot sequence references IDENTITY.md and memory/state.md
      expect(systemMd).toContain('IDENTITY.md');
      expect(systemMd).toContain('memory/state.md');

      // Should list actual primitive directories (post spec-#2 collapse: rules + skills only)
      expect(systemMd).toContain('`rules/`');
      expect(systemMd).toContain('`skills/`');
      // Legacy primitive sections must NOT appear
      expect(systemMd).not.toContain('`instincts/`');
      expect(systemMd).not.toContain('`playbooks/`');

      // Should show actual primitive names (from defaults)
      expect(systemMd).toContain('operations');
      expect(systemMd).toContain('lead-with-answer');
      expect(systemMd).toContain('research');

      // Should show memory stats
      expect(systemMd).toContain('`memory/sessions/`');
      expect(systemMd).toContain('`memory/journal/`');
    });

    it('should handle empty directories', () => {
      scaffoldHarness(agentDir, 'empty-agent');

      // After the 2-primitive collapse, daily-reflection and example-web-search
      // are now skills, not workflows/tools. The skills/ section should list them.
      const systemMd = generateSystemMd(agentDir, 'empty-agent');
      expect(systemMd).toContain('`skills/`');
      expect(systemMd).toContain('daily-reflection');
      expect(systemMd).toContain('example-web-search');
    });
  });
});
