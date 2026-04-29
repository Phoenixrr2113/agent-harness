import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runTriggerScript } from '../../src/runtime/triggers.js';

function makeSkillBundle(name: string, scriptContent: string): { harnessDir: string; bundleDir: string } {
  const harnessDir = mkdtempSync(join(tmpdir(), 'triggers-'));
  const bundleDir = join(harnessDir, 'skills', name);
  mkdirSync(join(bundleDir, 'scripts'), { recursive: true });
  writeFileSync(
    join(bundleDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Test trigger.\nmetadata:\n  harness-trigger: prepare-call\n---\nBody.`,
    'utf-8'
  );
  const scriptPath = join(bundleDir, 'scripts', 'run.sh');
  writeFileSync(scriptPath, scriptContent, 'utf-8');
  chmodSync(scriptPath, 0o755);
  return { harnessDir, bundleDir };
}

describe('runTriggerScript', () => {
  it('parses JSON returned by the script', async () => {
    const { bundleDir } = makeSkillBundle(
      'inject-state',
      `#!/usr/bin/env bash\necho '{"status":"ok","result":{"instructions":"injected"}}'`
    );
    const result = await runTriggerScript({
      bundleDir,
      trigger: 'prepare-call',
      payload: { test: 'value' },
    });
    expect(result.status).toBe('ok');
    expect(result.result).toEqual({ instructions: 'injected' });
  });

  it('reports error when script exits non-zero', async () => {
    const { bundleDir } = makeSkillBundle(
      'fail',
      `#!/usr/bin/env bash\necho '{"status":"error","error":{"code":"FAIL","message":"oops"}}' && exit 1`
    );
    const result = await runTriggerScript({
      bundleDir,
      trigger: 'prepare-call',
      payload: {},
    });
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('FAIL');
  });

  it('honors timeout and returns error when script hangs', async () => {
    const { bundleDir } = makeSkillBundle(
      'hang',
      `#!/usr/bin/env bash\nsleep 5`
    );
    const result = await runTriggerScript({
      bundleDir,
      trigger: 'prepare-call',
      payload: {},
      timeoutMs: 200,
    });
    expect(result.status).toBe('error');
    expect(result.error?.code).toMatch(/TIMEOUT|TIMED_OUT/);
  }, 10000);

  it('passes payload via stdin and trigger name via argv', async () => {
    const { bundleDir } = makeSkillBundle(
      'echo',
      `#!/usr/bin/env bash\nstdin=$(cat)\necho "{\\"status\\":\\"ok\\",\\"result\\":{\\"trigger\\":\\"$1\\",\\"payload\\":$stdin}}"`
    );
    const result = await runTriggerScript({
      bundleDir,
      trigger: 'prepare-call',
      payload: { foo: 'bar' },
    });
    expect(result.status).toBe('ok');
    const r = result.result as { trigger: string; payload: { foo: string } };
    expect(r.trigger).toBe('prepare-call');
    expect(r.payload.foo).toBe('bar');
  });
});
