import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import {
  getStarterPack,
  listStarterPacks,
  isPackReference,
  parsePackName,
} from '../src/runtime/starter-packs.js';
import { installBundle } from '../src/runtime/primitive-registry.js';

const PACK_TEST_DIR = join(__dirname, '__test_starter_packs__');

describe('starter-packs', () => {
  describe('isPackReference', () => {
    it('should return true for pack: prefix', () => {
      expect(isPackReference('pack:daily-briefs')).toBe(true);
      expect(isPackReference('pack:list')).toBe(true);
    });

    it('should return false for non-pack references', () => {
      expect(isPackReference('https://example.com/skill.md')).toBe(false);
      expect(isPackReference('./local-file.md')).toBe(false);
      expect(isPackReference('some-search-term')).toBe(false);
    });
  });

  describe('parsePackName', () => {
    it('should extract pack name from reference', () => {
      expect(parsePackName('pack:daily-briefs')).toBe('daily-briefs');
      expect(parsePackName('pack:weekly-review')).toBe('weekly-review');
      expect(parsePackName('pack:code-review')).toBe('code-review');
      expect(parsePackName('pack:list')).toBe('list');
    });
  });

  describe('listStarterPacks', () => {
    it('should return all available packs', () => {
      const packs = listStarterPacks();
      expect(packs.length).toBeGreaterThanOrEqual(6);

      const names = packs.map(p => p.name);
      expect(names).toContain('daily-briefs');
      expect(names).toContain('weekly-review');
      expect(names).toContain('code-review');
      expect(names).toContain('code-reviewer');
      expect(names).toContain('personal-assistant');
      expect(names).toContain('devops');
    });

    it('should include description and file count for each pack', () => {
      const packs = listStarterPacks();
      for (const pack of packs) {
        expect(pack.description.length).toBeGreaterThan(10);
        expect(pack.fileCount).toBeGreaterThan(0);
        expect(pack.tags.length).toBeGreaterThan(0);
      }
    });
  });

  describe('getStarterPack', () => {
    it('should return a packed bundle for valid pack names', () => {
      const bundle = getStarterPack('daily-briefs');
      expect(bundle).not.toBeNull();
      expect(bundle!.manifest.name).toBe('pack:daily-briefs');
      expect(bundle!.manifest.types).toContain('workflows');
      expect(bundle!.files.length).toBe(2); // morning-brief + evening-review
    });

    it('should return null for unknown pack names', () => {
      expect(getStarterPack('nonexistent')).toBeNull();
      expect(getStarterPack('')).toBeNull();
    });

    it('should include valid frontmatter in all pack files', () => {
      const packs = listStarterPacks();
      for (const packInfo of packs) {
        const bundle = getStarterPack(packInfo.name);
        expect(bundle).not.toBeNull();

        for (const file of bundle!.files) {
          // All workflow files should have frontmatter with id
          expect(file.content).toContain('---');
          expect(file.content).toMatch(/^---\n/);
          expect(file.content).toMatch(/id: /);
          expect(file.content).toMatch(/tags: /);
          expect(file.content).toMatch(/status: active/);
        }
      }
    });

    it('should include manifest file entries matching actual files', () => {
      const bundle = getStarterPack('weekly-review');
      expect(bundle).not.toBeNull();
      expect(bundle!.manifest.files.length).toBe(bundle!.files.length);

      for (const entry of bundle!.manifest.files) {
        const matchingFile = bundle!.files.find(f => f.path === entry.path);
        expect(matchingFile).toBeDefined();
        expect(entry.id.length).toBeGreaterThan(0);
        expect(entry.description.length).toBeGreaterThan(0);
      }
    });

    it('should produce unique IDs across all packs', () => {
      const allIds: string[] = [];
      const packs = listStarterPacks();
      for (const packInfo of packs) {
        const bundle = getStarterPack(packInfo.name);
        for (const entry of bundle!.manifest.files) {
          allIds.push(entry.id);
        }
      }
      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(allIds.length);
    });
  });

  describe('installBundle integration', () => {
    beforeEach(() => {
      mkdirSync(PACK_TEST_DIR, { recursive: true });
      writeFileSync(join(PACK_TEST_DIR, 'CORE.md'), '# Core', 'utf-8');
      writeFileSync(
        join(PACK_TEST_DIR, 'config.yaml'),
        `agent:\n  name: test\n  version: "0.1.0"\nmodel:\n  provider: openrouter\n  id: test-model\n  max_tokens: 200000\nmemory:\n  session_retention_days: 7\n  journal_retention_days: 365\n`,
        'utf-8',
      );
    });

    afterEach(() => {
      rmSync(PACK_TEST_DIR, { recursive: true, force: true });
    });

    it('should install daily-briefs pack into workflows directory', () => {
      const bundle = getStarterPack('daily-briefs')!;
      const result = installBundle(PACK_TEST_DIR, bundle);

      expect(result.installed).toBe(true);
      expect(result.files.length).toBe(2);
      expect(existsSync(join(PACK_TEST_DIR, 'workflows', 'morning-brief.md'))).toBe(true);
      expect(existsSync(join(PACK_TEST_DIR, 'workflows', 'evening-review.md'))).toBe(true);
    });

    it('should install code-review pack with both workflow files', () => {
      const bundle = getStarterPack('code-review')!;
      const result = installBundle(PACK_TEST_DIR, bundle);

      expect(result.installed).toBe(true);
      expect(result.files.length).toBe(2);
      expect(existsSync(join(PACK_TEST_DIR, 'workflows', 'code-review.md'))).toBe(true);
      expect(existsSync(join(PACK_TEST_DIR, 'workflows', 'pr-checklist.md'))).toBe(true);
    });

    it('should skip existing files without overwrite', () => {
      // Pre-create one file
      const wfDir = join(PACK_TEST_DIR, 'workflows');
      mkdirSync(wfDir, { recursive: true });
      writeFileSync(join(wfDir, 'morning-brief.md'), '# Custom content', 'utf-8');

      const bundle = getStarterPack('daily-briefs')!;
      const result = installBundle(PACK_TEST_DIR, bundle);

      expect(result.installed).toBe(true);
      expect(result.skipped.length).toBe(1);
      expect(result.skipped[0]).toContain('morning-brief');
      // evening-review should still be installed
      expect(existsSync(join(wfDir, 'evening-review.md'))).toBe(true);
    });

    it('should overwrite existing files when overwrite=true', () => {
      // Pre-create one file
      const wfDir = join(PACK_TEST_DIR, 'workflows');
      mkdirSync(wfDir, { recursive: true });
      writeFileSync(join(wfDir, 'morning-brief.md'), '# Custom content', 'utf-8');

      const bundle = getStarterPack('daily-briefs')!;
      const result = installBundle(PACK_TEST_DIR, bundle, { overwrite: true });

      expect(result.installed).toBe(true);
      expect(result.skipped.length).toBe(0);
      expect(result.files.length).toBe(2);
    });

    it('should install code-reviewer pack into multiple directories', () => {
      const bundle = getStarterPack('code-reviewer')!;
      const result = installBundle(PACK_TEST_DIR, bundle);

      expect(result.installed).toBe(true);
      expect(result.files.length).toBe(5);
      // Rules
      expect(existsSync(join(PACK_TEST_DIR, 'rules', 'code-quality.md'))).toBe(true);
      expect(existsSync(join(PACK_TEST_DIR, 'rules', 'review-standards.md'))).toBe(true);
      // Instincts
      expect(existsSync(join(PACK_TEST_DIR, 'instincts', 'review-pattern-detection.md'))).toBe(true);
      expect(existsSync(join(PACK_TEST_DIR, 'instincts', 'refactor-opportunity.md'))).toBe(true);
      // Skills
      expect(existsSync(join(PACK_TEST_DIR, 'skills', 'structured-review.md'))).toBe(true);
    });

    it('should install personal-assistant pack with workflows, instincts, and skills', () => {
      const bundle = getStarterPack('personal-assistant')!;
      const result = installBundle(PACK_TEST_DIR, bundle);

      expect(result.installed).toBe(true);
      expect(result.files.length).toBe(5);
      expect(existsSync(join(PACK_TEST_DIR, 'workflows', 'daily-planner.md'))).toBe(true);
      expect(existsSync(join(PACK_TEST_DIR, 'workflows', 'inbox-triage.md'))).toBe(true);
      expect(existsSync(join(PACK_TEST_DIR, 'instincts', 'clear-communication.md'))).toBe(true);
      expect(existsSync(join(PACK_TEST_DIR, 'instincts', 'context-awareness.md'))).toBe(true);
      expect(existsSync(join(PACK_TEST_DIR, 'skills', 'task-prioritization.md'))).toBe(true);
    });

    it('should install devops pack with rules, instincts, and skills', () => {
      const bundle = getStarterPack('devops')!;
      const result = installBundle(PACK_TEST_DIR, bundle);

      expect(result.installed).toBe(true);
      expect(result.files.length).toBe(5);
      expect(existsSync(join(PACK_TEST_DIR, 'rules', 'deployment-safety.md'))).toBe(true);
      expect(existsSync(join(PACK_TEST_DIR, 'rules', 'infrastructure-standards.md'))).toBe(true);
      expect(existsSync(join(PACK_TEST_DIR, 'instincts', 'anomaly-detection.md'))).toBe(true);
      expect(existsSync(join(PACK_TEST_DIR, 'instincts', 'change-risk-assessment.md'))).toBe(true);
      expect(existsSync(join(PACK_TEST_DIR, 'skills', 'incident-response.md'))).toBe(true);
    });
  });

  describe('multi-type packs', () => {
    it('should report multiple types in code-reviewer manifest', () => {
      const bundle = getStarterPack('code-reviewer')!;
      expect(bundle.manifest.types).toContain('rules');
      expect(bundle.manifest.types).toContain('instincts');
      expect(bundle.manifest.types).toContain('skills');
      expect(bundle.manifest.types.length).toBe(3);
    });

    it('should report multiple types in personal-assistant manifest', () => {
      const bundle = getStarterPack('personal-assistant')!;
      expect(bundle.manifest.types).toContain('workflows');
      expect(bundle.manifest.types).toContain('instincts');
      expect(bundle.manifest.types).toContain('skills');
      expect(bundle.manifest.types.length).toBe(3);
    });

    it('should report multiple types in devops manifest', () => {
      const bundle = getStarterPack('devops')!;
      expect(bundle.manifest.types).toContain('rules');
      expect(bundle.manifest.types).toContain('instincts');
      expect(bundle.manifest.types).toContain('skills');
      expect(bundle.manifest.types.length).toBe(3);
    });

    it('should have correct file counts for multi-type packs', () => {
      expect(getStarterPack('code-reviewer')!.files.length).toBe(5);
      expect(getStarterPack('personal-assistant')!.files.length).toBe(5);
      expect(getStarterPack('devops')!.files.length).toBe(5);
    });

    it('should have correct type distribution in code-reviewer', () => {
      const bundle = getStarterPack('code-reviewer')!;
      const byType = new Map<string, number>();
      for (const entry of bundle.manifest.files) {
        byType.set(entry.type, (byType.get(entry.type) ?? 0) + 1);
      }
      expect(byType.get('rules')).toBe(2);
      expect(byType.get('instincts')).toBe(2);
      expect(byType.get('skills')).toBe(1);
    });
  });
});
