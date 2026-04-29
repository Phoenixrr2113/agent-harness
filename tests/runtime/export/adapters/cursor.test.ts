import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import matter from 'gray-matter';
import { cursorAdapter } from '../../../../src/runtime/export/adapters/cursor.js';
import { loadAllPrimitives } from '../../../../src/primitives/loader.js';
import { loadIdentity } from '../../../../src/runtime/context-loader.js';
import type { ExportContext } from '../../../../src/runtime/export/types.js';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'cu-')); }

function makeHarness(dir: string, opts?: { withScript?: boolean; trigger?: string }): void {
  mkdirSync(join(dir, 'skills/research'), { recursive: true });
  if (opts?.withScript) mkdirSync(join(dir, 'skills/research/scripts'), { recursive: true });
  mkdirSync(join(dir, 'rules'), { recursive: true });
  writeFileSync(join(dir, 'IDENTITY.md'), `# Cursor test ${Math.random()}`);
  const triggerLine = opts?.trigger ? `\nmetadata:\n  harness-trigger: ${opts.trigger}` : '';
  writeFileSync(join(dir, 'skills/research/SKILL.md'), `---\nname: research\ndescription: cursor test ${Math.random()}${triggerLine}\n---\nResearch body.`);
  if (opts?.withScript) {
    writeFileSync(join(dir, 'skills/research/scripts/run.sh'), '#!/usr/bin/env bash\n' + 'echo hi\n'.repeat(2000));  // ~10KB
  }
  writeFileSync(join(dir, 'rules/r1.md'), `---\nname: r1\ndescription: rule one ${Math.random()}\nstatus: active\n---\nDo X.`);
}

function buildCtx(harnessDir: string): ExportContext {
  const all = loadAllPrimitives(harnessDir);
  const identity = loadIdentity(harnessDir);
  return {
    harnessDir,
    targetDir: join(harnessDir, '.cursor'),
    skills: all.get('skills') ?? [],
    rules: all.get('rules') ?? [],
    identity: { content: identity.content, source: String(identity.source) },
    harnessVersion: 'agent-harness@test',
  };
}

describe('cursorAdapter', () => {
  it('writes one .mdc file per skill under .cursor/rules/', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    const report = await cursorAdapter.exportAll(ctx);
    expect(existsSync(join(ctx.targetDir, 'rules/research.mdc'))).toBe(true);
    expect(report.written.some((p) => p.endsWith('research.mdc'))).toBe(true);
  });

  it('maps name → filename and description → frontmatter description', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await cursorAdapter.exportAll(ctx);
    const content = readFileSync(join(ctx.targetDir, 'rules/research.mdc'), 'utf-8');
    const fm = matter(content);
    expect(typeof fm.data.description).toBe('string');
  });

  it('sets alwaysApply: true for harness-trigger: prepare-call', async () => {
    const dir = tmp();
    makeHarness(dir, { trigger: 'prepare-call' });
    const ctx = buildCtx(dir);
    await cursorAdapter.exportAll(ctx);
    const content = readFileSync(join(ctx.targetDir, 'rules/research.mdc'), 'utf-8');
    const fm = matter(content);
    expect(fm.data.alwaysApply).toBe(true);
  });

  it('sets alwaysApply: false for regular skills', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await cursorAdapter.exportAll(ctx);
    const content = readFileSync(join(ctx.targetDir, 'rules/research.mdc'), 'utf-8');
    const fm = matter(content);
    expect(fm.data.alwaysApply).toBe(false);
  });

  it('warns when a script is too large to embed', async () => {
    const dir = tmp();
    makeHarness(dir, { withScript: true });
    const ctx = buildCtx(dir);
    const report = await cursorAdapter.exportAll(ctx);
    expect(report.warnings.some((w) => w.includes('research') && /script/i.test(w))).toBe(true);
  });
});
