import { spawn } from 'child_process';
import { readFileSync, statSync } from 'fs';
import type { LintResult } from '../lint-types.js';

async function shebang(scriptPath: string): Promise<LintResult[]> {
  const head = readFileSync(scriptPath, 'utf-8').slice(0, 200);
  if (!/^#!/.test(head)) {
    return [{
      code: 'MISSING_SHEBANG',
      severity: 'error',
      message: `${scriptPath} lacks a shebang (first line must start with #!). Common: #!/usr/bin/env bash, #!/usr/bin/env python3.`,
      path: scriptPath,
      fixable: false,
    }];
  }
  return [];
}

async function executable(scriptPath: string): Promise<LintResult[]> {
  const stats = statSync(scriptPath);
  // Check user-execute bit (0o100)
  if ((stats.mode & 0o100) === 0) {
    return [{
      code: 'NOT_EXECUTABLE',
      severity: 'error',
      message: `${scriptPath} lacks user-execute bit. Run \`chmod +x ${scriptPath}\` or use \`harness doctor --fix\`.`,
      path: scriptPath,
      fixable: true,
    }];
  }
  return [];
}

function runWithTimeout(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.on('error', () => { clearTimeout(timer); resolve({ status: -1, stdout, stderr }); });
  });
}

async function helpSupported(scriptPath: string): Promise<LintResult[]> {
  const result = await runWithTimeout(scriptPath, ['--help'], 5000);
  if (result.status !== 0) {
    return [{
      code: 'HELP_NOT_SUPPORTED',
      severity: 'error',
      message: `${scriptPath} --help exited with status ${result.status}; scripts must support --help. See docs/skill-authoring.md for the convention.`,
      path: scriptPath,
      fixable: false,
    }];
  }
  const out = result.stdout + result.stderr;
  if (!/Usage:/i.test(out) || !/Exit codes:/i.test(out)) {
    return [{
      code: 'HELP_INCOMPLETE',
      severity: 'warn',
      message: `${scriptPath} --help output should contain "Usage:" and "Exit codes:" sections per the script contract.`,
      path: scriptPath,
      fixable: false,
    }];
  }
  return [];
}

async function noInteractive(scriptPath: string): Promise<LintResult[]> {
  const src = readFileSync(scriptPath, 'utf-8');
  const patterns = [
    /\bread -p\b/,
    /\bread -r\b/,
    /\binput\(/,    // python
    /\bprompt\(/,   // js
    /\bgets\b/,     // ruby
  ];
  for (const p of patterns) {
    if (p.test(src)) {
      return [{
        code: 'INTERACTIVE_PROMPT',
        severity: 'warn',
        message: `${scriptPath} contains an interactive prompt pattern (${p.source}). Agent execution environments are non-interactive — block on stdin will hang the run. See docs/skill-authoring.md.`,
        path: scriptPath,
        fixable: false,
      }];
    }
  }
  return [];
}

export const scriptLints = {
  shebang,
  executable,
  helpSupported,
  noInteractive,
};

export const ALL_SCRIPT_LINTS: Array<(scriptPath: string) => Promise<LintResult[]>> = [
  shebang,
  executable,
  helpSupported,
  noInteractive,
];
