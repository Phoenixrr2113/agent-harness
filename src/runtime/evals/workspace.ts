import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

export interface EvalWorkspace {
  skillRoot: string;
  triggersDir: string;
  qualityDir: string;
}

export function evalWorkspaceFor(harnessDir: string, skillName: string): EvalWorkspace {
  const skillRoot = join(harnessDir, '.evals-workspace', skillName);
  return {
    skillRoot,
    triggersDir: join(skillRoot, 'triggers'),
    qualityDir: join(skillRoot, 'quality'),
  };
}

export function ensureWorkspaceGitignored(harnessDir: string): void {
  const giPath = join(harnessDir, '.gitignore');
  const entry = '.evals-workspace/';
  let existing = '';
  if (existsSync(giPath)) {
    existing = readFileSync(giPath, 'utf-8');
    if (existing.split('\n').some((line) => line.trim() === entry)) {
      return;
    }
  }
  const next = existing.length > 0 && !existing.endsWith('\n')
    ? existing + '\n' + entry + '\n'
    : existing + entry + '\n';
  writeFileSync(giPath, next, 'utf-8');
}

export interface QualityIteration {
  name: string;
  path: string;
}

export function newQualityIteration(harnessDir: string, skillName: string): QualityIteration {
  const ws = evalWorkspaceFor(harnessDir, skillName);
  if (!existsSync(ws.qualityDir)) {
    mkdirSync(ws.qualityDir, { recursive: true });
  }
  const existing = readdirSync(ws.qualityDir).filter((n) => n.startsWith('iteration-'));
  const max = existing
    .map((n) => Number(n.replace('iteration-', '')))
    .filter((n) => !Number.isNaN(n))
    .reduce((a, b) => Math.max(a, b), 0);
  const name = `iteration-${max + 1}`;
  const path = join(ws.qualityDir, name);
  mkdirSync(path, { recursive: true });
  return { name, path };
}
