import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

export interface TriggerScriptResult {
  status: 'ok' | 'error' | 'blocked';
  result?: unknown;
  error?: {
    code: string;
    message: string;
    evidence?: string;
    action?: 'abort' | 'retry' | 'escalate' | 'ignore';
  };
  next_steps?: string[];
  metrics?: Record<string, unknown>;
  artifacts?: Array<{ path: string; description?: string }>;
}

export interface RunTriggerScriptOptions {
  bundleDir: string;
  trigger: string;
  payload: unknown;
  timeoutMs?: number;
  scriptName?: string; // default: 'run.sh' (or .py/.ts/.js probed)
}

const DEFAULT_TIMEOUT_MS = 5000;

function findScript(bundleDir: string, scriptName?: string): string | null {
  const dir = join(bundleDir, 'scripts');
  const candidates = scriptName
    ? [scriptName]
    : ['run.sh', 'run.py', 'run.ts', 'run.js'];
  for (const name of candidates) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function runTriggerScript(opts: RunTriggerScriptOptions): Promise<TriggerScriptResult> {
  const { bundleDir, trigger, payload, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  return new Promise((resolve) => {
    const scriptPath = findScript(bundleDir, opts.scriptName);
    if (!scriptPath) {
      resolve({
        status: 'error',
        error: { code: 'SCRIPT_NOT_FOUND', message: `No run.sh/.py/.ts/.js in ${bundleDir}/scripts/` },
      });
      return;
    }

    const child = spawn(scriptPath, [trigger, bundleDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      resolve({
        status: 'error',
        error: { code: 'TIMEOUT', message: `Script exceeded ${timeoutMs}ms`, evidence: stderr.slice(0, 500) },
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      if (timedOut) return;
      resolve({
        status: 'error',
        error: { code: 'SPAWN_FAILED', message: err.message },
      });
    });

    child.on('close', (exitCode: number | null) => {
      clearTimeout(timer);
      if (timedOut) return;
      try {
        const parsed = JSON.parse(stdout) as TriggerScriptResult;
        resolve(parsed);
      } catch {
        resolve({
          status: 'error',
          error: {
            code: 'INVALID_JSON',
            message: `Script stdout is not valid JSON. Exit code: ${exitCode}.`,
            evidence: stdout.slice(0, 500),
          },
        });
      }
    });

    child.stdin.end(JSON.stringify(payload));
  });
}
