import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { loadAllPrimitives } from '../primitives/loader.js';
import type { HarnessDocument } from '../core/types.js';

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

// ---------------------------------------------------------------------------
// Trigger composition — AI SDK lifecycle handlers
// ---------------------------------------------------------------------------

export interface ComposedHandlers {
  /**
   * prepareCall: mutate call settings before each run. Requires ToolLoopAgent.
   * Not wired into createHarness in this release (generateText does not have
   * a prepareCall hook). See DONE_WITH_CONCERNS in Task 6.
   */
  prepareCall?: (settings: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /**
   * prepareStep: mutate step settings before each step in the tool-use loop.
   * Wired through provider.ts GenerateOptions.prepareStep.
   */
  prepareStep?: (settings: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** onStepFinish: observation callback after each step. No merge. */
  onStepFinish?: (stepResult: unknown) => Promise<void>;
  /** onFinish: observation callback after the run completes. No merge. */
  onFinish?: (runResult: unknown) => Promise<void>;
}

const TRIGGER_KINDS = [
  'prepare-call',
  'prepare-step',
  'step-finish',
  'run-finish',
  'repair-tool-call',
  'tool-pre',
  'tool-post',
  'stop-condition',
  'stream-transform',
  'subagent',
] as const;
type TriggerKind = (typeof TRIGGER_KINDS)[number];

function getSkillsForTrigger(harnessDir: string, kind: TriggerKind): HarnessDocument[] {
  const all = loadAllPrimitives(harnessDir);
  const skills = (all.get('skills') ?? []).filter((s) => {
    if (s.status === 'archived' || s.status === 'deprecated') return false;
    return s.metadata?.['harness-trigger'] === kind;
  });
  // Sort by harness-trigger-priority (default 100), then by name
  skills.sort((a, b) => {
    const pa = Number(a.metadata?.['harness-trigger-priority'] ?? 100);
    const pb = Number(b.metadata?.['harness-trigger-priority'] ?? 100);
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });
  return skills;
}

function mergeSettings(
  current: Record<string, unknown>,
  scriptResult: TriggerScriptResult,
): Record<string, unknown> {
  if (scriptResult.status !== 'ok' || !scriptResult.result) return current;
  const r = scriptResult.result as Record<string, unknown>;
  const merged = { ...current };
  // String fields: append (instructions)
  if (typeof r.instructions === 'string') {
    const prev = typeof merged.instructions === 'string' ? merged.instructions + '\n\n' : '';
    merged.instructions = prev + r.instructions;
  }
  // Object fields: shallow merge (tools)
  if (r.tools !== null && r.tools !== undefined && typeof r.tools === 'object' && !Array.isArray(r.tools)) {
    merged.tools = { ...(merged.tools as Record<string, unknown> ?? {}), ...(r.tools as Record<string, unknown>) };
  }
  // Array fields: replace (activeTools)
  if (Array.isArray(r.activeTools)) {
    merged.activeTools = r.activeTools;
  }
  // providerOptions: shallow merge
  if (r.providerOptions !== null && r.providerOptions !== undefined && typeof r.providerOptions === 'object' && !Array.isArray(r.providerOptions)) {
    merged.providerOptions = { ...(merged.providerOptions as Record<string, unknown> ?? {}), ...(r.providerOptions as Record<string, unknown>) };
  }
  return merged;
}

export function composeTriggerHandlers(harnessDir: string): ComposedHandlers {
  const handlers: ComposedHandlers = {};

  // prepare-call — NOTE: not wired in this release; requires ToolLoopAgent.
  // The handler is composed so callers that DO use ToolLoopAgent can consume it.
  const prepareCallSkills = getSkillsForTrigger(harnessDir, 'prepare-call');
  if (prepareCallSkills.length > 0) {
    handlers.prepareCall = async (settings) => {
      let merged = { ...settings };
      for (const skill of prepareCallSkills) {
        if (!skill.bundleDir) continue;
        const r = await runTriggerScript({
          bundleDir: skill.bundleDir,
          trigger: 'prepare-call',
          payload: { settings: merged },
        });
        if (r.status === 'error' && r.error?.action === 'abort') {
          throw new Error(`prepare-call aborted by ${skill.name}: ${r.error.message}`);
        }
        if (r.status === 'error') {
          process.stderr.write(`[triggers] prepare-call error in ${skill.name}: ${r.error?.message ?? 'unknown'}\n`);
          // proceed with unmodified settings
          continue;
        }
        merged = mergeSettings(merged, r);
      }
      return merged;
    };
  }

  // prepare-step
  const prepareStepSkills = getSkillsForTrigger(harnessDir, 'prepare-step');
  if (prepareStepSkills.length > 0) {
    handlers.prepareStep = async (settings) => {
      let merged = { ...settings };
      for (const skill of prepareStepSkills) {
        if (!skill.bundleDir) continue;
        const r = await runTriggerScript({
          bundleDir: skill.bundleDir,
          trigger: 'prepare-step',
          payload: { settings: merged },
        });
        if (r.status === 'error' && r.error?.action === 'abort') {
          throw new Error(`prepare-step aborted by ${skill.name}: ${r.error.message}`);
        }
        if (r.status === 'error') {
          process.stderr.write(`[triggers] prepare-step error in ${skill.name}: ${r.error?.message ?? 'unknown'}\n`);
          continue;
        }
        merged = mergeSettings(merged, r);
      }
      return merged;
    };
  }

  // step-finish — observation only
  const stepFinishSkills = getSkillsForTrigger(harnessDir, 'step-finish');
  if (stepFinishSkills.length > 0) {
    handlers.onStepFinish = async (stepResult) => {
      for (const skill of stepFinishSkills) {
        if (!skill.bundleDir) continue;
        const r = await runTriggerScript({
          bundleDir: skill.bundleDir,
          trigger: 'step-finish',
          payload: { stepResult },
        });
        if (r.status === 'error') {
          process.stderr.write(`[triggers] step-finish error in ${skill.name}: ${r.error?.message ?? 'unknown'}\n`);
        }
        // step-finish is observation-only; result is ignored
      }
    };
  }

  // run-finish — observation only
  const runFinishSkills = getSkillsForTrigger(harnessDir, 'run-finish');
  if (runFinishSkills.length > 0) {
    handlers.onFinish = async (runResult) => {
      for (const skill of runFinishSkills) {
        if (!skill.bundleDir) continue;
        const r = await runTriggerScript({
          bundleDir: skill.bundleDir,
          trigger: 'run-finish',
          payload: { runResult },
        });
        if (r.status === 'error') {
          process.stderr.write(`[triggers] run-finish error in ${skill.name}: ${r.error?.message ?? 'unknown'}\n`);
        }
      }
    };
  }

  return handlers;
}
