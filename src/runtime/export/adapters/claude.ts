import { join, dirname, relative } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, copyFileSync, rmSync } from 'fs';
import type { ExportContext, ExportReport, DriftReport, DriftFinding, ProviderAdapter } from '../types.js';
import { computeContentHash, embedProvenance, extractProvenance, stripProvenance } from '../provenance.js';
import { composeIdentityDocument } from '../identity-output.js';
import { registerAdapter } from '../registry.js';
import type { HarnessDocument } from '../../../core/types.js';

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

function writeSkill(skill: HarnessDocument, ctx: ExportContext, report: ExportReport): void {
  if (!skill.bundleDir) {
    report.skipped.push({ path: skill.name, reason: 'no bundle directory' });
    return;
  }
  const targetSkillDir = join(ctx.targetDir, 'skills', skill.name);
  mkdirSync(targetSkillDir, { recursive: true });

  for (const sub of ['scripts', 'references', 'assets']) {
    const subSrc = join(skill.bundleDir, sub);
    if (existsSync(subSrc)) {
      copyDir(subSrc, join(targetSkillDir, sub), report.written);
    }
  }

  const skillSourcePath = join(skill.bundleDir, 'SKILL.md');
  const sourceContent = readFileSync(skillSourcePath, 'utf-8');
  // Hash the canonicalized form (matches what detectDrift recomputes after stripProvenance).
  // gray-matter re-serializes YAML, so raw bytes can differ from the round-tripped form.
  const canonicalSource = stripProvenance(sourceContent, 'frontmatter');
  const hash = computeContentHash(canonicalSource);
  const targetSkillFile = join(targetSkillDir, 'SKILL.md');
  const stamped = embedProvenance(sourceContent, {
    'harness-exported-from': skillSourcePath,
    'harness-exported-at': new Date().toISOString(),
    'harness-exported-by': ctx.harnessVersion,
    'harness-content-hash': hash,
  }, 'frontmatter');
  writeFileSync(targetSkillFile, stamped, 'utf-8');
  report.written.push(targetSkillFile);
}

function writeIdentity(ctx: ExportContext, report: ExportReport): void {
  const claudeMdPath = join(ctx.targetDir, 'CLAUDE.md');
  const body = composeIdentityDocument(ctx.identity.content, ctx.rules);
  const hash = computeContentHash(body);
  const stamped = embedProvenance(body, {
    'harness-exported-from': join(ctx.harnessDir, 'IDENTITY.md'),
    'harness-exported-at': new Date().toISOString(),
    'harness-exported-by': ctx.harnessVersion,
    'harness-content-hash': hash,
  }, 'markdown-comment');
  mkdirSync(dirname(claudeMdPath), { recursive: true });
  writeFileSync(claudeMdPath, stamped, 'utf-8');
  report.written.push(claudeMdPath);
}

async function exportAll(ctx: ExportContext): Promise<ExportReport> {
  const report: ExportReport = { provider: 'claude', written: [], skipped: [], warnings: [] };
  mkdirSync(ctx.targetDir, { recursive: true });
  for (const skill of ctx.skills) {
    writeSkill(skill, ctx, report);
  }
  writeIdentity(ctx, report);
  return report;
}

async function detectDrift(ctx: ExportContext): Promise<DriftReport> {
  const findings: DriftFinding[] = [];
  const knownSkillNames = new Set(ctx.skills.map((s) => s.name));

  for (const skill of ctx.skills) {
    const targetSkillFile = join(ctx.targetDir, 'skills', skill.name, 'SKILL.md');
    if (!existsSync(targetSkillFile)) {
      findings.push({ path: targetSkillFile, severity: 'warning', kind: 'missing-file', detail: 'expected output not present' });
      continue;
    }
    const content = readFileSync(targetSkillFile, 'utf-8');
    const marker = extractProvenance(content, 'frontmatter');
    if (!marker) {
      findings.push({ path: targetSkillFile, severity: 'warning', kind: 'missing-marker', detail: 'no provenance marker' });
      continue;
    }
    const stripped = stripProvenance(content, 'frontmatter');
    if (computeContentHash(stripped) !== marker['harness-content-hash']) {
      findings.push({ path: targetSkillFile, severity: 'warning', kind: 'modified', detail: 'hash mismatch — file edited externally' });
    }
  }

  const claudeMdPath = join(ctx.targetDir, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    const content = readFileSync(claudeMdPath, 'utf-8');
    const marker = extractProvenance(content, 'markdown-comment');
    if (!marker) {
      findings.push({ path: claudeMdPath, severity: 'warning', kind: 'missing-marker', detail: 'no provenance marker' });
    } else {
      const stripped = stripProvenance(content, 'markdown-comment');
      const expected = composeIdentityDocument(ctx.identity.content, ctx.rules);
      if (computeContentHash(stripped) !== computeContentHash(expected)) {
        findings.push({ path: claudeMdPath, severity: 'warning', kind: 'modified', detail: 'hash mismatch — file edited externally or sources changed' });
      }
    }
  }

  const targetSkillsDir = join(ctx.targetDir, 'skills');
  if (existsSync(targetSkillsDir)) {
    for (const dirEntry of readdirSync(targetSkillsDir)) {
      const fullPath = join(targetSkillsDir, dirEntry);
      if (!statSync(fullPath).isDirectory()) continue;
      if (!knownSkillNames.has(dirEntry)) {
        findings.push({ path: fullPath, severity: 'warning', kind: 'orphan', detail: 'source skill removed; clean up via `harness export --prune`' });
      }
    }
  }

  return { provider: 'claude', findings };
}

async function prune(ctx: ExportContext): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  const knownSkillNames = new Set(ctx.skills.map((s) => s.name));
  const targetSkillsDir = join(ctx.targetDir, 'skills');
  if (!existsSync(targetSkillsDir)) return { removed };
  for (const dirEntry of readdirSync(targetSkillsDir)) {
    const fullPath = join(targetSkillsDir, dirEntry);
    if (!statSync(fullPath).isDirectory()) continue;
    if (!knownSkillNames.has(dirEntry)) {
      rmSync(fullPath, { recursive: true, force: true });
      removed.push(fullPath);
    }
  }
  return { removed };
}

async function resyncFile(ctx: ExportContext, providerFile: string): Promise<{ updated: string }> {
  const content = readFileSync(providerFile, 'utf-8');
  const stripped = stripProvenance(content, 'frontmatter');
  const rel = relative(ctx.targetDir, providerFile);
  const sourcePath = join(ctx.harnessDir, rel);
  if (!sourcePath.includes(ctx.harnessDir)) {
    throw new Error(`Resync target ${sourcePath} is outside harness dir`);
  }
  writeFileSync(sourcePath, stripped, 'utf-8');
  return { updated: sourcePath };
}

export const claudeAdapter: ProviderAdapter = {
  name: 'claude',
  exportAll,
  detectDrift,
  prune,
  resyncFile,
};

registerAdapter(claudeAdapter);
