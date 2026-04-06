import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseHarnessDocument,
  loadDirectory,
  loadAllPrimitives,
  estimateTokens,
  getAtLevel,
} from '../src/primitives/loader.js';

describe('primitives loader', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'primitives-test-'));
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('parseHarnessDocument', () => {
    it('should parse valid markdown with frontmatter and L0/L1', () => {
      const testFile = join(testDir, 'test.md');
      writeFileSync(
        testFile,
        `---
id: test-doc
tags: [test]
created: 2026-04-06
author: human
status: active
---

<!-- L0: This is a short one-line summary. -->
<!-- L1: This is a longer paragraph summary that provides more context
     about what this document contains and when it should be used. -->

# Test Document

This is the full body content of the document.
It contains multiple lines and paragraphs.
`
      );

      const doc = parseHarnessDocument(testFile);

      expect(doc.frontmatter.id).toBe('test-doc');
      expect(doc.frontmatter.tags).toEqual(['test']);
      expect(doc.frontmatter.author).toBe('human');
      expect(doc.frontmatter.status).toBe('active');

      expect(doc.l0).toBe('This is a short one-line summary.');
      expect(doc.l1).toContain('This is a longer paragraph summary');
      expect(doc.l1).toContain('when it should be used.');

      expect(doc.body).toContain('# Test Document');
      expect(doc.body).toContain('This is the full body content');
      // L0 and L1 should be stripped from body
      expect(doc.body).not.toContain('<!-- L0:');
      expect(doc.body).not.toContain('<!-- L1:');
    });

    it('should handle missing L0 and L1', () => {
      const testFile = join(testDir, 'no-summary.md');
      writeFileSync(
        testFile,
        `---
id: no-summary
tags: [test]
---

# Document Without Summaries

Just body content.
`
      );

      const doc = parseHarnessDocument(testFile);

      expect(doc.frontmatter.id).toBe('no-summary');
      expect(doc.l0).toBe('');
      expect(doc.l1).toBe('');
      expect(doc.body).toContain('# Document Without Summaries');
    });

    it('should create fallback frontmatter from filename if invalid', () => {
      const testFile = join(testDir, 'fallback-doc.md');
      writeFileSync(
        testFile,
        `# No Frontmatter

This document has no frontmatter.
`
      );

      const doc = parseHarnessDocument(testFile);

      expect(doc.frontmatter.id).toBe('fallback-doc');
      expect(doc.body).toContain('# No Frontmatter');
    });

    it('should handle Date objects in frontmatter', () => {
      const testFile = join(testDir, 'date-test.md');
      writeFileSync(
        testFile,
        `---
id: date-test
created: 2026-04-06
updated: 2026-04-07
---

Body content.
`
      );

      const doc = parseHarnessDocument(testFile);

      // Dates should be normalized to YYYY-MM-DD strings
      expect(doc.frontmatter.created).toBe('2026-04-06');
      expect(doc.frontmatter.updated).toBe('2026-04-07');
    });

    it('should handle multiline L1 summaries', () => {
      const testFile = join(testDir, 'multiline.md');
      writeFileSync(
        testFile,
        `---
id: multiline
---

<!-- L0: Short summary. -->
<!-- L1: This summary spans
     multiple lines with proper
     indentation and wrapping. -->

# Content
`
      );

      const doc = parseHarnessDocument(testFile);

      expect(doc.l0).toBe('Short summary.');
      expect(doc.l1).toContain('This summary spans');
      expect(doc.l1).toContain('multiple lines');
      expect(doc.l1).toContain('indentation and wrapping.');
    });
  });

  describe('loadDirectory', () => {
    it('should load all .md files in a directory', () => {
      const rulesDir = join(testDir, 'rules');
      mkdirSync(rulesDir);

      writeFileSync(
        join(rulesDir, 'rule1.md'),
        `---
id: rule1
status: active
---
Content 1`
      );

      writeFileSync(
        join(rulesDir, 'rule2.md'),
        `---
id: rule2
status: active
---
Content 2`
      );

      const docs = loadDirectory(rulesDir);

      expect(docs).toHaveLength(2);
      expect(docs.map(d => d.frontmatter.id).sort()).toEqual(['rule1', 'rule2']);
    });

    it('should skip files starting with underscore', () => {
      const skillsDir = join(testDir, 'skills');
      mkdirSync(skillsDir);

      writeFileSync(
        join(skillsDir, 'skill1.md'),
        `---
id: skill1
status: active
---
Content`
      );

      writeFileSync(
        join(skillsDir, '_index.md'),
        `---
id: index
---
Index content`
      );

      const docs = loadDirectory(skillsDir);

      expect(docs).toHaveLength(1);
      expect(docs[0].frontmatter.id).toBe('skill1');
    });

    it('should skip hidden files', () => {
      const instinctsDir = join(testDir, 'instincts');
      mkdirSync(instinctsDir);

      writeFileSync(
        join(instinctsDir, 'instinct1.md'),
        `---
id: instinct1
status: active
---
Content`
      );

      writeFileSync(
        join(instinctsDir, '.hidden.md'),
        `---
id: hidden
---
Hidden content`
      );

      const docs = loadDirectory(instinctsDir);

      expect(docs).toHaveLength(1);
      expect(docs[0].frontmatter.id).toBe('instinct1');
    });

    it('should skip archived and deprecated files', () => {
      const playbooksDir = join(testDir, 'playbooks');
      mkdirSync(playbooksDir);

      writeFileSync(
        join(playbooksDir, 'active.md'),
        `---
id: active
status: active
---
Active content`
      );

      writeFileSync(
        join(playbooksDir, 'archived.md'),
        `---
id: archived
status: archived
---
Archived content`
      );

      writeFileSync(
        join(playbooksDir, 'deprecated.md'),
        `---
id: deprecated
status: deprecated
---
Deprecated content`
      );

      const docs = loadDirectory(playbooksDir);

      expect(docs).toHaveLength(1);
      expect(docs[0].frontmatter.id).toBe('active');
    });

    it('should return empty array for non-existent directory', () => {
      const docs = loadDirectory(join(testDir, 'nonexistent'));
      expect(docs).toEqual([]);
    });

    it('should skip non-markdown files', () => {
      const toolsDir = join(testDir, 'tools');
      mkdirSync(toolsDir);

      writeFileSync(
        join(toolsDir, 'tool.md'),
        `---
id: tool
status: active
---
Tool content`
      );

      writeFileSync(join(toolsDir, 'readme.txt'), 'Not markdown');
      writeFileSync(join(toolsDir, 'script.sh'), '#!/bin/bash');

      const docs = loadDirectory(toolsDir);

      expect(docs).toHaveLength(1);
      expect(docs[0].frontmatter.id).toBe('tool');
    });
  });

  describe('loadAllPrimitives', () => {
    it('should load all primitive directories', () => {
      // Create all primitive directories with sample files
      const primitiveTypes = ['rules', 'instincts', 'skills', 'playbooks', 'workflows', 'tools', 'agents'];

      for (const type of primitiveTypes) {
        const dir = join(testDir, type);
        mkdirSync(dir);
        writeFileSync(
          join(dir, `${type}-1.md`),
          `---
id: ${type}-1
status: active
---
Content for ${type}`
        );
      }

      const primitives = loadAllPrimitives(testDir);

      expect(primitives.size).toBe(7);
      for (const type of primitiveTypes) {
        expect(primitives.has(type)).toBe(true);
        expect(primitives.get(type)?.length).toBe(1);
      }
    });

    it('should handle missing primitive directories', () => {
      // Create only some directories
      mkdirSync(join(testDir, 'rules'));
      writeFileSync(
        join(testDir, 'rules', 'rule.md'),
        `---
id: rule
status: active
---
Rule content`
      );

      const primitives = loadAllPrimitives(testDir);

      expect(primitives.get('rules')?.length).toBe(1);
      expect(primitives.get('instincts')?.length).toBe(0);
      expect(primitives.get('skills')?.length).toBe(0);
    });

    it('should load extension directories when provided', () => {
      mkdirSync(join(testDir, 'rules'));
      mkdirSync(join(testDir, 'protocols'));
      writeFileSync(
        join(testDir, 'rules', 'rule1.md'),
        `---
id: rule1
status: active
---
Rule content`
      );
      writeFileSync(
        join(testDir, 'protocols', 'proto1.md'),
        `---
id: proto1
status: active
---
Protocol content`
      );

      const primitives = loadAllPrimitives(testDir, ['protocols']);

      expect(primitives.has('rules')).toBe(true);
      expect(primitives.has('protocols')).toBe(true);
      expect(primitives.get('protocols')?.length).toBe(1);
      expect(primitives.get('protocols')?.[0].frontmatter.id).toBe('proto1');
    });

    it('should not duplicate core dirs when passed as extension', () => {
      mkdirSync(join(testDir, 'rules'));
      writeFileSync(
        join(testDir, 'rules', 'rule1.md'),
        `---
id: rule1
status: active
---
Rule`
      );

      const primitives = loadAllPrimitives(testDir, ['rules']);

      expect(primitives.get('rules')?.length).toBe(1);
      // Should still have exactly 7 core + 0 new = 7 entries
      expect(primitives.size).toBe(7);
    });
  });

  describe('estimateTokens', () => {
    it('should estimate roughly 1 token per 4 characters', () => {
      const text = 'a'.repeat(400); // 400 chars
      const tokens = estimateTokens(text);
      expect(tokens).toBe(100); // 400 / 4 = 100
    });

    it('should round up for partial tokens', () => {
      const text = 'abc'; // 3 chars
      const tokens = estimateTokens(text);
      expect(tokens).toBe(1); // ceil(3/4) = 1
    });

    it('should handle empty string', () => {
      const tokens = estimateTokens('');
      expect(tokens).toBe(0);
    });
  });

  describe('getAtLevel', () => {
    const sampleDoc = {
      path: '/test.md',
      frontmatter: {
        id: 'test',
        tags: ['test'],
        created: '2026-04-06',
        author: 'human' as const,
        status: 'active' as const,
      },
      l0: 'Short one-line summary.',
      l1: 'Longer paragraph summary with more details about the content and usage.',
      body: '# Full Document\n\nThis is the complete body content with all details.\n\nMultiple paragraphs and sections.',
      raw: '',
    };

    it('should return L0 at level 0', () => {
      const content = getAtLevel(sampleDoc, 0);
      expect(content).toBe('Short one-line summary.');
    });

    it('should return L1 at level 1', () => {
      const content = getAtLevel(sampleDoc, 1);
      expect(content).toBe('Longer paragraph summary with more details about the content and usage.');
    });

    it('should return full body at level 2', () => {
      const content = getAtLevel(sampleDoc, 2);
      expect(content).toContain('# Full Document');
      expect(content).toContain('complete body content');
    });

    it('should fallback to id if L0 is missing', () => {
      const docWithoutL0 = { ...sampleDoc, l0: '' };
      const content = getAtLevel(docWithoutL0, 0);
      expect(content).toBe('test');
    });

    it('should fallback to L0 if L1 is missing', () => {
      const docWithoutL1 = { ...sampleDoc, l1: '' };
      const content = getAtLevel(docWithoutL1, 1);
      expect(content).toBe('Short one-line summary.');
    });

    it('should fallback to truncated body if both L0 and L1 are missing', () => {
      const docWithoutSummaries = { ...sampleDoc, l0: '', l1: '' };
      const content = getAtLevel(docWithoutSummaries, 1);
      expect(content).toContain('# Full Document');
      expect(content.length).toBeLessThanOrEqual(400);
    });
  });
});
