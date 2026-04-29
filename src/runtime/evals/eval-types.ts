/** Per-query result inside a single trigger eval run. */
export interface TriggerEvalQueryResult {
  id: string;
  query: string;
  should_trigger: boolean;
  trigger_count: number;
  trigger_rate: number;
  passed: boolean;
}

/** Aggregate trigger eval result for one skill, one split. */
export interface TriggerEvalRunResult {
  skill: string;
  description: string;
  split: 'train' | 'validation' | 'all';
  runs_per_query: number;
  results: TriggerEvalQueryResult[];
  summary: {
    passed: number;
    failed: number;
    total: number;
    pass_rate: number;
  };
  ran_at: string;
}

/** Per-test-case quality eval result with-skill vs baseline. */
export interface QualityEvalCaseResult {
  id: string;
  prompt: string;
  with_skill: {
    pass_rate: number;
    tokens: number;
    duration_ms: number;
    output_dir: string;
    grading_path: string;
  };
  without_skill: {
    pass_rate: number;
    tokens: number;
    duration_ms: number;
    output_dir: string;
    grading_path: string;
  };
}

/** Aggregate quality eval benchmark. */
export interface BenchmarkResult {
  skill: string;
  iteration: string;
  baseline: 'none' | 'previous' | string;
  cases: QualityEvalCaseResult[];
  with_skill: { pass_rate: { mean: number }; tokens: { mean: number }; duration_ms: { mean: number } };
  without_skill: { pass_rate: { mean: number }; tokens: { mean: number }; duration_ms: { mean: number } };
  delta: { pass_rate: number; tokens: number; duration_ms: number };
  ran_at: string;
}
