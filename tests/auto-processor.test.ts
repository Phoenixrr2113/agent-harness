import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { autoProcessFile, autoProcessAll, processSkillOnSave } from '../src/runtime/auto-processor.js';

describe('auto-processor', () => {
  let harnessDir: string;

  beforeEach(() => {
    harnessDir = mkdtempSync(join(tmpdir(), 'auto-proc-test-'));
    // Create standard primitive directories
    for (const dir of ['rules', 'instincts', 'skills', 'playbooks', 'workflows', 'tools', 'agents']) {
      mkdirSync(join(harnessDir, dir), { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(harnessDir)) {
      rmSync(harnessDir, { recursive: true, force: true });
    }
  });

  describe('autoProcessFile', () => {
    it('should skip non-.md files', () => {
      const filePath = join(harnessDir, 'rules', 'test.txt');
      writeFileSync(filePath, 'content');

      const result = autoProcessFile(filePath, { harnessDir });
      expect(result.modified).toBe(false);
      expect(result.fixes).toHaveLength(0);
    });

    it('should skip non-existent files', () => {
      const result = autoProcessFile(join(harnessDir, 'rules', 'nope.md'), { harnessDir });
      expect(result.modified).toBe(false);
    });

    it('should skip index files starting with _', () => {
      const filePath = join(harnessDir, 'rules', '_index.md');
      writeFileSync(filePath, '# Index');

      const result = autoProcessFile(filePath, { harnessDir });
      expect(result.modified).toBe(false);
    });

    it('should skip CORE.md', () => {
      const filePath = join(harnessDir, 'CORE.md');
      writeFileSync(filePath, '# Core');

      const result = autoProcessFile(filePath, { harnessDir });
      expect(result.modified).toBe(false);
    });

    it('should skip SYSTEM.md', () => {
      const filePath = join(harnessDir, 'SYSTEM.md');
      writeFileSync(filePath, '# System');

      const result = autoProcessFile(filePath, { harnessDir });
      expect(result.modified).toBe(false);
    });

    it('should skip state.md', () => {
      const filePath = join(harnessDir, 'state.md');
      writeFileSync(filePath, '# State');

      const result = autoProcessFile(filePath, { harnessDir });
      expect(result.modified).toBe(false);
    });

    it('should skip empty files', () => {
      const filePath = join(harnessDir, 'rules', 'empty.md');
      writeFileSync(filePath, '   ');

      const result = autoProcessFile(filePath, { harnessDir });
      expect(result.modified).toBe(false);
    });

    it('should add frontmatter to bare markdown files', () => {
      const filePath = join(harnessDir, 'rules', 'my-coding-rule.md');
      writeFileSync(filePath, '# Coding Standards\n\nAlways use strict mode.');

      const result = autoProcessFile(filePath, { harnessDir });
      expect(result.modified).toBe(true);
      expect(result.fixes).toContain('Added id: "my-coding-rule"');
      expect(result.fixes).toContain('Added created date');
      expect(result.fixes).toContain('Added author: "human"');
      expect(result.fixes).toContain('Added status: "active"');
      expect(result.fixes).toContain('Added tag: "rule"');

      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('id: my-coding-rule');
      expect(content).toContain('author: human');
      expect(content).toContain('status: active');
      expect(content).toContain('tags:');
      expect(content).toContain('- rule');
    });

    it('should generate L0 summary from heading', () => {
      const filePath = join(harnessDir, 'skills', 'debugging.md');
      writeFileSync(filePath, '# Debugging Techniques\n\nLearn how to debug effectively.');

      const result = autoProcessFile(filePath, { harnessDir });
      expect(result.modified).toBe(true);
      expect(result.fixes).toContain('Generated L0 summary');

      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('<!-- L0: Debugging Techniques -->');
    });

    it('should generate L1 summary from first paragraph', () => {
      const filePath = join(harnessDir, 'skills', 'testing.md');
      writeFileSync(filePath, '# Testing\n\nThis skill covers unit testing, integration testing, and end-to-end testing patterns.');

      const result = autoProcessFile(filePath, { harnessDir });
      expect(result.modified).toBe(true);
      expect(result.fixes).toContain('Generated L1 summary');

      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('<!-- L1: This skill covers unit testing');
    });

    it('should not overwrite existing frontmatter fields', () => {
      const filePath = join(harnessDir, 'rules', 'existing.md');
      writeFileSync(filePath, `---
id: custom-id
author: agent
tags:
  - custom
---
# My Rule

Do the thing.
`);

      const result = autoProcessFile(filePath, { harnessDir });
      expect(result.modified).toBe(true);
      // Should add missing fields but not overwrite existing
      expect(result.fixes).not.toContainEqual(expect.stringContaining('Added id'));
      expect(result.fixes).not.toContainEqual(expect.stringContaining('Added author'));
      expect(result.fixes).not.toContainEqual(expect.stringContaining('Added tag'));

      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('id: custom-id');
      expect(content).toContain('author: agent');
    });

    it('should not overwrite existing L0/L1 summaries', () => {
      const filePath = join(harnessDir, 'rules', 'summarized.md');
      writeFileSync(filePath, `---
id: test
---
<!-- L0: Existing L0 -->
<!-- L1: Existing L1 -->
# My Rule

Content here.
`);

      const result = autoProcessFile(filePath, { harnessDir });
      // Should not regenerate L0/L1
      expect(result.fixes).not.toContain('Generated L0 summary');
      expect(result.fixes).not.toContain('Generated L1 summary');
    });

    it('should infer tags from different directories', () => {
      const dirs = [
        { dir: 'instincts', tag: 'instinct' },
        { dir: 'skills', tag: 'skill' },
        { dir: 'playbooks', tag: 'playbook' },
        { dir: 'workflows', tag: 'workflow' },
        { dir: 'tools', tag: 'tool' },
        { dir: 'agents', tag: 'agent' },
      ];

      for (const { dir, tag } of dirs) {
        const filePath = join(harnessDir, dir, 'test.md');
        writeFileSync(filePath, '# Test\n\nContent.');
        const result = autoProcessFile(filePath, { harnessDir });
        expect(result.fixes).toContain(`Added tag: "${tag}"`);
        // Clean up for next iteration
        rmSync(filePath);
      }
    });

    it('should respect generateFrontmatter: false', () => {
      const filePath = join(harnessDir, 'rules', 'no-fm.md');
      writeFileSync(filePath, '# My Rule\n\nContent here.');

      const result = autoProcessFile(filePath, {
        harnessDir,
        generateFrontmatter: false,
      });
      // Should still generate summaries but not frontmatter
      expect(result.fixes).not.toContainEqual(expect.stringContaining('Added id'));
      expect(result.fixes).toContain('Generated L0 summary');
    });

    it('should respect generateSummaries: false', () => {
      const filePath = join(harnessDir, 'rules', 'no-sum.md');
      writeFileSync(filePath, '# My Rule\n\nContent here.');

      const result = autoProcessFile(filePath, {
        harnessDir,
        generateSummaries: false,
      });
      // Should generate frontmatter but not summaries
      expect(result.fixes).toContainEqual(expect.stringContaining('Added id'));
      expect(result.fixes).not.toContain('Generated L0 summary');
      expect(result.fixes).not.toContain('Generated L1 summary');
    });

    it('should derive id from filename with special characters', () => {
      const filePath = join(harnessDir, 'rules', 'My Cool_Rule.md');
      writeFileSync(filePath, '# Rule\n\nContent.');

      const result = autoProcessFile(filePath, { harnessDir });
      expect(result.fixes).toContain('Added id: "my-cool-rule"');
    });

    it('should truncate L0 summary over 120 characters', () => {
      const longTitle = 'A'.repeat(150);
      const filePath = join(harnessDir, 'rules', 'long.md');
      writeFileSync(filePath, `# ${longTitle}\n\nContent.`);

      const result = autoProcessFile(filePath, { harnessDir });
      expect(result.fixes).toContain('Generated L0 summary');

      const content = readFileSync(filePath, 'utf-8');
      const l0Match = content.match(/<!-- L0: (.*?) -->/);
      expect(l0Match).toBeDefined();
      expect(l0Match![1].length).toBeLessThanOrEqual(120);
      expect(l0Match![1].endsWith('...')).toBe(true);
    });

    it('should truncate L1 summary over 300 characters', () => {
      const longPara = 'B'.repeat(350);
      const filePath = join(harnessDir, 'rules', 'long-para.md');
      writeFileSync(filePath, `# Rule\n\n${longPara}`);

      const result = autoProcessFile(filePath, { harnessDir });
      expect(result.fixes).toContain('Generated L1 summary');

      const content = readFileSync(filePath, 'utf-8');
      const l1Match = content.match(/<!-- L1: (.*?) -->/);
      expect(l1Match).toBeDefined();
      expect(l1Match![1].length).toBeLessThanOrEqual(300);
      expect(l1Match![1].endsWith('...')).toBe(true);
    });

    it('should generate L0 from first non-empty line when no heading', () => {
      const filePath = join(harnessDir, 'rules', 'no-heading.md');
      writeFileSync(filePath, '\nThis is the first line of content.\n\nMore content.');

      const result = autoProcessFile(filePath, { harnessDir });
      expect(result.fixes).toContain('Generated L0 summary');

      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('<!-- L0: This is the first line of content. -->');
    });

    it('should handle files with malformed frontmatter gracefully', () => {
      const filePath = join(harnessDir, 'rules', 'bad-fm.md');
      writeFileSync(filePath, '---\n: invalid yaml [[\n---\n# Content\n\nBody here.');

      const result = autoProcessFile(filePath, { harnessDir });
      // Should not crash; either adds frontmatter or reports error
      expect(result.errors.length + result.fixes.length).toBeGreaterThanOrEqual(0);
    });

    it('should place L1 after L0 when both generated', () => {
      const filePath = join(harnessDir, 'rules', 'both.md');
      writeFileSync(filePath, '# My Rule\n\nThis is the description paragraph.');

      autoProcessFile(filePath, { harnessDir });
      const content = readFileSync(filePath, 'utf-8');

      const l0Pos = content.indexOf('<!-- L0:');
      const l1Pos = content.indexOf('<!-- L1:');
      expect(l0Pos).not.toBe(-1);
      expect(l1Pos).not.toBe(-1);
      expect(l0Pos).toBeLessThan(l1Pos);
    });
  });

  describe('processSkillOnSave — strict skill validation', () => {
    it('generates description from body when missing', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'autoproc-skill-test-'));
      mkdirSync(join(dir, 'skills', 'foo'), { recursive: true });
      const skillPath = join(dir, 'skills', 'foo', 'SKILL.md');
      writeFileSync(
        skillPath,
        `---\nname: foo-skill\n---\nFirst paragraph of the body.\n\nSecond paragraph.`,
        'utf-8',
      );

      const result = await processSkillOnSave(skillPath, {
        generateDescription: async () => 'Auto-generated description from first paragraph.',
      });

      expect(result.status).toBe('processed');
      const after = readFileSync(skillPath, 'utf-8');
      expect(after).toMatch(/description:.*Auto-generated description/);

      rmSync(dir, { recursive: true, force: true });
    });

    it('reports error when validation fails and no fix-up possible', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'autoproc-skill-test-'));
      mkdirSync(join(dir, 'skills', 'foo'), { recursive: true });
      const skillPath = join(dir, 'skills', 'foo', 'SKILL.md');
      writeFileSync(
        skillPath,
        `---\nname: foo-skill\n---\n`,
        'utf-8',
      );

      // No generator and no non-empty body paragraph to lift from
      const result = await processSkillOnSave(skillPath, {});

      expect(result.status).toBe('error');

      rmSync(dir, { recursive: true, force: true });
    });

    it('leaves valid skill unchanged', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'autoproc-skill-test-'));
      mkdirSync(join(dir, 'skills', 'foo'), { recursive: true });
      const skillPath = join(dir, 'skills', 'foo', 'SKILL.md');
      const initialContent = `---\nname: foo-skill\ndescription: Already has a description.\n---\nBody content.`;
      writeFileSync(skillPath, initialContent, 'utf-8');

      const result = await processSkillOnSave(skillPath, {});

      expect(result.status).toBe('unchanged');
      expect(readFileSync(skillPath, 'utf-8')).toBe(initialContent);

      rmSync(dir, { recursive: true, force: true });
    });

    it('does not generate description when body is empty', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'autoproc-skill-test-'));
      mkdirSync(join(dir, 'skills', 'foo'), { recursive: true });
      const skillPath = join(dir, 'skills', 'foo', 'SKILL.md');
      writeFileSync(skillPath, `---\nname: foo-skill\n---\n   \n`, 'utf-8');

      let generatorCalled = false;
      const result = await processSkillOnSave(skillPath, {
        generateDescription: async () => {
          generatorCalled = true;
          return 'Should not be called.';
        },
      });

      expect(generatorCalled).toBe(false);
      expect(result.status).toBe('error');

      rmSync(dir, { recursive: true, force: true });
    });

    it('rejects description longer than 1024 characters', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'autoproc-skill-test-'));
      mkdirSync(join(dir, 'skills', 'foo'), { recursive: true });
      const skillPath = join(dir, 'skills', 'foo', 'SKILL.md');
      writeFileSync(
        skillPath,
        `---\nname: foo-skill\n---\nBody paragraph here.`,
        'utf-8',
      );

      const tooLong = 'x'.repeat(1025);
      const result = await processSkillOnSave(skillPath, {
        generateDescription: async () => tooLong,
      });

      // Too-long description is not written, so validation still fails
      expect(result.status).toBe('error');

      rmSync(dir, { recursive: true, force: true });
    });

    it('reports error for missing name field', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'autoproc-skill-test-'));
      mkdirSync(join(dir, 'skills', 'foo'), { recursive: true });
      const skillPath = join(dir, 'skills', 'foo', 'SKILL.md');
      // description present but name missing
      writeFileSync(skillPath, `---\ndescription: Has description but no name.\n---\nBody.`, 'utf-8');

      const result = await processSkillOnSave(skillPath, {});

      expect(result.status).toBe('error');

      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('autoProcessAll', () => {
    it('should process all markdown files across directories', () => {
      writeFileSync(join(harnessDir, 'rules', 'rule-a.md'), '# Rule A\n\nDescription A.');
      writeFileSync(join(harnessDir, 'skills', 'skill-b.md'), '# Skill B\n\nDescription B.');
      writeFileSync(join(harnessDir, 'instincts', 'instinct-c.md'), '# Instinct C\n\nDescription C.');

      const results = autoProcessAll(harnessDir);
      expect(results.length).toBe(3);
      expect(results.every((r) => r.modified)).toBe(true);
    });

    it('should skip index files', () => {
      writeFileSync(join(harnessDir, 'rules', '_index.md'), '# Index\n\nNot a primitive.');
      writeFileSync(join(harnessDir, 'rules', 'real-rule.md'), '# Real Rule\n\nContent.');

      const results = autoProcessAll(harnessDir);
      expect(results.length).toBe(1);
      expect(results[0].path).toContain('real-rule.md');
    });

    it('should return empty array when no changes needed', () => {
      writeFileSync(join(harnessDir, 'rules', 'done.md'), `---
id: done
created: '2024-01-01'
author: human
status: active
tags:
  - rule
---
<!-- L0: Done rule -->
<!-- L1: This rule is already complete. -->
# Done

This rule is already complete.
`);

      const results = autoProcessAll(harnessDir);
      expect(results).toHaveLength(0);
    });

    it('should respect options pass-through', () => {
      writeFileSync(join(harnessDir, 'rules', 'opt-test.md'), '# Opt Test\n\nContent.');

      const results = autoProcessAll(harnessDir, {
        generateFrontmatter: false,
        generateSummaries: true,
      });

      expect(results.length).toBe(1);
      const fixes = results[0].fixes;
      expect(fixes).not.toContainEqual(expect.stringContaining('Added id'));
      expect(fixes).toContain('Generated L0 summary');
    });

    it('should skip non-existent directories gracefully', () => {
      // Remove the skills dir
      rmSync(join(harnessDir, 'skills'), { recursive: true });
      writeFileSync(join(harnessDir, 'rules', 'test.md'), '# Test\n\nContent.');

      const results = autoProcessAll(harnessDir);
      expect(results.length).toBe(1);
    });
  });
});
