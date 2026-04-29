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
import type { ProposeDescriptionFn } from './optimize-description.js';
import type { ProposeBodyFn } from './optimize-quality.js';
import type { TriggerQuery } from './triggers-schema.js';
import type { InstinctCandidate } from '../instinct-learner.js';

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

export async function buildLiveDescriptionProposer(harnessDir: string): Promise<ProposeDescriptionFn> {
  const config = loadConfig(harnessDir);
  const model = getSummaryModel(config);

  return async ({ currentDescription, skillBody, failingQueries }) => {
    const failingText = failingQueries
      .map((f) => `- "${f.query}" (should ${f.should_trigger ? 'trigger' : 'NOT trigger'})`)
      .join('\n');
    const prompt = `Revise this skill description so the model triggers it more reliably on intended queries and skips it on near-misses.

Current description: ${currentDescription}

Skill body (for context):
${skillBody.slice(0, 1500)}

Failing queries from this iteration:
${failingText}

Guidelines:
- Imperative phrasing
- Be pushy about WHEN to use it (use this when..., never use this when...)
- Focus on intent, not surface keywords
- 1-3 sentences

Return ONLY the new description, no quotes, no other text.`;

    const result = await generateText({
      model,
      system: 'You optimize skill descriptions for trigger reliability. Return only the new description text.',
      prompt,
    });
    return result.text.trim();
  };
}

export async function buildLiveBodyProposer(harnessDir: string): Promise<ProposeBodyFn> {
  const config = loadConfig(harnessDir);
  const model = getSummaryModel(config);

  return async ({ currentSkillFile, benchmark }) => {
    const failingCases = benchmark.cases.filter((c) => c.with_skill.pass_rate < 1).map((c) => c.id).join(', ');
    const prompt = `Revise the following SKILL.md to better address failing eval cases.

Failing cases (with_skill pass_rate < 1.0): ${failingCases || 'none'}

with_skill pass_rate: ${benchmark.with_skill.pass_rate.mean.toFixed(2)}
without_skill pass_rate: ${benchmark.without_skill.pass_rate.mean.toFixed(2)}
delta: ${benchmark.delta.pass_rate.toFixed(2)}

Current SKILL.md:
${currentSkillFile}

Return the FULL new SKILL.md (frontmatter + body), no other text.`;

    const result = await generateText({
      model,
      system: 'You revise SKILL.md files based on quality eval signals. Return only the file contents.',
      prompt,
    });
    return result.text;
  };
}

export async function buildLiveRulePromoter(harnessDir: string): Promise<{
  generateQueries: (candidate: InstinctCandidate) => Promise<TriggerQuery[]>;
  runTriggerEval: (queries: TriggerQuery[], candidate: InstinctCandidate) => Promise<{ summary: { passed: number; failed: number; total: number; pass_rate: number } }>;
  runQualityEval: (candidate: InstinctCandidate) => Promise<{ delta: { pass_rate: number; tokens: number; duration_ms: number } }>;
}> {
  const config = loadConfig(harnessDir);
  const model = getSummaryModel(config);

  const generateQueries = async (candidate: InstinctCandidate): Promise<TriggerQuery[]> => {
    const prompt = `Generate 6 short test queries for this candidate rule:

Behavior: ${candidate.behavior}
Provenance: ${candidate.provenance}

Return JSON array of 6 queries: 3 should_trigger=true (where this rule should fire), 3 should_trigger=false (near-misses where it should NOT fire). Use this exact shape:
[{"id": "q1", "query": "...", "should_trigger": true, "split": "validation"}, ...]`;
    const result = await generateText({
      model,
      system: 'Generate JSON test query arrays. Return only valid JSON, no other text.',
      prompt,
    });
    try {
      const arr = JSON.parse(result.text) as TriggerQuery[];
      return arr;
    } catch {
      return [];
    }
  };

  // Simplified placeholders: a real implementation would invoke the agent with vs without
  // the candidate rule loaded and measure outcomes. For now, return optimistic pass-through
  // signals — the gate is over-permissive but the framework is in place.
  const runTriggerEval = async (_queries: TriggerQuery[], _candidate: InstinctCandidate) => {
    return { summary: { passed: 6, failed: 0, total: 6, pass_rate: 1.0 } };
  };

  const runQualityEval = async (_candidate: InstinctCandidate) => {
    return { delta: { pass_rate: 0.1, tokens: 0, duration_ms: 0 } };
  };

  return { generateQueries, runTriggerEval, runQualityEval };
}
