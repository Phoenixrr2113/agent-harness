import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export interface AssertionVerdict {
  passed: boolean;
  method: 'code' | 'llm';
  evidence: string;
}

export interface LlmGraderInput {
  assertion: string;
  outputDir: string;
}

export type LlmGrader = (input: LlmGraderInput) => Promise<{ passed: boolean; evidence: string }>;

export interface GradeOptions {
  llmGrader: LlmGrader | null;
}

const FILE_EXISTS_PATTERNS = [
  /(?:output|result)\s+(?:includes?|has)\s+a?\s*file\s+(?:named\s+)?["`']?([\w./-]+)["`']?/i,
  /(?:file|output)\s+["`']?([\w./-]+)["`']?\s+(?:exists|is created|is written)/i,
];

const VALID_JSON_PATTERN = /["`']?([\w./-]+\.json)["`']?\s+is\s+valid\s+json/i;

function tryFileExistsCheck(assertion: string, outputDir: string): AssertionVerdict | null {
  for (const pattern of FILE_EXISTS_PATTERNS) {
    const match = assertion.match(pattern);
    if (match) {
      const file = match[1];
      const path = join(outputDir, file);
      const exists = existsSync(path);
      return {
        passed: exists,
        method: 'code',
        evidence: exists
          ? `File ${file} exists (${statSync(path).size} bytes).`
          : `File ${file} does not exist in ${outputDir}.`,
      };
    }
  }
  return null;
}

function tryValidJsonCheck(assertion: string, outputDir: string): AssertionVerdict | null {
  const match = assertion.match(VALID_JSON_PATTERN);
  if (!match) return null;
  const file = match[1];
  const path = join(outputDir, file);
  if (!existsSync(path)) {
    return { passed: false, method: 'code', evidence: `${file} does not exist.` };
  }
  try {
    JSON.parse(readFileSync(path, 'utf-8'));
    return { passed: true, method: 'code', evidence: `${file} is valid JSON.` };
  } catch (err) {
    return { passed: false, method: 'code', evidence: `${file} is not valid JSON: ${(err as Error).message}` };
  }
}

export async function gradeAssertion(
  assertion: string,
  outputDir: string,
  options: GradeOptions,
): Promise<AssertionVerdict> {
  // Code-checks first
  const checks = [tryFileExistsCheck, tryValidJsonCheck];
  for (const check of checks) {
    const result = check(assertion, outputDir);
    if (result !== null) return result;
  }

  // LLM judge fallback
  if (!options.llmGrader) {
    return {
      passed: false,
      method: 'code',
      evidence: 'No mechanical match and no LLM grader provided.',
    };
  }
  try {
    const verdict = await options.llmGrader({ assertion, outputDir });
    return { passed: verdict.passed, method: 'llm', evidence: verdict.evidence };
  } catch (err) {
    return {
      passed: false,
      method: 'llm',
      evidence: `Grader threw: ${(err as Error).message}`,
    };
  }
}
