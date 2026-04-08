import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync } from 'fs';
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
      'instincts',
      'skills',
      'playbooks',
      'workflows',
      'tools',
      'agents',
      'memory',
      'memory/sessions',
      'memory/journal',
    ];

    for (const dir of expectedDirs) {
      const dirPath = join(agentDir, dir);
      expect(existsSync(dirPath), `Directory ${dir} should exist`).toBe(true);
    }
  });

  it('should create all core files', () => {
    scaffoldHarness(agentDir, 'test-agent');

    const expectedFiles = [
      'CORE.md',
      'SYSTEM.md',
      'config.yaml',
      'state.md',
      '.gitignore',
      'memory/scratch.md',
    ];

    for (const file of expectedFiles) {
      const filePath = join(agentDir, file);
      expect(existsSync(filePath), `File ${file} should exist`).toBe(true);
    }
  });

  it('should create default primitives', () => {
    scaffoldHarness(agentDir, 'test-agent');

    const expectedPrimitives = [
      'rules/operations.md',
      'instincts/lead-with-answer.md',
      'instincts/read-before-edit.md',
      'instincts/search-before-create.md',
      'skills/research.md',
      'playbooks/ship-feature.md',
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

  it('should include agent name in CORE.md', () => {
    scaffoldHarness(agentDir, 'test-agent');

    const coreContent = readFileSync(join(agentDir, 'CORE.md'), 'utf-8');
    expect(coreContent).toContain('test-agent');
    expect(coreContent).toContain('Purpose');
    expect(coreContent).toContain('Values');
    expect(coreContent).toContain('Ethics');
  });

  it('should include agent name in SYSTEM.md', () => {
    scaffoldHarness(agentDir, 'test-agent');

    const systemContent = readFileSync(join(agentDir, 'SYSTEM.md'), 'utf-8');
    expect(systemContent).toContain('test-agent');
    expect(systemContent).toContain('Boot Sequence');
    expect(systemContent).toContain('File Ownership');
    expect(systemContent).toContain('Context Loading Strategy');
  });

  it('should create state.md with correct structure', () => {
    scaffoldHarness(agentDir, 'test-agent');

    const stateContent = readFileSync(join(agentDir, 'state.md'), 'utf-8');
    expect(stateContent).toContain('## Mode');
    expect(stateContent).toContain('## Goals');
    expect(stateContent).toContain('## Active Workflows');
    expect(stateContent).toContain('## Last Interaction');
    expect(stateContent).toContain('## Unfinished Business');
    expect(stateContent).toContain('idle');
  });

  it('should create valid YAML frontmatter in all primitives', () => {
    scaffoldHarness(agentDir, 'test-agent');

    const primitives = [
      'rules/operations.md',
      'instincts/lead-with-answer.md',
      'instincts/read-before-edit.md',
      'instincts/search-before-create.md',
      'skills/research.md',
      'playbooks/ship-feature.md',
    ];

    for (const file of primitives) {
      const content = readFileSync(join(agentDir, file), 'utf-8');

      // Should start with frontmatter
      expect(content.startsWith('---\n'), `${file} should have frontmatter`).toBe(true);

      // Should have required fields
      expect(content).toContain('id:');
      expect(content).toContain('tags:');
      expect(content).toContain('created:');
      expect(content).toContain('author:');
      expect(content).toContain('status:');
    }
  });

  it('should include L0 and L1 summaries in primitives', () => {
    scaffoldHarness(agentDir, 'test-agent');

    const primitives = [
      'rules/operations.md',
      'instincts/lead-with-answer.md',
      'skills/research.md',
      'playbooks/ship-feature.md',
    ];

    for (const file of primitives) {
      const content = readFileSync(join(agentDir, file), 'utf-8');

      // Should have L0 and L1 summaries as HTML comments
      const l0Match = content.match(/<!-- L0: (.+?) -->/);
      const l1Match = content.match(/<!-- L1: (.+?) -->/s);

      expect(l0Match, `${file} should have L0 summary`).toBeTruthy();
      expect(l1Match, `${file} should have L1 summary`).toBeTruthy();

      if (l0Match && l1Match) {
        // L0 should be short (roughly one line)
        expect(l0Match[1].length).toBeLessThan(100);

        // L1 should be longer but not huge
        expect(l1Match[1].length).toBeGreaterThan(l0Match[1].length);
        expect(l1Match[1].length).toBeLessThan(600);
      }
    }
  });

  it('should create .gitignore that excludes ephemeral files', () => {
    scaffoldHarness(agentDir, 'test-agent');

    const gitignoreContent = readFileSync(join(agentDir, '.gitignore'), 'utf-8');
    expect(gitignoreContent).toContain('memory/scratch.md');
    expect(gitignoreContent).toContain('memory/sessions/*');
    expect(gitignoreContent).toContain('memory/journal/*');
    expect(gitignoreContent).toContain('.env');
    // Should preserve .gitkeep files
    expect(gitignoreContent).toContain('!memory/sessions/.gitkeep');
    expect(gitignoreContent).toContain('!memory/journal/.gitkeep');
  });

  it('should throw error if directory already exists', () => {
    scaffoldHarness(agentDir, 'test-agent');

    expect(() => {
      scaffoldHarness(agentDir, 'test-agent');
    }).toThrow('Directory already exists');
  });

  it('should set correct author for different primitive types', () => {
    scaffoldHarness(agentDir, 'test-agent');

    // Rules should be human-authored
    const ruleContent = readFileSync(join(agentDir, 'rules/operations.md'), 'utf-8');
    expect(ruleContent).toContain('author: human');

    // Instincts should be agent-authored
    const instinctContent = readFileSync(join(agentDir, 'instincts/lead-with-answer.md'), 'utf-8');
    expect(instinctContent).toContain('author: agent');

    // Skills can be mixed, but default should be human
    const skillContent = readFileSync(join(agentDir, 'skills/research.md'), 'utf-8');
    expect(skillContent).toContain('author: human');

    // Playbooks can be mixed, but default should be human
    const playbookContent = readFileSync(join(agentDir, 'playbooks/ship-feature.md'), 'utf-8');
    expect(playbookContent).toContain('author: human');
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

      const core = readFileSync(join(agentDir, 'CORE.md'), 'utf-8');
      expect(core).toContain('my-assistant');
      expect(core).toContain('personal assistant');
      expect(core).toContain('Reliability');

      const system = readFileSync(join(agentDir, 'SYSTEM.md'), 'utf-8');
      expect(system).toContain('my-assistant');
      expect(system).toContain('Boot Sequence');
      expect(system).toContain('File Ownership');

      const config = readFileSync(join(agentDir, 'config.yaml'), 'utf-8');
      expect(config).toContain('name: my-assistant');
      expect(config).toContain('session_retention_days: 14');
    });

    it('should scaffold with code-reviewer template', () => {
      scaffoldHarness(agentDir, 'my-reviewer', { template: 'code-reviewer' });

      const core = readFileSync(join(agentDir, 'CORE.md'), 'utf-8');
      expect(core).toContain('my-reviewer');
      expect(core).toContain('code review');
      expect(core).toContain('Security-first');

      const system = readFileSync(join(agentDir, 'SYSTEM.md'), 'utf-8');
      expect(system).toContain('my-reviewer');
      expect(system).toContain('Review Process');
      expect(system).toContain('Feedback Format');
      expect(system).toContain('Critical');

      const config = readFileSync(join(agentDir, 'config.yaml'), 'utf-8');
      expect(config).toContain('name: my-reviewer');
      expect(config).toContain('scratchpad_budget: 15000');
    });

    it('should use custom purpose in CORE.md', () => {
      scaffoldHarness(agentDir, 'my-bot', { purpose: 'I help developers write better tests.' });

      const core = readFileSync(join(agentDir, 'CORE.md'), 'utf-8');
      expect(core).toContain('my-bot');
      expect(core).toContain('I help developers write better tests.');
    });

    it('should use custom coreContent when provided', () => {
      const customCore = '# Custom Agent\n\nThis is a fully custom CORE.md.';
      scaffoldHarness(agentDir, 'custom-agent', { coreContent: customCore });

      const core = readFileSync(join(agentDir, 'CORE.md'), 'utf-8');
      expect(core).toBe(customCore);
      // Should NOT contain the template boilerplate
      expect(core).not.toContain('Values');
      expect(core).not.toContain('Ethics');
    });

    it('should prefer coreContent over purpose', () => {
      const customCore = '# Override\n\nCustom content wins.';
      scaffoldHarness(agentDir, 'priority-test', {
        purpose: 'This should be ignored',
        coreContent: customCore,
      });

      const core = readFileSync(join(agentDir, 'CORE.md'), 'utf-8');
      expect(core).toBe(customCore);
      expect(core).not.toContain('This should be ignored');
    });

    it('should fall back to base template for unknown template name', () => {
      scaffoldHarness(agentDir, 'test-agent', { template: 'nonexistent' });

      // Should still create files using inline fallbacks
      expect(existsSync(join(agentDir, 'CORE.md'))).toBe(true);
      expect(existsSync(join(agentDir, 'SYSTEM.md'))).toBe(true);
      expect(existsSync(join(agentDir, 'config.yaml'))).toBe(true);
    });

    it('should substitute {{AGENT_NAME}} in all template files', () => {
      scaffoldHarness(agentDir, 'agent-x', { template: 'assistant' });

      const core = readFileSync(join(agentDir, 'CORE.md'), 'utf-8');
      const system = readFileSync(join(agentDir, 'SYSTEM.md'), 'utf-8');
      const config = readFileSync(join(agentDir, 'config.yaml'), 'utf-8');

      // Should contain the substituted name, not the placeholder
      expect(core).not.toContain('{{AGENT_NAME}}');
      expect(system).not.toContain('{{AGENT_NAME}}');
      expect(config).not.toContain('{{AGENT_NAME}}');

      expect(core).toContain('agent-x');
      expect(system).toContain('agent-x');
      expect(config).toContain('name: agent-x');
    });
  });

  describe('generateSystemMd', () => {
    it('should generate SYSTEM.md from directory structure', () => {
      scaffoldHarness(agentDir, 'sys-agent');

      const systemMd = generateSystemMd(agentDir, 'sys-agent');

      expect(systemMd).toContain('# System');
      expect(systemMd).toContain('sys-agent');
      expect(systemMd).toContain('## Boot Sequence');
      expect(systemMd).toContain('## Directory Structure');
      expect(systemMd).toContain('## File Ownership');
      expect(systemMd).toContain('## Context Loading Strategy');

      // Should list actual primitive directories with file counts
      expect(systemMd).toContain('`rules/`');
      expect(systemMd).toContain('`instincts/`');
      expect(systemMd).toContain('`skills/`');
      expect(systemMd).toContain('`playbooks/`');

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

      // Defaults now ship with at least one workflow and one tool example,
      // so these sections should list primitives rather than being empty.
      const systemMd = generateSystemMd(agentDir, 'empty-agent');
      expect(systemMd).toContain('`workflows/`');
      expect(systemMd).toContain('`tools/`');
      expect(systemMd).toContain('daily-reflection');
      expect(systemMd).toContain('example-web-search');
    });
  });
});
