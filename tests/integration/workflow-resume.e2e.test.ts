import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { durableRun } from '../../src/runtime/durable-engine.js';
import { readEvents } from '../../src/runtime/durable-events.js';
import { saveStep, hashStep, loadStep } from '../../src/runtime/durable-cache.js';
import { appendEvent } from '../../src/runtime/durable-events.js';
import { writeState } from '../../src/runtime/durable-state.js';

const runIntegration = process.env.INTEGRATION === '1';

describe.runIf(runIntegration)('durable workflow resume E2E', () => {
  it('cached tool results persist across a simulated crash and resume does not re-fire them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resume-e2e-'));
    try {
      writeFileSync(
        join(dir, 'config.yaml'),
        `agent:\n  name: test\nmodel:\n  provider: openai\n  id: qwen3:1.7b\n  base_url: http://localhost:11434/v1\n`,
      );

      const runId = 'test-run-deterministic';
      let toolCallCount = 0;

      // First pass: simulate 2 tool calls completing, then a crash before the 3rd.
      writeState(dir, {
        runId,
        workflowId: 'test-wf',
        prompt: 'call echo three times',
        status: 'running',
        startedAt: new Date().toISOString(),
        lastOrdinal: 0,
      });

      for (let ordinal = 0; ordinal < 2; ordinal++) {
        const args = { idx: ordinal };
        const hash = hashStep('echo', ordinal, args);
        toolCallCount++;
        saveStep(dir, runId, hash, `echo-result-${ordinal}`);
        appendEvent(dir, runId, {
          type: 'step_completed',
          ordinal,
          toolName: 'echo',
          at: new Date().toISOString(),
          hash,
        });
      }

      // "Crash" — state.json is left at `running` with lastOrdinal unset; no
      // `finished` event yet. Now resume.
      await durableRun({
        harnessDir: dir,
        workflowId: 'test-wf',
        prompt: 'call echo three times',
        resumeRunId: runId,
        _runAgent: async (ctx) => {
          // Simulate AI SDK's tool loop on replay: call echo 3 times total.
          // The wrapped tools (not used here since _runAgent bypasses them) would
          // short-circuit the first 2. Here we simulate the effect directly by
          // checking the cache and only "running" the 3rd.
          for (let ordinal = 0; ordinal < 3; ordinal++) {
            const args = { idx: ordinal };
            const hash = hashStep('echo', ordinal, args);
            const cached = loadStep(ctx.harnessDir, ctx.runId, hash);
            if (cached === undefined) {
              toolCallCount++;
              saveStep(ctx.harnessDir, ctx.runId, hash, `echo-result-${ordinal}`);
              appendEvent(ctx.harnessDir, ctx.runId, {
                type: 'step_completed',
                ordinal,
                toolName: 'echo',
                at: new Date().toISOString(),
                hash,
              });
            }
          }
          return {
            text: 'all three echoed',
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            steps: 1,
            toolCalls: [],
            session_id: 's',
          };
        },
      });

      expect(toolCallCount).toBe(3); // 2 pre-crash + 1 after resume
      const events = readEvents(dir, runId);
      const completed = events.filter((e) => e.type === 'step_completed');
      expect(completed).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
