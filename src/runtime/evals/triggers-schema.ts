import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';

export const TriggerQuerySchema = z.object({
  id: z.string().min(1).max(64),
  query: z.string().min(1).max(500),
  should_trigger: z.boolean(),
  split: z.enum(['train', 'validation']),
  notes: z.string().optional(),
});

export const TriggersFileSchema = z.array(TriggerQuerySchema);

export type TriggerQuery = z.infer<typeof TriggerQuerySchema>;

export function parseTriggersFile(path: string): TriggerQuery[] {
  if (!existsSync(path)) {
    throw new Error(`triggers.json not found at ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`triggers.json is not valid JSON at ${path}: ${(err as Error).message}`);
  }
  return TriggersFileSchema.parse(parsed);
}
