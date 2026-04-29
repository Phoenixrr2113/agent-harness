import { readdirSync, existsSync, statSync, mkdirSync, renameSync, unlinkSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import matter from 'gray-matter';

export type MigrationKind =
  | 'rename-core-to-identity'
  | 'delete-system-md'
  | 'move-state-to-memory'
  | 'bundle-flat-skill'
  | 'rewrite-skill-frontmatter'
  | 'convert-allowed-tools-to-string'
  | 'strip-l0-l1-comments';

export interface MigrationFinding {
  kind: MigrationKind;
  path: string;
  detail?: string;
}

export interface MigrationReport {
  findings: MigrationFinding[];
}

/**
 * Convert a value from gray-matter frontmatter to a date string.
 * gray-matter (via js-yaml) automatically parses bare YAML dates (e.g.
 * `2026-01-15`) into JavaScript Date objects. We want to preserve the
 * original ISO date string form in the output.
 */
function toDateString(value: unknown): string {
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value);
}

/**
 * Read-only inspection of a harness directory. Returns the list of migrations
 * that would be applied by `applyMigrations`. Idempotent and safe to run on a
 * clean harness.
 */
export function checkMigrations(harnessDir: string): MigrationReport {
  const findings: MigrationFinding[] = [];

  if (existsSync(join(harnessDir, 'CORE.md'))) {
    findings.push({ kind: 'rename-core-to-identity', path: join(harnessDir, 'CORE.md') });
  }

  if (existsSync(join(harnessDir, 'SYSTEM.md'))) {
    findings.push({ kind: 'delete-system-md', path: join(harnessDir, 'SYSTEM.md') });
  }

  if (existsSync(join(harnessDir, 'state.md'))) {
    findings.push({ kind: 'move-state-to-memory', path: join(harnessDir, 'state.md') });
  }

  const skillsDir = join(harnessDir, 'skills');
  if (existsSync(skillsDir) && statSync(skillsDir).isDirectory()) {
    for (const entry of readdirSync(skillsDir)) {
      const entryPath = join(skillsDir, entry);
      const entryStats = statSync(entryPath);

      // Flat skill files need bundling. Also inspect their frontmatter now so
      // the rewrite findings are queued for the SKILL.md path the file will
      // occupy after bundling. The bundle step runs before the rewrite step
      // (insertion order is preserved through applyMigrations), so the file
      // will exist at the expected path when the rewrite executes.
      if (entryStats.isFile() && entry.endsWith('.md')) {
        findings.push({ kind: 'bundle-flat-skill', path: entryPath });

        const baseName = basename(entryPath, '.md');
        const futureSKILLmd = join(skillsDir, baseName, 'SKILL.md');

        let flatParsed: ReturnType<typeof matter>;
        try {
          const flatRaw = readFileSync(entryPath, 'utf-8');
          flatParsed = matter(flatRaw);
        } catch {
          continue;
        }

        const { data: flatData, content: flatContent } = flatParsed;
        const NON_SPEC_TOP_LEVEL_KEYS_FLAT = ['id', 'tags', 'status', 'author', 'created', 'updated', 'related'];

        if (NON_SPEC_TOP_LEVEL_KEYS_FLAT.some((k) => k in flatData)) {
          findings.push({ kind: 'rewrite-skill-frontmatter', path: futureSKILLmd });
        }

        if (Array.isArray(flatData['allowed-tools'])) {
          findings.push({ kind: 'convert-allowed-tools-to-string', path: futureSKILLmd });
        }

        if (/<!--\s*L[01]:/.test(flatContent)) {
          findings.push({ kind: 'strip-l0-l1-comments', path: futureSKILLmd });
        }
      }

      // Inspect bundled skill directories for frontmatter that needs rewriting
      if (entryStats.isDirectory()) {
        const skillMd = join(entryPath, 'SKILL.md');
        if (!existsSync(skillMd)) continue;

        let parsed: ReturnType<typeof matter>;
        try {
          const raw = readFileSync(skillMd, 'utf-8');
          parsed = matter(raw);
        } catch {
          continue;
        }

        const { data, content } = parsed;

        const NON_SPEC_TOP_LEVEL_KEYS = ['id', 'tags', 'status', 'author', 'created', 'updated', 'related'];
        if (NON_SPEC_TOP_LEVEL_KEYS.some((k) => k in data)) {
          findings.push({ kind: 'rewrite-skill-frontmatter', path: skillMd });
        }

        if (Array.isArray(data['allowed-tools'])) {
          findings.push({ kind: 'convert-allowed-tools-to-string', path: skillMd });
        }

        if (/<!--\s*L[01]:/.test(content)) {
          findings.push({ kind: 'strip-l0-l1-comments', path: skillMd });
        }
      }
    }
  }

  return { findings };
}

export interface ApplyResult {
  applied: MigrationFinding[];
  skipped: Array<MigrationFinding & { reason: string }>;
  errors: Array<MigrationFinding & { reason: string }>;
}

/**
 * Executes the findings from `checkMigrations` against the harness directory.
 * Each migration is idempotent: if the target state already exists, the step
 * is skipped with a reason instead of overwriting or erroring.
 *
 * The three skill-rewrite kinds (rewrite-skill-frontmatter,
 * convert-allowed-tools-to-string, strip-l0-l1-comments) are deduplicated
 * per file so each SKILL.md is rewritten exactly once even if all three are
 * detected.
 */
export function applyMigrations(harnessDir: string, report: MigrationReport): ApplyResult {
  const applied: MigrationFinding[] = [];
  const skipped: ApplyResult['skipped'] = [];
  const errors: ApplyResult['errors'] = [];

  // Deduplicate: consolidate all three rewrite kinds per file into a single
  // 'rewrite-skill-frontmatter' finding so the file is only written once.
  const seen = new Set<string>();
  const dedupedFindings: MigrationFinding[] = [];
  const rewriteSkillFiles = new Set<string>();

  for (const f of report.findings) {
    if (
      f.kind === 'rewrite-skill-frontmatter' ||
      f.kind === 'convert-allowed-tools-to-string' ||
      f.kind === 'strip-l0-l1-comments'
    ) {
      if (rewriteSkillFiles.has(f.path)) continue;
      rewriteSkillFiles.add(f.path);
      // Consolidate all three kinds into a single 'rewrite-skill-frontmatter' finding
      dedupedFindings.push({ kind: 'rewrite-skill-frontmatter', path: f.path });
      continue;
    }
    const key = `${f.kind}::${f.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedFindings.push(f);
  }

  for (const finding of dedupedFindings) {
    try {
      switch (finding.kind) {
        case 'rename-core-to-identity': {
          const target = join(harnessDir, 'IDENTITY.md');
          if (existsSync(target)) {
            skipped.push({ ...finding, reason: 'IDENTITY.md exists; CORE.md left in place' });
            break;
          }
          renameSync(finding.path, target);
          applied.push(finding);
          break;
        }
        case 'delete-system-md': {
          unlinkSync(finding.path);
          applied.push(finding);
          break;
        }
        case 'move-state-to-memory': {
          const target = join(harnessDir, 'memory', 'state.md');
          if (existsSync(target)) {
            skipped.push({ ...finding, reason: 'memory/state.md exists; top-level state.md left in place' });
            break;
          }
          mkdirSync(dirname(target), { recursive: true });
          renameSync(finding.path, target);
          applied.push(finding);
          break;
        }
        case 'bundle-flat-skill': {
          const flatPath = finding.path;
          const baseName = basename(flatPath, '.md');
          const bundleDir = join(dirname(flatPath), baseName);
          if (existsSync(bundleDir)) {
            skipped.push({ ...finding, reason: `${baseName}/ already exists; flat skill left in place` });
            break;
          }
          mkdirSync(bundleDir, { recursive: true });
          renameSync(flatPath, join(bundleDir, 'SKILL.md'));
          applied.push(finding);
          break;
        }
        case 'rewrite-skill-frontmatter': {
          const skillMd = finding.path;
          const raw = readFileSync(skillMd, 'utf-8');
          const { data, content } = matter(raw);

          const newData: Record<string, unknown> = {
            name: data.name,
          };

          // Description: use existing, or lift from L0 comment if missing
          if (data.description) {
            newData.description = data.description;
          } else {
            const l0Match = content.match(/<!--\s*L0:\s*([\s\S]*?)\s*-->/);
            if (l0Match) {
              newData.description = l0Match[1].trim();
            }
          }

          if (data.license) newData.license = data.license;
          if (data.compatibility) newData.compatibility = data.compatibility;

          // Convert allowed-tools array to space-separated string
          if (Array.isArray(data['allowed-tools'])) {
            newData['allowed-tools'] = (data['allowed-tools'] as string[]).join(' ');
          } else if (typeof data['allowed-tools'] === 'string') {
            newData['allowed-tools'] = data['allowed-tools'];
          }

          // Build metadata: move non-spec top-level fields into harness-* keys
          const meta: Record<string, string> = {};
          if (Array.isArray(data.tags) && (data.tags as unknown[]).length > 0) {
            meta['harness-tags'] = (data.tags as string[]).join(',');
          }
          if (data.status) meta['harness-status'] = String(data.status);
          if (data.author) meta['harness-author'] = String(data.author);
          if (data.created) meta['harness-created'] = toDateString(data.created);
          if (data.updated) meta['harness-updated'] = toDateString(data.updated);
          if (Array.isArray(data.related) && (data.related as unknown[]).length > 0) {
            meta['harness-related'] = (data.related as string[]).join(',');
          }
          // Preserve any pre-existing user metadata that's already string→string
          if (data.metadata && typeof data.metadata === 'object') {
            for (const [k, v] of Object.entries(data.metadata as Record<string, unknown>)) {
              meta[k] = String(v);
            }
          }
          if (Object.keys(meta).length > 0) {
            newData.metadata = meta;
          }

          // Strip L0/L1 HTML comments from body
          const newContent = content
            .replace(/<!--\s*L0:[\s\S]*?-->\s*\n?/g, '')
            .replace(/<!--\s*L1:[\s\S]*?-->\s*\n?/g, '')
            .trim();

          const out = matter.stringify(newContent, newData);
          writeFileSync(skillMd, out, 'utf-8');
          applied.push(finding);
          break;
        }
        // convert-allowed-tools-to-string and strip-l0-l1-comments are always
        // consolidated into rewrite-skill-frontmatter by the deduplication pass
        // above, so these cases are unreachable in normal operation. They are
        // listed here to satisfy the exhaustiveness guard.
        case 'convert-allowed-tools-to-string':
        case 'strip-l0-l1-comments': {
          skipped.push({ ...finding, reason: 'consolidated into rewrite-skill-frontmatter' });
          break;
        }
        default: {
          // Exhaustiveness guard
          const _exhaustive: never = finding.kind;
          skipped.push({ ...finding, reason: `unknown migration kind: ${_exhaustive}` });
          break;
        }
      }
    } catch (err) {
      errors.push({ ...finding, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { applied, skipped, errors };
}
