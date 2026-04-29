import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { claudeAdapter } from '../../../../src/runtime/export/adapters/claude.js';
import { loadAllPrimitives } from '../../../../src/primitives/loader.js';
import { loadIdentity } from '../../../../src/runtime/context-loader.js';
import type { ExportContext } from '../../../../src/runtime/export/types.js';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'cl-')); }

function makeHarness(dir: string): void {
  mkdirSync(join(dir, 'skills/research'), { recursive: true });
  mkdirSync(join(dir, 'skills/research/scripts'), { recursive: true });
  mkdirSync(join(dir, 'skills/research/references'), { recursive: true });
  mkdirSync(join(dir, 'rules'), { recursive: true });
  writeFileSync(join(dir, 'IDENTITY.md'), `# I am a harness ${Math.random()}\nIdentity body.`);
  writeFileSync(join(dir, 'skills/research/SKILL.md'), `---\nname: research\ndescription: research desc ${Math.random()}\n---\nResearch body.`);
  writeFileSync(join(dir, 'skills/research/scripts/run.sh'), '#!/usr/bin/env bash\necho hi');
  writeFileSync(join(dir, 'skills/research/references/REFERENCE.md'), '# Reference content');
  writeFileSync(join(dir, 'rules/be-careful.md'), `---\nname: be-careful\ndescription: be careful ${Math.random()}\nstatus: active\n---\nAlways be careful.`);
}

function buildCtx(harnessDir: string): ExportContext {
  const all = loadAllPrimitives(harnessDir);
  const identity = loadIdentity(harnessDir);
  return {
    harnessDir,
    targetDir: join(harnessDir, '.claude'),
    skills: all.get('skills') ?? [],
    rules: all.get('rules') ?? [],
    identity: { content: identity.content, source: String(identity.source) },
    harnessVersion: 'agent-harness@test',
  };
}

describe('claudeAdapter.exportAll', () => {
  it('writes skills to .claude/skills/<name>/', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    const report = await claudeAdapter.exportAll(ctx);
    const skillFile = join(ctx.targetDir, 'skills/research/SKILL.md');
    expect(existsSync(skillFile)).toBe(true);
    expect(report.written).toContain(skillFile);
  });

  it('copies bundle resources verbatim', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await claudeAdapter.exportAll(ctx);
    expect(existsSync(join(ctx.targetDir, 'skills/research/scripts/run.sh'))).toBe(true);
    expect(existsSync(join(ctx.targetDir, 'skills/research/references/REFERENCE.md'))).toBe(true);
  });

  it('writes CLAUDE.md with identity + rules', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await claudeAdapter.exportAll(ctx);
    const claudeMd = join(ctx.targetDir, 'CLAUDE.md');
    expect(existsSync(claudeMd)).toBe(true);
    const content = readFileSync(claudeMd, 'utf-8');
    expect(content).toContain('## Identity');
    expect(content).toContain('## Rules');
    expect(content).toContain('be-careful');
    expect(content).toContain('Always be careful');
  });

  it('embeds provenance marker in exported skill', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await claudeAdapter.exportAll(ctx);
    const skillFile = readFileSync(join(ctx.targetDir, 'skills/research/SKILL.md'), 'utf-8');
    expect(skillFile).toContain('harness-exported-from');
    expect(skillFile).toContain('harness-content-hash');
  });

  it('embeds provenance marker in CLAUDE.md (HTML comment)', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await claudeAdapter.exportAll(ctx);
    const claudeMd = readFileSync(join(ctx.targetDir, 'CLAUDE.md'), 'utf-8');
    expect(claudeMd.startsWith('<!-- agent-harness-provenance')).toBe(true);
  });
});

describe('claudeAdapter.detectDrift', () => {
  it('returns no findings on clean state', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await claudeAdapter.exportAll(ctx);
    const drift = await claudeAdapter.detectDrift(ctx);
    expect(drift.findings.filter((f) => f.kind === 'modified')).toHaveLength(0);
  });

  it('detects external edit', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await claudeAdapter.exportAll(ctx);
    const skillPath = join(ctx.targetDir, 'skills/research/SKILL.md');
    const original = readFileSync(skillPath, 'utf-8');
    writeFileSync(skillPath, original + '\nEdited externally.');
    const drift = await claudeAdapter.detectDrift(ctx);
    const finding = drift.findings.find((f) => f.kind === 'modified' && f.path.includes('research'));
    expect(finding).toBeDefined();
  });

  it('detects orphan export when source skill removed', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await claudeAdapter.exportAll(ctx);
    const driftCtx = { ...ctx, skills: [] };
    const drift = await claudeAdapter.detectDrift(driftCtx);
    const orphan = drift.findings.find((f) => f.kind === 'orphan');
    expect(orphan).toBeDefined();
  });
});
