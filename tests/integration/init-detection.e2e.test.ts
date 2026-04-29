import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectExistingProviders, decideScaffoldLocation } from '../../src/cli/scaffold.js';
import { loadProjectContextRule } from '../../src/runtime/context-loader.js';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'init-')); }

describe('detectExistingProviders', () => {
  it('returns empty in a clean directory', () => {
    const dir = tmp();
    expect(detectExistingProviders(dir)).toEqual([]);
  });

  it('detects .claude/', () => {
    const dir = tmp();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const detected = detectExistingProviders(dir);
    expect(detected.find((d) => d.provider === 'claude')).toBeDefined();
  });

  it('detects .github/copilot-instructions.md', () => {
    const dir = tmp();
    mkdirSync(join(dir, '.github'), { recursive: true });
    writeFileSync(join(dir, '.github', 'copilot-instructions.md'), '# x');
    const detected = detectExistingProviders(dir);
    expect(detected.find((d) => d.provider === 'copilot')).toBeDefined();
  });

  it('detects AGENTS.md as agents convention', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'AGENTS.md'), '# x');
    const detected = detectExistingProviders(dir);
    expect(detected.find((d) => d.provider === 'agents')).toBeDefined();
  });

  it('does not double-count CLAUDE.md when .claude/ exists', () => {
    const dir = tmp();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, 'CLAUDE.md'), '# x');
    const detected = detectExistingProviders(dir);
    const claudeCount = detected.filter((d) => d.provider === 'claude').length;
    expect(claudeCount).toBe(1);
  });
});

describe('decideScaffoldLocation', () => {
  it('returns root scaffold when no sentinels exist', () => {
    const dir = tmp();
    expect(decideScaffoldLocation(dir).useSubdirectory).toBe(false);
  });

  it('returns subdirectory when AGENTS.md exists', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'AGENTS.md'), '# x');
    const decision = decideScaffoldLocation(dir);
    expect(decision.useSubdirectory).toBe(true);
    expect(decision.subdirName).toBe('.harness');
  });
});

describe('loadProjectContextRule', () => {
  it('returns null when no host AGENTS/CLAUDE/GEMINI.md exists', () => {
    const projectRoot = tmp();
    const harnessDir = join(projectRoot, '.harness');
    mkdirSync(harnessDir, { recursive: true });
    expect(loadProjectContextRule(harnessDir)).toBeNull();
  });

  it('loads project-root AGENTS.md as project-context rule', () => {
    const projectRoot = tmp();
    const harnessDir = join(projectRoot, '.harness');
    mkdirSync(harnessDir, { recursive: true });
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# Project AGENTS\n\nUse npm test.');
    const rule = loadProjectContextRule(harnessDir);
    expect(rule).not.toBeNull();
    expect(rule!.name).toBe('project-context');
    expect(rule!.body).toContain('Use npm test');
    expect(rule!.status).toBe('active');
  });
});
