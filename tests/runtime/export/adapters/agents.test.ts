import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { agentsAdapter } from '../../../../src/runtime/export/adapters/agents.js';
import { loadAllPrimitives } from '../../../../src/primitives/loader.js';
import { loadIdentity } from '../../../../src/runtime/context-loader.js';
import type { ExportContext } from '../../../../src/runtime/export/types.js';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'ag-')); }

function makeHarness(dir: string): void {
  mkdirSync(join(dir, 'skills/research'), { recursive: true });
  mkdirSync(join(dir, 'rules'), { recursive: true });
  writeFileSync(join(dir, 'IDENTITY.md'), `# Agents test identity ${Math.random()}`);
  writeFileSync(join(dir, 'skills/research/SKILL.md'), `---\nname: research\ndescription: agents test ${Math.random()}\n---\nBody.`);
  writeFileSync(join(dir, 'rules/r1.md'), `---\nname: r1\ndescription: rule one ${Math.random()}\nstatus: active\n---\nDo X.`);
}

function buildCtx(harnessDir: string): ExportContext {
  const all = loadAllPrimitives(harnessDir);
  const identity = loadIdentity(harnessDir);
  return {
    harnessDir,
    projectRoot: harnessDir,
    targetDir: join(harnessDir, '.agents'),
    skills: all.get('skills') ?? [],
    rules: all.get('rules') ?? [],
    identity: { content: identity.content, source: String(identity.source) },
    harnessVersion: 'agent-harness@test',
  };
}

describe('agentsAdapter', () => {
  it('writes skills to .agents/skills/<name>/SKILL.md', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await agentsAdapter.exportAll(ctx);
    expect(existsSync(join(ctx.targetDir, 'skills/research/SKILL.md'))).toBe(true);
  });

  it('writes AGENTS.md to project root, not inside .agents/', async () => {
    const dir = tmp();
    makeHarness(dir);
    const ctx = buildCtx(dir);
    await agentsAdapter.exportAll(ctx);
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(ctx.targetDir, 'AGENTS.md'))).toBe(false);
  });

  it('preserves existing user-authored AGENTS.md and inserts auto-managed block', async () => {
    const projectDir = tmp();
    const harnessDir = join(projectDir, '.harness');
    mkdirSync(harnessDir);
    writeFileSync(join(projectDir, 'AGENTS.md'), '# my-project\n\nUse npm test. The test database is sqlite.', 'utf-8');
    mkdirSync(join(harnessDir, 'skills/research'), { recursive: true });
    mkdirSync(join(harnessDir, 'rules'), { recursive: true });
    writeFileSync(join(harnessDir, 'IDENTITY.md'), `# Project assistant ${Math.random()}`);
    writeFileSync(join(harnessDir, 'skills/research/SKILL.md'), `---\nname: research\ndescription: append-block test ${Math.random()}\n---\nBody.`);
    writeFileSync(join(harnessDir, 'rules/r1.md'), `---\nname: r1\ndescription: rule one ${Math.random()}\nstatus: active\n---\nDo X.`);

    const all = loadAllPrimitives(harnessDir);
    const identity = loadIdentity(harnessDir);
    const ctx: ExportContext = {
      harnessDir,
      projectRoot: projectDir,
      targetDir: join(projectDir, '.agents'),
      skills: all.get('skills') ?? [],
      rules: all.get('rules') ?? [],
      identity: { content: identity.content, source: String(identity.source) },
      harnessVersion: 'agent-harness@test',
    };
    const report = await agentsAdapter.exportAll(ctx);
    const finalContent = readFileSync(join(projectDir, 'AGENTS.md'), 'utf-8');
    expect(finalContent).toContain('Use npm test');
    expect(finalContent).toContain('test database is sqlite');
    expect(finalContent).toContain('agent-harness:auto-managed:start');
    expect(finalContent).toContain('agent-harness:auto-managed:end');
    expect(finalContent).toContain('## Auto-managed by agent-harness');
    expect(report.warnings.some((w) => /preserved/.test(w))).toBe(true);
  });

  it('on re-export, replaces just the auto-managed block (idempotent, no double-block)', async () => {
    const projectDir = tmp();
    const harnessDir = join(projectDir, '.harness');
    mkdirSync(harnessDir);
    writeFileSync(join(projectDir, 'AGENTS.md'), '# my-project\n\nUse npm test.', 'utf-8');
    mkdirSync(join(harnessDir, 'skills/research'), { recursive: true });
    mkdirSync(join(harnessDir, 'rules'), { recursive: true });
    writeFileSync(join(harnessDir, 'IDENTITY.md'), `# Idem test ${Math.random()}`);
    writeFileSync(join(harnessDir, 'skills/research/SKILL.md'), `---\nname: research\ndescription: idempotent block test ${Math.random()}\n---\nBody.`);
    writeFileSync(join(harnessDir, 'rules/r1.md'), `---\nname: r1\ndescription: rule one ${Math.random()}\nstatus: active\n---\nDo X.`);

    const all = loadAllPrimitives(harnessDir);
    const identity = loadIdentity(harnessDir);
    const ctx: ExportContext = {
      harnessDir,
      projectRoot: projectDir,
      targetDir: join(projectDir, '.agents'),
      skills: all.get('skills') ?? [],
      rules: all.get('rules') ?? [],
      identity: { content: identity.content, source: String(identity.source) },
      harnessVersion: 'agent-harness@test',
    };
    await agentsAdapter.exportAll(ctx);
    await agentsAdapter.exportAll(ctx);
    const finalContent = readFileSync(join(projectDir, 'AGENTS.md'), 'utf-8');
    const startCount = finalContent.split('agent-harness:auto-managed:start').length - 1;
    expect(startCount).toBe(1);
  });
});
