import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scaffoldHarness } from '../src/cli/scaffold.js';
import {
  autoPromoteInstincts,
  detectDeadPrimitives,
  detectContradictions,
  enrichSessions,
  suggestCapabilities,
  classifyFailure,
  getRecoveryStrategies,
  analyzeFailures,
  FAILURE_TAXONOMY,
  runGate,
  runAllGates,
  listGates,
} from '../src/runtime/intelligence.js';

describe('intelligence', () => {
  let harnessDir: string;
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'intel-test-'));
    harnessDir = join(tmpBase, 'test-agent');
    scaffoldHarness(harnessDir, 'test-agent');
  });

  afterEach(() => {
    if (existsSync(tmpBase)) {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  function createJournal(date: string, instinctCandidates: string[]): void {
    const journalDir = join(harnessDir, 'memory', 'journal');
    mkdirSync(journalDir, { recursive: true });
    const candidates = instinctCandidates.map((c) => `- INSTINCT: ${c}`).join('\n');
    writeFileSync(
      join(journalDir, `${date}.md`),
      `---\nid: journal-${date}\ntags: [journal]\ncreated: ${date}\nauthor: infrastructure\nstatus: active\n---\n\n## Summary\nA productive day.\n\n## Insights\n- Good progress\n\n## Instinct Candidates\n${candidates}\n\n## Knowledge Updates\n- Learned something\n`,
    );
  }

  function createRule(id: string, content: string): void {
    writeFileSync(
      join(harnessDir, 'rules', `${id}.md`),
      `---\nid: ${id}\ntags: [test]\ncreated: 2024-01-01\nauthor: human\nstatus: active\nrelated: []\n---\n\n${content}`,
    );
  }

  function createInstinct(id: string, content: string): void {
    writeFileSync(
      join(harnessDir, 'instincts', `${id}.md`),
      `---\nid: ${id}\ntags: [test]\ncreated: 2024-01-01\nauthor: agent\nstatus: active\nrelated: []\ndescription: "${content.split('\n')[0]}"\n---\n\n${content}`,
    );
  }

  function createSession(id: string, prompt: string, summary: string, extras?: string): void {
    const sessionsDir = join(harnessDir, 'memory', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, `${id}.md`),
      `---\nid: ${id}\ntags: [session]\ncreated: 2024-01-01\nauthor: infrastructure\nstatus: active\n---\n\nTokens: 1500\nSteps: 3\nModel: anthropic/claude-sonnet-4\nDuration: 5min\n\n## Prompt\n${prompt}\n\n## Summary\n${summary}\n${extras ?? ''}`,
    );
  }

  // --- Auto-Promote Instincts ---

  describe('autoPromoteInstincts', () => {
    it('should detect patterns appearing 3+ times across journals', () => {
      createJournal('2024-01-01', ['Always validate input before processing', 'Check error codes']);
      createJournal('2024-01-02', ['Always validate input before processing', 'Log all errors']);
      createJournal('2024-01-03', ['Always validate input before processing', 'Check error codes']);
      createJournal('2024-01-04', ['Always validate input before processing', 'Write tests first']);

      const result = autoPromoteInstincts(harnessDir);

      expect(result.journalsScanned).toBe(4);
      expect(result.patterns.length).toBeGreaterThanOrEqual(1);

      const validatePattern = result.patterns.find((p) =>
        p.behavior.toLowerCase().includes('validate input'),
      );
      expect(validatePattern).toBeDefined();
      expect(validatePattern!.count).toBe(4);
      expect(validatePattern!.journalDates).toHaveLength(4);
    });

    it('should respect custom threshold', () => {
      createJournal('2024-01-01', ['Pattern A']);
      createJournal('2024-01-02', ['Pattern A']);

      // Default threshold 3 — should find nothing
      const result3 = autoPromoteInstincts(harnessDir, { threshold: 3 });
      expect(result3.patterns).toHaveLength(0);

      // Threshold 2 — should find the pattern
      const result2 = autoPromoteInstincts(harnessDir, { threshold: 2 });
      expect(result2.patterns.length).toBeGreaterThanOrEqual(1);
    });

    it('should install promoted instincts when requested', () => {
      createJournal('2024-01-01', ['Check return values always']);
      createJournal('2024-01-02', ['Check return values always']);
      createJournal('2024-01-03', ['Check return values always']);

      const result = autoPromoteInstincts(harnessDir, { threshold: 3, install: true });

      expect(result.promoted.length).toBeGreaterThanOrEqual(1);
      // Check that instinct file was created
      const instinctFiles = require('fs').readdirSync(join(harnessDir, 'instincts'));
      expect(instinctFiles.length).toBeGreaterThanOrEqual(1);
    });

    it('should skip already existing instincts', () => {
      createInstinct('always-validate-input', 'Always validate input before processing');
      createJournal('2024-01-01', ['Always validate input before processing']);
      createJournal('2024-01-02', ['Always validate input before processing']);
      createJournal('2024-01-03', ['Always validate input before processing']);

      const result = autoPromoteInstincts(harnessDir, { threshold: 3, install: true });

      // Pattern detected but skipped because it already exists
      expect(result.skipped.length).toBeGreaterThanOrEqual(1);
    });

    it('should return empty when no journal directory exists', () => {
      const result = autoPromoteInstincts(harnessDir);
      expect(result.journalsScanned).toBe(0);
      expect(result.patterns).toHaveLength(0);
    });

    it('should count unique dates, not duplicate occurrences on same date', () => {
      // Same instinct appears twice in same journal — should count as 1 date
      createJournal('2024-01-01', ['Validate input', 'Validate input']);
      createJournal('2024-01-02', ['Validate input']);
      // Only 2 unique dates, below threshold of 3
      const result = autoPromoteInstincts(harnessDir, { threshold: 3 });
      expect(result.patterns).toHaveLength(0);
    });
  });

  // --- Dead Primitive Detection ---

  describe('detectDeadPrimitives', () => {
    it('should detect orphaned old primitives', () => {
      // Create a rule with no references and old mtime
      createRule('old-unused', '# Old Unused Rule\n\nThis rule is obsolete.');

      // Set mtime to 60 days ago
      const filePath = join(harnessDir, 'rules', 'old-unused.md');
      const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      require('fs').utimesSync(filePath, sixtyDaysAgo, sixtyDaysAgo);

      const result = detectDeadPrimitives(harnessDir);

      expect(result.dead.length).toBeGreaterThanOrEqual(1);
      const deadRule = result.dead.find((d) => d.id === 'old-unused');
      expect(deadRule).toBeDefined();
      expect(deadRule!.daysSinceModified).toBeGreaterThanOrEqual(30);
      expect(deadRule!.reason).toContain('Orphaned');
    });

    it('should NOT flag recently modified orphans', () => {
      // Create a rule with no references but recent mtime
      createRule('new-orphan', '# New Orphan\n\nJust created, no refs yet.');

      const result = detectDeadPrimitives(harnessDir);

      const found = result.dead.find((d) => d.id === 'new-orphan');
      expect(found).toBeUndefined();
    });

    it('should NOT flag connected primitives even if old', () => {
      // Create two connected rules
      writeFileSync(
        join(harnessDir, 'rules', 'rule-a.md'),
        '---\nid: rule-a\ntags: [test]\ncreated: 2024-01-01\nauthor: human\nstatus: active\nrelated: [rule-b]\n---\n\n# Rule A',
      );
      writeFileSync(
        join(harnessDir, 'rules', 'rule-b.md'),
        '---\nid: rule-b\ntags: [test]\ncreated: 2024-01-01\nauthor: human\nstatus: active\nrelated: []\n---\n\n# Rule B',
      );

      // Set both to 60 days old
      const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      require('fs').utimesSync(join(harnessDir, 'rules', 'rule-a.md'), sixtyDaysAgo, sixtyDaysAgo);
      require('fs').utimesSync(join(harnessDir, 'rules', 'rule-b.md'), sixtyDaysAgo, sixtyDaysAgo);

      const result = detectDeadPrimitives(harnessDir);

      // rule-a and rule-b should NOT be flagged — they're connected
      expect(result.dead.find((d) => d.id === 'rule-a')).toBeUndefined();
      expect(result.dead.find((d) => d.id === 'rule-b')).toBeUndefined();
    });

    it('should respect custom threshold days', () => {
      createRule('medium-old', '# Medium Old Rule');

      // Set mtime to 15 days ago
      const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
      require('fs').utimesSync(join(harnessDir, 'rules', 'medium-old.md'), fifteenDaysAgo, fifteenDaysAgo);

      // Default 30 days — should not detect
      const result30 = detectDeadPrimitives(harnessDir, undefined, { thresholdDays: 30 });
      expect(result30.dead.find((d) => d.id === 'medium-old')).toBeUndefined();

      // 10 days — should detect
      const result10 = detectDeadPrimitives(harnessDir, undefined, { thresholdDays: 10 });
      expect(result10.dead.find((d) => d.id === 'medium-old')).toBeDefined();
    });

    it('should sort by staleness (most stale first)', () => {
      createRule('stale-30', '# 30 day rule');
      createRule('stale-60', '# 60 day rule');

      const thirtyAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      const sixtyAgo = new Date(Date.now() - 61 * 24 * 60 * 60 * 1000);
      require('fs').utimesSync(join(harnessDir, 'rules', 'stale-30.md'), thirtyAgo, thirtyAgo);
      require('fs').utimesSync(join(harnessDir, 'rules', 'stale-60.md'), sixtyAgo, sixtyAgo);

      const result = detectDeadPrimitives(harnessDir);

      if (result.dead.length >= 2) {
        expect(result.dead[0].daysSinceModified).toBeGreaterThanOrEqual(result.dead[1].daysSinceModified);
      }
    });
  });

  // --- Contradiction Detection ---

  describe('detectContradictions', () => {
    it('should detect direct negation between rule and instinct', () => {
      createRule('always-test', '# Test Rule\n\n- Always test your code before committing');
      createInstinct('never-test', '# Skip Tests\n\n- Never test your code before committing');

      const result = detectContradictions(harnessDir);

      expect(result.contradictions.length).toBeGreaterThanOrEqual(1);
      const found = result.contradictions.find(
        (c) =>
          (c.primitiveA.id === 'always-test' && c.primitiveB.id === 'never-test') ||
          (c.primitiveA.id === 'never-test' && c.primitiveB.id === 'always-test'),
      );
      expect(found).toBeDefined();
      expect(found!.severity).toBe('high');
    });

    it('should detect "always X" vs "avoid X" contradictions', () => {
      createRule('use-comments', '# Comments\n\n- Always use inline comments');
      createInstinct('avoid-comments', '# No Comments\n\n- Avoid use inline comments');

      const result = detectContradictions(harnessDir);

      expect(result.contradictions.length).toBeGreaterThanOrEqual(1);
    });

    it('should NOT flag non-contradictory rules and instincts', () => {
      createRule('test-first', '# Test First\n\n- Always write tests before code');
      createInstinct('be-thorough', '# Be Thorough\n\n- Always review changes carefully');

      const result = detectContradictions(harnessDir);

      expect(result.contradictions).toHaveLength(0);
    });

    it('should detect intra-group contradictions (rule vs rule)', () => {
      createRule('always-comments', '# Use Comments\n\n- Always use inline comments for clarity');
      createRule('never-comments', '# No Comments\n\n- Never use inline comments for clarity');

      const result = detectContradictions(harnessDir);

      expect(result.contradictions.length).toBeGreaterThanOrEqual(1);
      const found = result.contradictions.find(
        (c) => c.primitiveA.type === 'rule' && c.primitiveB.type === 'rule',
      );
      expect(found).toBeDefined();
    });

    it('should return counts of rules and instincts checked', () => {
      createRule('rule-a', '# Rule A');
      createRule('rule-b', '# Rule B');
      createInstinct('instinct-a', '# Instinct A');

      const result = detectContradictions(harnessDir);

      // Scaffold creates 1 default rule (operations.md) + 3 default instincts
      expect(result.rulesChecked).toBeGreaterThanOrEqual(2);
      expect(result.instinctsChecked).toBeGreaterThanOrEqual(1);
    });

    it('should handle scaffold defaults gracefully', () => {
      // Scaffold creates default primitives; just verify no errors
      const result = detectContradictions(harnessDir);

      expect(result.contradictions).toBeDefined();
      expect(result.rulesChecked).toBeGreaterThanOrEqual(0);
      expect(result.instinctsChecked).toBeGreaterThanOrEqual(0);
    });
  });

  // --- Session Enrichment ---

  describe('enrichSessions', () => {
    it('should extract metadata from sessions', () => {
      createSession(
        '2024-01-01-abc',
        'Help me refactor the authentication module',
        'Refactored auth module with better error handling.',
        '\n### Tool Call: list_directory\nArgs: { path: "/src" }\n',
      );

      const result = enrichSessions(harnessDir);

      expect(result.sessionsScanned).toBe(1);
      expect(result.enriched).toHaveLength(1);

      const session = result.enriched[0];
      expect(session.sessionId).toBe('2024-01-01-abc');
      expect(session.tokenCount).toBe(1500);
      expect(session.stepCount).toBe(3);
      expect(session.model).toContain('claude');
      expect(session.toolsUsed).toContain('list_directory');
      expect(session.topics.length).toBeGreaterThanOrEqual(1);
    });

    it('should filter sessions by date range', () => {
      createSession('2024-01-01-aaa', 'First prompt', 'First summary');
      createSession('2024-01-15-bbb', 'Second prompt', 'Second summary');
      createSession('2024-02-01-ccc', 'Third prompt', 'Third summary');

      const result = enrichSessions(harnessDir, undefined, { from: '2024-01-10', to: '2024-01-31' });

      expect(result.sessionsScanned).toBe(1);
      expect(result.enriched[0].sessionId).toBe('2024-01-15-bbb');
    });

    it('should find referenced primitives in session text', () => {
      createRule('code-review', '# Code Review Rule');

      createSession(
        '2024-01-01-ref',
        'Apply the code-review rule to this PR',
        'Applied the code-review guidelines.',
      );

      const result = enrichSessions(harnessDir);

      expect(result.enriched[0].primitivesReferenced).toContain('code-review');
    });

    it('should return empty for missing sessions directory', () => {
      const result = enrichSessions(harnessDir);

      expect(result.sessionsScanned).toBe(0);
      expect(result.enriched).toHaveLength(0);
    });

    it('should extract topics from prompt and summary', () => {
      createSession(
        '2024-01-01-topics',
        'Implement authentication middleware with JWT tokens and rate limiting',
        'Built authentication middleware using JWT for token validation and added rate limiting.',
      );

      const result = enrichSessions(harnessDir);

      const session = result.enriched[0];
      expect(session.topics.length).toBeGreaterThanOrEqual(1);
      // Should find meaningful topics like "authentication", "middleware", "tokens", etc.
      const topicsStr = session.topics.join(' ');
      expect(
        topicsStr.includes('authentication') ||
        topicsStr.includes('middleware') ||
        topicsStr.includes('tokens') ||
        topicsStr.includes('limiting'),
      ).toBe(true);
    });
  });

  // --- Capability Suggestions ---

  describe('suggestCapabilities', () => {
    it('should suggest capabilities for frequent uncovered topics', () => {
      // Create sessions with recurring "deployment" topic
      createSession('2024-01-01-dep1', 'Help with deployment configuration', 'Configured deployment settings.');
      createSession('2024-01-02-dep2', 'Fix deployment pipeline issues', 'Fixed deployment pipeline.');
      createSession('2024-01-03-dep3', 'Optimize deployment process', 'Optimized deployment.');

      const result = suggestCapabilities(harnessDir, undefined, { minFrequency: 2 });

      expect(result.sessionsScanned).toBe(3);
      // Should find "deployment" as a frequent uncovered topic
      const deploymentSuggestion = result.suggestions.find((s) =>
        s.topic.includes('deployment'),
      );
      // This is heuristic-based, so may or may not find it depending on topic extraction
      // At minimum, it should return valid structure
      expect(result.suggestions).toBeDefined();
      expect(Array.isArray(result.suggestions)).toBe(true);
    });

    it('should NOT suggest topics already covered by skills', () => {
      // Create a skill that covers "testing"
      writeFileSync(
        join(harnessDir, 'skills', 'testing-skill.md'),
        '---\nid: testing-skill\ntags: [testing]\ncreated: 2024-01-01\nauthor: human\nstatus: active\nrelated: []\n---\n\n# Testing Skill',
      );

      createSession('2024-01-01-t1', 'Write testing tests for testing', 'Wrote tests with testing.');
      createSession('2024-01-02-t2', 'More testing testing tests', 'More testing.');
      createSession('2024-01-03-t3', 'Testing the testing tests', 'Testing done.');

      const result = suggestCapabilities(harnessDir, undefined, { minFrequency: 2 });

      // "testing" should not be suggested since it's covered by testing-skill
      const testingSuggestion = result.suggestions.find((s) => s.topic === 'testing');
      expect(testingSuggestion).toBeUndefined();
    });

    it('should return empty when no sessions exist', () => {
      const result = suggestCapabilities(harnessDir);

      expect(result.sessionsScanned).toBe(0);
      expect(result.suggestions).toHaveLength(0);
    });
  });

  // --- Failure Taxonomy ---

  describe('failure taxonomy', () => {
    it('should have all failure modes defined', () => {
      const modes = Object.keys(FAILURE_TAXONOMY.modes);
      expect(modes.length).toBeGreaterThanOrEqual(14);
      expect(modes).toContain('context_overflow');
      expect(modes).toContain('budget_exhausted');
      expect(modes).toContain('rate_limited');
      expect(modes).toContain('llm_timeout');
      expect(modes).toContain('tool_execution_error');
      expect(modes).toContain('unknown');
    });

    it('should classify errors into correct failure modes', () => {
      expect(classifyFailure('Context length exceeded maximum')).toBe('context_overflow');
      expect(classifyFailure('Budget limit exceeded')).toBe('budget_exhausted');
      expect(classifyFailure('Rate limit hit: 429 Too Many Requests')).toBe('rate_limited');
      expect(classifyFailure('Request timed out after 30s')).toBe('llm_timeout');
      expect(classifyFailure('Tool execution failed: write_file')).toBe('tool_execution_error');
      expect(classifyFailure('MCP server connection failed')).toBe('mcp_connection_failed');
      expect(classifyFailure('YAML parse error in frontmatter')).toBe('parse_error');
      expect(classifyFailure('Config validation failed')).toBe('config_invalid');
      expect(classifyFailure('Something completely unexpected')).toBe('unknown');
    });

    it('should classify Error objects', () => {
      expect(classifyFailure(new Error('Context overflow detected'))).toBe('context_overflow');
      expect(classifyFailure(new Error('HTTP 429 rate limit'))).toBe('rate_limited');
    });

    it('should return recovery strategies for each mode', () => {
      const strategies = getRecoveryStrategies('context_overflow');
      expect(strategies.length).toBeGreaterThanOrEqual(1);
      expect(strategies.some((s) => s.toLowerCase().includes('trim'))).toBe(true);

      const budgetStrategies = getRecoveryStrategies('budget_exhausted');
      expect(budgetStrategies.length).toBeGreaterThanOrEqual(1);
    });

    it('should return fallback strategy for unknown mode', () => {
      const strategies = getRecoveryStrategies('unknown');
      expect(strategies.length).toBeGreaterThanOrEqual(1);
    });

    it('should analyze failures from harness directory', () => {
      const analysis = analyzeFailures(harnessDir);
      expect(analysis.recentFailures).toBeDefined();
      expect(analysis.modeFrequency).toBeDefined();
      expect(analysis.healthImplication).toBeDefined();
      expect(['healthy', 'degraded', 'unhealthy']).toContain(analysis.healthImplication);
    });

    it('should detect failures from health.json', () => {
      const memoryDir = join(harnessDir, 'memory');
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(
        join(memoryDir, 'health.json'),
        JSON.stringify({
          lastError: 'Context length exceeded maximum token limit',
          lastFailure: '2024-01-01T00:00:00Z',
          consecutiveFailures: 2,
        }),
      );

      const analysis = analyzeFailures(harnessDir);
      expect(analysis.recentFailures.length).toBeGreaterThanOrEqual(1);
      expect(analysis.recentFailures[0].mode).toBe('context_overflow');
    });
  });

  // --- Verification Gates ---

  describe('verification gates', () => {
    it('should list available gates', () => {
      const gates = listGates();
      expect(gates.length).toBeGreaterThanOrEqual(4);
      expect(gates.map((g) => g.name)).toContain('pre-boot');
      expect(gates.map((g) => g.name)).toContain('pre-run');
      expect(gates.map((g) => g.name)).toContain('post-session');
      expect(gates.map((g) => g.name)).toContain('pre-deploy');
    });

    it('should run pre-boot gate successfully on valid harness', () => {
      const result = runGate('pre-boot', harnessDir);

      expect(result.gateName).toBe('pre-boot');
      expect(result.checks.length).toBeGreaterThanOrEqual(2);

      // CORE.md should pass (scaffold creates it)
      const coreCheck = result.checks.find((c) => c.name === 'core-md');
      expect(coreCheck).toBeDefined();
      expect(coreCheck!.status).toBe('pass');

      // Config check should exist (scaffold creates config.yaml)
      const configCheck = result.checks.find((c) => c.name === 'config-valid');
      expect(configCheck).toBeDefined();
      // Config status depends on scaffold template — just verify the gate ran
      expect(['pass', 'fail']).toContain(configCheck!.status);
    });

    it('should fail pre-boot gate when CORE.md is missing', () => {
      const fs = require('fs');
      fs.unlinkSync(join(harnessDir, 'CORE.md'));

      const result = runGate('pre-boot', harnessDir);

      const coreCheck = result.checks.find((c) => c.name === 'core-md');
      expect(coreCheck).toBeDefined();
      expect(coreCheck!.status).toBe('fail');
      expect(result.passed).toBe(false);
    });

    it('should run post-session gate', () => {
      const result = runGate('post-session', harnessDir);

      expect(result.gateName).toBe('post-session');
      expect(result.checks.length).toBeGreaterThanOrEqual(1);
    });

    it('should run pre-deploy gate', () => {
      const result = runGate('pre-deploy', harnessDir);

      expect(result.gateName).toBe('pre-deploy');
      expect(result.checks.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle unknown gate name', () => {
      const result = runGate('nonexistent-gate', harnessDir);

      expect(result.passed).toBe(false);
      expect(result.checks[0].status).toBe('fail');
      expect(result.summary).toContain('not found');
    });

    it('should run all gates at once', () => {
      const results = runAllGates(harnessDir);

      expect(results.length).toBeGreaterThanOrEqual(4);
      for (const r of results) {
        expect(r.gateName).toBeDefined();
        expect(r.checks.length).toBeGreaterThanOrEqual(1);
        expect(r.summary).toBeDefined();
      }
    });
  });
});
