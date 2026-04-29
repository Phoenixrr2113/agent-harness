import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseHarnessDocument,
  loadDirectory,
  loadDirectoryWithErrors,
  loadAllPrimitives,
  loadAllPrimitivesWithErrors,
  estimateTokens,
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
    it('should parse valid markdown with frontmatter', () => {
      const testFile = join(testDir, 'test.md');
      writeFileSync(
        testFile,
        `---
id: test-doc
tags: [test]
created: 2026-04-06
author: human
status: active
description: This is a short one-line summary.
---

# Test Document

This is the full body content of the document.
It contains multiple lines and paragraphs.
`
      );

      const doc = parseHarnessDocument(testFile);

      expect(doc.id).toBe('test-doc');
      expect(doc.tags).toEqual(['test']);
      expect(doc.author).toBe('human');
      expect(doc.status).toBe('active');
      expect(doc.description).toBe('This is a short one-line summary.');

      expect(doc.body).toContain('# Test Document');
      expect(doc.body).toContain('This is the full body content');
    });

    it('should handle missing description', () => {
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

      expect(doc.id).toBe('no-summary');
      expect(doc.description).toBeUndefined();
      expect(doc.body).toContain('# Document Without Summaries');
    });

    it('should create fallback id from filename if invalid', () => {
      const testFile = join(testDir, 'fallback-doc.md');
      writeFileSync(
        testFile,
        `# No Frontmatter

This document has no frontmatter.
`
      );

      const doc = parseHarnessDocument(testFile);

      expect(doc.id).toBe('fallback-doc');
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

    it('should strip L0/L1 comments from body', () => {
      const testFile = join(testDir, 'multiline.md');
      writeFileSync(
        testFile,
        `---
id: multiline
description: Short summary.
---

<!-- L0: Short summary. -->
<!-- L1: This summary spans
     multiple lines with proper
     indentation and wrapping. -->

# Content
`
      );

      const doc = parseHarnessDocument(testFile);

      expect(doc.description).toBe('Short summary.');
      expect(doc.body).not.toContain('<!-- L0:');
      expect(doc.body).not.toContain('<!-- L1:');
      expect(doc.body).toContain('# Content');
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
      expect(docs.map(d => d.id).sort()).toEqual(['rule1', 'rule2']);
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
      expect(docs[0].id).toBe('skill1');
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
      expect(docs[0].id).toBe('instinct1');
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
      expect(docs[0].id).toBe('active');
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
      expect(docs[0].id).toBe('tool');
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
      expect(primitives.get('protocols')?.[0].id).toBe('proto1');
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

  describe('HarnessDocument canonical accessors', () => {
    it('should expose description and id as top-level fields', () => {
      // Verify the new canonical accessor shape via a real parsed doc
      const testFile = join(testDir, 'accessor-test.md');
      writeFileSync(
        testFile,
        `---
id: test
tags: [test]
created: 2026-04-06
author: human
status: active
description: Short one-line summary.
---

# Full Document

This is the complete body content with all details.

Multiple paragraphs and sections.
`,
      );
      const doc = parseHarnessDocument(testFile);
      // description is the new canonical accessor (replaces L0/L1)
      expect(doc.description).toBe('Short one-line summary.');
      // id is a top-level canonical field
      expect(doc.id).toBe('test');
      // body contains document content
      expect(doc.body).toContain('# Full Document');
      expect(doc.body).toContain('complete body content');
    });

    it('should have undefined description when not set in frontmatter', () => {
      const testFile = join(testDir, 'no-desc.md');
      writeFileSync(
        testFile,
        `---
id: test
---
Body.
`,
      );
      const doc = parseHarnessDocument(testFile);
      // Falls back to id when description is not present
      expect(doc.description).toBeUndefined();
      expect(doc.id).toBe('test');
    });

    it('should fall back to truncated body for description-less docs in context', () => {
      const testFile = join(testDir, 'no-desc-body.md');
      writeFileSync(
        testFile,
        `---
id: test
---
# Full Document

This is the complete body content with all details.

Multiple paragraphs and sections.
`,
      );
      const doc = parseHarnessDocument(testFile);
      expect(doc.description).toBeUndefined();
      // Consumers should use: doc.description ?? doc.body.slice(0, 400)
      const summary = doc.description ?? doc.body.slice(0, 400);
      expect(summary).toContain('# Full Document');
      expect(summary.length).toBeLessThanOrEqual(400);
    });
  });

  describe('loadDirectoryWithErrors', () => {
    it('should still load valid files alongside resilient parsing', () => {
      const rulesDir = join(testDir, 'rules');
      mkdirSync(rulesDir);

      writeFileSync(
        join(rulesDir, 'good.md'),
        `---
id: good
status: active
---
Good content`,
      );

      // gray-matter is resilient and can parse most content without throwing.
      // The key behavior: loadDirectoryWithErrors never throws and always returns valid docs.
      writeFileSync(join(rulesDir, 'other.md'), 'No frontmatter at all');

      const result = loadDirectoryWithErrors(rulesDir);

      // Both files should parse (gray-matter creates fallback frontmatter)
      expect(result.docs.some((d) => d.id === 'good')).toBe(true);
      // No errors because gray-matter is resilient
      expect(result.errors).toHaveLength(0);
    });

    it('should return empty errors for valid directory', () => {
      const rulesDir = join(testDir, 'rules');
      mkdirSync(rulesDir);

      writeFileSync(
        join(rulesDir, 'valid.md'),
        `---
id: valid
status: active
---
Valid content`,
      );

      const result = loadDirectoryWithErrors(rulesDir);

      expect(result.docs).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
    });

    it('should return empty result for non-existent directory', () => {
      const result = loadDirectoryWithErrors(join(testDir, 'nonexistent'));

      expect(result.docs).toEqual([]);
      expect(result.errors).toEqual([]);
    });
  });

  describe('loadAllPrimitivesWithErrors', () => {
    it('should aggregate errors across directories', () => {
      const rulesDir = join(testDir, 'rules');
      mkdirSync(rulesDir);

      writeFileSync(
        join(rulesDir, 'good.md'),
        `---
id: good-rule
status: active
---
Good content`,
      );

      const result = loadAllPrimitivesWithErrors(testDir);

      expect(result.primitives.get('rules')?.length).toBe(1);
      expect(result.primitives.get('rules')?.[0].id).toBe('good-rule');
      // No errors for valid files
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('bundled primitive directories (Agent Skills convention)', () => {
    it('loads skills/<name>/SKILL.md', () => {
      const skillsDir = join(testDir, 'skills');
      const bundleDir = join(skillsDir, 'debug-workflow');
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(
        join(bundleDir, 'SKILL.md'),
        `---
name: debug-workflow
description: Systematic debug procedure with diagnostic script.
tags: [skill, debugging]
status: active
---

<!-- L0: Systematic debug procedure. -->

# Debug Workflow

See scripts/run-diagnostics.sh.
`,
      );
      mkdirSync(join(bundleDir, 'scripts'));
      writeFileSync(join(bundleDir, 'scripts', 'run-diagnostics.sh'), '#!/bin/sh\necho diag\n');

      const docs = loadDirectory(skillsDir);

      expect(docs).toHaveLength(1);
      expect(docs[0].id).toBe('debug-workflow');
      expect(docs[0].frontmatter.name).toBe('debug-workflow');
      expect(docs[0].frontmatter.description).toBe('Systematic debug procedure with diagnostic script.');
      expect(docs[0].bundleDir).toBe(bundleDir);
    });

    it('loads playbooks/<name>/PLAYBOOK.md', () => {
      const playbooksDir = join(testDir, 'playbooks');
      const bundleDir = join(playbooksDir, 'deploy-production');
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(
        join(bundleDir, 'PLAYBOOK.md'),
        `---
name: deploy-production
description: Ship-to-prod sequence with preflight + rollback.
status: active
---

<!-- L0: Ship-to-prod sequence. -->
`,
      );

      const docs = loadDirectory(playbooksDir);

      expect(docs).toHaveLength(1);
      expect(docs[0].id).toBe('deploy-production');
      expect(docs[0].bundleDir).toBe(bundleDir);
    });

    it('loads rules/<name>/RULE.md and workflows/<name>/WORKFLOW.md', () => {
      const cases: Array<[string, string]> = [
        ['rules', 'RULE.md'],
        ['workflows', 'WORKFLOW.md'],
      ];
      for (const [kind, entry] of cases) {
        const bundleDir = join(testDir, kind, `my-${kind}-bundle`);
        mkdirSync(bundleDir, { recursive: true });
        writeFileSync(
          join(bundleDir, entry),
          `---
name: my-${kind}-bundle
status: active
---

<!-- L0: ${kind} bundle. -->
`,
        );
      }

      const primitives = loadAllPrimitives(testDir);

      expect(primitives.get('rules')?.[0].id).toBe('my-rules-bundle');
      expect(primitives.get('rules')?.[0].bundleDir).toContain('my-rules-bundle');
      expect(primitives.get('workflows')?.[0].id).toBe('my-workflows-bundle');
      expect(primitives.get('workflows')?.[0].bundleDir).toContain('my-workflows-bundle');
    });

    it('errors when a bundle-capable dir has a subdir missing its entry file', () => {
      const skillsDir = join(testDir, 'skills');
      const bundleDir = join(skillsDir, 'orphan-bundle');
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, 'just-a-script.js'), 'console.log("orphan");\n');

      const result = loadDirectoryWithErrors(skillsDir);

      expect(result.docs).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].path).toBe(bundleDir);
      expect(result.errors[0].error).toContain('SKILL.md');
    });

    it('errors when a flat-only kind (instincts) contains a directory', () => {
      const instinctsDir = join(testDir, 'instincts');
      const rogueSubdir = join(instinctsDir, 'my-instinct-bundle');
      mkdirSync(rogueSubdir, { recursive: true });
      writeFileSync(
        join(rogueSubdir, 'INSTINCT.md'),
        `---\nid: bundled-instinct\nstatus: active\n---\n<!-- L0: nope -->`,
      );

      const result = loadDirectoryWithErrors(instinctsDir);

      expect(result.docs).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].path).toBe(rogueSubdir);
      expect(result.errors[0].error).toContain('Bundling is not supported for "instincts"');
    });

    it('keeps flat .md files working alongside bundled dirs in the same kind', () => {
      const skillsDir = join(testDir, 'skills');
      mkdirSync(skillsDir);
      writeFileSync(
        join(skillsDir, 'flat-skill.md'),
        `---
id: flat-skill
tags: [skill]
status: active
---

<!-- L0: Flat one. -->
`,
      );
      const bundleDir = join(skillsDir, 'bundled-skill');
      mkdirSync(bundleDir);
      writeFileSync(
        join(bundleDir, 'SKILL.md'),
        `---
name: bundled-skill
status: active
---

<!-- L0: Bundled one. -->
`,
      );

      const docs = loadDirectory(skillsDir).sort((a, b) =>
        a.id.localeCompare(b.id),
      );

      expect(docs).toHaveLength(2);
      expect(docs[0].id).toBe('bundled-skill');
      expect(docs[0].bundleDir).toBe(bundleDir);
      expect(docs[1].id).toBe('flat-skill');
      expect(docs[1].bundleDir).toBeUndefined();
    });

    it('skips hidden and _underscore bundle dirs silently', () => {
      const skillsDir = join(testDir, 'skills');
      mkdirSync(skillsDir);
      mkdirSync(join(skillsDir, '.hidden-bundle'));
      mkdirSync(join(skillsDir, '_archive-bundle'));
      writeFileSync(
        join(skillsDir, '.hidden-bundle', 'SKILL.md'),
        `---\nname: hidden\nstatus: active\n---\n<!-- L0: h -->`,
      );
      writeFileSync(
        join(skillsDir, '_archive-bundle', 'SKILL.md'),
        `---\nname: archived\nstatus: active\n---\n<!-- L0: a -->`,
      );

      const result = loadDirectoryWithErrors(skillsDir);

      expect(result.docs).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('Agent Skills frontmatter (name/description) dual-schema', () => {
    it('derives id from name when id is missing', () => {
      const skillsDir = join(testDir, 'skills');
      const bundleDir = join(skillsDir, 'pr-review');
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(
        join(bundleDir, 'SKILL.md'),
        `---
name: PR Review
description: Structured pull-request review.
status: active
---

<!-- L0: PR review. -->
`,
      );

      const docs = loadDirectory(skillsDir);

      expect(docs).toHaveLength(1);
      expect(docs[0].id).toBe('pr-review');
      expect(docs[0].frontmatter.name).toBe('PR Review');
      expect(docs[0].frontmatter.description).toBe('Structured pull-request review.');
    });

    it('preserves explicit id when both id and name are present', () => {
      const testFile = join(testDir, 'legacy.md');
      writeFileSync(
        testFile,
        `---
id: explicit-id
name: Display Name
status: active
---

Body.
`,
      );

      const doc = parseHarnessDocument(testFile);

      expect(doc.id).toBe('explicit-id');
      expect(doc.frontmatter.name).toBe('Display Name');
    });

    it('accepts Agent Skills optional fields (license, compatibility, metadata, allowed-tools)', () => {
      const testFile = join(testDir, 'skills-compat.md');
      writeFileSync(
        testFile,
        `---
name: example-skill
description: test
license: MIT
compatibility: claude-code >= 2.1
metadata:
  author_url: https://example.com
allowed-tools:
  - Read
  - Bash
---

Body.
`,
      );

      const doc = parseHarnessDocument(testFile);

      expect(doc.frontmatter.license).toBe('MIT');
      expect(doc.frontmatter.compatibility).toBe('claude-code >= 2.1');
      expect(doc.frontmatter.metadata?.author_url).toBe('https://example.com');
      expect(doc.frontmatter['allowed-tools']).toEqual(['Read', 'Bash']);
    });
  });
});
