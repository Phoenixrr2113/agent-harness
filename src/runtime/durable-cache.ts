import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = canonicalize(obj[k]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Deterministic content hash for a step invocation. Arguments are canonicalized
 * (recursive sort of object keys) before hashing, so `{ a, b }` and `{ b, a }`
 * collide. The ordinal disambiguates repeat calls to the same tool within a
 * single run.
 */
export function hashStep(toolName: string, ordinal: number, args: unknown): string {
  const canonical = JSON.stringify({ toolName, ordinal, args: canonicalize(args) });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}

function stepPath(harnessDir: string, runId: string, hash: string): string {
  return join(harnessDir, '.workflow-data', 'runs', runId, 'steps', `${hash}.json`);
}

/**
 * Load a previously-cached step result for this run. Returns undefined on miss.
 */
export function loadStep(harnessDir: string, runId: string, hash: string): unknown | undefined {
  const path = stepPath(harnessDir, runId, hash);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * Persist a step result to the run's cache directory. Overwrites on collision.
 */
export function saveStep(harnessDir: string, runId: string, hash: string, result: unknown): void {
  const path = stepPath(harnessDir, runId, hash);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(result, null, 2));
}
