import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeState } from '../src/runtime/durable-state.js';

const CLI = join(process.cwd(), 'dist/cli/index.js');

function seed(dir: string) {
  writeFileSync(join(dir, 'config.yaml'), `agent:\n  name: t\nmodel:\n  provider: openai\n  id: m\n`);
}

describe('harness workflows', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-wf-'));
    seed(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('status prints "No runs found" when empty', () => {
    const r = spawnSync('node', [CLI, 'workflows', 'status', '--dir', dir], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no runs/i);
  });

  it('status prints a row per run', () => {
    writeState(dir, {
      runId: 'r1',
      workflowId: 'wf1',
      prompt: 'p',
      status: 'complete',
      startedAt: '2026-04-21T10:00:00Z',
      endedAt: '2026-04-21T10:01:00Z',
      lastOrdinal: 0,
    });
    const r = spawnSync('node', [CLI, 'workflows', 'status', '--dir', dir], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('r1');
    expect(r.stdout).toContain('complete');
  });

  it('cleanup reports count', () => {
    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    writeState(dir, {
      runId: 'old',
      workflowId: 'wf',
      prompt: 'p',
      status: 'complete',
      startedAt: old,
      endedAt: old,
      lastOrdinal: 0,
    });
    const r = spawnSync('node', [CLI, 'workflows', 'cleanup', '--dir', dir, '--older-than', '30'], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/clean/i);
    expect(r.stdout).toContain('1');
  });

  it('inspect prints state JSON', () => {
    writeState(dir, {
      runId: 'r1',
      workflowId: 'wf',
      prompt: 'p',
      status: 'complete',
      startedAt: 't',
      endedAt: 't',
      lastOrdinal: 0,
    });
    const r = spawnSync('node', [CLI, 'workflows', 'inspect', 'r1', '--dir', dir], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('wf');
    expect(r.stdout).toContain('complete');
  });

  it('inspect fails clearly when run id is unknown', () => {
    const r = spawnSync('node', [CLI, 'workflows', 'inspect', 'nope', '--dir', dir], { encoding: 'utf-8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/not found/i);
  });
});
