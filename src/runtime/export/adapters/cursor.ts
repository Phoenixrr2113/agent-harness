import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'fs';
import matter from 'gray-matter';
import type { ExportContext, ExportReport, DriftReport, DriftFinding, ProviderAdapter } from '../types.js';
import { computeContentHash, embedProvenance, extractProvenance, stripProvenance } from '../provenance.js';
import { registerAdapter } from '../registry.js';
import type { HarnessDocument } from '../../../core/types.js';

// Cursor MDC schema verified 2026-04-29 against https://cursor.com/docs/context/rules
// Frontmatter fields:
//   description (string, optional) — used by Agent for relevance when alwaysApply=false
//   globs (string, optional) — comma-separated file patterns; auto-attach when matching
//   alwaysApply (boolean, optional) — when true, rule is always included
// We emit globs as an empty string when there are no patterns (the docs show
// comma-separated string form, not array). alwaysApply defaults to false.

const SCRIPT_EMBED_BYTE_LIMIT = 8000; // 8KB — embed inline; otherwise warn and drop

function buildMdcBody(skill: HarnessDocument, warnings: string[]): string {
  const lines: string[] = [];
  if (skill.body && skill.body.trim()) lines.push(skill.body.trim());

  if (skill.bundleDir) {
    const scriptsDir = join(skill.bundleDir, 'scripts');
    if (existsSync(scriptsDir)) {
      for (const entry of readdirSync(scriptsDir)) {
        const fullPath = join(scriptsDir, entry);
        const st = statSync(fullPath);
        if (!st.isFile()) continue;
        if (st.size > SCRIPT_EMBED_BYTE_LIMIT) {
          warnings.push(`${skill.name}: script ${entry} (${st.size} bytes) too large to embed; preserved at source path`);
          continue;
        }
        const content = readFileSync(fullPath, 'utf-8');
        lines.push(`\n### Script: \`${entry}\`\n\n\`\`\`\n${content}\n\`\`\``);
      }
    }
  }
  return lines.join('\n\n');
}

async function exportAll(ctx: ExportContext): Promise<ExportReport> {
  const report: ExportReport = { provider: 'cursor', written: [], skipped: [], warnings: [] };
  const rulesDir = join(ctx.targetDir, 'rules');
  mkdirSync(rulesDir, { recursive: true });

  for (const skill of ctx.skills) {
    if (!skill.bundleDir) {
      report.skipped.push({ path: skill.name, reason: 'no bundle directory' });
      continue;
    }
    const trigger = skill.metadata?.['harness-trigger'] as string | undefined;
    const alwaysApply = trigger === 'prepare-call';
    const body = buildMdcBody(skill, report.warnings);
    const frontmatterData = {
      description: typeof skill.description === 'string' ? skill.description : '',
      globs: '',
      alwaysApply,
    };
    const composed = matter.stringify(body, frontmatterData);
    // Canonicalize before hashing — stripProvenance re-serializes via gray-matter,
    // and the canonical form is what we want to compare against on drift detection.
    const canonical = stripProvenance(composed, 'frontmatter');
    const hash = computeContentHash(canonical);
    const stamped = embedProvenance(composed, {
      'harness-exported-from': join(skill.bundleDir, 'SKILL.md'),
      'harness-exported-at': new Date().toISOString(),
      'harness-exported-by': ctx.harnessVersion,
      'harness-content-hash': hash,
    }, 'frontmatter');
    const target = join(rulesDir, `${skill.name}.mdc`);
    writeFileSync(target, stamped, 'utf-8');
    report.written.push(target);
  }
  return report;
}

async function detectDrift(ctx: ExportContext): Promise<DriftReport> {
  const findings: DriftFinding[] = [];
  const knownNames = new Set(ctx.skills.map((s) => s.name));
  const rulesDir = join(ctx.targetDir, 'rules');
  if (!existsSync(rulesDir)) return { provider: 'cursor', findings };

  for (const skill of ctx.skills) {
    const target = join(rulesDir, `${skill.name}.mdc`);
    if (!existsSync(target)) {
      findings.push({ path: target, severity: 'warning', kind: 'missing-file', detail: 'expected output not present' });
      continue;
    }
    const content = readFileSync(target, 'utf-8');
    const marker = extractProvenance(content, 'frontmatter');
    if (!marker) {
      findings.push({ path: target, severity: 'warning', kind: 'missing-marker', detail: 'no provenance marker' });
      continue;
    }
    const stripped = stripProvenance(content, 'frontmatter');
    if (computeContentHash(stripped) !== marker['harness-content-hash']) {
      findings.push({ path: target, severity: 'warning', kind: 'modified', detail: 'hash mismatch — file edited externally' });
    }
  }
  for (const entry of readdirSync(rulesDir)) {
    if (!entry.endsWith('.mdc')) continue;
    const skillName = entry.replace(/\.mdc$/, '');
    if (!knownNames.has(skillName)) {
      findings.push({ path: join(rulesDir, entry), severity: 'warning', kind: 'orphan', detail: 'source skill removed; clean up via `harness export --prune`' });
    }
  }
  return { provider: 'cursor', findings };
}

export const cursorAdapter: ProviderAdapter = {
  name: 'cursor',
  exportAll,
  detectDrift,
};

registerAdapter(cursorAdapter);
