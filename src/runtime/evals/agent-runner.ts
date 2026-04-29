import { tool as aiTool, generateText } from 'ai';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../../core/config.js';
import { getModel, getSummaryModel, generateWithAgent } from '../../llm/provider.js';
import { buildActivateSkillTool } from '../skill-activation.js';
import { loadIdentity } from '../context-loader.js';
import type { AIToolSet } from '../tool-executor.js';
import type { TriggerEvalAgentRunner } from './triggers.js';
import type { LlmGrader } from './grading.js';
import type { QualityEvalAgentRunner } from './quality.js';

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

export async function buildLiveQualityEvalRunner(harnessDir: string): Promise<QualityEvalAgentRunner> {
  const config = loadConfig(harnessDir);
  const identity = loadIdentity(harnessDir);

  return async ({ withSkill, prompt, workingDir, skillName }) => {
    const activate = withSkill
      ? buildActivateSkillTool(harnessDir)
      : buildActivateSkillTool(harnessDir, { excludeSkillNames: [skillName] });
    const tools: AIToolSet = {};
    if (activate) {
      tools['activate_skill'] = aiTool({
        description: activate.description,
        inputSchema: activate.inputSchema,
        execute: (input) => activate.execute(input as { name: string; args?: string }),
      });
    }
    const model = getModel(config);
    const start = Date.now();
    const result = await generateWithAgent({
      model,
      system: `${identity.content}\n\nWorking directory: ${workingDir}`,
      prompt,
      tools,
      maxToolSteps: 10,
    });
    const durationMs = Date.now() - start;
    return { usage: result.usage, durationMs };
  };
}

export async function buildLiveLlmGrader(harnessDir: string): Promise<LlmGrader> {
  const config = loadConfig(harnessDir);
  const model = getSummaryModel(config);

  return async ({ assertion, outputDir }) => {
    const files = readdirSync(outputDir).map((f) => {
      const p = join(outputDir, f);
      const st = statSync(p);
      const content = st.size < 8000 && st.isFile() ? readFileSync(p, 'utf-8') : `(${st.size} bytes binary or large)`;
      return `=== ${f} ===\n${content.slice(0, 4000)}`;
    }).join('\n\n');
    const prompt = `Assertion to evaluate: "${assertion}"

Output files in the agent's working directory:
${files}

Reply with EXACTLY this JSON shape (no other text):
{"passed": true|false, "evidence": "1-sentence reason"}`;
    const result = await generateText({
      model,
      system: 'You evaluate whether agent outputs satisfy an assertion. Reply only with the requested JSON.',
      prompt,
    });
    let parsed: { passed: unknown; evidence: unknown };
    try {
      parsed = JSON.parse(result.text);
    } catch {
      return { passed: false, evidence: `Grader returned non-JSON: ${result.text.slice(0, 100)}` };
    }
    return {
      passed: parsed.passed === true,
      evidence: typeof parsed.evidence === 'string' ? parsed.evidence : 'no evidence',
    };
  };
}
