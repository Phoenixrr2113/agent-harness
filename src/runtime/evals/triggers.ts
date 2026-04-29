import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { loadAllPrimitives } from '../../primitives/loader.js';
import type { HarnessDocument } from '../../core/types.js';
import { parseTriggersFile } from './triggers-schema.js';
import type { TriggerEvalRunResult, TriggerEvalQueryResult } from './eval-types.js';
import { evalWorkspaceFor, ensureWorkspaceGitignored } from './workspace.js';

export interface TriggerEvalAgentResult {
  toolCalls: Array<{ toolName: string; args: Record<string, unknown>; result: unknown }>;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  steps: number;
  text: string;
}

export type TriggerEvalAgentRunner = (
  input: { harnessDir: string; query: string; skillName: string },
) => Promise<TriggerEvalAgentResult>;

export interface TriggerEvalOptions {
  harnessDir: string;
  skillName: string;
  runs?: number;
  split?: 'train' | 'validation' | 'all';
  runner: TriggerEvalAgentRunner;
}

const DEFAULT_RUNS = 3;
const PASS_THRESHOLD = 0.5;

function getSkill(harnessDir: string, name: string): HarnessDocument | null {
  const all = loadAllPrimitives(harnessDir);
  const skills = (all.get('skills') ?? []).filter((s) => s.name === name);
  return skills[0] ?? null;
}

function triggerCountFor(result: TriggerEvalAgentResult, skillName: string): number {
  let count = 0;
  for (const call of result.toolCalls) {
    if (call.toolName === 'activate_skill' && (call.args as { name?: string }).name === skillName) {
      count++;
    }
  }
  return count > 0 ? 1 : 0;
}

export async function runTriggerEval(opts: TriggerEvalOptions): Promise<TriggerEvalRunResult> {
  const { harnessDir, skillName, runs = DEFAULT_RUNS, split = 'all', runner } = opts;
  const skill = getSkill(harnessDir, skillName);
  if (!skill) throw new Error(`Skill not found: ${skillName}`);
  if (!skill.bundleDir) throw new Error(`Skill ${skillName} has no bundle directory`);

  const triggersPath = join(skill.bundleDir, 'evals', 'triggers.json');
  const queries = parseTriggersFile(triggersPath);
  const filtered = split === 'all' ? queries : queries.filter((q) => q.split === split);

  const results: TriggerEvalQueryResult[] = [];
  for (const q of filtered) {
    let triggerCount = 0;
    for (let r = 0; r < runs; r++) {
      const agentResult = await runner({ harnessDir, query: q.query, skillName });
      triggerCount += triggerCountFor(agentResult, skillName);
    }
    const triggerRate = triggerCount / runs;
    const passed = q.should_trigger ? triggerRate >= PASS_THRESHOLD : triggerRate < PASS_THRESHOLD;
    results.push({
      id: q.id,
      query: q.query,
      should_trigger: q.should_trigger,
      trigger_count: triggerCount,
      trigger_rate: triggerRate,
      passed,
    });
  }

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const summary = {
    passed,
    failed: total - passed,
    total,
    pass_rate: total === 0 ? 0 : passed / total,
  };

  const result: TriggerEvalRunResult = {
    skill: skillName,
    description: typeof skill.description === 'string' ? skill.description : '',
    split,
    runs_per_query: runs,
    results,
    summary,
    ran_at: new Date().toISOString(),
  };

  ensureWorkspaceGitignored(harnessDir);
  const ws = evalWorkspaceFor(harnessDir, skillName);
  if (!existsSync(ws.triggersDir)) {
    mkdirSync(ws.triggersDir, { recursive: true });
  }
  const stamp = result.ran_at.replace(/[:.]/g, '-');
  writeFileSync(join(ws.triggersDir, `${stamp}.json`), JSON.stringify(result, null, 2), 'utf-8');

  return result;
}
