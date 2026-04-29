import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { codexAdapter } from '../../../../src/runtime/export/adapters/codex.js';
import { loadAllPrimitives } from '../../../../src/primitives/loader.js';
import { loadIdentity } from '../../../../src/runtime/context-loader.js';
import type { ExportContext } from '../../../../src/runtime/export/types.js';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'cx-')); }

function makeHarness(dir: string): void {
  mkdirSync(join(dir, 'skills/research'), { recursive: true });
  mkdirSync(join(dir, 'rules'), { recursive: true });
  writeFileSync(join(dir, 'IDENTITY.md'), `# Codex test identity ${Math.random()}`);
  writeFileSync(join(dir, 'skills/research/SKILL.md'), `---\nname: research\ndescription: codex test ${Math.random()}\n---\nResearch body.`);
  writeFileSync(join(dir, 'rules/r1.md'), `---\nname: r1\ndescription: rule one ${Math.random()}\nstatus: active\n---\nDo X.`);
}

function buildCtx(harnessDir: string): ExportContext {
  const all = loadAllPrimitives(harnessDir);
  const identity = loadIdentity(harnessDir);
  return {
    harnessDir,
    targetDir: join(harnessDir, '.codex'),
    skills: all.get('skills') ?? [],
    rules: all.get('rules') ?? [],
    identity: { content: identity.content, source: String(identity.source) },
    harnessVersion: 'agent-harness@test',
  };
}

describe('codexAdapter', () => {
  it('writes skills to .codex/skills/<name>/SKILL.md', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await codexAdapter.exportAll(ctx);
    expect(existsSync(join(ctx.targetDir, 'skills/research/SKILL.md'))).toBe(true);
  });

  it('writes AGENTS.md (not CLAUDE.md) at targetDir root', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await codexAdapter.exportAll(ctx);
    expect(existsSync(join(ctx.targetDir, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(ctx.targetDir, 'CLAUDE.md'))).toBe(false);
  });

  it('detects drift on AGENTS.md', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await codexAdapter.exportAll(ctx);
    const agentsMd = join(ctx.targetDir, 'AGENTS.md');
    writeFileSync(agentsMd, readFileSync(agentsMd, 'utf-8') + '\nEdited.');
    const drift = await codexAdapter.detectDrift(ctx);
    expect(drift.findings.some((f) => f.kind === 'modified' && f.path === agentsMd)).toBe(true);
  });
});
