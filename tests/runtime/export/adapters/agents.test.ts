import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
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
});
