import { join, basename } from 'path';
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'fs';
import { loadAllPrimitives } from '../../primitives/loader.js';
import { parseEvalsFile, type EvalCase } from './evals-schema.js';
import type { BenchmarkResult, QualityEvalCaseResult } from './eval-types.js';
import { newQualityIteration, ensureWorkspaceGitignored } from './workspace.js';
import { gradeAssertion, type LlmGrader } from './grading.js';

export interface QualityEvalAgentInput {
  withSkill: boolean;
  prompt: string;
  workingDir: string;
  outputDir: string;
  skillName: string;
  harnessDir: string;
}

export interface QualityEvalAgentResult {
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  durationMs: number;
}

export type QualityEvalAgentRunner = (input: QualityEvalAgentInput) => Promise<QualityEvalAgentResult>;

export interface QualityEvalOptions {
  harnessDir: string;
  skillName: string;
  baseline?: 'none' | 'previous';
  runner: QualityEvalAgentRunner;
  llmGrader: LlmGrader | null;
}

function bundleDirFor(harnessDir: string, skillName: string): string {
  const skill = (loadAllPrimitives(harnessDir).get('skills') ?? []).find((s) => s.name === skillName);
  if (!skill || !skill.bundleDir) throw new Error(`Skill ${skillName} not found or missing bundleDir`);
  return skill.bundleDir;
}

function copyFiles(bundleDir: string, files: string[] | undefined, target: string): void {
  if (!files || files.length === 0) return;
  for (const rel of files) {
    const src = join(bundleDir, rel);
    if (!existsSync(src)) continue;
    const dst = join(target, basename(src));
    copyFileSync(src, dst);
  }
}

async function gradeCase(
  evalCase: EvalCase,
  outputDir: string,
  llmGrader: LlmGrader | null,
): Promise<{ pass_rate: number; grading_path: string }> {
  const verdicts: Array<{ assertion: string; passed: boolean; method: string; evidence: string }> = [];
  for (const assertion of evalCase.assertions) {
    const v = await gradeAssertion(assertion, outputDir, { llmGrader });
    verdicts.push({ assertion, passed: v.passed, method: v.method, evidence: v.evidence });
  }
  const passed = verdicts.filter((v) => v.passed).length;
  const passRate = verdicts.length === 0 ? 0 : passed / verdicts.length;
  const gradingPath = join(outputDir, '..', 'grading.json');
  writeFileSync(gradingPath, JSON.stringify({ verdicts, pass_rate: passRate }, null, 2), 'utf-8');
  return { pass_rate: passRate, grading_path: gradingPath };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export async function runQualityEval(opts: QualityEvalOptions): Promise<BenchmarkResult> {
  const { harnessDir, skillName, baseline = 'none', runner, llmGrader } = opts;
  const bundleDir = bundleDirFor(harnessDir, skillName);
  const evalsFile = parseEvalsFile(join(bundleDir, 'evals/evals.json'));

  ensureWorkspaceGitignored(harnessDir);
  const iter = newQualityIteration(harnessDir, skillName);

  const cases: QualityEvalCaseResult[] = [];

  for (const c of evalsFile.evals) {
    const caseDir = join(iter.path, `eval-${c.id}`);
    const withDir = join(caseDir, 'with_skill');
    const withoutDir = join(caseDir, 'without_skill');
    const withOutputs = join(withDir, 'outputs');
    const withoutOutputs = join(withoutDir, 'outputs');
    mkdirSync(withOutputs, { recursive: true });
    mkdirSync(withoutOutputs, { recursive: true });

    // With-skill run
    copyFiles(bundleDir, c.files, withOutputs);
    const tWithStart = Date.now();
    const withResult = await runner({
      withSkill: true,
      prompt: c.prompt,
      workingDir: withOutputs,
      outputDir: withOutputs,
      skillName,
      harnessDir,
    });
    const tWithEnd = Date.now();
    const withDuration = withResult.durationMs > 0 ? withResult.durationMs : tWithEnd - tWithStart;
    writeFileSync(
      join(withDir, 'timing.json'),
      JSON.stringify({ ...withResult.usage, duration_ms: withDuration }, null, 2),
    );
    const withGrade = await gradeCase(c, withOutputs, llmGrader);

    // Without-skill (baseline)
    copyFiles(bundleDir, c.files, withoutOutputs);
    const tWithoutStart = Date.now();
    const withoutResult = await runner({
      withSkill: false,
      prompt: c.prompt,
      workingDir: withoutOutputs,
      outputDir: withoutOutputs,
      skillName,
      harnessDir,
    });
    const tWithoutEnd = Date.now();
    const withoutDuration = withoutResult.durationMs > 0 ? withoutResult.durationMs : tWithoutEnd - tWithoutStart;
    writeFileSync(
      join(withoutDir, 'timing.json'),
      JSON.stringify({ ...withoutResult.usage, duration_ms: withoutDuration }, null, 2),
    );
    const withoutGrade = await gradeCase(c, withoutOutputs, llmGrader);

    cases.push({
      id: c.id,
      prompt: c.prompt,
      with_skill: {
        pass_rate: withGrade.pass_rate,
        tokens: withResult.usage.totalTokens,
        duration_ms: withDuration,
        output_dir: withOutputs,
        grading_path: withGrade.grading_path,
      },
      without_skill: {
        pass_rate: withoutGrade.pass_rate,
        tokens: withoutResult.usage.totalTokens,
        duration_ms: withoutDuration,
        output_dir: withoutOutputs,
        grading_path: withoutGrade.grading_path,
      },
    });
  }

  const withPass = mean(cases.map((c) => c.with_skill.pass_rate));
  const withoutPass = mean(cases.map((c) => c.without_skill.pass_rate));
  const withTokens = mean(cases.map((c) => c.with_skill.tokens));
  const withoutTokens = mean(cases.map((c) => c.without_skill.tokens));
  const withDuration = mean(cases.map((c) => c.with_skill.duration_ms));
  const withoutDuration = mean(cases.map((c) => c.without_skill.duration_ms));

  const benchmark: BenchmarkResult = {
    skill: skillName,
    iteration: iter.name,
    baseline,
    cases,
    with_skill: { pass_rate: { mean: withPass }, tokens: { mean: withTokens }, duration_ms: { mean: withDuration } },
    without_skill: { pass_rate: { mean: withoutPass }, tokens: { mean: withoutTokens }, duration_ms: { mean: withoutDuration } },
    delta: {
      pass_rate: withPass - withoutPass,
      tokens: withTokens - withoutTokens,
      duration_ms: withDuration - withoutDuration,
    },
    ran_at: new Date().toISOString(),
  };

  writeFileSync(join(iter.path, 'benchmark.json'), JSON.stringify(benchmark, null, 2), 'utf-8');
  return benchmark;
}
