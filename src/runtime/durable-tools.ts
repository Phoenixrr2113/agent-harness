import { hashStep, loadStep, saveStep } from './durable-cache.js';
import { appendEvent } from './durable-events.js';
import type { AIToolSet } from './tool-executor.js';

export interface DurableRunContext {
  harnessDir: string;
  runId: string;
  ordinalCounter: { value: number };
}

type ToolWithExecute = AIToolSet[string] & { execute?: (args: unknown, ctx: unknown) => unknown };

/**
 * Return a new tool set where every tool's `execute` is wrapped with
 * cache-check logic. On a cache hit, the wrapper returns the stored result
 * without calling the real execute. On a miss, the real execute runs, its
 * result is cached under hash(toolName, ordinal, args), and step_started /
 * step_completed events are appended. Tools without an `execute` are passed
 * through untouched.
 */
export function wrapToolsWithCache(tools: AIToolSet, ctx: DurableRunContext): AIToolSet {
  const wrapped: AIToolSet = {};
  for (const [name, original] of Object.entries(tools)) {
    const tool = original as ToolWithExecute;
    if (!tool.execute) {
      wrapped[name] = original;
      continue;
    }
    const realExecute = tool.execute;
    wrapped[name] = {
      ...tool,
      execute: async (args: unknown, execCtx: unknown) => {
        const ordinal = ctx.ordinalCounter.value++;
        const hash = hashStep(name, ordinal, args);
        const cached = loadStep(ctx.harnessDir, ctx.runId, hash);
        if (cached !== undefined) {
          appendEvent(ctx.harnessDir, ctx.runId, {
            type: 'step_cached',
            ordinal,
            toolName: name,
            at: new Date().toISOString(),
            hash,
          });
          return cached;
        }

        appendEvent(ctx.harnessDir, ctx.runId, {
          type: 'step_started',
          ordinal,
          toolName: name,
          at: new Date().toISOString(),
          hash,
        });
        try {
          const result = await realExecute(args, execCtx);
          saveStep(ctx.harnessDir, ctx.runId, hash, result);
          appendEvent(ctx.harnessDir, ctx.runId, {
            type: 'step_completed',
            ordinal,
            toolName: name,
            at: new Date().toISOString(),
            hash,
          });
          return result;
        } catch (err) {
          appendEvent(ctx.harnessDir, ctx.runId, {
            type: 'step_failed',
            ordinal,
            toolName: name,
            at: new Date().toISOString(),
            hash,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
    } as AIToolSet[string];
  }
  return wrapped;
}
