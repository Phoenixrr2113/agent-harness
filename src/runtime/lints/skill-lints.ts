import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import cron from 'node-cron';
import type { HarnessDocument } from '../../core/types.js';
import type { LintResult } from '../lint-types.js';

const LEGACY_L0_BODY_REGEX = /<!--\s*L0:/;
const LEGACY_L1_BODY_REGEX = /<!--\s*L1:/;

function descriptionQuality(skill: HarnessDocument, _bundleDir: string): LintResult[] {
  const out: LintResult[] = [];
  const desc = skill.description ?? '';
  if (desc.length < 80) {
    out.push({
      code: 'DESCRIPTION_TOO_SHORT',
      severity: 'warn',
      message: `description is ${desc.length} chars; recommended >= 80 to give the model enough context to trigger reliably`,
      path: skill.path,
      fixable: false,
    });
  }
  if (desc.length > 1024) {
    out.push({
      code: 'DESCRIPTION_TOO_LONG',
      severity: 'error',
      message: `description is ${desc.length} chars; Agent Skills spec maximum is 1024`,
      path: skill.path,
      fixable: false,
    });
  }
  // "Use when..." pattern is a common signal of imperative phrasing
  if (desc.length >= 80 && !/use when/i.test(desc) && !/when (the user|the agent|to|invoking|handling)/i.test(desc)) {
    out.push({
      code: 'DESCRIPTION_NOT_IMPERATIVE',
      severity: 'info',
      message: 'description does not contain a "Use when..." trigger phrase; consider adding one for better trigger reliability (per https://agentskills.io/skill-creation/optimizing-descriptions)',
      path: skill.path,
      fixable: false,
    });
  }
  return out;
}

function bodyLength(skill: HarnessDocument, _bundleDir: string): LintResult[] {
  const out: LintResult[] = [];
  const tokenEstimate = Math.ceil(skill.body.length / 4);
  if (tokenEstimate > 6000) {
    out.push({
      code: 'BODY_TOO_LONG',
      severity: 'error',
      message: `SKILL.md body is ~${tokenEstimate} tokens; Agent Skills spec recommends < 5000. Move detailed sections to references/ files and tell the agent when to load each.`,
      path: skill.path,
      fixable: false,
    });
  } else if (tokenEstimate > 4000) {
    out.push({
      code: 'BODY_LONG',
      severity: 'warn',
      message: `SKILL.md body is ~${tokenEstimate} tokens; consider moving detail to references/ for predictable activation cost`,
      path: skill.path,
      fixable: false,
    });
  }
  return out;
}

function referencedFilesExist(skill: HarnessDocument, bundleDir: string): LintResult[] {
  const out: LintResult[] = [];
  // Match relative paths in body that look like references: scripts/foo.sh, references/foo.md, assets/foo.txt
  const pathPattern = /\b(scripts|references|assets)\/[\w.-]+(?:\/[\w.-]+)*\.\w+/g;
  const matches = skill.body.matchAll(pathPattern);
  const seen = new Set<string>();
  for (const m of matches) {
    const rel = m[0];
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = join(bundleDir, rel);
    if (!existsSync(abs)) {
      out.push({
        code: 'REFERENCED_FILE_MISSING',
        severity: 'error',
        message: `SKILL.md references "${rel}" but ${abs} does not exist`,
        path: skill.path,
        fixable: false,
      });
    }
  }
  return out;
}

function requiredSections(skill: HarnessDocument, _bundleDir: string): LintResult[] {
  const hasWhenToUse = /^##\s*when to use/im.test(skill.body);
  const hasAnyOfTheRest = /^##\s*(available scripts|workflow|gotchas|failure modes)/im.test(skill.body);
  if (!hasWhenToUse && !hasAnyOfTheRest) {
    return [{
      code: 'MISSING_RECOMMENDED_SECTIONS',
      severity: 'warn',
      message: 'SKILL.md is missing recommended sections (## When to use, ## Available scripts, ## Workflow, ## Gotchas, or ## Failure modes). See docs/skill-authoring.md for the convention.',
      path: skill.path,
      fixable: false,
    }];
  }
  return [];
}

function evalsCoverage(skill: HarnessDocument, bundleDir: string): LintResult[] {
  const triggersPath = join(bundleDir, 'evals', 'triggers.json');
  if (!existsSync(triggersPath)) {
    return [{
      code: 'MISSING_EVALS_TRIGGERS',
      severity: 'warn',
      message: `Skill ${skill.name} has no evals/triggers.json — consider authoring trigger queries to validate the description`,
      path: skill.path,
      fixable: false,
    }];
  }
  return [];
}

/**
 * Flag legacy L0/L1 HTML body markers. The Agent Skills spec uses
 * `description:` in frontmatter as the single discovery-tier surface; L0/L1
 * comments are deprecated. Files with these markers should be cleaned up via
 * `harness doctor --migrate`.
 */
function legacyL0L1Markers(skill: HarnessDocument, _bundleDir: string): LintResult[] {
  const out: LintResult[] = [];
  if (LEGACY_L0_BODY_REGEX.test(skill.body)) {
    out.push({
      code: 'LEGACY_L0_MARKER',
      severity: 'warn',
      message: 'SKILL.md body contains a legacy <!-- L0: ... --> marker. The harness uses `description:` in frontmatter now; run `harness doctor --migrate` to clean up.',
      path: skill.path,
      fixable: false,
    });
  }
  if (LEGACY_L1_BODY_REGEX.test(skill.body)) {
    out.push({
      code: 'LEGACY_L1_MARKER',
      severity: 'warn',
      message: 'SKILL.md body contains a legacy <!-- L1: ... --> marker. The harness uses `description:` in frontmatter now; run `harness doctor --migrate` to clean up.',
      path: skill.path,
      fixable: false,
    });
  }
  return out;
}

/**
 * Flag a skill missing its `description:`. Description is the discovery surface
 * — without it the skill can't surface in the catalog reliably.
 */
function descriptionPresent(skill: HarnessDocument, _bundleDir: string): LintResult[] {
  const desc = skill.description?.trim() ?? '';
  if (desc.length === 0) {
    return [{
      code: 'MISSING_DESCRIPTION',
      severity: 'error',
      message: 'SKILL.md frontmatter is missing `description:` — required for the discovery tier of progressive disclosure (https://agentskills.io/specification#progressive-disclosure).',
      path: skill.path,
      fixable: false,
    }];
  }
  return [];
}

/**
 * Flag invalid cron expressions in `metadata.harness-schedule`. Without this,
 * the scheduler accepts a typo'd or malformed schedule at validate time and
 * either silently never fires or crashes when the cron parser hits the
 * expression at runtime.
 */
function cronSchedule(skill: HarnessDocument, _bundleDir: string): LintResult[] {
  // The scheduler reads `metadata['harness-schedule']` directly from the
  // normalized HarnessDocument (see src/runtime/scheduler.ts). The normalize
  // layer doesn't strip that key (it's not in HARNESS_METADATA_KEYS), so
  // it stays accessible on `skill.metadata`. Mirror the scheduler's lookup
  // exactly so the lint flags whatever the scheduler would itself reject.
  const expr = skill.metadata?.['harness-schedule'];
  if (typeof expr !== 'string' || expr.trim() === '') return [];
  if (!cron.validate(expr)) {
    return [{
      code: 'INVALID_CRON_SCHEDULE',
      severity: 'error',
      message: `metadata.harness-schedule "${expr}" is not a valid cron expression. The scheduler will refuse to register this skill at runtime. See https://crontab.guru for examples.`,
      path: skill.path,
      fixable: false,
    }];
  }
  return [];
}

export const skillLints = {
  descriptionQuality,
  bodyLength,
  referencedFilesExist,
  requiredSections,
  evalsCoverage,
  legacyL0L1Markers,
  descriptionPresent,
  cronSchedule,
};

export const ALL_SKILL_LINTS: Array<(s: HarnessDocument, b: string) => LintResult[]> = [
  descriptionPresent,
  descriptionQuality,
  bodyLength,
  referencedFilesExist,
  requiredSections,
  evalsCoverage,
  legacyL0L1Markers,
  cronSchedule,
];

// --- Rule lints (mirror the L0/L1 + description checks for rules/) ---

/**
 * Flag legacy L0/L1 markers in rule files. Same rule as for skills — the
 * harness uses `description:` in frontmatter as the single discovery surface.
 *
 * Loaded directly from disk because rule loading does not parse the body in
 * the same way as the skill loader.
 */
export function lintRuleFile(rulePath: string): LintResult[] {
  const out: LintResult[] = [];
  let body: string;
  try {
    body = readFileSync(rulePath, 'utf-8');
  } catch {
    return out;
  }
  if (LEGACY_L0_BODY_REGEX.test(body)) {
    out.push({
      code: 'LEGACY_L0_MARKER',
      severity: 'warn',
      message: 'Rule body contains a legacy <!-- L0: ... --> marker. The harness uses `description:` in frontmatter now; run `harness doctor --migrate` to clean up.',
      path: rulePath,
      fixable: false,
    });
  }
  if (LEGACY_L1_BODY_REGEX.test(body)) {
    out.push({
      code: 'LEGACY_L1_MARKER',
      severity: 'warn',
      message: 'Rule body contains a legacy <!-- L1: ... --> marker. The harness uses `description:` in frontmatter now; run `harness doctor --migrate` to clean up.',
      path: rulePath,
      fixable: false,
    });
  }
  return out;
}
