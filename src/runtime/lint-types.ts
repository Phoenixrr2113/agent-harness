export type LintSeverity = 'info' | 'warn' | 'error';

export interface LintResult {
  code: string;            // SCREAMING_SNAKE_CASE constant, e.g. DESCRIPTION_TOO_VAGUE
  severity: LintSeverity;
  message: string;         // human-readable, includes the offending value when relevant
  path: string;            // file path the issue is in
  line?: number;
  fixable?: boolean;       // can `harness doctor --fix` repair it
}

export interface SkillLintFn {
  (skill: import('../core/types.js').HarnessDocument, bundleDir: string): LintResult[];
}

export interface ScriptLintFn {
  (scriptPath: string): Promise<LintResult[]>;  // some lints spawn the script for --help
}
