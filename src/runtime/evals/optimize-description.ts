import { join } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import matter from 'gray-matter';
import { runTriggerEval, type TriggerEvalAgentRunner } from './triggers.js';
import { loadAllPrimitives } from '../../primitives/loader.js';
import type { TriggerEvalRunResult } from './eval-types.js';

export interface ProposeDescriptionInput {
  currentDescription: string;
  skillBody: string;
  failingQueries: Array<{ query: string; should_trigger: boolean }>;
}

export type ProposeDescriptionFn = (input: ProposeDescriptionInput) => Promise<string>;

export interface OptimizeDescriptionOptions {
  harnessDir: string;
  skillName: string;
  maxIterations?: number;
  runner: TriggerEvalAgentRunner;
  proposeDescription: ProposeDescriptionFn;
  runs?: number;
  dryRun?: boolean;
}

export interface OptimizationIteration {
  iteration: number;
  description: string;
  trainResult: TriggerEvalRunResult;
  validationResult: TriggerEvalRunResult;
}

export interface OptimizeDescriptionResult {
  bestIteration: OptimizationIteration;
  history: OptimizationIteration[];
  finalDescription: string;
  applied: boolean;
}

function bundleDirFor(harnessDir: string, skillName: string): { bundleDir: string; skillPath: string } {
  const skill = (loadAllPrimitives(harnessDir).get('skills') ?? []).find((s) => s.name === skillName);
  if (!skill || !skill.bundleDir) throw new Error(`Skill ${skillName} not found`);
  return { bundleDir: skill.bundleDir, skillPath: join(skill.bundleDir, 'SKILL.md') };
}

function readDescription(skillPath: string): { description: string; body: string } {
  const fm = matter(readFileSync(skillPath, 'utf-8'));
  return { description: String(fm.data.description ?? ''), body: fm.content };
}

function writeDescription(skillPath: string, description: string): void {
  const fm = matter(readFileSync(skillPath, 'utf-8'));
  fm.data.description = description;
  writeFileSync(skillPath, matter.stringify(fm.content, fm.data), 'utf-8');
}

export async function optimizeDescription(opts: OptimizeDescriptionOptions): Promise<OptimizeDescriptionResult> {
  const { harnessDir, skillName, maxIterations = 5, runner, proposeDescription, runs = 3, dryRun = false } = opts;
  const { skillPath } = bundleDirFor(harnessDir, skillName);

  const original = readDescription(skillPath);
  const history: OptimizationIteration[] = [];

  // Iteration 0 baseline
  const baselineTrain = await runTriggerEval({ harnessDir, skillName, runs, split: 'train', runner });
  const baselineValidation = await runTriggerEval({ harnessDir, skillName, runs, split: 'validation', runner });
  history.push({
    iteration: 0,
    description: original.description,
    trainResult: baselineTrain,
    validationResult: baselineValidation,
  });

  let currentDescription = original.description;

  for (let i = 1; i <= maxIterations; i++) {
    const last = history[history.length - 1];
    if (last.trainResult.summary.pass_rate === 1.0) break;

    const failing = last.trainResult.results
      .filter((r) => !r.passed)
      .map((r) => ({ query: r.query, should_trigger: r.should_trigger }));

    const proposed = await proposeDescription({
      currentDescription,
      skillBody: original.body,
      failingQueries: failing,
    });

    writeDescription(skillPath, proposed);
    currentDescription = proposed;

    const train = await runTriggerEval({ harnessDir, skillName, runs, split: 'train', runner });
    const validation = await runTriggerEval({ harnessDir, skillName, runs, split: 'validation', runner });
    history.push({ iteration: i, description: proposed, trainResult: train, validationResult: validation });
  }

  const best = history.reduce((a, b) =>
    b.validationResult.summary.pass_rate > a.validationResult.summary.pass_rate ? b : a,
  );

  if (dryRun) {
    // Restore original
    writeDescription(skillPath, original.description);
    return { bestIteration: best, history, finalDescription: best.description, applied: false };
  }

  writeDescription(skillPath, best.description);
  return { bestIteration: best, history, finalDescription: best.description, applied: true };
}
