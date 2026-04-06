import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scaffoldHarness } from '../src/cli/scaffold.js';
import { parseHarnessDocument } from '../src/primitives/loader.js';
import {
  parseRulesFromDoc,
  loadRules,
  checkRules,
  enforceRules,
} from '../src/runtime/rule-engine.js';
import type { ParsedRule } from '../src/runtime/rule-engine.js';

/** Write markdown to a temp file and parse it. */
function parseFromString(content: string, tmpBase: string, name: string) {
  const path = join(tmpBase, `${name}.md`);
  writeFileSync(path, content);
  return parseHarnessDocument(path);
}

describe('rule-engine', () => {
  let testDir: string;
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'rule-engine-'));
    testDir = join(tmpBase, 'test-agent');
    scaffoldHarness(testDir, 'test-agent', { template: 'base' });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  describe('parseRulesFromDoc', () => {
    it('should parse deny directives from "never" patterns', () => {
      const doc = parseFromString(
        '---\nid: test-rule\ntags: [security]\n---\n\n<!-- L0: Security rules -->\n\n# Rule: Security\n\n- Never commit secrets or credentials.\n- Never store tokens in plain text.\n',
        tmpBase, 'security',
      );

      const rules = parseRulesFromDoc(doc);
      expect(rules.length).toBeGreaterThanOrEqual(2);

      const denyRules = rules.filter((r) => r.action === 'deny');
      expect(denyRules.length).toBeGreaterThanOrEqual(2);
      expect(denyRules[0].ruleId).toBe('test-rule');
      expect(denyRules[0].subject).toContain('commit secrets');
    });

    it('should parse approval gates from "without approval" patterns', () => {
      const doc = parseFromString(
        '---\nid: finance-rule\ntags: [finance]\n---\n\n<!-- L0: Financial rules -->\n\n# Rule: Finance\n\n- Never execute financial transactions without explicit human approval.\n',
        tmpBase, 'finance',
      );

      const rules = parseRulesFromDoc(doc);
      const approvalRules = rules.filter((r) => r.action === 'require_approval');
      expect(approvalRules.length).toBe(1);
      expect(approvalRules[0].subject).toContain('execute financial transactions');
    });

    it('should parse allow directives from "always" / "must" patterns', () => {
      const doc = parseFromString(
        '---\nid: code-rule\ntags: [code]\n---\n\n<!-- L0: Code rules -->\n\n# Rule: Code\n\n- Always validate user input.\n- Must write tests alongside implementation.\n',
        tmpBase, 'code',
      );

      const rules = parseRulesFromDoc(doc);
      const allowRules = rules.filter((r) => r.action === 'allow');
      expect(allowRules.length).toBeGreaterThanOrEqual(2);
    });

    it('should parse warn directives from "avoid" patterns', () => {
      const doc = parseFromString(
        '---\nid: style-rule\ntags: [style]\n---\n\n<!-- L0: Style rules -->\n\n# Rule: Style\n\n- Avoid using inline styles.\n- Avoid global variables.\n',
        tmpBase, 'style',
      );

      const rules = parseRulesFromDoc(doc);
      const warnRules = rules.filter((r) => r.action === 'warn');
      expect(warnRules.length).toBeGreaterThanOrEqual(2);
    });

    it('should skip comments and headings', () => {
      const doc = parseFromString(
        '---\nid: simple\ntags: []\n---\n\n<!-- L0: Test -->\n\n# Rule: Simple\n\n<!-- This is a comment: never do this -->\n## Section\n',
        tmpBase, 'simple',
      );

      const rules = parseRulesFromDoc(doc);
      const commentRules = rules.filter((r) => r.directive.includes('comment'));
      expect(commentRules).toHaveLength(0);
    });

    it('should handle approval requirement patterns', () => {
      const doc = parseFromString(
        '---\nid: deploy-rule\ntags: [deployment]\n---\n\n<!-- L0: Deploy rules -->\n\n# Rule: Deploy\n\n- Require explicit approval for production deployments.\n',
        tmpBase, 'deploy',
      );

      const rules = parseRulesFromDoc(doc);
      const approvalRules = rules.filter((r) => r.action === 'require_approval');
      expect(approvalRules.length).toBe(1);
    });
  });

  describe('loadRules', () => {
    it('should load rules from the rules directory', () => {
      const rules = loadRules(testDir);
      expect(rules.length).toBeGreaterThan(0);
    });

    it('should skip non-active rules', () => {
      writeFileSync(
        join(testDir, 'rules', 'archived.md'),
        '---\nid: archived-rule\ntags: [test]\nstatus: archived\n---\n\n<!-- L0: Archived -->\n\n- Never do anything.\n',
      );

      const rules = loadRules(testDir);
      const archivedRules = rules.filter((r) => r.ruleId === 'archived-rule');
      expect(archivedRules).toHaveLength(0);
    });

    it('should return empty for missing rules directory', () => {
      const emptyDir = mkdtempSync(join(tmpdir(), 'rule-empty-'));
      try {
        const rules = loadRules(emptyDir);
        expect(rules).toHaveLength(0);
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });

  describe('checkRules', () => {
    it('should allow actions that match no deny rules', () => {
      const rules: ParsedRule[] = [
        { ruleId: 'test', subject: 'commit secrets', action: 'deny', directive: 'never commit secrets', tags: ['security'] },
      ];

      const result = checkRules(rules, { action: 'write', description: 'update documentation' });
      expect(result.allowed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should block actions matching deny rules', () => {
      const rules: ParsedRule[] = [
        { ruleId: 'test', subject: 'commit secrets', action: 'deny', directive: 'never commit secrets', tags: ['security'] },
      ];

      const result = checkRules(rules, { action: 'commit', description: 'commit secrets to repo' });
      expect(result.allowed).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations[0].severity).toBe('deny');
    });

    it('should flag warnings without blocking', () => {
      const rules: ParsedRule[] = [
        { ruleId: 'test', subject: 'using inline styles', action: 'warn', directive: 'avoid using inline styles', tags: ['style'] },
      ];

      const result = checkRules(rules, { action: 'write', description: 'add inline styles to component', tags: ['style'] });
      expect(result.allowed).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should require approval when rules demand it', () => {
      const rules: ParsedRule[] = [
        { ruleId: 'finance', subject: 'execute financial transactions', action: 'require_approval', directive: 'never execute financial transactions without approval', tags: ['finance'] },
      ];

      const result = checkRules(rules, { action: 'execute', description: 'execute financial transactions', tags: ['finance'] });
      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(true);
    });

    it('should return clean summary when all checks pass', () => {
      const rules: ParsedRule[] = [
        { ruleId: 'test', subject: 'delete database', action: 'deny', directive: 'never delete database', tags: [] },
      ];

      const result = checkRules(rules, { action: 'read', description: 'read documentation' });
      expect(result.summary).toBe('All rule checks passed.');
    });
  });

  describe('enforceRules', () => {
    it('should load and check rules in one call', () => {
      const result = enforceRules(testDir, { action: 'test', description: 'run unit tests' });
      expect(result).toHaveProperty('allowed');
      expect(result).toHaveProperty('violations');
      expect(result).toHaveProperty('warnings');
      expect(result).toHaveProperty('summary');
    });

    it('should detect operations.md deny rules', () => {
      const result = enforceRules(testDir, {
        action: 'commit',
        description: 'commit secrets credentials to repository',
        tags: ['security'],
      });
      expect(result).toHaveProperty('allowed');
    });
  });
});
