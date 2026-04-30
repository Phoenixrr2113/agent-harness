import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { basename, relative, join } from 'path';
import matter from 'gray-matter';
import { getPrimitiveDirs, SkillFrontmatterSchema } from '../core/types.js';

// --- Types ---

/** Result of auto-processing a file */
export interface AutoProcessResult {
  /** Path that was processed */
  path: string;
  /** Whether any changes were made */
  modified: boolean;
  /** List of fixes applied */
  fixes: string[];
  /** Errors encountered */
  errors: string[];
}

/** Options for auto-processing */
export interface AutoProcessOptions {
  /** Harness directory (for inferring primitive type from path) */
  harnessDir: string;
  /** Whether to generate frontmatter (default: true) */
  generateFrontmatter?: boolean;
  /**
   * Whether to generate a `description:` in frontmatter when missing.
   * Default: true. Description is the single discovery-tier surface per the
   * Agent Skills spec at https://agentskills.io/specification#progressive-disclosure.
   */
  generateDescription?: boolean;
}

// --- Frontmatter detection ---

/**
 * Infer the primitive type from the file's directory relative to harness root.
 * e.g., "rules/my-rule.md" → "rule", "skills/coding.md" → "skill"
 */
function inferTypeFromPath(filePath: string, harnessDir: string): string | null {
  const rel = relative(harnessDir, filePath);
  const topDir = rel.split('/')[0];

  const dirToType: Record<string, string> = {
    rules: 'rule',
    instincts: 'instinct',
    skills: 'skill',
    playbooks: 'playbook',
    workflows: 'workflow',
    tools: 'tool',
    agents: 'agent',
  };

  return dirToType[topDir] ?? null;
}

/**
 * Derive an id from a filename.
 * "my-cool-rule.md" → "my-cool-rule"
 */
function deriveId(filePath: string): string {
  return basename(filePath, '.md').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
}

/**
 * Generate a `description:` value from content. Tries:
 *   1. The first markdown heading (e.g., "# Rule: Read Before Edit" → "Rule: Read Before Edit")
 *   2. The first non-empty, non-heading line of prose
 * Caps at 200 characters. Spec allows up to 1024, but 200 keeps auto-gen tight;
 * authors can write longer descriptions by hand if a primitive needs it.
 */
function generateDescription(content: string): string | null {
  // Try first markdown heading
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) {
    const text = headingMatch[1].trim();
    return text.length > 200 ? text.slice(0, 197) + '...' : text;
  }

  // Fall back to first non-empty, non-heading line of prose
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.length > 0 &&
      !trimmed.startsWith('<!--') &&
      !trimmed.startsWith('---') &&
      !trimmed.startsWith('#')
    ) {
      return trimmed.length > 200 ? trimmed.slice(0, 197) + '...' : trimmed;
    }
  }

  return null;
}

// --- Main Auto-Processor ---

/**
 * Auto-process a markdown primitive file:
 * 1. Generate frontmatter if missing (id from filename, created, status, tags, author)
 * 2. Generate L0 summary if missing (from heading or first line)
 * 3. Generate L1 summary if missing (from first paragraph)
 *
 * This is designed to run on file save (via watcher) to ensure
 * all primitives have valid structure without user intervention.
 */
export function autoProcessFile(
  filePath: string,
  options: AutoProcessOptions,
): AutoProcessResult {
  const result: AutoProcessResult = {
    path: filePath,
    modified: false,
    fixes: [],
    errors: [],
  };

  if (!existsSync(filePath) || !filePath.endsWith('.md')) {
    return result;
  }

  // Skip index files and special files
  const filename = basename(filePath);
  if (filename.startsWith('_') || filename === 'CORE.md' || filename === 'SYSTEM.md' || filename === 'state.md') {
    return result;
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    result.errors.push(`Failed to read: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  // Empty file — nothing to process
  if (raw.trim().length === 0) {
    return result;
  }

  const generateFrontmatter = options.generateFrontmatter !== false;
  const generateDescriptionField = options.generateDescription !== false;

  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(raw);
  } catch {
    // If frontmatter parsing fails, try to add basic frontmatter
    if (generateFrontmatter) {
      const id = deriveId(filePath);
      const type = inferTypeFromPath(filePath, options.harnessDir);
      const tags = type ? [type] : [];
      const data = {
        id,
        created: new Date().toISOString().split('T')[0],
        author: 'infrastructure' as const,
        status: 'active' as const,
        tags,
      };
      const newContent = matter.stringify(raw, data);
      writeFileSync(filePath, newContent, 'utf-8');
      result.modified = true;
      result.fixes.push(`Added frontmatter (id: ${id})`);
    }
    return result;
  }

  const data = { ...parsed.data } as Record<string, unknown>;
  let content = parsed.content;
  let modified = false;

  // --- Frontmatter fixes ---
  if (generateFrontmatter) {
    // Fix: Missing id
    if (!data.id) {
      data.id = deriveId(filePath);
      result.fixes.push(`Added id: "${data.id}"`);
      modified = true;
    }

    // Fix: Missing created
    if (!data.created) {
      data.created = new Date().toISOString().split('T')[0];
      result.fixes.push('Added created date');
      modified = true;
    }

    // Fix: Missing author — infrastructure for auto-generated
    if (!data.author) {
      data.author = 'human';
      result.fixes.push('Added author: "human"');
      modified = true;
    }

    // Fix: Missing status
    if (!data.status) {
      data.status = 'active';
      result.fixes.push('Added status: "active"');
      modified = true;
    }

    // Fix: Missing tags — add type tag from directory
    if (!Array.isArray(data.tags) || data.tags.length === 0) {
      const type = inferTypeFromPath(filePath, options.harnessDir);
      data.tags = type ? [type] : [];
      if (type) {
        result.fixes.push(`Added tag: "${type}"`);
        modified = true;
      }
    }
  }

  // --- description: in frontmatter (single discovery-tier surface) ---
  if (generateDescriptionField && !data.description) {
    const desc = generateDescription(content);
    if (desc) {
      data.description = desc;
      result.fixes.push(`Generated description: "${desc}"`);
      modified = true;
    }
  }

  // Write back if modified
  if (modified) {
    try {
      const newRaw = matter.stringify(content, data);
      writeFileSync(filePath, newRaw, 'utf-8');
      result.modified = true;
    } catch (err) {
      result.errors.push(`Failed to write: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

// --- Strict Skill Validation ---

/**
 * Options for processSkillOnSave.
 */
export interface ProcessSkillOptions {
  /**
   * Async function to generate a description from the first body paragraph.
   * Typically wraps summary_model. When absent, no auto-generation occurs.
   */
  generateDescription?: (body: string) => Promise<string>;
}

/**
 * Result of processSkillOnSave.
 */
export interface ProcessSkillResult {
  status: 'processed' | 'unchanged' | 'error';
  detail?: string;
}

/**
 * Validate a skill file against the strict SkillFrontmatterSchema.
 *
 * If `description` is missing and `opts.generateDescription` is provided,
 * generates one from the first body paragraph and writes it back to disk.
 *
 * Returns:
 *  - 'processed'  — file was valid (or made valid) and written back
 *  - 'unchanged'  — file was already valid, no write needed
 *  - 'error'      — validation failed and could not be fixed
 */
export async function processSkillOnSave(
  skillPath: string,
  opts: ProcessSkillOptions,
): Promise<ProcessSkillResult> {
  let raw: string;
  try {
    raw = readFileSync(skillPath, 'utf-8');
  } catch (err) {
    return {
      status: 'error',
      detail: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(raw);
  } catch (err) {
    return {
      status: 'error',
      detail: `Failed to parse frontmatter: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const data = { ...parsed.data } as Record<string, unknown>;
  const content = parsed.content;
  let changed = false;

  // Generate description if missing and a generator is available
  if (!data.description && opts.generateDescription) {
    const firstParagraph = content.split(/\n\s*\n/)[0]?.trim() ?? '';
    if (firstParagraph) {
      const generated = await opts.generateDescription(firstParagraph);
      if (generated && generated.length <= 1024) {
        data.description = generated;
        changed = true;
      }
    }
  }

  // Validate against the strict skill schema
  const parseResult = SkillFrontmatterSchema.safeParse(data);
  if (!parseResult.success) {
    return { status: 'error', detail: parseResult.error.message };
  }

  if (changed) {
    try {
      writeFileSync(skillPath, matter.stringify(content, data), 'utf-8');
    } catch (err) {
      return {
        status: 'error',
        detail: `Failed to write file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { status: 'processed' };
  }

  return { status: 'unchanged' };
}

/**
 * Auto-process all primitives in a harness directory.
 * Useful for batch processing after init or on first dev startup.
 */
export function autoProcessAll(
  harnessDir: string,
  options?: { generateFrontmatter?: boolean; generateDescription?: boolean },
): AutoProcessResult[] {
  const results: AutoProcessResult[] = [];
  const dirs = getPrimitiveDirs();

  for (const dir of dirs) {
    const dirPath = join(harnessDir, dir);
    if (!existsSync(dirPath)) continue;

    const files = readdirSync(dirPath).filter((f: string) => f.endsWith('.md') && !f.startsWith('_'));
    for (const file of files) {
      const filePath = join(dirPath, file);
      const result = autoProcessFile(filePath, {
        harnessDir,
        generateFrontmatter: options?.generateFrontmatter,
        generateDescription: options?.generateDescription,
      });
      if (result.modified || result.errors.length > 0) {
        results.push(result);
      }
    }
  }

  return results;
}
