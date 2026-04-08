import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs';
import { join, basename, extname } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import matter from 'gray-matter';
import { parse as parseYaml } from 'yaml';
import { fixCapability, installCapability, downloadCapability } from './intake.js';
import { autoProcessFile } from './auto-processor.js';
import { discoverSources, loadAllSources } from './sources.js';
import type { Source, SourceDiscoveryResult } from './sources.js';
import { log } from '../core/logger.js';

// ─── Provenance ──────────────────────────────────────────────────────────────

/**
 * Read the harness's own package.json version for the `installed_by` field.
 *
 * Has to handle three possible runtime layouts because tsup bundles flat:
 *   - Dev/test:   src/runtime/universal-installer.ts → ../../package.json
 *   - Built bin:  dist/cli/index.js                  → ../../package.json
 *   - Built lib:  dist/<bundle>.js                   → ../package.json
 *
 * Walks up one directory at a time, requires `package.json`, and returns
 * the version of the FIRST one whose name is `@agntk/agent-harness`. Stops
 * after a few levels so a broken environment never causes an infinite loop.
 * Returns "unknown" on any failure so an install never blocks on this.
 */
function getHarnessVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const candidates = [
      '../package.json',
      '../../package.json',
      '../../../package.json',
    ];
    for (const candidate of candidates) {
      try {
        const pkg = require(candidate) as { name?: string; version?: string };
        if (pkg.name === '@agntk/agent-harness' && pkg.version) {
          return pkg.version;
        }
      } catch {
        // Candidate didn't resolve — try the next one.
      }
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Resolve a commit SHA for a GitHub raw URL by calling the GitHub Contents API.
 *
 * Input URL shape:
 *   https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
 * where {ref} is either a 40-char commit SHA or a branch/tag name.
 *
 * Returns the SHA (either the one already in the URL, or the one resolved from
 * a branch name via the Contents API). Returns `null` on any failure — network
 * error, timeout, 404, non-github host, unparseable URL — so the install can
 * proceed without source_commit.
 */
async function resolveGithubCommitSha(url: string): Promise<string | null> {
  // Only handle raw.githubusercontent.com URLs
  const match = url.match(
    /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/,
  );
  if (!match) return null;
  const [, owner, repo, ref, path] = match;

  // If ref is already a 40-char hex SHA, just return it
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref;

  // Otherwise resolve via the Contents API
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(apiUrl, {
      signal: controller.signal,
      headers: { 'Accept': 'application/vnd.github+json' },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { sha?: string };
    if (typeof data.sha === 'string' && /^[0-9a-f]{40}$/i.test(data.sha)) {
      return data.sha;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── License Detection (Level 2 of task 12.14) ──────────────────────────────

/**
 * Result of license detection. `spdxId` is one of:
 *   - A standard SPDX identifier ("MIT", "Apache-2.0", etc.)
 *   - "PROPRIETARY" — text says "all rights reserved" or no permission grant
 *   - "UNKNOWN" — no LICENSE file found, or text doesn't match any pattern
 */
export interface LicenseInfo {
  /** SPDX id, "PROPRIETARY", or "UNKNOWN" */
  spdxId: string;
  /** First copyright line found in the LICENSE text, if any */
  copyright?: string;
  /** URL to the license file the detector actually found, if any */
  licenseSource?: string;
}

/** Sibling LICENSE filenames to probe in the same directory as the installed file. */
const SIBLING_LICENSE_NAMES = [
  'LICENSE',
  'LICENSE.txt',
  'LICENSE.md',
  'COPYING',
  'COPYING.txt',
] as const;

/**
 * Classify a LICENSE file's body text into an SPDX id, "PROPRIETARY", or "UNKNOWN".
 * Substring-based detection — not a full parser. Good enough for the common cases
 * (MIT, Apache-2.0, BSD, ISC, GPL, MPL, CC) and the proprietary "all rights reserved"
 * pattern that bit us in v0.1.0.
 */
function classifyLicenseText(text: string): string {
  const lower = text.toLowerCase();
  // PROPRIETARY check first — overrides any false-positive substring match below.
  if (lower.includes('all rights reserved')) {
    return 'PROPRIETARY';
  }
  // Then SPDX-by-substring. Order matters: check more-specific patterns first
  // (e.g. AGPL before GPL, LGPL before GPL).
  if (lower.includes('mit license')) return 'MIT';
  if (lower.includes('apache license, version 2.0') || lower.includes('apache-2.0'))
    return 'Apache-2.0';
  if (lower.includes('mozilla public license version 2.0') || lower.includes('mpl-2.0'))
    return 'MPL-2.0';
  if (lower.includes('gnu affero general public license')) return 'AGPL-3.0';
  if (lower.includes('gnu lesser general public license')) {
    if (lower.includes('version 3')) return 'LGPL-3.0';
    if (lower.includes('version 2')) return 'LGPL-2.1';
  }
  if (lower.includes('gnu general public license')) {
    if (lower.includes('version 3')) return 'GPL-3.0';
    if (lower.includes('version 2')) return 'GPL-2.0';
  }
  if (lower.includes('isc license')) return 'ISC';
  if (lower.includes('cc0 1.0 universal') || lower.includes('cc0-1.0')) return 'CC0-1.0';
  if (lower.includes('creative commons attribution-sharealike 4.0')) return 'CC-BY-SA-4.0';
  if (lower.includes('creative commons attribution 4.0') || lower.includes('cc-by-4.0'))
    return 'CC-BY-4.0';
  if (
    lower.includes('redistribution and use in source and binary forms') &&
    lower.includes('neither the name of')
  ) {
    return 'BSD-3-Clause';
  }
  if (lower.includes('redistribution and use in source and binary forms')) {
    return 'BSD-2-Clause';
  }
  if (lower.includes('this is free and unencumbered software released into the public domain')) {
    return 'Unlicense';
  }
  return 'UNKNOWN';
}

/**
 * Extract the first `Copyright (c) YEAR ...` line from a license body.
 * Returns the trimmed line, or undefined if no copyright line is found.
 */
function extractCopyright(text: string): string | undefined {
  // Match lines starting with "©" or "Copyright" (any case) and containing a
  // 4-digit year. The leading "©" can be followed immediately by space/digit
  // (it's a non-word char so we don't put a \b after it). "Copyright" can be
  // followed by anything as long as a year appears later in the line.
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^©\s*\d{4}/.test(trimmed) || /^copyright\b.*\d{4}/i.test(trimmed)) {
      return trimmed;
    }
  }
  return undefined;
}

/**
 * Try to fetch a single sibling LICENSE file next to the installed file.
 * Returns the body text on success, null on any failure (404, network, timeout).
 */
async function fetchSiblingLicense(
  siblingUrl: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(siblingUrl, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Try to fetch the repo-root LICENSE via the GitHub License API.
 * Returns the SPDX id, html_url, and (when available) the decoded body text
 * so the caller can extract a copyright line. Null on any failure.
 *
 * The API response shape:
 *   {
 *     license: { spdx_id: "MIT" },
 *     html_url: "https://github.com/owner/repo/blob/main/LICENSE",
 *     content: "<base64>",
 *     encoding: "base64"
 *   }
 *
 * https://docs.github.com/en/rest/licenses/licenses#get-the-license-for-a-repository
 */
async function fetchGithubRepoLicense(
  owner: string,
  repo: string,
): Promise<{ spdxId: string; htmlUrl: string; body?: string } | null> {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/license`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(apiUrl, {
      signal: controller.signal,
      headers: { 'Accept': 'application/vnd.github+json' },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      license?: { spdx_id?: string };
      html_url?: string;
      content?: string;
      encoding?: string;
    };
    const spdxId = data.license?.spdx_id;
    if (!spdxId || spdxId === 'NOASSERTION') return null;

    // Decode the base64-encoded body so the caller can extract copyright.
    // Tolerant of failures — if decoding throws, just omit the body.
    let body: string | undefined;
    if (data.content && data.encoding === 'base64') {
      try {
        body = Buffer.from(data.content, 'base64').toString('utf-8');
      } catch {
        body = undefined;
      }
    }

    return { spdxId, htmlUrl: data.html_url ?? '', body };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Detect the license of a file at a given URL.
 *
 * Lookup order, strictest finding wins:
 *   1. Per-file LICENSE sibling in the same directory as the file.
 *      Catches the v0.1.0 case where each anthropics/skills/<skill>/
 *      directory contained its own proprietary LICENSE.txt.
 *   2. Repository root LICENSE via the GitHub License API. Returns SPDX id.
 *   3. Caller falls back to the source file's own frontmatter (handled in
 *      recordProvenance, not here).
 *
 * Strictness rule: PROPRIETARY > UNKNOWN > permissive SPDX. If a per-file
 * LICENSE says "All rights reserved" we never look at the repo root —
 * proprietary always wins.
 *
 * Non-github URLs return immediately with `{ spdxId: 'UNKNOWN' }` since we
 * have no way to look up a license. The caller can still use frontmatter.
 *
 * @param sourceUrl The URL the user passed to `harness install`
 * @returns LicenseInfo. Always returns an object — never throws or returns null.
 */
export async function detectLicense(sourceUrl: string): Promise<LicenseInfo> {
  // Only github raw URLs have a structure we can probe.
  const match = sourceUrl.match(
    /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/,
  );
  if (!match) {
    return { spdxId: 'UNKNOWN' };
  }
  const [, owner, repo, ref, path] = match;

  // 1. Per-file LICENSE sibling — split path into dir, then probe each filename.
  const lastSlash = path.lastIndexOf('/');
  const dir = lastSlash >= 0 ? path.slice(0, lastSlash) : '';
  const dirPrefix = dir ? `${dir}/` : '';

  for (const siblingName of SIBLING_LICENSE_NAMES) {
    const siblingUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${dirPrefix}${siblingName}`;
    const text = await fetchSiblingLicense(siblingUrl);
    if (text) {
      const spdxId = classifyLicenseText(text);
      const copyright = extractCopyright(text);
      return { spdxId, copyright, licenseSource: siblingUrl };
    }
  }

  // 2. Repository root LICENSE via the GitHub License API. The API returns
  //    the SPDX id directly, plus a base64-encoded body we can use to extract
  //    a copyright line.
  const repoLicense = await fetchGithubRepoLicense(owner, repo);
  if (repoLicense) {
    const copyright = repoLicense.body
      ? extractCopyright(repoLicense.body)
      : undefined;
    return {
      spdxId: repoLicense.spdxId,
      copyright,
      licenseSource: repoLicense.htmlUrl || undefined,
    };
  }

  return { spdxId: 'UNKNOWN' };
}

/**
 * Inject provenance and license fields into a normalized markdown file's
 * frontmatter.
 *
 * Provenance rules (Level 1 of task 12.14):
 * - `source` and `source_commit` are preserved if already present (idempotent)
 * - `installed_at` and `installed_by` are always updated to reflect the most
 *   recent install action
 * - `source_commit` is only written when a SHA could be resolved
 *
 * License rules (Level 2 of task 12.14):
 * - `license`, `copyright`, `license_source` are preserved if already present
 *   in the source file's frontmatter (idempotent — author intent wins)
 * - Otherwise detected via detectLicense() and merged in
 * - License detection NEVER blocks the install. Failures result in
 *   `license: UNKNOWN` rather than an error.
 *
 * @param content Normalized markdown content with existing frontmatter
 * @param originalSource The exact URL the user passed to `harness install`
 * @returns The content with provenance + license fields merged into frontmatter
 */
export async function recordProvenance(
  content: string,
  originalSource: string,
): Promise<string> {
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(content);
  } catch {
    return content;
  }

  const data = parsed.data as Record<string, unknown>;

  // Preserve existing source — idempotency rule
  if (!data.source) {
    data.source = originalSource;
  }

  // Preserve existing source_commit; only resolve if missing AND URL is github raw
  if (!data.source_commit) {
    const sha = await resolveGithubCommitSha(originalSource);
    if (sha) {
      data.source_commit = sha;
    }
  }

  // License detection (Level 2). Idempotent: don't overwrite author-set fields.
  // Only run detection if at least one license-related field is missing — saves
  // the network calls when re-installing files that already carry their license.
  if (!data.license || !data.copyright || !data.license_source) {
    const license = await detectLicense(originalSource);
    if (!data.license) {
      data.license = license.spdxId;
    }
    if (!data.copyright && license.copyright) {
      data.copyright = license.copyright;
    }
    if (!data.license_source && license.licenseSource) {
      data.license_source = license.licenseSource;
    }
  }

  // Always update these to reflect the most recent install
  data.installed_at = new Date().toISOString();
  data.installed_by = `agent-harness@${getHarnessVersion()}`;

  return matter.stringify(parsed.content, data);
}

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

  // Step 4b: Record provenance for URL installs so every installed file is
  // traceable back to its source. Local-path installs are skipped — the path
  // on disk is not a stable identifier.
  let finalContent = normalized.content;
  if (source.startsWith('http://') || source.startsWith('https://')) {
    finalContent = await recordProvenance(finalContent, source);
    result.fixes.push('Recorded provenance (source, installed_at, installed_by)');
  }

  // Step 5: Write normalized content to temp file for installation
  const tempDir = join(tmpdir(), 'harness-install');
  mkdirSync(tempDir, { recursive: true });
  const tempPath = join(tempDir, normalized.filename);
  writeFileSync(tempPath, finalContent, 'utf-8');

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
