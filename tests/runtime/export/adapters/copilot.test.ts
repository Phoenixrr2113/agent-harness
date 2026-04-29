import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { copilotAdapter } from '../../../../src/runtime/export/adapters/copilot.js';
import { loadAllPrimitives } from '../../../../src/primitives/loader.js';
import { loadIdentity } from '../../../../src/runtime/context-loader.js';
import type { ExportContext } from '../../../../src/runtime/export/types.js';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'cp-')); }

function makeHarness(dir: string, opts?: { manySkills?: boolean }): void {
  mkdirSync(join(dir, 'rules'), { recursive: true });
  writeFileSync(join(dir, 'IDENTITY.md'), `# Copilot test identity ${Math.random()}`);
  writeFileSync(join(dir, 'rules/be-careful.md'), `---\nname: be-careful\ndescription: be careful ${Math.random()}\nstatus: active\n---\nAlways be careful.`);
  const skillCount = opts?.manySkills ? 10 : 2;
  for (let i = 0; i < skillCount; i++) {
    const name = `skill-${i}`;
    mkdirSync(join(dir, 'skills', name), { recursive: true });
    writeFileSync(join(dir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: skill ${i} desc ${Math.random()}\n---\n${'Body line.\n'.repeat(opts?.manySkills ? 100 : 5)}`);
  }
}

function buildCtx(harnessDir: string): ExportContext {
  const all = loadAllPrimitives(harnessDir);
  const identity = loadIdentity(harnessDir);
  return {
    harnessDir,
    targetDir: join(harnessDir, '.github'),
    skills: all.get('skills') ?? [],
    rules: all.get('rules') ?? [],
    identity: { content: identity.content, source: String(identity.source) },
    harnessVersion: 'agent-harness@test',
  };
}

describe('copilotAdapter', () => {
  it('writes a single .github/copilot-instructions.md', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    const report = await copilotAdapter.exportAll(ctx);
    const out = join(ctx.targetDir, 'copilot-instructions.md');
    expect(existsSync(out)).toBe(true);
    expect(report.written).toEqual([out]);
  });

  it('contains identity, rules, and skill descriptions', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await copilotAdapter.exportAll(ctx);
    const text = readFileSync(join(ctx.targetDir, 'copilot-instructions.md'), 'utf-8');
    expect(text).toContain('## Identity');
    expect(text).toContain('## Rules');
    expect(text).toContain('be-careful');
    expect(text).toContain('## Skills');
    expect(text).toContain('skill-0');
  });

  it('starts with HTML-comment provenance marker', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await copilotAdapter.exportAll(ctx);
    const text = readFileSync(join(ctx.targetDir, 'copilot-instructions.md'), 'utf-8');
    expect(text.startsWith('<!-- agent-harness-provenance')).toBe(true);
  });

  it('produces a single file even with many skills', async () => {
    const dir = tmp();
    makeHarness(dir, { manySkills: true });
    const ctx = buildCtx(dir);
    const report = await copilotAdapter.exportAll(ctx);
    expect(report.written.length).toBe(1);
  });

  it('detects drift on external edit', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await copilotAdapter.exportAll(ctx);
    const out = join(ctx.targetDir, 'copilot-instructions.md');
    writeFileSync(out, readFileSync(out, 'utf-8') + '\nEdited.');
    const drift = await copilotAdapter.detectDrift(ctx);
    expect(drift.findings.some((f) => f.kind === 'modified')).toBe(true);
  });
});
