import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  evalWorkspaceFor,
  ensureWorkspaceGitignored,
  newQualityIteration,
} from '../../../src/runtime/evals/workspace.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'evals-ws-'));
}

describe('evalWorkspaceFor', () => {
  it('returns deterministic paths under harness-dir', () => {
    const ws = evalWorkspaceFor('/h', 'foo');
    expect(ws.skillRoot).toBe('/h/.evals-workspace/foo');
    expect(ws.triggersDir).toBe('/h/.evals-workspace/foo/triggers');
    expect(ws.qualityDir).toBe('/h/.evals-workspace/foo/quality');
  });
});

describe('ensureWorkspaceGitignored', () => {
  it('creates .gitignore with .evals-workspace/ entry if missing', () => {
    const dir = tmp();
    ensureWorkspaceGitignored(dir);
    const giPath = join(dir, '.gitignore');
    expect(existsSync(giPath)).toBe(true);
    expect(readFileSync(giPath, 'utf-8')).toContain('.evals-workspace/');
  });

  it('appends to existing .gitignore if entry not present', () => {
    const dir = tmp();
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\ndist/\n');
    ensureWorkspaceGitignored(dir);
    const text = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(text).toContain('node_modules/');
    expect(text).toContain('.evals-workspace/');
  });

  it('does not double-add if entry already present', () => {
    const dir = tmp();
    writeFileSync(join(dir, '.gitignore'), '.evals-workspace/\n');
    ensureWorkspaceGitignored(dir);
    const text = readFileSync(join(dir, '.gitignore'), 'utf-8');
    const occurrences = text.split('.evals-workspace/').length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('newQualityIteration', () => {
  it('returns iteration-1 for fresh skill', () => {
    const dir = tmp();
    const it = newQualityIteration(dir, 'foo');
    expect(it.name).toBe('iteration-1');
    expect(it.path).toBe(join(dir, '.evals-workspace/foo/quality/iteration-1'));
    expect(existsSync(it.path)).toBe(true);
  });

  it('increments past existing iterations', () => {
    const dir = tmp();
    mkdirSync(join(dir, '.evals-workspace/foo/quality/iteration-1'), { recursive: true });
    mkdirSync(join(dir, '.evals-workspace/foo/quality/iteration-2'), { recursive: true });
    const it = newQualityIteration(dir, 'foo');
    expect(it.name).toBe('iteration-3');
  });
});
