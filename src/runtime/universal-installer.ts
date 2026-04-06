import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs';
import { join, basename, extname } from 'path';
import { tmpdir } from 'os';
import matter from 'gray-matter';
import { parse as parseYaml } from 'yaml';
import { fixCapability, installCapability, downloadCapability } from './intake.js';
import { autoProcessFile } from './auto-processor.js';
import { discoverSources, loadAllSources } from './sources.js';
import type { Source, SourceDiscoveryResult } from './sources.js';
import { log } from '../core/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Detected source format of a file to be installed. */
export type SourceFormat =
  | 'harness'         // Already harness convention (frontmatter + L0/L1)
  | 'claude-skill'    // Claude Code SKILL.md (plain markdown, no frontmatter)
  | 'faf-yaml'        // .faf YAML format
  | 'raw-markdown'    // Plain markdown with no harness structure
  | 'bash-hook'       // Bash/shell script (hook or workflow)
  | 'mcp-config'      // MCP server configuration (JSON/YAML)
  | 'unknown';

/** Result of format detection. */
export interface FormatDetection {
  /** Detected format */
  format: SourceFormat;
  /** Inferred primitive type (skill, agent, rule, etc.) */
  primitiveType: string | null;
  /** Confidence score (0-1) */
  confidence: number;
  /** Reasons for the detection */
  reasons: string[];
}

/** Result of a universal install operation. */
export interface UniversalInstallResult {
  /** Whether installation succeeded */
  installed: boolean;
  /** Source reference that was resolved */
  source: string;
  /** Detected format */
  format: FormatDetection;
  /** Path where the file was installed */
  destination: string;
  /** Fixes applied during normalization */
  fixes: string[];
  /** Errors encountered */
  errors: string[];
  /** Suggested dependencies to install */
  suggestedDependencies: string[];
}

/** Options for the universal installer. */
export interface UniversalInstallOptions {
  /** Override the detected primitive type (skill, rule, agent, etc.) */
  type?: string;
  /** Override the generated ID */
  id?: string;
  /** Force install even if validation has warnings */
  force?: boolean;
  /** Skip auto-fix (frontmatter, L0/L1 generation) */
  skipFix?: boolean;
  /** Additional tags to add */
  tags?: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

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

// ─── Format Detection ────────────────────────────────────────────────────────

/**
 * Detect the format of a file based on its content and extension.
 *
 * Detection heuristics:
 * - Has `---` frontmatter with `id:` + `status:` → harness convention
 * - Has `---` frontmatter but missing harness fields → raw-markdown
 * - `.faf` or `.yaml`/`.yml` with `type:` + `content:` keys → faf-yaml
 * - `.sh`/`.bash` or starts with `#!/` → bash-hook
 * - JSON/YAML with `mcpServers` or `servers` → mcp-config
 * - Plain markdown with no frontmatter → claude-skill or raw-markdown
 */
export function detectFormat(content: string, filename: string): FormatDetection {
  const ext = extname(filename).toLowerCase();
  const reasons: string[] = [];
  let format: SourceFormat = 'unknown';
  let primitiveType: string | null = null;
  let confidence = 0;

  // Check for bash/shell scripts
  if (ext === '.sh' || ext === '.bash' || content.trimStart().startsWith('#!/')) {
    format = 'bash-hook';
    primitiveType = 'workflow';
    confidence = 0.9;
    reasons.push('Shell script detected (shebang or .sh extension)');

    // Hooks are typically short scripts with specific patterns
    if (content.includes('hook') || content.includes('pre-commit') || content.includes('post-')) {
      primitiveType = 'workflow';
      reasons.push('Hook pattern detected in content');
    }

    return { format, primitiveType, confidence, reasons };
  }

  // Check for JSON/YAML MCP configs
  if (ext === '.json') {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (parsed.mcpServers || parsed.servers || parsed.command || parsed.args) {
        format = 'mcp-config';
        primitiveType = 'tool';
        confidence = 0.9;
        reasons.push('MCP configuration JSON detected');
        return { format, primitiveType, confidence, reasons };
      }
    } catch {
      // Not valid JSON, continue
    }
  }

  // Check for .faf YAML format
  if (ext === '.faf' || ext === '.yaml' || ext === '.yml') {
    try {
      const parsed = parseYaml(content) as Record<string, unknown>;
      if (parsed.type && parsed.content) {
        format = 'faf-yaml';
        primitiveType = inferTypeFromFafType(String(parsed.type));
        confidence = 0.9;
        reasons.push(`.faf YAML format with type: ${parsed.type}`);
        return { format, primitiveType, confidence, reasons };
      }
      // YAML with mcpServers
      if (parsed.mcpServers || parsed.servers) {
        format = 'mcp-config';
        primitiveType = 'tool';
        confidence = 0.85;
        reasons.push('MCP configuration YAML detected');
        return { format, primitiveType, confidence, reasons };
      }
    } catch {
      // Not valid YAML, continue
    }
  }

  // Check for markdown content
  if (ext === '.md' || ext === '' || !ext) {
    // Try to parse frontmatter
    try {
      const parsed = matter(content);
      const data = parsed.data as Record<string, unknown>;

      if (data.id && data.status) {
        // Has harness-style frontmatter
        format = 'harness';
        confidence = 0.95;
        reasons.push('Harness frontmatter detected (id + status fields)');

        // Detect type from tags
        const tags = Array.isArray(data.tags)
          ? (data.tags as string[]).map((t) => String(t).toLowerCase())
          : [];
        for (const type of VALID_TYPES) {
          if (tags.includes(type)) {
            primitiveType = type;
            break;
          }
        }

        return { format, primitiveType, confidence, reasons };
      }

      if (Object.keys(data).length > 0) {
        // Has some frontmatter but not harness convention
        format = 'raw-markdown';
        confidence = 0.7;
        reasons.push('Markdown with non-harness frontmatter');
      }
    } catch {
      // No frontmatter or parse error
    }

    // Check for Claude Code SKILL.md patterns
    if (format === 'unknown' || format === 'raw-markdown') {
      const isClaudeSkill = detectClaudeSkillPattern(content, filename);
      if (isClaudeSkill) {
        format = 'claude-skill';
        primitiveType = 'skill';
        confidence = 0.8;
        reasons.push('Claude Code SKILL.md pattern detected');
        return { format, primitiveType, confidence, reasons };
      }
    }

    // Plain markdown — infer type from content
    if (format === 'unknown') {
      format = 'raw-markdown';
      confidence = 0.5;
      reasons.push('Plain markdown without frontmatter');
    }

    // Try to infer type from content/filename
    if (!primitiveType) {
      primitiveType = inferTypeFromContent(content, filename);
      if (primitiveType) {
        reasons.push(`Type inferred from content/filename: ${primitiveType}`);
      }
    }

    return { format, primitiveType, confidence, reasons };
  }

  return { format, primitiveType, confidence, reasons };
}

// ─── Format Normalization ────────────────────────────────────────────────────

/**
 * Normalize content from any detected format to harness convention.
 * Returns the normalized markdown content ready for writing.
 */
export function normalizeToHarness(
  content: string,
  filename: string,
  detection: FormatDetection,
  options?: UniversalInstallOptions,
): { content: string; filename: string; fixes: string[] } {
  const fixes: string[] = [];
  const type = options?.type ?? detection.primitiveType;

  switch (detection.format) {
    case 'harness':
      // Already in harness format — just pass through
      return { content, filename, fixes: ['Already in harness format'] };

    case 'claude-skill':
      return normalizeClaudeSkill(content, filename, type, options, fixes);

    case 'faf-yaml':
      return normalizeFafYaml(content, filename, type, options, fixes);

    case 'raw-markdown':
      return normalizeRawMarkdown(content, filename, type, options, fixes);

    case 'bash-hook':
      return normalizeBashHook(content, filename, type, options, fixes);

    case 'mcp-config':
      return normalizeMcpConfig(content, filename, options, fixes);

    default:
      return normalizeRawMarkdown(content, filename, type, options, fixes);
  }
}

/**
 * Convert Claude Code SKILL.md to harness convention.
 * Claude skills are plain markdown — add frontmatter + L0/L1.
 */
function normalizeClaudeSkill(
  content: string,
  filename: string,
  type: string | null,
  options: UniversalInstallOptions | undefined,
  fixes: string[],
): { content: string; filename: string; fixes: string[] } {
  const id = options?.id ?? deriveId(filename);
  const primitiveType = type ?? 'skill';
  const tags = [primitiveType, ...(options?.tags ?? [])];

  // Extract first heading as title
  const headingMatch = content.match(/^#\s+(.+)$/m);
  const title = headingMatch ? headingMatch[1].trim() : id;

  const frontmatter: Record<string, unknown> = {
    id,
    created: new Date().toISOString().split('T')[0],
    author: 'human',
    status: 'active',
    tags,
  };

  // Generate L0 from title/first heading
  const l0 = title.length > 120 ? title.slice(0, 117) + '...' : title;

  // Generate L1 from first paragraph
  const paragraphs = content.split(/\n{2,}/).filter((p) => {
    const trimmed = p.trim();
    return trimmed.length > 0 && !trimmed.startsWith('#') && !trimmed.startsWith('<!--');
  });
  const l1 = paragraphs.length > 0
    ? paragraphs[0].replace(/\n/g, ' ').trim().slice(0, 300)
    : '';

  let body = `<!-- L0: ${l0} -->\n`;
  if (l1) {
    body += `<!-- L1: ${l1} -->\n`;
  }
  body += '\n' + content;

  const result = matter.stringify(body, frontmatter);
  fixes.push('Added harness frontmatter (id, status, tags)');
  fixes.push(`Generated L0 from heading: "${l0}"`);
  if (l1) fixes.push('Generated L1 from first paragraph');

  const outFilename = ensureMdExtension(filename);
  return { content: result, filename: outFilename, fixes };
}

/**
 * Convert .faf YAML format to harness markdown.
 */
function normalizeFafYaml(
  content: string,
  filename: string,
  type: string | null,
  options: UniversalInstallOptions | undefined,
  fixes: string[],
): { content: string; filename: string; fixes: string[] } {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseYaml(content) as Record<string, unknown>;
  } catch {
    fixes.push('Failed to parse YAML — treating as raw markdown');
    return normalizeRawMarkdown(content, filename, type, options, fixes);
  }

  const id = options?.id ?? String(parsed.id ?? deriveId(filename));
  const fafType = String(parsed.type ?? 'skill');
  const primitiveType = type ?? inferTypeFromFafType(fafType) ?? 'skill';
  const title = String(parsed.title ?? parsed.name ?? id);
  const description = String(parsed.description ?? '');
  const fafContent = String(parsed.content ?? '');
  const fafTags = Array.isArray(parsed.tags)
    ? (parsed.tags as string[]).map(String)
    : [];

  const tags = [primitiveType, ...fafTags, ...(options?.tags ?? [])];

  const frontmatter: Record<string, unknown> = {
    id,
    created: new Date().toISOString().split('T')[0],
    author: 'human',
    status: 'active',
    tags: [...new Set(tags)],
  };

  const l0 = title.length > 120 ? title.slice(0, 117) + '...' : title;
  const l1 = description.length > 300 ? description.slice(0, 297) + '...' : description;

  let body = `<!-- L0: ${l0} -->\n`;
  if (l1) body += `<!-- L1: ${l1} -->\n`;
  body += `\n# ${title}\n\n`;
  if (description) body += `${description}\n\n`;
  if (fafContent) body += fafContent + '\n';

  const result = matter.stringify(body, frontmatter);
  fixes.push('Converted .faf YAML to harness markdown');
  fixes.push(`Added frontmatter (id: ${id}, type: ${primitiveType})`);

  const outFilename = deriveId(filename) + '.md';
  return { content: result, filename: outFilename, fixes };
}

/**
 * Normalize raw markdown (no frontmatter or non-harness frontmatter).
 */
function normalizeRawMarkdown(
  content: string,
  filename: string,
  type: string | null,
  options: UniversalInstallOptions | undefined,
  fixes: string[],
): { content: string; filename: string; fixes: string[] } {
  const id = options?.id ?? deriveId(filename);
  const primitiveType = type ?? 'skill';
  const tags = [primitiveType, ...(options?.tags ?? [])];

  // Try to preserve any existing frontmatter
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(content);
  } catch {
    parsed = { data: {}, content, orig: '', excerpt: '', language: '', matter: '', stringify: () => '' } as ReturnType<typeof matter>;
  }

  const data = parsed.data as Record<string, unknown>;

  // Set required harness fields — options override existing values
  if (options?.id || !data.id) {
    data.id = id;
    fixes.push(`Set id: "${id}"`);
  }
  if (!data.status) {
    data.status = 'active';
    fixes.push('Added status: "active"');
  }
  if (!data.created) {
    data.created = new Date().toISOString().split('T')[0];
    fixes.push('Added created date');
  }
  if (!data.author || !['human', 'agent', 'infrastructure'].includes(String(data.author))) {
    data.author = 'human';
    fixes.push('Added author: "human"');
  }
  if (!Array.isArray(data.tags) || data.tags.length === 0) {
    data.tags = [...new Set(tags)];
    fixes.push(`Added tags: [${(data.tags as string[]).join(', ')}]`);
  }

  let body = parsed.content;

  // Add L0 if missing
  const l0Regex = /<!--\s*L0:\s*(.*?)\s*-->/;
  if (!l0Regex.test(body)) {
    const headingMatch = body.match(/^#\s+(.+)$/m);
    const firstLine = body.split('\n').find((line) => line.trim().length > 0);
    const summary = headingMatch ? headingMatch[1].trim() : (firstLine?.trim() ?? id);
    const l0 = summary.length > 120 ? summary.slice(0, 117) + '...' : summary;
    body = `<!-- L0: ${l0} -->\n${body}`;
    fixes.push(`Generated L0: "${l0}"`);
  }

  // Add L1 if missing
  const l1Regex = /<!--\s*L1:\s*([\s\S]*?)\s*-->/;
  if (!l1Regex.test(body)) {
    const paragraphs = body.split(/\n{2,}/).filter((p) => {
      const trimmed = p.trim();
      return trimmed.length > 0 && !trimmed.startsWith('<!--') && !trimmed.startsWith('#');
    });
    if (paragraphs.length > 0) {
      const para = paragraphs[0].replace(/\n/g, ' ').trim();
      const l1 = para.length > 300 ? para.slice(0, 297) + '...' : para;
      const l0Pos = body.indexOf('-->');
      if (l0Pos !== -1) {
        const insertPos = l0Pos + 3;
        body = body.slice(0, insertPos) + `\n<!-- L1: ${l1} -->` + body.slice(insertPos);
      } else {
        body = `<!-- L1: ${l1} -->\n${body}`;
      }
      fixes.push('Generated L1 from first paragraph');
    }
  }

  const result = matter.stringify(body, data);
  const outFilename = ensureMdExtension(filename);
  return { content: result, filename: outFilename, fixes };
}

/**
 * Wrap a bash hook script in harness markdown.
 */
function normalizeBashHook(
  content: string,
  filename: string,
  type: string | null,
  options: UniversalInstallOptions | undefined,
  fixes: string[],
): { content: string; filename: string; fixes: string[] } {
  const id = options?.id ?? deriveId(filename);
  const primitiveType = type ?? 'workflow';
  const tags = [primitiveType, 'hook', ...(options?.tags ?? [])];

  // Extract description from comments at top of script
  const commentLines = content.split('\n')
    .filter((line) => line.startsWith('#') && !line.startsWith('#!'))
    .map((line) => line.replace(/^#\s?/, '').trim())
    .filter((line) => line.length > 0);

  const description = commentLines.length > 0
    ? commentLines.slice(0, 3).join(' ')
    : `Bash hook: ${id}`;

  const frontmatter: Record<string, unknown> = {
    id,
    created: new Date().toISOString().split('T')[0],
    author: 'human',
    status: 'active',
    tags: [...new Set(tags)],
  };

  const l0 = description.length > 120 ? description.slice(0, 117) + '...' : description;

  let body = `<!-- L0: ${l0} -->\n\n`;
  body += `# ${id}\n\n`;
  body += `${description}\n\n`;
  body += '```bash\n';
  body += content;
  if (!content.endsWith('\n')) body += '\n';
  body += '```\n';

  const result = matter.stringify(body, frontmatter);
  fixes.push('Wrapped bash script in harness markdown');
  fixes.push(`Added frontmatter (id: ${id}, type: ${primitiveType})`);

  const outFilename = deriveId(filename) + '.md';
  return { content: result, filename: outFilename, fixes };
}

/**
 * Convert an MCP config to harness tool documentation.
 */
function normalizeMcpConfig(
  content: string,
  filename: string,
  options: UniversalInstallOptions | undefined,
  fixes: string[],
): { content: string; filename: string; fixes: string[] } {
  const id = options?.id ?? deriveId(filename);
  const tags = ['tool', 'mcp', ...(options?.tags ?? [])];

  // Try to parse config
  let config: Record<string, unknown> = {};
  const ext = extname(filename).toLowerCase();
  try {
    if (ext === '.json') {
      config = JSON.parse(content) as Record<string, unknown>;
    } else {
      config = parseYaml(content) as Record<string, unknown>;
    }
  } catch {
    fixes.push('Failed to parse MCP config');
  }

  const serverName = String(config.name ?? config.command ?? id);
  const description = String(config.description ?? `MCP server: ${serverName}`);

  const frontmatter: Record<string, unknown> = {
    id,
    created: new Date().toISOString().split('T')[0],
    author: 'human',
    status: 'active',
    tags: [...new Set(tags)],
  };

  const l0 = description.length > 120 ? description.slice(0, 117) + '...' : description;

  let body = `<!-- L0: ${l0} -->\n\n`;
  body += `# MCP Server: ${serverName}\n\n`;
  body += `${description}\n\n`;
  body += '## Configuration\n\n';
  body += '```json\n';
  body += JSON.stringify(config, null, 2);
  body += '\n```\n';

  const result = matter.stringify(body, frontmatter);
  fixes.push('Converted MCP config to harness tool documentation');
  fixes.push(`Added frontmatter (id: ${id})`);

  const outFilename = deriveId(filename) + '.md';
  return { content: result, filename: outFilename, fixes };
}

// ─── Source Resolution ───────────────────────────────────────────────────────

/**
 * Resolve a source reference to a local file path.
 *
 * Supports:
 * - Local file paths (absolute or relative)
 * - HTTPS URLs (GitHub raw, any markdown URL)
 * - Source query (searches registered sources)
 *
 * @returns Path to a local file (downloaded if remote)
 */
export async function resolveSource(
  source: string,
  harnessDir: string,
): Promise<{ localPath: string; originalSource: string; error?: string }> {
  // Case 1: Local file path
  if (existsSync(source)) {
    return { localPath: source, originalSource: source };
  }

  // Case 2: URL
  if (source.startsWith('https://') || source.startsWith('http://')) {
    // Convert GitHub URL to raw if needed
    const rawUrl = convertToRawUrl(source);
    const result = await downloadCapability(rawUrl);
    if (result.downloaded) {
      return { localPath: result.localPath, originalSource: source };
    }
    return { localPath: '', originalSource: source, error: result.error };
  }

  // Case 3: Source registry lookup — search known sources
  const results = discoverSources(harnessDir, source, { maxResults: 1 });
  if (results.length > 0) {
    const hit = results[0];
    // If the source is a GitHub source, construct a raw URL
    if (hit.source.type === 'github') {
      const rawUrl = convertToRawUrl(hit.url);
      const result = await downloadCapability(rawUrl);
      if (result.downloaded) {
        return { localPath: result.localPath, originalSource: source };
      }
      return { localPath: '', originalSource: source, error: result.error };
    }
    return { localPath: '', originalSource: source, error: `Source "${hit.source.name}" is type "${hit.source.type}" — direct install not yet supported for this type` };
  }

  return { localPath: '', originalSource: source, error: `Could not resolve "${source}" — not a local file, URL, or known source` };
}

// ─── Main Install Function ───────────────────────────────────────────────────

/**
 * Universal install: resolve → detect → normalize → fix → install.
 *
 * Accepts a local path, URL, or search query. Detects the format,
 * normalizes to harness convention, applies auto-fixes, and installs
 * to the correct directory.
 *
 * @param harnessDir - Harness directory
 * @param source - File path, URL, or name to install
 * @param options - Installation options
 * @returns Install result with status, fixes, errors, dependency hints
 */
export async function universalInstall(
  harnessDir: string,
  source: string,
  options?: UniversalInstallOptions,
): Promise<UniversalInstallResult> {
  const result: UniversalInstallResult = {
    installed: false,
    source,
    format: { format: 'unknown', primitiveType: null, confidence: 0, reasons: [] },
    destination: '',
    fixes: [],
    errors: [],
    suggestedDependencies: [],
  };

  // Step 1: Resolve source to local file
  const resolved = await resolveSource(source, harnessDir);
  if (resolved.error || !resolved.localPath) {
    result.errors.push(resolved.error ?? 'Failed to resolve source');
    return result;
  }

  // Step 2: Read content
  let content: string;
  try {
    content = readFileSync(resolved.localPath, 'utf-8');
  } catch (err) {
    result.errors.push(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  if (content.trim().length === 0) {
    result.errors.push('File is empty');
    return result;
  }

  // Step 3: Detect format
  const filename = basename(resolved.localPath);
  const detection = detectFormat(content, filename);
  result.format = detection;

  // Step 4: Normalize to harness convention
  const normalized = normalizeToHarness(content, filename, detection, options);
  result.fixes.push(...normalized.fixes);

  // Step 5: Write normalized content to temp file for installation
  const tempDir = join(tmpdir(), 'harness-install');
  mkdirSync(tempDir, { recursive: true });
  const tempPath = join(tempDir, normalized.filename);
  writeFileSync(tempPath, normalized.content, 'utf-8');

  // Step 6: Apply auto-fix if not skipped
  if (!options?.skipFix) {
    const fixResult = fixCapability(tempPath);
    result.fixes.push(...fixResult.fixes_applied);

    if (!fixResult.valid && !options?.force) {
      result.errors.push(...fixResult.errors);
      return result;
    }
  }

  // Step 7: Install via existing pipeline
  const installResult = installCapability(harnessDir, tempPath);
  result.installed = installResult.installed;
  result.destination = installResult.destination;

  if (!installResult.installed) {
    result.errors.push(...installResult.evalResult.errors);
    // If force mode, try direct copy
    if (options?.force && detection.primitiveType) {
      const targetDir = join(harnessDir, TYPE_DIRS[detection.primitiveType] ?? 'skills');
      if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
      const dest = join(targetDir, normalized.filename);
      copyFileSync(tempPath, dest);
      result.installed = true;
      result.destination = dest;
      result.fixes.push('Force-installed despite validation errors');
    }
  }

  // Step 8: Scan for dependency hints
  result.suggestedDependencies = extractDependencyHints(normalized.content);

  return result;
}

/**
 * Install from a URL (convenience wrapper).
 */
export async function installFromUrl(
  harnessDir: string,
  url: string,
  options?: UniversalInstallOptions,
): Promise<UniversalInstallResult> {
  return universalInstall(harnessDir, url, options);
}

/**
 * Install from a local file path (convenience wrapper).
 */
export async function installFromFile(
  harnessDir: string,
  filePath: string,
  options?: UniversalInstallOptions,
): Promise<UniversalInstallResult> {
  return universalInstall(harnessDir, filePath, options);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deriveId(filename: string): string {
  const base = basename(filename).replace(/\.(md|faf|yaml|yml|json|sh|bash)$/i, '');
  return base.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
}

function ensureMdExtension(filename: string): string {
  if (filename.endsWith('.md')) return filename;
  return deriveId(filename) + '.md';
}

/**
 * Convert a GitHub URL to its raw content URL.
 *
 * Handles:
 * - github.com/owner/repo/blob/branch/path → raw.githubusercontent.com/owner/repo/branch/path
 * - Already raw.githubusercontent.com URLs → pass through
 * - Other URLs → pass through
 */
export function convertToRawUrl(url: string): string {
  // Already raw
  if (url.includes('raw.githubusercontent.com')) return url;

  // GitHub blob URL → raw
  const blobMatch = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/,
  );
  if (blobMatch) {
    const [, owner, repo, rest] = blobMatch;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${rest}`;
  }

  return url;
}

/**
 * Detect if content matches Claude Code SKILL.md patterns.
 * Claude skills are plain markdown with specific structural patterns.
 */
function detectClaudeSkillPattern(content: string, filename: string): boolean {
  const nameLower = filename.toLowerCase();

  // Filename patterns
  if (nameLower === 'skill.md' || nameLower.endsWith('-skill.md') || nameLower.endsWith('_skill.md')) {
    return true;
  }

  // Content patterns common in Claude Code skills
  const patterns = [
    /^#\s+.+skill/im,
    /instructions?\s+for\s+/i,
    /when\s+(the\s+)?user\s+(asks?|wants?|needs?|requests?)/i,
    /you\s+(should|must|will)\s+/i,
  ];

  let matches = 0;
  for (const pattern of patterns) {
    if (pattern.test(content)) matches++;
  }

  // Need at least 2 pattern matches to classify as Claude skill
  // (plain markdown + instructional tone)
  return matches >= 2 && !content.startsWith('---');
}

function inferTypeFromFafType(fafType: string): string | null {
  const typeMap: Record<string, string> = {
    skill: 'skill',
    agent: 'agent',
    rule: 'rule',
    playbook: 'playbook',
    workflow: 'workflow',
    tool: 'tool',
    instinct: 'instinct',
    hook: 'workflow',
    template: 'skill',
    plugin: 'skill',
  };

  return typeMap[fafType.toLowerCase()] ?? null;
}

function inferTypeFromContent(content: string, filename: string): string | null {
  const lower = content.toLowerCase();
  const nameLower = filename.toLowerCase();

  // From filename
  if (nameLower.includes('rule')) return 'rule';
  if (nameLower.includes('agent')) return 'agent';
  if (nameLower.includes('playbook')) return 'playbook';
  if (nameLower.includes('workflow')) return 'workflow';
  if (nameLower.includes('instinct')) return 'instinct';
  if (nameLower.includes('tool')) return 'tool';
  if (nameLower.includes('skill')) return 'skill';

  // From content patterns
  if (lower.includes('# rule:') || lower.includes('## rules')) return 'rule';
  if (lower.includes('# agent:') || lower.includes('## agent')) return 'agent';
  if (lower.includes('# playbook:') || lower.includes('## playbook')) return 'playbook';
  if (lower.includes('# skill:') || lower.includes('## skill')) return 'skill';
  if (lower.includes('# workflow:') || lower.includes('## workflow')) return 'workflow';
  if (lower.includes('# tool:') || lower.includes('## tool')) return 'tool';

  // Default for markdown without clear type
  return null;
}

/**
 * Extract dependency hints from content.
 * Looks for references to tools, skills, or other primitives.
 */
function extractDependencyHints(content: string): string[] {
  const hints: string[] = [];
  const seen = new Set<string>();

  // Look for "requires:" or "depends:" in frontmatter
  try {
    const parsed = matter(content);
    const data = parsed.data as Record<string, unknown>;
    if (Array.isArray(data.requires)) {
      for (const dep of data.requires as string[]) {
        if (!seen.has(dep)) {
          hints.push(dep);
          seen.add(dep);
        }
      }
    }
    if (Array.isArray(data.depends)) {
      for (const dep of data.depends as string[]) {
        if (!seen.has(dep)) {
          hints.push(dep);
          seen.add(dep);
        }
      }
    }
    if (Array.isArray(data.related)) {
      for (const dep of data.related as string[]) {
        if (!seen.has(dep)) {
          hints.push(dep);
          seen.add(dep);
        }
      }
    }
  } catch {
    // Ignore parse errors
  }

  return hints;
}
