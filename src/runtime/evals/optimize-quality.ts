import { join } from 'path';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { loadAllPrimitives } from '../../primitives/loader.js';
import { runQualityEval, type QualityEvalAgentRunner } from './quality.js';
import type { LlmGrader } from './grading.js';
import type { BenchmarkResult } from './eval-types.js';

export interface ProposeBodyInput {
  currentSkillFile: string;
  benchmark: BenchmarkResult;
}

export type ProposeBodyFn = (input: ProposeBodyInput) => Promise<string>;

export interface OptimizeQualityOptions {
  harnessDir: string;
  skillName: string;
  maxIterations?: number;
  qualityRunner: QualityEvalAgentRunner;
  proposeBody: ProposeBodyFn;
  llmGrader: LlmGrader | null;
  autoApprove?: boolean;
}

export interface OptimizeQualityResult {
  iterations: BenchmarkResult[];
  applied: boolean;
}

function skillBundleDir(harnessDir: string, name: string): { bundleDir: string; skillPath: string } {
  const skill = (loadAllPrimitives(harnessDir).get('skills') ?? []).find((s) => s.name === name);
  if (!skill || !skill.bundleDir) throw new Error(`Skill ${name} not found`);
  return { bundleDir: skill.bundleDir, skillPath: join(skill.bundleDir, 'SKILL.md') };
}

export async function optimizeQuality(opts: OptimizeQualityOptions): Promise<OptimizeQualityResult> {
  const { harnessDir, skillName, maxIterations = 3, qualityRunner, proposeBody, llmGrader, autoApprove = false } = opts;
  const { skillPath } = skillBundleDir(harnessDir, skillName);
  const iterations: BenchmarkResult[] = [];

  for (let i = 0; i < maxIterations; i++) {
    const benchmark = await runQualityEval({
      harnessDir,
      skillName,
      runner: qualityRunner,
      llmGrader,
      baseline: 'previous',
    });
    iterations.push(benchmark);

    // Snapshot the SKILL.md as it existed for this iteration
    const snapshotDir = join(harnessDir, '.evals-workspace', skillName, 'quality', benchmark.iteration, 'skill-snapshot');
    if (!existsSync(snapshotDir)) mkdirSync(snapshotDir, { recursive: true });
    copyFileSync(skillPath, join(snapshotDir, 'SKILL.md'));

    // Propose body change
    const proposed = await proposeBody({ currentSkillFile: readFileSync(skillPath, 'utf-8'), benchmark });

    // Auto-approve in tests; CLI prompts the user
    if (!autoApprove) break;
    writeFileSync(skillPath, proposed, 'utf-8');
  }

  return { iterations, applied: autoApprove };
}
