import { tool } from 'ai';
import { z } from 'zod';
import { join } from 'path';
import { loadDirectory } from '../primitives/loader.js';
import { log } from '../core/logger.js';
import type { AIToolSet } from './tool-executor.js';

/**
 * Build an AIToolSet where each tool delegates to one active agent in
 * `agents/*.md`. Tool name equals the agent's frontmatter `id`. Description
 * falls back through `frontmatter.description` → `l1` → `l0`. Tool input is
 * `{ prompt: string }`. The tool's execute calls `delegateTo` from
 * `./delegate.js` and returns the subagent's final text, or an error object
 * on failure.
 *
 * Tools for agents with `status !== 'active'` are excluded.
 *
 * Must not be called from within a subagent — nested delegation is blocked
 * structurally by excluding agent-tools from `buildToolSet` when
 * `includeAgentTools: false`.
 */
export function buildAgentTools(harnessDir: string): AIToolSet {
  const docs = loadDirectory(join(harnessDir, 'agents'));
  const tools: AIToolSet = {};

  for (const doc of docs) {
    if (doc.status !== 'active') continue;

    const id = doc.id;
    if (!id) {
      log.warn(`agents/${doc.path}: skipped — missing frontmatter id`);
      continue;
    }

    const description = doc.description || `Delegate to the ${id} sub-agent.`;

    tools[id] = tool({
      description,
      inputSchema: z.object({
        prompt: z.string().describe('The task to hand off to this subagent.'),
      }),
      execute: async ({ prompt }: { prompt: string }) => {
        const { delegateTo } = await import('./delegate.js');
        try {
          const result = await delegateTo({ harnessDir, agentId: id, prompt });
          return { text: result.text, sessionId: result.sessionId, agentId: id };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(`agent-tool "${id}" failed: ${message}`);
          return { error: message, agentId: id };
        }
      },
    });
  }

  return tools;
}
