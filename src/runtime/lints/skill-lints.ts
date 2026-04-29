import { existsSync } from 'fs';
import { join } from 'path';
import type { HarnessDocument } from '../../core/types.js';
import type { LintResult } from '../lint-types.js';

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

export const skillLints = {
  descriptionQuality,
  bodyLength,
  referencedFilesExist,
  requiredSections,
  evalsCoverage,
};

export const ALL_SKILL_LINTS: Array<(s: HarnessDocument, b: string) => LintResult[]> = [
  descriptionQuality,
  bodyLength,
  referencedFilesExist,
  requiredSections,
  evalsCoverage,
];
