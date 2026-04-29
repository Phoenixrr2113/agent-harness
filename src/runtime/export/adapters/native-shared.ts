import { join, dirname, relative } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, copyFileSync, rmSync } from 'fs';
import type { ExportContext, ExportReport, DriftReport, DriftFinding, ProviderAdapter, ProviderName } from '../types.js';
import { computeContentHash, embedProvenance, extractProvenance, stripProvenance } from '../provenance.js';
import { composeIdentityDocument } from '../identity-output.js';
import type { HarnessDocument } from '../../../core/types.js';

export interface NativeAdapterConfig {
  name: ProviderName;
  /** Filename for the project-level identity file: 'CLAUDE.md', 'AGENTS.md', etc. */
  identityFilename: string;
  /** Where the identity file is written: targetDir or projectRoot. */
  identityLocation: 'targetDir' | 'projectRoot';
  /** Where skills go, relative to ctx.targetDir. */
  skillsSubdir: string;
}

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

function writeSkill(skill: HarnessDocument, ctx: ExportContext, cfg: NativeAdapterConfig, report: ExportReport): void {
  if (!skill.bundleDir) {
    report.skipped.push({ path: skill.name, reason: 'no bundle directory' });
    return;
  }
  const targetSkillDir = join(ctx.targetDir, cfg.skillsSubdir, skill.name);
  mkdirSync(targetSkillDir, { recursive: true });

  for (const sub of ['scripts', 'references', 'assets']) {
    const subSrc = join(skill.bundleDir, sub);
    if (existsSync(subSrc)) {
      copyDir(subSrc, join(targetSkillDir, sub), report.written);
    }
  }

  const skillSourcePath = join(skill.bundleDir, 'SKILL.md');
  const sourceContent = readFileSync(skillSourcePath, 'utf-8');
  // CRITICAL: hash the canonicalized form (after a strip pass through gray-matter),
  // not the raw source. stripProvenance re-serializes via gray-matter; without
  // canonicalization, drift detection produces false-positives on a clean export.
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

function identityPath(ctx: ExportContext, cfg: NativeAdapterConfig): string {
  return cfg.identityLocation === 'targetDir'
    ? join(ctx.targetDir, cfg.identityFilename)
    : join(ctx.harnessDir, cfg.identityFilename);
}

function writeIdentity(ctx: ExportContext, cfg: NativeAdapterConfig, report: ExportReport): void {
  const identityFile = identityPath(ctx, cfg);
  const body = composeIdentityDocument(ctx.identity.content, ctx.rules);
  const hash = computeContentHash(body);
  const stamped = embedProvenance(body, {
    'harness-exported-from': join(ctx.harnessDir, 'IDENTITY.md'),
    'harness-exported-at': new Date().toISOString(),
    'harness-exported-by': ctx.harnessVersion,
    'harness-content-hash': hash,
  }, 'markdown-comment');
  mkdirSync(dirname(identityFile), { recursive: true });
  writeFileSync(identityFile, stamped, 'utf-8');
  report.written.push(identityFile);
}

export function buildNativeAdapter(cfg: NativeAdapterConfig): ProviderAdapter {
  return {
    name: cfg.name,

    async exportAll(ctx: ExportContext): Promise<ExportReport> {
      const report: ExportReport = { provider: cfg.name, written: [], skipped: [], warnings: [] };
      mkdirSync(ctx.targetDir, { recursive: true });
      for (const skill of ctx.skills) writeSkill(skill, ctx, cfg, report);
      writeIdentity(ctx, cfg, report);
      return report;
    },

    async detectDrift(ctx: ExportContext): Promise<DriftReport> {
      const findings: DriftFinding[] = [];
      const knownSkillNames = new Set(ctx.skills.map((s) => s.name));

      for (const skill of ctx.skills) {
        const targetSkillFile = join(ctx.targetDir, cfg.skillsSubdir, skill.name, 'SKILL.md');
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

      const identityFile = identityPath(ctx, cfg);
      if (existsSync(identityFile)) {
        const content = readFileSync(identityFile, 'utf-8');
        const marker = extractProvenance(content, 'markdown-comment');
        if (!marker) {
          findings.push({ path: identityFile, severity: 'warning', kind: 'missing-marker', detail: 'no provenance marker' });
        } else {
          const stripped = stripProvenance(content, 'markdown-comment');
          const expected = composeIdentityDocument(ctx.identity.content, ctx.rules);
          if (computeContentHash(stripped) !== computeContentHash(expected)) {
            findings.push({ path: identityFile, severity: 'warning', kind: 'modified', detail: 'hash mismatch — file edited externally or sources changed' });
          }
        }
      }

      const targetSkillsDir = join(ctx.targetDir, cfg.skillsSubdir);
      if (existsSync(targetSkillsDir)) {
        for (const dirEntry of readdirSync(targetSkillsDir)) {
          const fullPath = join(targetSkillsDir, dirEntry);
          if (!statSync(fullPath).isDirectory()) continue;
          if (!knownSkillNames.has(dirEntry)) {
            findings.push({ path: fullPath, severity: 'warning', kind: 'orphan', detail: 'source skill removed; clean up via `harness export --prune`' });
          }
        }
      }

      return { provider: cfg.name, findings };
    },

    async prune(ctx: ExportContext): Promise<{ removed: string[] }> {
      const removed: string[] = [];
      const knownSkillNames = new Set(ctx.skills.map((s) => s.name));
      const targetSkillsDir = join(ctx.targetDir, cfg.skillsSubdir);
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
    },

    async resyncFile(ctx: ExportContext, providerFile: string): Promise<{ updated: string }> {
      const content = readFileSync(providerFile, 'utf-8');
      const stripped = stripProvenance(content, 'frontmatter');
      const rel = relative(ctx.targetDir, providerFile);
      const sourcePath = join(ctx.harnessDir, rel);
      if (!sourcePath.includes(ctx.harnessDir)) {
        throw new Error(`Resync target ${sourcePath} is outside harness dir`);
      }
      writeFileSync(sourcePath, stripped, 'utf-8');
      return { updated: sourcePath };
    },
  };
}
