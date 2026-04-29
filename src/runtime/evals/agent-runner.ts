import { tool as aiTool } from 'ai';
import { loadConfig } from '../../core/config.js';
import { getModel, generateWithAgent } from '../../llm/provider.js';
import { buildActivateSkillTool } from '../skill-activation.js';
import { loadIdentity } from '../context-loader.js';
import type { AIToolSet } from '../tool-executor.js';
import type { TriggerEvalAgentRunner } from './triggers.js';

export async function buildLiveTriggerEvalRunner(harnessDir: string): Promise<TriggerEvalAgentRunner> {
  const config = loadConfig(harnessDir);
  const identity = loadIdentity(harnessDir);

  return async ({ query, skillName: _skillName }) => {
    const activate = buildActivateSkillTool(harnessDir);
    const tools: AIToolSet = {};
    if (activate) {
      tools['activate_skill'] = aiTool({
        description: activate.description,
        inputSchema: activate.inputSchema,
        execute: (input) => activate.execute(input as { name: string; args?: string }),
      });
    }
    const model = getModel(config);
    const result = await generateWithAgent({
      model,
      system: identity.content,
      prompt: query,
      tools,
      maxToolSteps: 5,
    });
    return {
      toolCalls: result.toolCalls.map((tc) => ({
        toolName: tc.toolName,
        args: tc.args,
        result: tc.result,
      })),
      usage: result.usage,
      steps: result.steps,
      text: result.text,
    };
  };
}
