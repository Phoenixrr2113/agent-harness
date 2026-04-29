import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';

export const EvalCaseSchema = z.object({
  id: z.string().min(1).max(64),
  prompt: z.string().min(1),
  expected_output: z.string().min(1),
  files: z.array(z.string()).optional(),
  assertions: z.array(z.string().min(1)).min(1, { message: 'at least one assertion required' }),
});

export const EvalsFileSchema = z.object({
  skill_name: z.string().min(1),
  evals: z.array(EvalCaseSchema).min(1),
});

export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type EvalsFile = z.infer<typeof EvalsFileSchema>;

export function parseEvalsFile(path: string): EvalsFile {
  if (!existsSync(path)) {
    throw new Error(`evals.json not found at ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`evals.json is not valid JSON at ${path}: ${(err as Error).message}`);
  }
  return EvalsFileSchema.parse(parsed);
}
