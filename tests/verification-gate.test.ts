import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scaffoldHarness } from '../src/cli/scaffold.js';
import { parseHarnessDocument } from '../src/primitives/loader.js';
import {
  extractGates,
  loadGates,
  getGatesForPlaybook,
  checkGate,
  checkAllGates,
} from '../src/runtime/verification-gate.js';

/** Write markdown to a temp file and parse it. */
function parseFromString(content: string, tmpBase: string, name: string) {
  const path = join(tmpBase, `${name}.md`);
  writeFileSync(path, content);
  return parseHarnessDocument(path);
}

describe('verification-gate', () => {
  let testDir: string;
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'vgate-'));
    testDir = join(tmpBase, 'test-agent');
    scaffoldHarness(testDir, 'test-agent', { template: 'base' });
    // Legacy `playbooks/` is no longer scaffolded by `harness init`
    // (per spec #2 collapse), but the runtime still reads from it for
    // backward-compat with pre-collapse harnesses. Tests create the dir.
    mkdirSync(join(testDir, 'playbooks'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  describe('extractGates', () => {
    it('should extract gates from named gate sections', () => {
      const doc = parseFromString(
        '---\nid: deploy-playbook\ntags: [deployment]\n---\n\n<!-- L0: Deployment playbook -->\n\n# Playbook: Deploy\n\n## Gate: Pre-Deploy\n- All tests passing\n- No lint errors\n- Version bumped\n\n## Steps\n1. Build\n2. Test\n3. Deploy\n',
        tmpBase, 'deploy',
      );

      const gates = extractGates(doc);
      expect(gates.length).toBeGreaterThanOrEqual(1);

      const preDeploy = gates.find((g) => g.stage === 'Pre-Deploy');
      expect(preDeploy).toBeDefined();
      expect(preDeploy!.criteria.length).toBe(3);
      expect(preDeploy!.criteria[0].description).toContain('All tests passing');
      expect(preDeploy!.criteria[0].manual).toBe(true);
    });

    it('should extract gates from acceptance criteria sections', () => {
      const doc = parseFromString(
        '---\nid: feature-playbook\ntags: [development]\n---\n\n<!-- L0: Feature playbook -->\n\n# Playbook: Feature\n\n### Acceptance Criteria\n- Feature works as specified\n- `npm test` passes\n- No regressions\n',
        tmpBase, 'feature',
      );

      const gates = extractGates(doc);
      expect(gates.length).toBeGreaterThanOrEqual(1);

      const acGate = gates.find((g) => g.id.includes('ac-'));
      expect(acGate).toBeDefined();
      expect(acGate!.criteria.length).toBe(3);

      const npmTest = acGate!.criteria.find((c) => c.command === 'npm test');
      expect(npmTest).toBeDefined();
      expect(npmTest!.manual).toBe(false);
    });

    it('should extract inline gate markers', () => {
      const doc = parseFromString(
        '---\nid: quick-check\ntags: [check]\n---\n\n<!-- L0: Quick check -->\n\n# Playbook: Quick\n\n<!-- gate: All unit tests pass -->\n\nDo the work.\n\n<!-- gate: Run `npm run lint` successfully -->\n',
        tmpBase, 'quick',
      );

      const gates = extractGates(doc);
      const inlineGates = gates.filter((g) => g.stage === 'inline');
      expect(inlineGates.length).toBe(2);
    });

    it('should extract step gates from checkbox items', () => {
      const doc = parseFromString(
        '---\nid: ship-feature\ntags: [shipping]\n---\n\n<!-- L0: Ship a feature -->\n\n# Playbook: Ship Feature\n\n1. **Understand** — Read the ask.\n- [ ] Requirements are clear\n- [ ] No ambiguity in spec\n\n2. **Build** — Write code.\n- [ ] Code compiles\n- [ ] `npm test` passes\n\n3. **Verify** — Check everything.\n- [ ] Manual smoke test done\n',
        tmpBase, 'ship',
      );

      const gates = extractGates(doc);
      const stepGates = gates.filter((g) => g.id.includes('step-'));
      expect(stepGates.length).toBeGreaterThanOrEqual(2);

      const buildGate = stepGates.find((g) => g.stage === 'Build');
      if (buildGate) {
        expect(buildGate.criteria.length).toBe(2);
        const npmTestCriterion = buildGate.criteria.find((c) => c.command === 'npm test');
        expect(npmTestCriterion).toBeDefined();
      }
    });

    it('should return empty array for docs without gates', () => {
      const doc = parseFromString(
        '---\nid: simple-doc\ntags: []\n---\n\n<!-- L0: Simple doc -->\n\nJust some text with no gate markers.\n',
        tmpBase, 'simple',
      );

      const gates = extractGates(doc);
      expect(gates).toHaveLength(0);
    });

    it('should avoid duplicate gates', () => {
      const doc = parseFromString(
        '---\nid: dup-test\ntags: []\n---\n\n<!-- L0: Dup test -->\n\n## Gate: Pre-Build\n- Code compiles\n\n## Gate: Pre-Build\n- Code compiles\n',
        tmpBase, 'dup',
      );

      const gates = extractGates(doc);
      const preBuildGates = gates.filter((g) => g.stage === 'Pre-Build');
      expect(preBuildGates.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('loadGates', () => {
    it('should load gates from playbooks directory', () => {
      writeFileSync(
        join(testDir, 'playbooks', 'test-flow.md'),
        '---\nid: test-flow\ntags: [test]\nstatus: active\n---\n\n<!-- L0: Test flow -->\n\n# Playbook: Test Flow\n\n## Gate: Pre-Test\n- Environment set up\n- Dependencies installed\n',
      );

      const { gates, sources } = loadGates(testDir);
      const testGates = gates.filter((g) => g.sourceId === 'test-flow');
      expect(testGates.length).toBeGreaterThanOrEqual(1);
      expect(sources).toContain('test-flow');
    });

    it('should skip archived playbooks', () => {
      writeFileSync(
        join(testDir, 'playbooks', 'old-flow.md'),
        '---\nid: old-flow\ntags: [test]\nstatus: archived\n---\n\n<!-- L0: Old flow -->\n\n## Gate: Pre-Test\n- Should not appear\n',
      );

      const { gates } = loadGates(testDir);
      const oldGates = gates.filter((g) => g.sourceId === 'old-flow');
      expect(oldGates).toHaveLength(0);
    });

    it('should handle missing playbooks/workflows directories', () => {
      const emptyDir = mkdtempSync(join(tmpdir(), 'vgate-empty-'));
      try {
        const { gates, sources } = loadGates(emptyDir);
        expect(gates).toHaveLength(0);
        expect(sources).toHaveLength(0);
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });

  describe('getGatesForPlaybook', () => {
    it('should filter gates by playbook ID', () => {
      writeFileSync(
        join(testDir, 'playbooks', 'alpha.md'),
        '---\nid: alpha\ntags: []\nstatus: active\n---\n\n<!-- L0: Alpha -->\n\n## Gate: Check\n- Alpha check\n',
      );
      writeFileSync(
        join(testDir, 'playbooks', 'beta.md'),
        '---\nid: beta\ntags: []\nstatus: active\n---\n\n<!-- L0: Beta -->\n\n## Gate: Check\n- Beta check\n',
      );

      const alphaGates = getGatesForPlaybook(testDir, 'alpha');
      const betaGates = getGatesForPlaybook(testDir, 'beta');

      expect(alphaGates.every((g) => g.sourceId === 'alpha')).toBe(true);
      expect(betaGates.every((g) => g.sourceId === 'beta')).toBe(true);
    });
  });

  describe('checkGate', () => {
    it('should pass when all manual criteria are verified', () => {
      const gate = {
        id: 'test:pre-deploy',
        stage: 'Pre-Deploy',
        sourceId: 'test',
        criteria: [
          { description: 'All tests pass', manual: true },
          { description: 'Code reviewed', manual: true },
        ],
      };

      const manualResults = new Map<string, boolean>();
      manualResults.set('All tests pass', true);
      manualResults.set('Code reviewed', true);

      const result = checkGate(gate, manualResults);
      expect(result.passed).toBe(true);
      expect(result.pendingManual).toHaveLength(0);
    });

    it('should fail when manual criteria are not provided', () => {
      const gate = {
        id: 'test:check',
        stage: 'Check',
        sourceId: 'test',
        criteria: [
          { description: 'Manual check required', manual: true },
        ],
      };

      const result = checkGate(gate);
      expect(result.passed).toBe(false);
      expect(result.pendingManual).toContain('Manual check required');
    });

    it('should check automated criteria against command outputs', () => {
      const gate = {
        id: 'test:build',
        stage: 'Build',
        sourceId: 'test',
        criteria: [
          { description: 'Tests pass: `npm test`', manual: false, command: 'npm test', expectedPattern: 'passed' },
        ],
      };

      const commandOutputs = new Map<string, string>();
      commandOutputs.set('npm test', '42 tests passed');

      const result = checkGate(gate, undefined, commandOutputs);
      expect(result.passed).toBe(true);
    });

    it('should fail when command output does not match expected pattern', () => {
      const gate = {
        id: 'test:lint',
        stage: 'Lint',
        sourceId: 'test',
        criteria: [
          { description: 'Lint clean: `npm run lint`', manual: false, command: 'npm run lint', expectedPattern: '0 errors' },
        ],
      };

      const commandOutputs = new Map<string, string>();
      commandOutputs.set('npm run lint', '5 errors found');

      const result = checkGate(gate, undefined, commandOutputs);
      expect(result.passed).toBe(false);
    });

    it('should fail when command was not executed', () => {
      const gate = {
        id: 'test:missing',
        stage: 'Missing',
        sourceId: 'test',
        criteria: [
          { description: 'Build succeeds: `npm run build`', manual: false, command: 'npm run build' },
        ],
      };

      const result = checkGate(gate, undefined, new Map());
      expect(result.passed).toBe(false);
    });

    it('should pass automated criteria with no expected pattern when output exists', () => {
      const gate = {
        id: 'test:run',
        stage: 'Run',
        sourceId: 'test',
        criteria: [
          { description: 'Run `npm start`', manual: false, command: 'npm start' },
        ],
      };

      const commandOutputs = new Map<string, string>();
      commandOutputs.set('npm start', 'Server started on port 3000');

      const result = checkGate(gate, undefined, commandOutputs);
      expect(result.passed).toBe(true);
    });
  });

  describe('checkAllGates', () => {
    it('should check all gates for a playbook', () => {
      writeFileSync(
        join(testDir, 'playbooks', 'multi-gate.md'),
        '---\nid: multi-gate\ntags: []\nstatus: active\n---\n\n<!-- L0: Multi gate -->\n\n## Gate: Step1\n- First check\n\n## Gate: Step2\n- Second check\n',
      );

      const results = checkAllGates(testDir, 'multi-gate');
      expect(results.length).toBeGreaterThanOrEqual(2);

      for (const result of results) {
        expect(result.passed).toBe(false);
      }
    });

    it('should return empty for playbook with no gates', () => {
      const results = checkAllGates(testDir, 'nonexistent-playbook');
      expect(results).toHaveLength(0);
    });
  });
});
