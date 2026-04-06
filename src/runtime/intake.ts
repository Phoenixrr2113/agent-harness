import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync, readdirSync, copyFileSync } from 'fs';
import { join, basename } from 'path';
import { parseHarnessDocument } from '../primitives/loader.js';
import { writeIndexFile } from './indexer.js';
import type { HarnessDocument } from '../core/types.js';

export interface EvalResult {
  valid: boolean;
  type: string | null;
  errors: string[];
  warnings: string[];
  fixes_applied: string[];
}

const VALID_TYPES = ['rule', 'instinct', 'skill', 'playbook', 'workflow', 'tool', 'agent'];
const TYPE_DIRS: Record<string, string> = {
  rule: 'rules',
  instinct: 'instincts',
  skill: 'skills',
  playbook: 'playbooks',
  workflow: 'workflows',
  tool: 'tools',
  agent: 'agents',
};

export function evaluateCapability(filePath: string): EvalResult {
  const result: EvalResult = {
    valid: true,
    type: null,
    errors: [],
    warnings: [],
    fixes_applied: [],
  };

  // Step 1: Check file exists and is markdown
  if (!existsSync(filePath)) {
    result.valid = false;
    result.errors.push('File does not exist');
    return result;
  }

  if (!filePath.endsWith('.md')) {
    result.valid = false;
    result.errors.push('File must be a .md file');
    return result;
  }

  // Step 2: Try to parse
  let doc: HarnessDocument;
  try {
    doc = parseHarnessDocument(filePath);
  } catch (err) {
    result.valid = false;
    result.errors.push(`Failed to parse: ${err}`);
    return result;
  }

  // Step 3: Check frontmatter
  if (!doc.frontmatter.id) {
    result.valid = false;
    result.errors.push('Missing frontmatter field: id');
  }

  if (!doc.frontmatter.status) {
    result.warnings.push('Missing status field, defaulting to "active"');
  }

  // Step 4: Detect type from tags or directory hint
  const tags = doc.frontmatter.tags.map((t) => t.toLowerCase());
  for (const type of VALID_TYPES) {
    if (tags.includes(type)) {
      result.type = type;
      break;
    }
  }

  if (!result.type) {
    // Try to infer from content
    const bodyLower = doc.body.toLowerCase();
    if (bodyLower.includes('# rule:')) result.type = 'rule';
    else if (bodyLower.includes('# instinct:')) result.type = 'instinct';
    else if (bodyLower.includes('# skill:')) result.type = 'skill';
    else if (bodyLower.includes('# playbook:')) result.type = 'playbook';
    else if (bodyLower.includes('# workflow:')) result.type = 'workflow';
    else if (bodyLower.includes('# tool:')) result.type = 'tool';
    else if (bodyLower.includes('# agent:')) result.type = 'agent';
  }

  if (!result.type) {
    result.valid = false;
    result.errors.push(
      'Cannot determine primitive type. Add a type tag (rule, instinct, skill, playbook, workflow, tool, agent) or use a heading like "# Skill: Name"',
    );
  }

  // Step 5: Check L0/L1
  if (!doc.l0) {
    result.warnings.push('Missing L0 summary (<!-- L0: ... -->). Recommended for context loading.');
  }
  if (!doc.l1) {
    result.warnings.push('Missing L1 summary (<!-- L1: ... -->). Recommended for context loading.');
  }

  // Step 6: Check body has content
  if (!doc.body || doc.body.length < 20) {
    result.valid = false;
    result.errors.push('Body content is too short or empty');
  }

  return result;
}

export function installCapability(harnessDir: string, filePath: string): { installed: boolean; destination: string; evalResult: EvalResult } {
  const evalResult = evaluateCapability(filePath);

  if (!evalResult.valid || !evalResult.type) {
    return { installed: false, destination: '', evalResult };
  }

  const targetDir = join(harnessDir, TYPE_DIRS[evalResult.type]);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const destination = join(targetDir, basename(filePath));

  // Copy file to target directory
  copyFileSync(filePath, destination);

  // Move original to .processed
  const processedDir = join(harnessDir, 'intake', '.processed');
  if (!existsSync(processedDir)) {
    mkdirSync(processedDir, { recursive: true });
  }
  copyFileSync(filePath, join(processedDir, basename(filePath)));

  // Rebuild index for target directory
  writeIndexFile(harnessDir, TYPE_DIRS[evalResult.type]);

  return { installed: true, destination, evalResult };
}

export function processIntake(harnessDir: string): Array<{ file: string; result: ReturnType<typeof installCapability> }> {
  const intakeDir = join(harnessDir, 'intake');
  if (!existsSync(intakeDir)) return [];

  const files = readdirSync(intakeDir).filter(
    (f) => f.endsWith('.md') && !f.startsWith('.'),
  );

  const results: Array<{ file: string; result: ReturnType<typeof installCapability> }> = [];

  for (const file of files) {
    const filePath = join(intakeDir, file);
    const result = installCapability(harnessDir, filePath);
    results.push({ file, result });

    // Remove from intake if installed
    if (result.installed) {
      try {
        unlinkSync(filePath);
      } catch {
        // Leave it if can't remove
      }
    }
  }

  return results;
}
