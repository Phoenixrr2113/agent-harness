import { readdirSync, existsSync, statSync, mkdirSync, renameSync, unlinkSync, rmSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { join, dirname, basename } from 'path';
import matter from 'gray-matter';

export type MigrationKind =
  | 'rename-core-to-identity'
  | 'delete-system-md'
  | 'move-state-to-memory'
  | 'bundle-flat-skill'
  | 'rewrite-skill-frontmatter'
  | 'convert-allowed-tools-to-string'
  | 'strip-l0-l1-comments'
  | 'move-instinct-to-rule'
  | 'move-playbook-to-skill'
  | 'move-workflow-to-skill'
  | 'move-agent-to-skill'
  | 'convert-tool-to-skill-with-script'
  | 'cleanup-empty-primitive-dir';

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

  // Scan old primitive directories that collapse into skills/ or rules/
  const PRIMITIVE_DIRS_TO_COLLAPSE = ['instincts', 'playbooks', 'workflows', 'agents'] as const;
  const kindByDir: Record<string, MigrationKind> = {
    instincts: 'move-instinct-to-rule',
    playbooks: 'move-playbook-to-skill',
    workflows: 'move-workflow-to-skill',
    agents: 'move-agent-to-skill',
  };

  for (const oldKind of PRIMITIVE_DIRS_TO_COLLAPSE) {
    const oldDir = join(harnessDir, oldKind);
    if (!existsSync(oldDir) || !statSync(oldDir).isDirectory()) continue;
    for (const entry of readdirSync(oldDir)) {
      const entryPath = join(oldDir, entry);
      if (!statSync(entryPath).isFile() || !entry.endsWith('.md')) continue;
      findings.push({ kind: kindByDir[oldKind], path: entryPath });
    }
  }

  // Scan tools/ for markdown HTTP tool descriptions to convert to skill bundles
  const toolsDir = join(harnessDir, 'tools');
  if (existsSync(toolsDir) && statSync(toolsDir).isDirectory()) {
    for (const entry of readdirSync(toolsDir)) {
      const entryPath = join(toolsDir, entry);
      if (statSync(entryPath).isFile() && entry.endsWith('.md')) {
        findings.push({ kind: 'convert-tool-to-skill-with-script', path: entryPath });
      }
    }
  }

  // Detect now-empty primitive directories that can be removed
  for (const oldKind of [...PRIMITIVE_DIRS_TO_COLLAPSE, 'tools'] as const) {
    const oldDir = join(harnessDir, oldKind);
    if (!existsSync(oldDir) || !statSync(oldDir).isDirectory()) continue;
    const entries = readdirSync(oldDir);
    if (entries.length === 0) {
      findings.push({ kind: 'cleanup-empty-primitive-dir', path: oldDir });
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

          // Derive name: prefer explicit name, fall back to parent directory name
          // (the parent dir is authoritative for bundle identity). Only use data.id
          // as a last resort when the file is not inside a bundle directory.
          const parentDirName = basename(dirname(skillMd));
          const resolvedName = data.name ?? (parentDirName !== 'skills' ? parentDirName : data.id);
          const newData: Record<string, unknown> = {};
          if (resolvedName !== undefined) {
            newData.name = resolvedName;
          }

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
        case 'move-instinct-to-rule': {
          const flatPath = finding.path;
          const baseName = basename(flatPath, '.md');
          const newDir = join(harnessDir, 'rules');
          mkdirSync(newDir, { recursive: true });
          const newPath = join(newDir, `${baseName}.md`);
          if (existsSync(newPath)) {
            skipped.push({ ...finding, reason: `rules/${baseName}.md exists; instinct left in place` });
            break;
          }
          const raw = readFileSync(flatPath, 'utf-8');
          const { data, content } = matter(raw);
          data.author = 'agent';
          if (!data.metadata || typeof data.metadata !== 'object') data.metadata = {};
          (data.metadata as Record<string, unknown>)['harness-source'] = 'learned';
          writeFileSync(newPath, matter.stringify(content, data), 'utf-8');
          unlinkSync(flatPath);
          applied.push(finding);
          break;
        }
        case 'move-playbook-to-skill': {
          const flatPath = finding.path;
          const baseName = basename(flatPath, '.md');
          const newBundleDir = join(harnessDir, 'skills', baseName);
          if (existsSync(newBundleDir)) {
            skipped.push({ ...finding, reason: `skills/${baseName}/ exists; playbook left in place` });
            break;
          }
          mkdirSync(newBundleDir, { recursive: true });
          renameSync(flatPath, join(newBundleDir, 'SKILL.md'));
          applied.push(finding);
          break;
        }
        case 'move-workflow-to-skill': {
          const flatPath = finding.path;
          const baseName = basename(flatPath, '.md');
          const newBundleDir = join(harnessDir, 'skills', baseName);
          if (existsSync(newBundleDir)) {
            skipped.push({ ...finding, reason: `skills/${baseName}/ exists; workflow left in place` });
            break;
          }
          const raw = readFileSync(flatPath, 'utf-8');
          const { data, content } = matter(raw);
          if (!data.metadata || typeof data.metadata !== 'object') data.metadata = {};
          const wfMeta = data.metadata as Record<string, unknown>;
          if (data.schedule !== undefined) { wfMeta['harness-schedule'] = String(data.schedule); delete data.schedule; }
          if (data.durable !== undefined) { wfMeta['harness-durable'] = String(data.durable); delete data.durable; }
          if (data.max_retries !== undefined) { wfMeta['harness-max-retries'] = String(data.max_retries); delete data.max_retries; }
          if (data.retry_delay_ms !== undefined) { wfMeta['harness-retry-delay-ms'] = String(data.retry_delay_ms); delete data.retry_delay_ms; }
          if (data.channel !== undefined) { wfMeta['harness-channel'] = String(data.channel); delete data.channel; }
          mkdirSync(newBundleDir, { recursive: true });
          writeFileSync(join(newBundleDir, 'SKILL.md'), matter.stringify(content, data), 'utf-8');
          unlinkSync(flatPath);
          applied.push(finding);
          break;
        }
        case 'move-agent-to-skill': {
          const flatPath = finding.path;
          const baseName = basename(flatPath, '.md');
          const newBundleDir = join(harnessDir, 'skills', baseName);
          if (existsSync(newBundleDir)) {
            skipped.push({ ...finding, reason: `skills/${baseName}/ exists; agent left in place` });
            break;
          }
          const raw = readFileSync(flatPath, 'utf-8');
          const { data, content } = matter(raw);
          if (!data.metadata || typeof data.metadata !== 'object') data.metadata = {};
          const agentMeta = data.metadata as Record<string, unknown>;
          agentMeta['harness-trigger'] = 'subagent';
          if (data.model !== undefined) { agentMeta['harness-model'] = String(data.model); delete data.model; }
          if (Array.isArray(data.active_tools)) {
            agentMeta['harness-active-tools'] = (data.active_tools as string[]).join(',');
            delete data.active_tools;
          }
          mkdirSync(newBundleDir, { recursive: true });
          writeFileSync(join(newBundleDir, 'SKILL.md'), matter.stringify(content, data), 'utf-8');
          unlinkSync(flatPath);
          applied.push(finding);
          break;
        }
        case 'convert-tool-to-skill-with-script': {
          const flatPath = finding.path;
          const baseName = basename(flatPath, '.md');
          const newBundleDir = join(harnessDir, 'skills', baseName);
          if (existsSync(newBundleDir)) {
            skipped.push({ ...finding, reason: `skills/${baseName}/ exists; tool left in place` });
            break;
          }

          const raw = readFileSync(flatPath, 'utf-8');
          const { data, content } = matter(raw);

          // Try to parse ## Operations section to generate a script with operation stubs
          const opsMatch = content.match(/##\s*Operations\s*\n([\s\S]*?)(?=\n##|$)/i);

          let script: string;
          if (opsMatch) {
            script = [
              '#!/usr/bin/env bash',
              `# Auto-generated from tools/${baseName}.md`,
              'set -euo pipefail',
              '',
              '# Authentication: see SKILL.md "## Authentication" section',
              '',
              '# Usage: scripts/call.sh <operation> [args...]',
              'OP="${1:-}"',
              'shift || true',
              '',
              'case "$OP" in',
              '  --help|-h)',
              '    cat <<\'EOF\'',
              `Usage: scripts/call.sh <operation> [args...]`,
              `Operations: see SKILL.md "## Operations" section.`,
              'Returns JSON: { status, result?, error?, next_steps? }',
              'EOF',
              '    exit 0',
              '    ;;',
              '  *)',
              '    echo \'{"status":"error","error":{"code":"NOT_IMPLEMENTED","message":"Auto-generated stub. Edit scripts/call.sh to implement operations."}}\'',
              '    exit 1',
              '    ;;',
              'esac',
              '',
            ].join('\n');
          } else {
            // No operations section — emit a stub script flagging that the tool needs manual conversion
            script = [
              '#!/usr/bin/env bash',
              `# Auto-generated stub — no parseable Operations section in the original tool md.`,
              `echo '{"status":"error","error":{"code":"NEEDS_MANUAL_CONVERSION","message":"This tool was converted from tools/${baseName}.md but its operations could not be auto-extracted. See SKILL.md and rewrite this script."}}'`,
              'exit 1',
              '',
            ].join('\n');
          }

          // Inject harness-script-source into metadata
          if (!data.metadata || typeof data.metadata !== 'object') data.metadata = {};
          (data.metadata as Record<string, unknown>)['harness-script-source'] = 'auto-generated-from-tools';

          // Append ## Available scripts section to the body
          const newBody = `${content.trim()}\n\n## Available scripts\n\n- \`scripts/call.sh\` — Auto-generated from this tool's Operations section. Review before relying on it.\n`;

          mkdirSync(newBundleDir, { recursive: true });
          mkdirSync(join(newBundleDir, 'scripts'), { recursive: true });
          writeFileSync(join(newBundleDir, 'SKILL.md'), matter.stringify(newBody, data), 'utf-8');
          writeFileSync(join(newBundleDir, 'scripts', 'call.sh'), script, 'utf-8');
          // chmod +x the script — best-effort, ignore on systems that don't support it
          try { chmodSync(join(newBundleDir, 'scripts', 'call.sh'), 0o755); } catch { /* best-effort */ }
          unlinkSync(flatPath);
          applied.push(finding);
          break;
        }
        case 'cleanup-empty-primitive-dir': {
          rmSync(finding.path, { recursive: true, force: true });
          applied.push(finding);
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

  // Post-pass: after moving files out of old primitive directories, remove
  // any that are now empty. This covers the case where a single applyMigrations
  // call both moves files out AND cleans up the resulting empty directory.
  const OLD_PRIMITIVE_DIRS = ['instincts', 'playbooks', 'workflows', 'agents', 'tools'];
  for (const dirName of OLD_PRIMITIVE_DIRS) {
    const dirPath = join(harnessDir, dirName);
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) continue;
    const entries = readdirSync(dirPath);
    if (entries.length === 0) {
      try {
        rmSync(dirPath, { recursive: true, force: true });
        // Only record as applied if it wasn't already in the report (dedup guard)
        const alreadyApplied = applied.some(
          (f) => f.kind === 'cleanup-empty-primitive-dir' && f.path === dirPath
        );
        if (!alreadyApplied) {
          applied.push({ kind: 'cleanup-empty-primitive-dir', path: dirPath });
        }
      } catch (err) {
        errors.push({
          kind: 'cleanup-empty-primitive-dir',
          path: dirPath,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { applied, skipped, errors };
}
