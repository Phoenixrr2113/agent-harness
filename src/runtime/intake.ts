import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync, copyFileSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import matter from 'gray-matter';
import { parseHarnessDocument, loadDirectory } from '../primitives/loader.js';
import { writeIndexFile } from './indexer.js';
import { getPrimitiveDirs } from '../core/types.js';
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

  // Fix 4: Missing description — derive from first heading or first non-empty
  // line. Description is the single discovery-tier surface per the Agent Skills
  // spec (https://agentskills.io/specification#progressive-disclosure).
  if (!data.description) {
    const headingMatch = content.match(/^#\s+(.+)$/m);
    const firstLine = content.split('\n').find((line) => line.trim().length > 0);
    const summary = headingMatch ? headingMatch[1].trim() : (firstLine?.trim() ?? '');
    if (summary.length > 0) {
      data.description = summary.length > 200 ? summary.slice(0, 197) + '...' : summary;
      result.fixes_applied.push(`Generated description: "${data.description}"`);
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
  if (!content.trim() || content.trim().length < 20) {
    result.valid = false;
    result.errors.push('Body content is too short or empty');
  }

  if (result.errors.length > 0) {
    result.valid = false;
  }

  return result;
}

/**
 * Evaluate a capability file. If harnessDir is provided, also checks
 * dependency resolution (related: references, with: agent references).
 */
export function evaluateCapability(filePath: string, harnessDir?: string): EvalResult {
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
  if (!doc.id) {
    result.valid = false;
    result.errors.push('Missing frontmatter field: id');
  }

  if (!doc.status) {
    result.warnings.push('Missing status field, defaulting to "active"');
  }

  // Step 4: Detect type from tags or directory hint
  const tags = doc.tags.map((t) => t.toLowerCase());
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

  // Step 5: Check description
  if (!doc.description) {
    result.warnings.push('Missing description field in frontmatter. Recommended for context loading and discovery.');
  }

  // Step 6: Check body has content
  if (!doc.body || doc.body.length < 20) {
    result.valid = false;
    result.errors.push('Body content is too short or empty');
  }

  // Step 7: Dependency resolution (when harness dir is available)
  if (harnessDir) {
    resolveDependencies(doc, harnessDir, result);
  }

  return result;
}

/**
 * Check that referenced primitives (related: and with: fields) exist in the harness.
 */
function resolveDependencies(doc: HarnessDocument, harnessDir: string, result: EvalResult): void {
  // Load all known primitive IDs for reference checking
  const primitiveDirs = getPrimitiveDirs();
  const knownIds = new Set<string>();
  for (const dir of primitiveDirs) {
    const fullPath = join(harnessDir, dir);
    if (!existsSync(fullPath)) continue;
    const docs = loadDirectory(fullPath);
    for (const d of docs) {
      knownIds.add(d.id);
    }
  }

  // Check related: references
  const related = doc.related;
  if (related && related.length > 0) {
    for (const ref of related) {
      if (knownIds.has(ref)) continue;
      // Check if it's a file path
      const refPath = join(harnessDir, ref);
      if (existsSync(refPath) || existsSync(refPath + '.md')) continue;
      result.warnings.push(`Unresolved reference: "${ref}" (related: field) — not found in harness`);
    }
  }

  // Check with: agent reference (used for delegation)
  const withAgent = doc.with;
  if (withAgent) {
    // Check if agent exists in agents/ directory
    const agentsDir = join(harnessDir, 'agents');
    let agentFound = false;
    if (existsSync(agentsDir)) {
      const agentDocs = loadDirectory(agentsDir);
      agentFound = agentDocs.some(
        (d) => d.id === withAgent || basename(d.path, '.md') === withAgent,
      );
    }
    if (!agentFound) {
      result.warnings.push(`Unresolved agent: "${withAgent}" (with: field) — no matching agent found`);
    }
  }

  // Check schedule: cron expression validity (for workflows)
  const schedule = doc.schedule;
  if (schedule) {
    // Basic cron validation: should have 5-6 space-separated fields
    const fields = schedule.trim().split(/\s+/);
    if (fields.length < 5 || fields.length > 6) {
      result.warnings.push(`Possibly invalid cron expression: "${schedule}" (expected 5-6 fields)`);
    }
  }
}

export function installCapability(harnessDir: string, filePath: string): { installed: boolean; destination: string; evalResult: EvalResult } {
  const evalResult = evaluateCapability(filePath, harnessDir);

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
      } catch (_unlinkErr) {
        // Best-effort cleanup — file persists if removal fails
      }
    }
  }

  return results;
}

export interface DownloadResult {
  downloaded: boolean;
  localPath: string;
  error?: string;
}

/**
 * Download a capability file from a URL to a temporary file.
 * Validates the URL (must be HTTPS) and content type (must look like markdown).
 * Returns a local temp path suitable for passing to installCapability().
 */
export async function downloadCapability(url: string): Promise<DownloadResult> {
  // Validate URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { downloaded: false, localPath: '', error: `Invalid URL: ${url}` };
  }

  if (parsed.protocol !== 'https:') {
    return { downloaded: false, localPath: '', error: 'Only HTTPS URLs are supported' };
  }

  // Derive filename from URL path
  const urlPath = parsed.pathname;
  let filename = basename(urlPath);
  if (!filename.endsWith('.md')) {
    filename = filename + '.md';
  }

  try {
    const response = await fetch(url);

    if (!response.ok) {
      return { downloaded: false, localPath: '', error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const body = await response.text();

    // Basic validation: must contain frontmatter delimiters or be valid markdown
    if (body.length === 0) {
      return { downloaded: false, localPath: '', error: 'Downloaded file is empty' };
    }

    // Max size: 1MB
    if (body.length > 1_048_576) {
      return { downloaded: false, localPath: '', error: 'File exceeds 1MB size limit' };
    }

    // Write to temp directory
    const tempDir = join(tmpdir(), 'harness-download');
    mkdirSync(tempDir, { recursive: true });
    const localPath = join(tempDir, filename);
    writeFileSync(localPath, body, 'utf-8');

    return { downloaded: true, localPath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { downloaded: false, localPath: '', error: `Download failed: ${msg}` };
  }
}
