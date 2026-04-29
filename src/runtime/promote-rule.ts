import { join } from 'path';
import { writeFileSync } from 'fs';
import matter from 'gray-matter';
import type { InstinctCandidate } from './instinct-learner.js';
import type { TriggerQuery } from './evals/triggers-schema.js';

export interface RulePromoteOptions {
  harnessDir: string;
  candidate: InstinctCandidate;
  runTriggerEval: (queries: TriggerQuery[], candidate: InstinctCandidate) => Promise<{ summary: { passed: number; failed: number; total: number; pass_rate: number } }>;
  runQualityEval: (candidate: InstinctCandidate) => Promise<{ delta: { pass_rate: number; tokens: number; duration_ms: number } }>;
  generateQueries: (candidate: InstinctCandidate) => Promise<TriggerQuery[]>;
  noEvalGate?: boolean;
  triggerThreshold?: number;
}

export interface RulePromoteResult {
  promoted: boolean;
  reason: string;
  rulePath?: string;
}

const TRIGGER_PASS_RATE_FLOOR = 0.5;

function writeRuleFile(harnessDir: string, candidate: InstinctCandidate): string {
  const path = join(harnessDir, 'rules', `${candidate.id}.md`);
  const frontmatter = {
    name: candidate.id,
    description: candidate.behavior,
    author: 'agent',
    confidence: candidate.confidence,
    provenance: candidate.provenance,
    status: 'active',
  };
  const body = `# ${candidate.id}\n\n${candidate.behavior}`;
  writeFileSync(path, matter.stringify(body, frontmatter), 'utf-8');
  return path;
}

export async function promoteRule(opts: RulePromoteOptions): Promise<RulePromoteResult> {
  const { harnessDir, candidate, runTriggerEval, runQualityEval, generateQueries, noEvalGate = false, triggerThreshold = TRIGGER_PASS_RATE_FLOOR } = opts;

  if (noEvalGate) {
    const path = writeRuleFile(harnessDir, candidate);
    return { promoted: true, reason: 'eval gate bypass (--no-eval-gate)', rulePath: path };
  }

  const queries = await generateQueries(candidate);
  if (queries.length > 0) {
    const trig = await runTriggerEval(queries, candidate);
    if (trig.summary.pass_rate < triggerThreshold) {
      return {
        promoted: false,
        reason: `trigger eval pass_rate ${trig.summary.pass_rate.toFixed(2)} below threshold ${triggerThreshold}`,
      };
    }
  }

  const quality = await runQualityEval(candidate);
  if (quality.delta.pass_rate <= 0) {
    return {
      promoted: false,
      reason: `no measurable improvement (delta pass_rate=${quality.delta.pass_rate.toFixed(2)})`,
    };
  }

  const path = writeRuleFile(harnessDir, candidate);
  return {
    promoted: true,
    reason: `quality delta pass_rate=${quality.delta.pass_rate.toFixed(2)} (positive)`,
    rulePath: path,
  };
}
