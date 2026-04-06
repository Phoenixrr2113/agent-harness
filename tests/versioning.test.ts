import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { scaffoldHarness } from '../src/cli/scaffold.js';
import {
  isGitRepo,
  initVersioning,
  snapshot,
  getVersionLog,
  getVersionDiff,
  rollback,
  listTags,
  tagVersion,
  getPendingChanges,
  getFileHistory,
  getFileAtVersion,
} from '../src/runtime/versioning.js';

describe('versioning', () => {
  let harnessDir: string;
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'version-test-'));
    harnessDir = join(tmpBase, 'test-agent');
    scaffoldHarness(harnessDir, 'test-agent', { template: 'base' });
  });

  afterEach(() => {
    if (existsSync(tmpBase)) {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  describe('isGitRepo', () => {
    it('should return false for non-git directory', () => {
      expect(isGitRepo(harnessDir)).toBe(false);
    });

    it('should return true after init', () => {
      initVersioning(harnessDir);
      expect(isGitRepo(harnessDir)).toBe(true);
    });
  });

  describe('initVersioning', () => {
    it('should initialize a git repository', () => {
      const result = initVersioning(harnessDir);
      expect(result).toBe(true);
      expect(existsSync(join(harnessDir, '.git'))).toBe(true);
    });

    it('should preserve existing .gitignore or create one', () => {
      initVersioning(harnessDir);
      const gitignorePath = join(harnessDir, '.gitignore');
      expect(existsSync(gitignorePath)).toBe(true);
      const gitignore = readFileSync(gitignorePath, 'utf-8');
      // Should have some content (either scaffold or versioning default)
      expect(gitignore.length).toBeGreaterThan(0);
    });

    it('should be idempotent', () => {
      initVersioning(harnessDir);
      const result = initVersioning(harnessDir);
      expect(result).toBe(true);
    });

    it('should create initial commit', () => {
      initVersioning(harnessDir);
      const log = getVersionLog(harnessDir);
      expect(log.entries.length).toBeGreaterThanOrEqual(1);
      expect(log.entries[0].message).toBe('Initial harness version');
    });
  });

  describe('snapshot', () => {
    it('should create a versioned snapshot', () => {
      initVersioning(harnessDir);

      // Make a change
      writeFileSync(join(harnessDir, 'rules', 'new-rule.md'), '---\nid: new-rule\ntags: [test]\ncreated: 2024-01-01\nauthor: human\nstatus: active\nrelated: []\n---\n\nA new rule.');

      const result = snapshot(harnessDir, 'Added new rule');
      expect(result.success).toBe(true);
      expect(result.hash.length).toBeGreaterThan(0);
      expect(result.files).toContain('rules/new-rule.md');
    });

    it('should handle no changes gracefully', () => {
      initVersioning(harnessDir);
      const result = snapshot(harnessDir, 'No changes');
      expect(result.success).toBe(true);
      expect(result.error).toContain('No changes');
    });

    it('should apply a tag when requested', () => {
      initVersioning(harnessDir);
      writeFileSync(join(harnessDir, 'rules', 'tagged.md'), '---\nid: tagged\ntags: []\ncreated: 2024-01-01\nauthor: human\nstatus: active\nrelated: []\n---\n\nTagged rule.');

      const result = snapshot(harnessDir, 'Tagged version', { tag: 'v1.0.0' });
      expect(result.success).toBe(true);

      const tags = listTags(harnessDir);
      expect(tags.some((t) => t.tag === 'v1.0.0')).toBe(true);
    });

    it('should auto-initialize git if needed', () => {
      writeFileSync(join(harnessDir, 'rules', 'auto-init.md'), '---\nid: auto-init\ntags: []\ncreated: 2024-01-01\nauthor: human\nstatus: active\nrelated: []\n---\n\nAuto-init test.');

      const result = snapshot(harnessDir, 'Auto-init snapshot');
      expect(result.success).toBe(true);
      expect(isGitRepo(harnessDir)).toBe(true);
    });
  });

  describe('getVersionLog', () => {
    it('should return empty log for non-git dir', () => {
      const log = getVersionLog(harnessDir);
      expect(log.entries).toHaveLength(0);
    });

    it('should return version history', () => {
      initVersioning(harnessDir);

      writeFileSync(join(harnessDir, 'rules', 'v1.md'), '---\nid: v1\ntags: []\ncreated: 2024-01-01\nauthor: human\nstatus: active\nrelated: []\n---\n\nVersion 1.');
      snapshot(harnessDir, 'Version 1');

      writeFileSync(join(harnessDir, 'rules', 'v2.md'), '---\nid: v2\ntags: []\ncreated: 2024-01-01\nauthor: human\nstatus: active\nrelated: []\n---\n\nVersion 2.');
      snapshot(harnessDir, 'Version 2');

      const log = getVersionLog(harnessDir);
      expect(log.entries.length).toBeGreaterThanOrEqual(3); // init + v1 + v2
      expect(log.entries[0].message).toBe('Version 2');
      expect(log.entries[1].message).toBe('Version 1');
    });

    it('should respect limit', () => {
      initVersioning(harnessDir);

      for (let i = 0; i < 5; i++) {
        writeFileSync(join(harnessDir, 'rules', `r${i}.md`), `---\nid: r${i}\ntags: []\ncreated: 2024-01-01\nauthor: human\nstatus: active\nrelated: []\n---\n\nRule ${i}.`);
        snapshot(harnessDir, `Version ${i}`);
      }

      const log = getVersionLog(harnessDir, { limit: 3 });
      expect(log.entries).toHaveLength(3);
    });
  });

  describe('getVersionDiff', () => {
    it('should show changes between versions', () => {
      initVersioning(harnessDir);
      const log1 = getVersionLog(harnessDir);
      const hash1 = log1.currentHash;

      writeFileSync(join(harnessDir, 'rules', 'diff-test.md'), '---\nid: diff-test\ntags: []\ncreated: 2024-01-01\nauthor: human\nstatus: active\nrelated: []\n---\n\nDiff test.');
      snapshot(harnessDir, 'Added diff-test');

      const diff = getVersionDiff(harnessDir, hash1);
      expect(diff.entries.length).toBeGreaterThan(0);
      expect(diff.entries.some((e) => e.file.includes('diff-test'))).toBe(true);
    });
  });

  describe('rollback', () => {
    it('should restore files to a previous version', () => {
      initVersioning(harnessDir);

      // Version 1: add a rule
      writeFileSync(join(harnessDir, 'rules', 'rollback.md'), '---\nid: rollback\ntags: []\ncreated: 2024-01-01\nauthor: human\nstatus: active\nrelated: []\n---\n\nOriginal content.');
      snapshot(harnessDir, 'Add rule');

      const log1 = getVersionLog(harnessDir);
      const v1Hash = log1.entries[0].fullHash;

      // Version 2: modify the rule
      writeFileSync(join(harnessDir, 'rules', 'rollback.md'), '---\nid: rollback\ntags: []\ncreated: 2024-01-01\nauthor: human\nstatus: active\nrelated: []\n---\n\nModified content.');
      snapshot(harnessDir, 'Modify rule');

      // Rollback to v1
      const result = rollback(harnessDir, v1Hash);
      expect(result.success).toBe(true);

      // Verify content was restored
      const content = readFileSync(join(harnessDir, 'rules', 'rollback.md'), 'utf-8');
      expect(content).toContain('Original content');
    });

    it('should fail for invalid hash', () => {
      initVersioning(harnessDir);
      const result = rollback(harnessDir, 'invalidhash123');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid version');
    });

    it('should preserve full history', () => {
      initVersioning(harnessDir);

      writeFileSync(join(harnessDir, 'rules', 'history.md'), '---\nid: history\ntags: []\ncreated: 2024-01-01\nauthor: human\nstatus: active\nrelated: []\n---\n\nV1.');
      snapshot(harnessDir, 'V1');

      const v1Hash = getVersionLog(harnessDir).entries[0].fullHash;

      writeFileSync(join(harnessDir, 'rules', 'history.md'), '---\nid: history\ntags: []\ncreated: 2024-01-01\nauthor: human\nstatus: active\nrelated: []\n---\n\nV2.');
      snapshot(harnessDir, 'V2');

      rollback(harnessDir, v1Hash);

      // Full history preserved (init + v1 + v2 + rollback)
      const log = getVersionLog(harnessDir);
      expect(log.entries.length).toBeGreaterThanOrEqual(4);
      expect(log.entries[0].message).toContain('Rollback');
    });
  });

  describe('tags', () => {
    it('should list empty tags', () => {
      initVersioning(harnessDir);
      const tags = listTags(harnessDir);
      expect(tags).toHaveLength(0);
    });

    it('should create and list tags', () => {
      initVersioning(harnessDir);
      tagVersion(harnessDir, 'v0.1.0');

      const tags = listTags(harnessDir);
      expect(tags).toHaveLength(1);
      expect(tags[0].tag).toBe('v0.1.0');
    });

    it('should create annotated tags with message', () => {
      initVersioning(harnessDir);
      const result = tagVersion(harnessDir, 'v1.0.0', 'First stable release');
      expect(result).toBe(true);

      const tags = listTags(harnessDir);
      expect(tags.some((t) => t.tag === 'v1.0.0')).toBe(true);
    });
  });

  describe('getPendingChanges', () => {
    it('should detect uncommitted changes', () => {
      initVersioning(harnessDir);

      writeFileSync(join(harnessDir, 'rules', 'pending.md'), '---\nid: pending\ntags: []\ncreated: 2024-01-01\nauthor: human\nstatus: active\nrelated: []\n---\n\nPending.');

      const changes = getPendingChanges(harnessDir);
      expect(changes.length).toBeGreaterThan(0);
      expect(changes.some((c) => c.file.includes('pending'))).toBe(true);
    });

    it('should return empty for clean state', () => {
      initVersioning(harnessDir);
      const changes = getPendingChanges(harnessDir);
      expect(changes).toHaveLength(0);
    });
  });

  describe('file history', () => {
    it('should track file changes across versions', () => {
      initVersioning(harnessDir);

      writeFileSync(join(harnessDir, 'rules', 'tracked.md'), '---\nid: tracked\ntags: []\ncreated: 2024-01-01\nauthor: human\nstatus: active\nrelated: []\n---\n\nV1.');
      snapshot(harnessDir, 'Create tracked');

      writeFileSync(join(harnessDir, 'rules', 'tracked.md'), '---\nid: tracked\ntags: []\ncreated: 2024-01-01\nauthor: human\nstatus: active\nrelated: []\n---\n\nV2.');
      snapshot(harnessDir, 'Update tracked');

      const history = getFileHistory(harnessDir, 'rules/tracked.md');
      expect(history.length).toBeGreaterThanOrEqual(2);
    });

    it('should get file content at specific version', () => {
      initVersioning(harnessDir);

      writeFileSync(join(harnessDir, 'rules', 'content.md'), '---\nid: content\ntags: []\ncreated: 2024-01-01\nauthor: human\nstatus: active\nrelated: []\n---\n\nOriginal.');
      snapshot(harnessDir, 'Create content');

      const hash = getVersionLog(harnessDir).entries[0].fullHash;

      writeFileSync(join(harnessDir, 'rules', 'content.md'), '---\nid: content\ntags: []\ncreated: 2024-01-01\nauthor: human\nstatus: active\nrelated: []\n---\n\nModified.');
      snapshot(harnessDir, 'Modify content');

      const oldContent = getFileAtVersion(harnessDir, 'rules/content.md', hash);
      expect(oldContent).toContain('Original');
      expect(oldContent).not.toContain('Modified');
    });
  });
});
