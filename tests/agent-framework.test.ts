import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scaffoldHarness } from '../src/cli/scaffold.js';
import {
  createAgent,
  checkRuleViolation,
  checkAction,
} from '../src/runtime/agent-framework.js';

describe('agent-framework', () => {
  let harnessDir: string;
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'framework-test-'));
    harnessDir = join(tmpBase, 'test-agent');
    scaffoldHarness(harnessDir, 'test-agent');
  });

  afterEach(() => {
    if (existsSync(tmpBase)) {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  function createRule(id: string, content: string): void {
    writeFileSync(
      join(harnessDir, 'rules', `${id}.md`),
      `---\nid: ${id}\ntags: [test]\ncreated: 2024-01-01\nauthor: human\nstatus: active\nrelated: []\n---\n\n${content}`,
    );
  }

  describe('createAgent', () => {
    it('should create a defined agent with expected interface', () => {
      const agent = createAgent({
        name: 'test',
        dir: harnessDir,
      });

      expect(agent.name).toBe('test');
      expect(agent.definition.name).toBe('test');
      expect(agent.harness).toBeDefined();
      expect(typeof agent.boot).toBe('function');
      expect(typeof agent.run).toBe('function');
      expect(typeof agent.stream).toBe('function');
      expect(typeof agent.shutdown).toBe('function');
      expect(typeof agent.getState).toBe('function');
      expect(typeof agent.getSystemPrompt).toBe('function');
      expect(typeof agent.isBooted).toBe('function');
      expect(agent.isBooted()).toBe(false);
    });

    it('should accept lifecycle hooks', () => {
      let bootCalled = false;

      const agent = createAgent({
        name: 'test',
        dir: harnessDir,
        hooks: {
          onBoot: async () => { bootCalled = true; },
        },
      });

      expect(agent).toBeDefined();
      expect(bootCalled).toBe(false);
    });

    it('should accept guardrail config', () => {
      const agent = createAgent({
        name: 'test',
        dir: harnessDir,
        guardrails: {
          enforceRules: true,
          ruleTags: ['security'],
        },
      });

      expect(agent.definition.guardrails?.enforceRules).toBe(true);
    });

    it('should accept approval gate config', () => {
      const agent = createAgent({
        name: 'test',
        dir: harnessDir,
        approval: {
          requireApproval: (prompt) => prompt.includes('deploy'),
          onApprovalNeeded: async () => true,
        },
      });

      expect(agent.definition.approval).toBeDefined();
      expect(agent.definition.approval!.requireApproval!('deploy now')).toBe(true);
      expect(agent.definition.approval!.requireApproval!('hello')).toBe(false);
    });

    it('should accept middleware', () => {
      const agent = createAgent({
        name: 'test',
        dir: harnessDir,
        middleware: [
          async (_ctx, next) => {
            return next();
          },
        ],
      });

      expect(agent.definition.middleware).toHaveLength(1);
    });
  });

  describe('checkRuleViolation', () => {
    it('should detect rule violations from prompt keywords', () => {
      createRule('no-delete', '# No Deletion Rule\n\nNever delete production data.');

      const violation = checkRuleViolation(harnessDir, 'please delete the production data immediately');

      expect(violation).not.toBeNull();
      expect(violation).toContain('no-delete');
    });

    it('should return null when no rules are violated', () => {
      createRule('no-delete', '# No Deletion Rule\n\nNever delete production data.');

      const violation = checkRuleViolation(harnessDir, 'please help me write a test');

      expect(violation).toBeNull();
    });

    it('should handle empty rules directory', () => {
      const violation = checkRuleViolation(harnessDir, 'any prompt');

      expect(violation).toBeNull();
    });

    it('should filter rules by tags - skip non-matching tags', () => {
      writeFileSync(
        join(harnessDir, 'rules', 'security-rule.md'),
        '---\nid: security-rule\ntags: [security]\ncreated: 2024-01-01\nauthor: human\nstatus: active\nrelated: []\n---\n\nNever expose API keys in public repositories.',
      );

      // With non-matching tag, the security rule should be skipped
      const violation = checkRuleViolation(
        harnessDir,
        'I need to expose the API keys in this public repository',
        { ruleTags: ['performance'] },
      );
      expect(violation).toBeNull();
    });

    it('should skip inactive rules', () => {
      writeFileSync(
        join(harnessDir, 'rules', 'archived-rule.md'),
        '---\nid: archived-rule\ntags: [test]\ncreated: 2024-01-01\nauthor: human\nstatus: archived\nrelated: []\n---\n\nNever do anything at all.',
      );

      const violation = checkRuleViolation(harnessDir, 'I want to do something');

      const isFromArchived = violation?.includes('archived-rule') ?? false;
      expect(isFromArchived).toBe(false);
    });
  });

  describe('checkAction', () => {
    it('should return allowed: true when no violation', () => {
      const result = checkAction(harnessDir, 'write a test');

      expect(result.allowed).toBe(true);
      expect(result.reason).toBeNull();
    });

    it('should return allowed: false with reason on violation', () => {
      createRule('no-push', '# No Push\n\nNever push directly to main branch.');

      const result = checkAction(harnessDir, 'push directly to main branch now');

      expect(result.allowed).toBe(false);
      expect(result.reason).not.toBeNull();
      expect(result.reason).toContain('no-push');
    });
  });

  describe('approval gates', () => {
    it('should identify prompts needing approval', () => {
      const requireApproval = (prompt: string): boolean =>
        prompt.includes('deploy') || prompt.includes('delete');

      expect(requireApproval('deploy to production')).toBe(true);
      expect(requireApproval('delete all records')).toBe(true);
      expect(requireApproval('write a test')).toBe(false);
    });

    it('should compose with createAgent', () => {
      let approvalRequested = false;

      const agent = createAgent({
        name: 'test',
        dir: harnessDir,
        approval: {
          requireApproval: (prompt) => prompt.includes('deploy'),
          onApprovalNeeded: async () => {
            approvalRequested = true;
            return true;
          },
        },
      });

      expect(agent.definition.approval).toBeDefined();
      expect(approvalRequested).toBe(false);
    });
  });

  describe('middleware', () => {
    it('should chain multiple middleware functions', () => {
      const agent = createAgent({
        name: 'test',
        dir: harnessDir,
        middleware: [
          async (_ctx, next) => {
            return next();
          },
          async (_ctx, next) => {
            return next();
          },
        ],
      });

      expect(agent.definition.middleware).toHaveLength(2);
    });
  });

  describe('beforeRun hook', () => {
    it('should be configurable', () => {
      let hookCalled = false;

      const agent = createAgent({
        name: 'test',
        dir: harnessDir,
        hooks: {
          beforeRun: async () => {
            hookCalled = true;
          },
        },
      });

      expect(agent.definition.hooks?.beforeRun).toBeDefined();
      expect(hookCalled).toBe(false);
    });

    it('should support prompt modification', () => {
      const agent = createAgent({
        name: 'test',
        dir: harnessDir,
        hooks: {
          beforeRun: async ({ prompt }) => {
            return { prompt: prompt + ' (modified)' };
          },
        },
      });

      expect(agent.definition.hooks?.beforeRun).toBeDefined();
    });
  });
});
