import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import type { ExportContext, ExportReport, DriftReport, DriftFinding, ProviderAdapter } from '../types.js';
import { computeContentHash, embedProvenance, extractProvenance, stripProvenance } from '../provenance.js';
import { registerAdapter } from '../registry.js';
import type { HarnessDocument } from '../../../core/types.js';

// Per Copilot docs at https://docs.github.com/en/copilot/customizing-copilot/about-customizing-github-copilot-chat-responses
// (verify size limits if known). Single-file concatenation; no native skill mechanism.

const CHARS_PER_TOKEN = 4;          // rough English estimate
const DEFAULT_TOKEN_CAP = 32000;     // configurable per-target later

function estimateTokensFromChars(charCount: number): number {
  return Math.ceil(charCount / CHARS_PER_TOKEN);
}

function describeSkill(skill: HarnessDocument): string {
  const lines: string[] = [];
  lines.push(`### ${skill.name}`);
  if (skill.description) lines.push(String(skill.description).trim());
  if (skill.body && skill.body.trim()) lines.push(skill.body.trim());
  if (skill.bundleDir) {
    lines.push(`Skill resources at: ${skill.bundleDir}`);
  }
  return lines.join('\n\n');
}

function composeCopilotInstructions(ctx: ExportContext, tokenCap: number, warnings: string[]): string {
  const sections: string[] = [];
  sections.push('# Project guidance for Copilot');

  sections.push('## Identity');
  sections.push(ctx.identity.content.trim());

  const activeRules = ctx.rules
    .filter((r) => r.status === 'active' || r.status === undefined)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  if (activeRules.length > 0) {
    sections.push('## Rules');
    for (const r of activeRules) {
      sections.push(`### ${r.name}`);
      if (r.description) sections.push(String(r.description).trim());
      if (r.body && r.body.trim()) sections.push(r.body.trim());
    }
  }

  if (ctx.skills.length > 0) {
    sections.push('## Skills');
    sections.push('The following skills are available:');
    const sortedSkills = ctx.skills.slice().sort((a, b) => a.name.localeCompare(b.name));
    let totalSoFar = sections.join('\n\n').length;
    let droppedBodies = 0;
    for (const skill of sortedSkills) {
      const full = describeSkill(skill);
      if (estimateTokensFromChars(totalSoFar + full.length) <= tokenCap) {
        sections.push(full);
        totalSoFar += full.length + 2;
      } else {
        const minimal = `### ${skill.name}\n\n${typeof skill.description === 'string' ? skill.description : ''}`.trim();
        sections.push(minimal);
        totalSoFar += minimal.length + 2;
        droppedBodies++;
      }
    }
    if (droppedBodies > 0) {
      warnings.push(`copilot: dropped bodies for ${droppedBodies} skill(s) to fit token cap (${tokenCap})`);
    }
  }

  return sections.join('\n\n') + '\n';
}

async function exportAll(ctx: ExportContext): Promise<ExportReport> {
  const report: ExportReport = { provider: 'copilot', written: [], skipped: [], warnings: [] };
  mkdirSync(ctx.targetDir, { recursive: true });
  const tokenCap = DEFAULT_TOKEN_CAP;
  const body = composeCopilotInstructions(ctx, tokenCap, report.warnings);
  const hash = computeContentHash(body);
  const stamped = embedProvenance(body, {
    'harness-exported-from': join(ctx.harnessDir, 'IDENTITY.md'),
    'harness-exported-at': new Date().toISOString(),
    'harness-exported-by': ctx.harnessVersion,
    'harness-content-hash': hash,
  }, 'markdown-comment');
  const target = join(ctx.targetDir, 'copilot-instructions.md');
  writeFileSync(target, stamped, 'utf-8');
  report.written.push(target);
  return report;
}

async function detectDrift(ctx: ExportContext): Promise<DriftReport> {
  const findings: DriftFinding[] = [];
  const target = join(ctx.targetDir, 'copilot-instructions.md');
  if (!existsSync(target)) {
    return { provider: 'copilot', findings: [{ path: target, severity: 'warning', kind: 'missing-file', detail: 'expected output not present' }] };
  }
  const content = readFileSync(target, 'utf-8');
  const marker = extractProvenance(content, 'markdown-comment');
  if (!marker) {
    findings.push({ path: target, severity: 'warning', kind: 'missing-marker', detail: 'no provenance marker' });
    return { provider: 'copilot', findings };
  }
  const stripped = stripProvenance(content, 'markdown-comment');
  const expectedBody = composeCopilotInstructions(ctx, DEFAULT_TOKEN_CAP, []);
  if (computeContentHash(stripped) !== computeContentHash(expectedBody)) {
    findings.push({ path: target, severity: 'warning', kind: 'modified', detail: 'hash mismatch — file edited externally or sources changed' });
  }
  return { provider: 'copilot', findings };
}

export const copilotAdapter: ProviderAdapter = {
  name: 'copilot',
  exportAll,
  detectDrift,
};

registerAdapter(copilotAdapter);
