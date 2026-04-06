import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { loadDirectory } from '../primitives/loader.js';
import type { HarnessDocument, HarnessConfig } from '../core/types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface VerificationCriterion {
  /** Human-readable criterion description */
  description: string;
  /** Whether this criterion must be manually checked (vs auto-checkable) */
  manual: boolean;
  /** Optional command to run for automated verification */
  command?: string;
  /** Optional expected output pattern (regex) for automated verification */
  expectedPattern?: string;
}

export interface VerificationGate {
  /** Gate ID derived from playbook/workflow stage */
  id: string;
  /** Stage name this gate guards (e.g., "Build", "Verify") */
  stage: string;
  /** Source playbook/workflow ID */
  sourceId: string;
  /** Acceptance criteria that must pass before proceeding */
  criteria: VerificationCriterion[];
}

export interface GateCheckResult {
  gateId: string;
  stage: string;
  passed: boolean;
  /** Individual criterion results */
  results: Array<{
    criterion: string;
    passed: boolean;
    detail?: string;
  }>;
  /** Criteria that need manual verification */
  pendingManual: string[];
}

export interface GateExtractResult {
  gates: VerificationGate[];
  /** Source playbook/workflow IDs that had gates */
  sources: string[];
}

// ─── Gate Extraction ─────────────────────────────────────────────────────────

/**
 * Extract verification gates from a playbook or workflow document.
 *
 * Gates are detected from:
 * 1. `## Gate:` or `## Verification:` sections in the document body
 * 2. Acceptance criteria blocks (`### Acceptance Criteria` or `### Gate`)
 * 3. Inline gate markers: `<!-- gate: description -->` in the markdown
 * 4. Numbered steps with `[x]` checkbox markers (treated as manual criteria)
 */
export function extractGates(doc: HarnessDocument): VerificationGate[] {
  const gates: VerificationGate[] = [];
  const body = doc.body;

  // Strategy 1: Named gate sections
  const gateSectionRegex = /##\s+(?:Gate|Verification):\s*(.+)\n([\s\S]*?)(?=\n##\s|\n*$)/gi;
  let match: RegExpExecArray | null;

  while ((match = gateSectionRegex.exec(body)) !== null) {
    const stageName = match[1].trim();
    const sectionBody = match[2];
    const criteria = extractCriteriaFromSection(sectionBody);

    if (criteria.length > 0) {
      gates.push({
        id: `${doc.frontmatter.id}:${slugify(stageName)}`,
        stage: stageName,
        sourceId: doc.frontmatter.id,
        criteria,
      });
    }
  }

  // Strategy 2: Acceptance criteria subsections
  const acRegex = /###\s+(?:Acceptance Criteria|Gate)\s*(?::\s*(.+))?\n([\s\S]*?)(?=\n###?\s|\n*$)/gi;

  while ((match = acRegex.exec(body)) !== null) {
    const stageName = match[1]?.trim() ?? 'default';
    const sectionBody = match[2];
    const criteria = extractCriteriaFromSection(sectionBody);

    if (criteria.length > 0) {
      const gateId = `${doc.frontmatter.id}:ac-${slugify(stageName)}`;
      // Avoid duplicates from strategy 1
      if (!gates.some((g) => g.id === gateId)) {
        gates.push({
          id: gateId,
          stage: stageName,
          sourceId: doc.frontmatter.id,
          criteria,
        });
      }
    }
  }

  // Strategy 3: Inline gate markers
  const inlineRegex = /<!--\s*gate:\s*(.+?)\s*-->/gi;

  while ((match = inlineRegex.exec(body)) !== null) {
    const desc = match[1].trim();
    const gateId = `${doc.frontmatter.id}:inline-${slugify(desc.slice(0, 40))}`;

    if (!gates.some((g) => g.id === gateId)) {
      gates.push({
        id: gateId,
        stage: 'inline',
        sourceId: doc.frontmatter.id,
        criteria: [{
          description: desc,
          manual: !desc.includes('`'),
          command: extractInlineCommand(desc),
        }],
      });
    }
  }

  // Strategy 4: Steps with checkboxes between stages
  const stepGates = extractStepGates(doc);
  for (const gate of stepGates) {
    if (!gates.some((g) => g.id === gate.id)) {
      gates.push(gate);
    }
  }

  return gates;
}

/**
 * Extract criteria from a section body (bullet list parsing).
 */
function extractCriteriaFromSection(section: string): VerificationCriterion[] {
  const criteria: VerificationCriterion[] = [];

  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Bullet or numbered list items
    const listMatch = trimmed.match(/^[-*]\s+(?:\[[ x]]\s+)?(.+)/);
    if (!listMatch) continue;

    const desc = listMatch[1].trim();
    if (!desc) continue;

    // Check if it's an automated criterion (contains backtick command)
    const cmdMatch = desc.match(/`(.+?)`/);
    const isManual = !cmdMatch;

    // Check for expected pattern: "should output X" or "expected: X"
    const patternMatch = desc.match(/(?:should\s+(?:output|return|show)|expected:\s*)(.+?)(?:\)|$)/i);

    criteria.push({
      description: desc,
      manual: isManual,
      command: cmdMatch ? cmdMatch[1] : undefined,
      expectedPattern: patternMatch ? patternMatch[1].trim() : undefined,
    });
  }

  return criteria;
}

/**
 * Extract verification gates from step transitions.
 * Looks for numbered steps where intermediate verification steps exist.
 */
function extractStepGates(doc: HarnessDocument): VerificationGate[] {
  const gates: VerificationGate[] = [];
  const lines = doc.body.split('\n');
  let currentStep = '';
  let criteriaBuffer: VerificationCriterion[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect numbered step headers (e.g., "1. **Understand**" or "## Step 1:")
    const stepMatch = trimmed.match(/^(?:\d+\.\s+\*\*(.+?)\*\*|##\s+Step\s+\d+:\s*(.+))/);
    if (stepMatch) {
      // Flush previous gate if criteria were collected
      if (currentStep && criteriaBuffer.length > 0) {
        gates.push({
          id: `${doc.frontmatter.id}:step-${slugify(currentStep)}`,
          stage: currentStep,
          sourceId: doc.frontmatter.id,
          criteria: [...criteriaBuffer],
        });
        criteriaBuffer = [];
      }
      currentStep = (stepMatch[1] ?? stepMatch[2]).trim();
      continue;
    }

    // Collect checkbox items within steps as criteria
    const checkboxMatch = trimmed.match(/^[-*]\s+\[[ x]]\s+(.+)/);
    if (checkboxMatch && currentStep) {
      const desc = checkboxMatch[1].trim();
      const cmdMatch = desc.match(/`(.+?)`/);
      criteriaBuffer.push({
        description: desc,
        manual: !cmdMatch,
        command: cmdMatch ? cmdMatch[1] : undefined,
      });
    }
  }

  // Flush last step
  if (currentStep && criteriaBuffer.length > 0) {
    gates.push({
      id: `${doc.frontmatter.id}:step-${slugify(currentStep)}`,
      stage: currentStep,
      sourceId: doc.frontmatter.id,
      criteria: [...criteriaBuffer],
    });
  }

  return gates;
}

/**
 * Extract a command from an inline gate description (text between backticks).
 */
function extractInlineCommand(desc: string): string | undefined {
  const match = desc.match(/`(.+?)`/);
  return match ? match[1] : undefined;
}

/**
 * Convert text to a URL-safe slug.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 50)
    .replace(/-+$/, '');
}

// ─── Gate Loading ────────────────────────────────────────────────────────────

/**
 * Load all verification gates from playbooks and workflows in the harness.
 */
export function loadGates(harnessDir: string): GateExtractResult {
  const gates: VerificationGate[] = [];
  const sources: string[] = [];

  for (const dir of ['playbooks', 'workflows']) {
    const fullPath = join(harnessDir, dir);
    if (!existsSync(fullPath)) continue;

    const docs = loadDirectory(fullPath);
    for (const doc of docs) {
      if (doc.frontmatter.status !== 'active') continue;
      const docGates = extractGates(doc);
      if (docGates.length > 0) {
        gates.push(...docGates);
        if (!sources.includes(doc.frontmatter.id)) {
          sources.push(doc.frontmatter.id);
        }
      }
    }
  }

  return { gates, sources };
}

/**
 * Find gates for a specific playbook/workflow by ID.
 */
export function getGatesForPlaybook(harnessDir: string, playbookId: string): VerificationGate[] {
  const { gates } = loadGates(harnessDir);
  return gates.filter((g) => g.sourceId === playbookId);
}

// ─── Gate Checking ───────────────────────────────────────────────────────────

/**
 * Check a verification gate against provided results.
 * For manual criteria, checks against the `manualResults` map.
 * For automated criteria, checks if the command output matches the expected pattern.
 *
 * @param gate - The gate to check
 * @param manualResults - Map of criterion description → pass/fail
 * @param commandOutputs - Map of command → actual output (for automated checks)
 */
export function checkGate(
  gate: VerificationGate,
  manualResults?: Map<string, boolean>,
  commandOutputs?: Map<string, string>,
): GateCheckResult {
  const results: Array<{ criterion: string; passed: boolean; detail?: string }> = [];
  const pendingManual: string[] = [];

  for (const criterion of gate.criteria) {
    if (criterion.manual) {
      // Manual criterion — check if result was provided
      if (manualResults && manualResults.has(criterion.description)) {
        const passed = manualResults.get(criterion.description)!;
        results.push({
          criterion: criterion.description,
          passed,
          detail: passed ? 'Manually verified' : 'Manual verification failed',
        });
      } else {
        pendingManual.push(criterion.description);
        results.push({
          criterion: criterion.description,
          passed: false,
          detail: 'Awaiting manual verification',
        });
      }
    } else if (criterion.command && commandOutputs) {
      // Automated criterion — check command output
      const output = commandOutputs.get(criterion.command);
      if (output === undefined) {
        results.push({
          criterion: criterion.description,
          passed: false,
          detail: `Command not executed: ${criterion.command}`,
        });
      } else if (criterion.expectedPattern) {
        try {
          const regex = new RegExp(criterion.expectedPattern, 'i');
          const passed = regex.test(output);
          results.push({
            criterion: criterion.description,
            passed,
            detail: passed
              ? `Output matches expected pattern`
              : `Output does not match expected pattern: ${criterion.expectedPattern}`,
          });
        } catch {
          // Invalid regex — treat as string match
          const passed = output.includes(criterion.expectedPattern);
          results.push({
            criterion: criterion.description,
            passed,
            detail: passed ? 'Output contains expected text' : 'Output missing expected text',
          });
        }
      } else {
        // No expected pattern — command succeeded if output exists
        results.push({
          criterion: criterion.description,
          passed: true,
          detail: 'Command produced output',
        });
      }
    } else {
      // Automated criterion but no output available
      results.push({
        criterion: criterion.description,
        passed: false,
        detail: criterion.command ? `Command not executed: ${criterion.command}` : 'No verification method',
      });
    }
  }

  const passed = results.every((r) => r.passed) && pendingManual.length === 0;

  return {
    gateId: gate.id,
    stage: gate.stage,
    passed,
    results,
    pendingManual,
  };
}

/**
 * Check all gates for a playbook/workflow. Returns individual gate results.
 */
export function checkAllGates(
  harnessDir: string,
  playbookId: string,
  manualResults?: Map<string, boolean>,
  commandOutputs?: Map<string, string>,
): GateCheckResult[] {
  const gates = getGatesForPlaybook(harnessDir, playbookId);
  return gates.map((gate) => checkGate(gate, manualResults, commandOutputs));
}
