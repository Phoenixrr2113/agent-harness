import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync, copyFileSync } from 'fs';
import { join, basename } from 'path';
import matter from 'gray-matter';
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

/**
 * Auto-fix common issues in a capability file.
 * Reads the file, applies fixes, writes back, returns what was fixed.
 * Does NOT fix unfixable issues (e.g., empty body, unparseable YAML).
 */
export function fixCapability(filePath: string): EvalResult {
  const result: EvalResult = {
    valid: true,
    type: null,
    errors: [],
    warnings: [],
    fixes_applied: [],
  };

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

  const raw = readFileSync(filePath, 'utf-8');
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(raw);
  } catch (err) {
    result.valid = false;
    result.errors.push(`Failed to parse frontmatter: ${err}`);
    return result;
  }

  const data = { ...parsed.data } as Record<string, unknown>;
  let content = parsed.content;
  let modified = false;

  // Fix 1: Missing id — derive from filename
  if (!data.id) {
    const name = basename(filePath, '.md');
    data.id = name.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    result.fixes_applied.push(`Added id: "${data.id}" (from filename)`);
    modified = true;
  }

  // Fix 2: Missing status — set to active
  if (!data.status) {
    data.status = 'active';
    result.fixes_applied.push('Added status: "active"');
    modified = true;
  }

  // Fix 3: Missing type tag — infer from content and add tag
  const existingTags = Array.isArray(data.tags) ? (data.tags as string[]).map((t) => t.toLowerCase()) : [];
  let detectedType: string | null = null;
  for (const type of VALID_TYPES) {
    if (existingTags.includes(type)) {
      detectedType = type;
      break;
    }
  }
  if (!detectedType) {
    const bodyLower = content.toLowerCase();
    if (bodyLower.includes('# rule:')) detectedType = 'rule';
    else if (bodyLower.includes('# instinct:')) detectedType = 'instinct';
    else if (bodyLower.includes('# skill:')) detectedType = 'skill';
    else if (bodyLower.includes('# playbook:')) detectedType = 'playbook';
    else if (bodyLower.includes('# workflow:')) detectedType = 'workflow';
    else if (bodyLower.includes('# tool:')) detectedType = 'tool';
    else if (bodyLower.includes('# agent:')) detectedType = 'agent';
  }
  if (detectedType && !existingTags.includes(detectedType)) {
    if (!Array.isArray(data.tags)) data.tags = [];
    (data.tags as string[]).push(detectedType);
    result.fixes_applied.push(`Added tag: "${detectedType}"`);
    modified = true;
  }
  result.type = detectedType;

  // Fix 4: Missing L0 — generate from first heading or first non-empty line
  const l0Regex = /<!--\s*L0:\s*(.*?)\s*-->/;
  if (!l0Regex.test(content)) {
    const headingMatch = content.match(/^#\s+(.+)$/m);
    const firstLine = content.split('\n').find((line) => line.trim().length > 0);
    const summary = headingMatch ? headingMatch[1].trim() : (firstLine?.trim() ?? '');
    if (summary.length > 0) {
      const l0Text = summary.length > 120 ? summary.slice(0, 117) + '...' : summary;
      content = `<!-- L0: ${l0Text} -->\n${content}`;
      result.fixes_applied.push('Generated L0 summary from content');
      modified = true;
    }
  }

  // Fix 5: Missing L1 — generate from first paragraph
  const l1Regex = /<!--\s*L1:\s*(.*?)\s*-->/s;
  if (!l1Regex.test(content)) {
    const paragraphs = content.split(/\n{2,}/).filter((p) => {
      const trimmed = p.trim();
      return trimmed.length > 0 && !trimmed.startsWith('<!--') && !trimmed.startsWith('#');
    });
    if (paragraphs.length > 0) {
      const para = paragraphs[0].replace(/\n/g, ' ').trim();
      const l1Text = para.length > 300 ? para.slice(0, 297) + '...' : para;
      // Insert L1 after L0 if present, otherwise at the top
      const l0Pos = content.indexOf('-->');
      if (l0Pos !== -1) {
        const insertPos = l0Pos + 3;
        content = content.slice(0, insertPos) + `\n<!-- L1: ${l1Text} -->` + content.slice(insertPos);
      } else {
        content = `<!-- L1: ${l1Text} -->\n${content}`;
      }
      result.fixes_applied.push('Generated L1 summary from first paragraph');
      modified = true;
    }
  }

  // Write back if modified
  if (modified) {
    const newRaw = matter.stringify(content, data);
    writeFileSync(filePath, newRaw, 'utf-8');
  }

  // Re-evaluate after fixes
  if (!result.type) {
    result.errors.push(
      'Cannot determine primitive type. Add a type tag or use a heading like "# Skill: Name"',
    );
  }

  // Check body has content
  const bodyContent = content.replace(l0Regex, '').replace(l1Regex, '').trim();
  if (!bodyContent || bodyContent.length < 20) {
    result.valid = false;
    result.errors.push('Body content is too short or empty');
  }

  if (result.errors.length > 0) {
    result.valid = false;
  }

  return result;
}

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
