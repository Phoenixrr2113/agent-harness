import { join, dirname } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, copyFileSync, rmSync } from 'fs';
import type { ExportContext, ExportReport, DriftReport, DriftFinding, ProviderAdapter } from '../types.js';
import { computeContentHash, embedProvenance, extractProvenance, stripProvenance } from '../provenance.js';
import { composeIdentityDocument } from '../identity-output.js';
import { registerAdapter } from '../registry.js';
import type { HarnessDocument } from '../../../core/types.js';

// Gemini extension schema verified 2026-04-29 against
//   https://geminicli.com/docs/extensions/writing-extensions
//   https://geminicli.com/docs/extensions/reference
//
// Verified facts:
//   - Manifest filename is `gemini-extension.json` (NOT manifest.json).
//   - Required fields: `name` (unique extension name) and `version`.
//     Optional fields include `mcpServers`, `settings`, `contextFileName`.
//   - The CLI loads extensions from `<home>/.gemini/extensions/<name>/`; each
//     extension MUST place gemini-extension.json at its root directory.
//   - Skills bundled inside an installed extension surface as "Extension Skills"
//     (third tier alongside workspace and user skills). Subdirectory layout for
//     skills is not specified in public docs; we follow the Agent Skills
//     convention by writing SKILL.md + bundle resources at the extension root,
//     which mirrors how the claude/agents adapters layout per-skill bundles.
//
// Layout note:
//   We export one extension per skill at `<targetDir>/extensions/<name>/`.
//   `ctx.targetDir` is configured by the export config (`.gemini/` or
//   `~/.gemini/`), so the same adapter serves both project-level and
//   user-level destinations without code changes.

function copyDir(src: string, dst: string, written: string[]): void {
  if (!existsSync(src)) return;
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      copyDir(srcPath, dstPath, written);
    } else {
      copyFileSync(srcPath, dstPath);
      written.push(dstPath);
    }
  }
}

function writeExtensionForSkill(skill: HarnessDocument, ctx: ExportContext, report: ExportReport): void {
  if (!skill.bundleDir) {
    report.skipped.push({ path: skill.name, reason: 'no bundle directory' });
    return;
  }
  const extDir = join(ctx.targetDir, 'extensions', skill.name);
  mkdirSync(extDir, { recursive: true });

  // gemini-extension.json — verified manifest filename
  const manifest: Record<string, string> = {
    name: skill.name,
    version: ctx.harnessVersion,
    description: typeof skill.description === 'string' ? skill.description : '',
  };
  const manifestPath = join(extDir, 'gemini-extension.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  report.written.push(manifestPath);

  // SKILL.md with provenance — canonicalize-before-hash to avoid false drift
  // positives (stripProvenance re-serializes through gray-matter).
  const skillSourcePath = join(skill.bundleDir, 'SKILL.md');
  const sourceContent = readFileSync(skillSourcePath, 'utf-8');
  const canonical = stripProvenance(sourceContent, 'frontmatter');
  const hash = computeContentHash(canonical);
  const stamped = embedProvenance(sourceContent, {
    'harness-exported-from': skillSourcePath,
    'harness-exported-at': new Date().toISOString(),
    'harness-exported-by': ctx.harnessVersion,
    'harness-content-hash': hash,
  }, 'frontmatter');
  const skillTargetPath = join(extDir, 'SKILL.md');
  writeFileSync(skillTargetPath, stamped, 'utf-8');
  report.written.push(skillTargetPath);

  // Bundle resources (scripts, references, assets) — copied verbatim
  for (const sub of ['scripts', 'references', 'assets']) {
    const subSrc = join(skill.bundleDir, sub);
    if (existsSync(subSrc)) copyDir(subSrc, join(extDir, sub), report.written);
  }
}

async function exportAll(ctx: ExportContext): Promise<ExportReport> {
  const report: ExportReport = { provider: 'gemini', written: [], skipped: [], warnings: [] };
  mkdirSync(ctx.targetDir, { recursive: true });

  for (const skill of ctx.skills) writeExtensionForSkill(skill, ctx, report);

  // Identity at project root: GEMINI.md sibling to .gemini/ (matches the
  // CLAUDE.md / AGENTS.md convention used by other native adapters).
  const geminiMdPath = join(ctx.projectRoot, 'GEMINI.md');
  const body = composeIdentityDocument(ctx.identity.content, ctx.rules);
  const hash = computeContentHash(body);
  const stamped = embedProvenance(body, {
    'harness-exported-from': join(ctx.harnessDir, 'IDENTITY.md'),
    'harness-exported-at': new Date().toISOString(),
    'harness-exported-by': ctx.harnessVersion,
    'harness-content-hash': hash,
  }, 'markdown-comment');
  mkdirSync(dirname(geminiMdPath), { recursive: true });
  writeFileSync(geminiMdPath, stamped, 'utf-8');
  report.written.push(geminiMdPath);

  return report;
}

async function detectDrift(ctx: ExportContext): Promise<DriftReport> {
  const findings: DriftFinding[] = [];
  const knownNames = new Set(ctx.skills.map((s) => s.name));
  const extensionsDir = join(ctx.targetDir, 'extensions');

  if (existsSync(extensionsDir)) {
    for (const skill of ctx.skills) {
      const target = join(extensionsDir, skill.name, 'SKILL.md');
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
    for (const dirEntry of readdirSync(extensionsDir)) {
      const fullPath = join(extensionsDir, dirEntry);
      if (!statSync(fullPath).isDirectory()) continue;
      if (!knownNames.has(dirEntry)) {
        findings.push({ path: fullPath, severity: 'warning', kind: 'orphan', detail: 'source skill removed; clean up via `harness export --prune`' });
      }
    }
  }

  // GEMINI.md drift
  const geminiMdPath = join(ctx.projectRoot, 'GEMINI.md');
  if (existsSync(geminiMdPath)) {
    const content = readFileSync(geminiMdPath, 'utf-8');
    const marker = extractProvenance(content, 'markdown-comment');
    if (!marker) {
      findings.push({ path: geminiMdPath, severity: 'warning', kind: 'missing-marker', detail: 'no provenance marker' });
    } else {
      const stripped = stripProvenance(content, 'markdown-comment');
      const expected = composeIdentityDocument(ctx.identity.content, ctx.rules);
      if (computeContentHash(stripped) !== computeContentHash(expected)) {
        findings.push({ path: geminiMdPath, severity: 'warning', kind: 'modified', detail: 'hash mismatch — file edited externally or sources changed' });
      }
    }
  }

  return { provider: 'gemini', findings };
}

async function prune(ctx: ExportContext): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  const knownNames = new Set(ctx.skills.map((s) => s.name));
  const extensionsDir = join(ctx.targetDir, 'extensions');
  if (!existsSync(extensionsDir)) return { removed };
  for (const dirEntry of readdirSync(extensionsDir)) {
    const fullPath = join(extensionsDir, dirEntry);
    if (!statSync(fullPath).isDirectory()) continue;
    if (!knownNames.has(dirEntry)) {
      rmSync(fullPath, { recursive: true, force: true });
      removed.push(fullPath);
    }
  }
  return { removed };
}

export const geminiAdapter: ProviderAdapter = {
  name: 'gemini',
  exportAll,
  detectDrift,
  prune,
};

registerAdapter(geminiAdapter);
