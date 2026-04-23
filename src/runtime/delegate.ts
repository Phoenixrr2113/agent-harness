import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { loadDirectory, estimateTokens, getAtLevel } from '../primitives/loader.js';
import { loadConfig } from '../core/config.js';
import { log } from '../core/logger.js';
import {
  getModel,
  getSummaryModel,
  getFastModel,
  generate,
  streamGenerateWithDetails,
} from '../llm/provider.js';
import { buildToolSet } from './tool-executor.js';
import { createSessionId, writeSession, type SessionRecord } from './sessions.js';
import type { HarnessDocument, HarnessConfig } from '../core/types.js';

// --- Types ---

export interface DelegationResult {
  agentId: string;
  text: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  sessionId: string;
}

export interface AgentInfo {
  id: string;
  l0: string;
  l1: string;
  path: string;
  tags: string[];
  status: string;
}

// --- Agent Discovery ---

/**
 * Load all agent documents from the agents/ directory.
 */
export function loadAgentDocs(harnessDir: string): HarnessDocument[] {
  return loadDirectory(join(harnessDir, 'agents'));
}

/**
 * Find an agent document by its frontmatter id.
 * Falls back to filename match if id doesn't match.
 */
export function findAgent(harnessDir: string, agentId: string): HarnessDocument | undefined {
  const agents = loadAgentDocs(harnessDir);

  // Exact id match
  const byId = agents.find((a) => a.frontmatter.id === agentId);
  if (byId) return byId;

  // Try with "agent-" prefix
  const prefixed = agents.find((a) => a.frontmatter.id === `agent-${agentId}`);
  if (prefixed) return prefixed;

  // Filename match (e.g., "evaluator" matches "evaluator.md")
  const byFilename = agents.find((a) => {
    const filename = a.path.split('/').pop()?.replace('.md', '') || '';
    return filename === agentId || filename === `agent-${agentId}`;
  });

  return byFilename;
}

/**
 * List all available agents with summary info.
 */
export function listAgents(harnessDir: string): AgentInfo[] {
  return loadAgentDocs(harnessDir).map((doc) => ({
    id: doc.frontmatter.id,
    l0: doc.l0,
    l1: doc.l1,
    path: doc.path,
    tags: doc.frontmatter.tags,
    status: doc.frontmatter.status,
  }));
}

// --- System Prompt Assembly ---

/**
 * Build a minimal system prompt for a delegated agent.
 * Sub-agents are stateless — they get:
 * 1. The agent's own body (L2) as primary instructions
 * 2. CORE.md identity (so they know who they serve)
 * 3. Active rules (at L1 level — compressed for efficiency)
 */
export function buildAgentPrompt(harnessDir: string, agentDoc: HarnessDocument, config: HarnessConfig): string {
  const sections: string[] = [];
  const maxTokens = config.model.max_tokens;
  const targetBudget = maxTokens * 0.10; // Sub-agents get 10% context budget
  let usedTokens = 0;

  // 1. Agent identity and instructions (always full L2)
  const agentBody = agentDoc.body;
  sections.push(`# AGENT: ${agentDoc.frontmatter.id}\n\n${agentBody}`);
  usedTokens += estimateTokens(agentBody);

  // 2. Primary agent identity from CORE.md (brief context)
  const corePath = join(harnessDir, 'CORE.md');
  if (existsSync(corePath)) {
    const core = readFileSync(corePath, 'utf-8');
    const coreTokens = estimateTokens(core);
    if (usedTokens + coreTokens <= targetBudget) {
      sections.push(`# PRIMARY AGENT CONTEXT\n\n${core}`);
      usedTokens += coreTokens;
    }
  }

  // 3. Rules (at appropriate disclosure level based on remaining budget)
  const rulesDir = join(harnessDir, 'rules');
  if (existsSync(rulesDir)) {
    const rules = loadDirectory(rulesDir);
    if (rules.length > 0) {
      const ruleDocs: string[] = [];
      for (const rule of rules) {
        // Estimate how much room is left
        const remaining = targetBudget - usedTokens;
        if (remaining < 50) break;

        // Try L1 first, fall back to L0
        let level: 0 | 1 | 2 = 1;
        let content = getAtLevel(rule, level);
        let tokens = estimateTokens(content);

        if (usedTokens + tokens > targetBudget) {
          level = 0;
          content = getAtLevel(rule, 0);
          tokens = estimateTokens(content);
        }

        if (usedTokens + tokens <= targetBudget) {
          ruleDocs.push(`### ${rule.frontmatter.id}\n${content}`);
          usedTokens += tokens;
        }
      }
      if (ruleDocs.length > 0) {
        sections.push(`# RULES\n\n${ruleDocs.join('\n\n')}`);
      }
    }
  }

  return sections.join('\n\n---\n\n');
}

// --- Delegation ---

export interface DelegateOptions {
  harnessDir: string;
  agentId: string;
  prompt: string;
  apiKey?: string;
  modelOverride?: string;
}

function prepareDelegation(opts: DelegateOptions) {
  const { harnessDir, agentId, apiKey } = opts;

  if (!agentId || !agentId.trim()) {
    throw new Error('agentId is required');
  }
  if (!opts.prompt || !opts.prompt.trim()) {
    throw new Error('prompt cannot be empty');
  }

  const agentDoc = findAgent(harnessDir, agentId);
  if (!agentDoc) {
    const available = listAgents(harnessDir);
    const agentList = available.length > 0
      ? available.map((a) => `  - ${a.id}: ${a.l0}`).join('\n')
      : '  (none)';
    throw new Error(
      `Agent "${agentId}" not found.\n\nAvailable agents:\n${agentList}`
    );
  }

  const config = loadConfig(harnessDir, opts.modelOverride
    ? { model: { id: opts.modelOverride } }
    : undefined);

  const systemPrompt = buildAgentPrompt(harnessDir, agentDoc, config);

  // Sub-agent may declare `model: primary | summary | fast` in its
  // frontmatter to route the delegated LLM call to a different config
  // model than `harness run` uses. Defaults to 'primary' (same as
  // today's behavior). Resolves via the existing provider helpers:
  //
  //   primary → config.model.id                      (always set)
  //   summary → config.model.summary_model           (falls back to primary)
  //   fast    → config.model.fast_model              (falls back to summary → primary)
  //
  // Invalid values throw a clear error at delegation time.
  const modelTier = (agentDoc.frontmatter as { model?: string }).model ?? 'primary';
  let model;
  let resolvedModelId: string;
  switch (modelTier) {
    case 'primary':
      model = getModel(config, apiKey);
      resolvedModelId = config.model.id;
      break;
    case 'summary':
      model = getSummaryModel(config, apiKey);
      resolvedModelId = config.model.summary_model ?? config.model.id;
      log.debug(
        `[delegate] agent "${agentDoc.frontmatter.id}" using summary model tier → ${resolvedModelId}`,
      );
      break;
    case 'fast':
      model = getFastModel(config, apiKey);
      resolvedModelId = config.model.fast_model ?? config.model.summary_model ?? config.model.id;
      log.debug(
        `[delegate] agent "${agentDoc.frontmatter.id}" using fast model tier → ${resolvedModelId}`,
      );
      break;
    default:
      throw new Error(
        `Agent "${agentDoc.frontmatter.id}" declares model: "${modelTier}" ` +
          `which is not valid. Allowed values: primary, summary, fast.`,
      );
  }

  const toolSet = buildToolSet(harnessDir, { includeAgentTools: false });
  const hasTools = Object.keys(toolSet).length > 0;

  return { agentDoc, config, systemPrompt, model, resolvedModelId, toolSet, hasTools };
}

/**
 * Delegate a prompt to a sub-agent.
 * Sub-agents are stateless single-turn executors. They:
 * - Receive their own body as system prompt + rules + CORE.md
 * - Execute a single prompt
 * - Record a session (tagged with the agent id)
 * - Return the result
 *
 * They do NOT have persistent state, memory, or learning.
 */
export async function delegateTo(opts: DelegateOptions): Promise<DelegationResult> {
  const { harnessDir, prompt } = opts;
  const { agentDoc, config, systemPrompt, model, resolvedModelId, toolSet, hasTools } = prepareDelegation(opts);

  const sessionId = createSessionId();
  const started = new Date().toISOString();

  const activeTools = (agentDoc.frontmatter as { active_tools?: string[] }).active_tools;
  const result = await generate({
    model,
    system: systemPrompt,
    prompt,
    maxRetries: config.model.max_retries,
    timeoutMs: config.model.timeout_ms,
    ...(hasTools ? { tools: toolSet, maxToolSteps: 25, ...(activeTools ? { activeTools } : {}) } : {}),
  });

  const ended = new Date().toISOString();

  const session: SessionRecord = {
    id: sessionId,
    started,
    ended,
    prompt,
    summary: result.text.slice(0, 200),
    tokens_used: result.usage.totalTokens,
    model_id: resolvedModelId,
    delegated_to: agentDoc.frontmatter.id,
    steps: result.steps,
    tool_calls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
  };

  try {
    writeSession(harnessDir, session);
  } catch (err) {
    log.warn(`Failed to write delegation session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    agentId: agentDoc.frontmatter.id,
    text: result.text,
    usage: result.usage,
    sessionId,
  };
}

export interface DelegateStreamResult {
  agentId: string;
  sessionId: string;
  textStream: AsyncIterable<string>;
}

/**
 * Stream-delegate a prompt to a sub-agent.
 * Returns an async iterable of text chunks. Session is recorded after
 * the stream is fully consumed.
 */
export function delegateStream(opts: DelegateOptions): DelegateStreamResult {
  const { harnessDir, prompt } = opts;

  // prepareDelegation() is called eagerly so callers get immediate errors
  // (e.g., agent not found) before consuming the stream.
  const { agentDoc, config, systemPrompt, model, resolvedModelId, toolSet, hasTools } = prepareDelegation(opts);

  const sessionId = createSessionId();
  const started = new Date().toISOString();

  const activeTools = (agentDoc.frontmatter as { active_tools?: string[] }).active_tools;
  const result = streamGenerateWithDetails({
    model,
    system: systemPrompt,
    prompt,
    maxRetries: config.model.max_retries,
    timeoutMs: config.model.timeout_ms,
    ...(hasTools ? { tools: toolSet, maxToolSteps: 25, ...(activeTools ? { activeTools } : {}) } : {}),
  });

  async function* wrappedStream(): AsyncIterable<string> {
    let fullText = '';
    try {
      for await (const chunk of result.textStream) {
        fullText += chunk;
        yield chunk;
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.warn(`Delegation stream error for agent "${agentDoc.frontmatter.id}": ${error.message}`);
      throw error;
    }

    // Await post-stream metadata — wrapped so failures don't crash the generator
    let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let steps = 1;
    let toolCalls: Array<{ toolName: string; args: Record<string, unknown>; result: unknown }> = [];
    try {
      [usage, steps, toolCalls] = await Promise.all([
        result.usage,
        result.steps,
        result.toolCalls,
      ]);
    } catch (err) {
      log.warn(`Failed to resolve delegation post-stream metadata: ${err instanceof Error ? err.message : String(err)}`);
    }

    const ended = new Date().toISOString();

    const session: SessionRecord = {
      id: sessionId,
      started,
      ended,
      prompt,
      summary: fullText.slice(0, 200),
      tokens_used: usage.totalTokens,
      model_id: resolvedModelId,
      delegated_to: agentDoc.frontmatter.id,
      steps,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    };

    try {
      writeSession(harnessDir, session);
    } catch (err) {
      log.warn(`Failed to write delegation session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    agentId: agentDoc.frontmatter.id,
    sessionId,
    textStream: wrappedStream(),
  };
}
