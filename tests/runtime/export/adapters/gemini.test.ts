import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { geminiAdapter } from '../../../../src/runtime/export/adapters/gemini.js';
import { loadAllPrimitives } from '../../../../src/primitives/loader.js';
import { loadIdentity } from '../../../../src/runtime/context-loader.js';
import type { ExportContext } from '../../../../src/runtime/export/types.js';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'gm-')); }

function makeHarness(dir: string): void {
  mkdirSync(join(dir, 'skills/research'), { recursive: true });
  mkdirSync(join(dir, 'rules'), { recursive: true });
  writeFileSync(join(dir, 'IDENTITY.md'), `# Gemini test ${Math.random()}`);
  writeFileSync(join(dir, 'skills/research/SKILL.md'), `---\nname: research\ndescription: gemini test ${Math.random()}\n---\nResearch body.`);
  writeFileSync(join(dir, 'rules/r1.md'), `---\nname: r1\ndescription: rule one ${Math.random()}\nstatus: active\n---\nDo X.`);
}

function buildCtx(harnessDir: string): ExportContext {
  const all = loadAllPrimitives(harnessDir);
  const identity = loadIdentity(harnessDir);
  return {
    harnessDir,
    projectRoot: harnessDir,
    targetDir: join(harnessDir, '.gemini'),
    skills: all.get('skills') ?? [],
    rules: all.get('rules') ?? [],
    identity: { content: identity.content, source: String(identity.source) },
    harnessVersion: 'agent-harness@test',
  };
}

describe('geminiAdapter', () => {
  it('writes one extension per skill with gemini-extension.json + SKILL.md', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await geminiAdapter.exportAll(ctx);
    expect(existsSync(join(ctx.targetDir, 'extensions/research/gemini-extension.json'))).toBe(true);
    expect(existsSync(join(ctx.targetDir, 'extensions/research/SKILL.md'))).toBe(true);
  });

  it('writes GEMINI.md to project root', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await geminiAdapter.exportAll(ctx);
    expect(existsSync(join(dir, 'GEMINI.md'))).toBe(true);
  });

  it('manifest has name + description + version', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await geminiAdapter.exportAll(ctx);
    const manifest = JSON.parse(readFileSync(join(ctx.targetDir, 'extensions/research/gemini-extension.json'), 'utf-8')) as Record<string, unknown>;
    expect(manifest.name).toBe('research');
    expect(typeof manifest.description).toBe('string');
    expect(typeof manifest.version).toBe('string');
  });

  it('detects drift on extension SKILL.md', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await geminiAdapter.exportAll(ctx);
    const target = join(ctx.targetDir, 'extensions/research/SKILL.md');
    writeFileSync(target, readFileSync(target, 'utf-8') + '\nedited');
    const drift = await geminiAdapter.detectDrift(ctx);
    expect(drift.findings.some((f) => f.kind === 'modified')).toBe(true);
  });
});
