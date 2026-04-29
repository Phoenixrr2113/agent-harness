import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { loadAllPrimitives, loadAllPrimitivesWithErrors, estimateTokens } from '../primitives/loader.js';
import type { ParseError } from '../primitives/loader.js';
import type { HarnessConfig, ContextBudget } from '../core/types.js';
import { log } from '../core/logger.js';

export interface LoadedContext {
  systemPrompt: string;
  budget: ContextBudget;
  parseErrors: ParseError[];
  warnings: string[];
}

export interface IdentityLoadResult {
  content: string;
  source: 'IDENTITY.md' | 'CORE.md' | 'none';
}

/**
 * Load the agent's identity file. Prefers IDENTITY.md (the canonical name as of
 * 2026-04-28). Falls back to CORE.md with a deprecation warning. If both exist,
 * IDENTITY.md wins and CORE.md is reported as ignored.
 */
export function loadIdentity(harnessDir: string): IdentityLoadResult {
  const identityPath = join(harnessDir, 'IDENTITY.md');
  const corePath = join(harnessDir, 'CORE.md');

  const hasIdentity = existsSync(identityPath);
  const hasCore = existsSync(corePath);

  if (hasIdentity) {
    if (hasCore) {
      console.error(
        `[deprecation] Both IDENTITY.md and CORE.md found at ${harnessDir}. CORE.md is being ignored. Delete CORE.md or run \`harness doctor --migrate\` to clean up.`
      );
    }
    return { content: readFileSync(identityPath, 'utf-8'), source: 'IDENTITY.md' };
  }

  if (hasCore) {
    console.error(
      `[deprecation] CORE.md is deprecated at ${harnessDir}. Rename to IDENTITY.md or run \`harness doctor --migrate\`.`
    );
    return { content: readFileSync(corePath, 'utf-8'), source: 'CORE.md' };
  }

  // Neither IDENTITY.md nor CORE.md exists. The agent will operate with no
  // identity grounding, which is rarely what the user wants — surface this
  // loudly. (D11)
  console.error(
    `[warning] No IDENTITY.md found at ${harnessDir}. The agent will boot with an empty identity. ` +
    `Create IDENTITY.md (or run \`harness init\` to scaffold one) before relying on this harness.`,
  );
  return { content: '', source: 'none' };
}

/**
 * Build the system prompt using the Agent Skills three-tier model:
 *
 * 1. Identity — IDENTITY.md (or CORE.md fallback) loaded full body, wrapped in <identity>.
 * 2. Rules — every active rule loaded full body, wrapped in <rules>, alphabetical by name.
 * 3. State — memory/state.md content if present, wrapped in <state>.
 * 4. Skill catalog — name + description + location for model-invokable skills only, wrapped
 *    in <available_skills>. Skills with a lifecycle harness-trigger (not 'subagent') or a
 *    harness-schedule are excluded — the harness fires them, not the model.
 *
 * Sections are separated by blank lines. Sections with no content are omitted.
 */
export function buildSystemPrompt(harnessDir: string, config: HarnessConfig): string {
  const sections: string[] = [];

  // 1. Identity — always loaded full body
  const identity = loadIdentity(harnessDir);
  if (identity.content) {
    sections.push(`<identity>\n${identity.content}\n</identity>`);
  }

  // 2. Rules — always loaded full body, alphabetical by name
  const allPrimitives = loadAllPrimitives(harnessDir);
  const rules = (allPrimitives.get('rules') ?? [])
    .filter((r) => r.status !== 'archived' && r.status !== 'deprecated')
    .sort((a, b) => a.name.localeCompare(b.name));
  if (rules.length > 0) {
    const rulesBlock = rules.map((r) => `## ${r.name}\n\n${r.body}`).join('\n\n');
    sections.push(`<rules>\n${rulesBlock}\n</rules>`);
  }

  // 3. State — current runtime state if available
  const statePath = canonicalStatePath(harnessDir);
  const legacyPath = join(harnessDir, 'state.md');
  const resolvedStatePath = existsSync(statePath)
    ? statePath
    : existsSync(legacyPath)
      ? legacyPath
      : null;
  if (resolvedStatePath) {
    const stateContent = readFileSync(resolvedStatePath, 'utf-8');
    if (stateContent.trim()) {
      sections.push(`<state>\n${stateContent}\n</state>`);
    }
  }

  // 4. Skill catalog — name + description + location for model-invokable skills.
  //    Lifecycle-triggered skills (harness-trigger !== 'subagent') and
  //    scheduled skills (harness-schedule set) are excluded — the harness fires
  //    them, not the model.
  const skills = (allPrimitives.get('skills') ?? [])
    .filter((s) => s.status !== 'archived' && s.status !== 'deprecated')
    .filter((s) => {
      const trigger = s.metadata?.['harness-trigger'] as string | undefined;
      const schedule = s.metadata?.['harness-schedule'] as string | undefined;
      if (schedule) return false;
      if (trigger && trigger !== 'subagent') return false;
      return true;
    });
  if (skills.length > 0) {
    const catalog = skills
      .map(
        (s) =>
          `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description ?? ''}</description>\n    <location>${s.path}</location>\n  </skill>`
      )
      .join('\n');
    sections.push(
      `<available_skills>\n${catalog}\n</available_skills>\n\nWhen a task matches a skill's description, call the activate_skill tool with the skill's name to load its full instructions.`
    );
  }

  return sections.join('\n\n');
}

function canonicalStatePath(harnessDir: string): string {
  return join(harnessDir, 'memory', 'state.md');
}

/**
 * Build the system prompt and collect budget/parse-error metadata for callers
 * that need it (harness.ts boot log, conversation.ts token tracking, validator,
 * CLI `harness context` command).
 *
 * The system-prompt string is built by `buildSystemPrompt`. Budget numbers are
 * approximated from the resulting string — no per-primitive tracking is needed
 * because the new three-tier model is not token-budget-driven.
 */
export function buildLoadedContext(harnessDir: string, config: HarnessConfig): LoadedContext {
  const maxTokens = config.model?.max_tokens ?? 200000;

  const { errors: parseErrors } = loadAllPrimitivesWithErrors(
    harnessDir,
    config.extensions?.directories ?? []
  );

  const warnings: string[] = [];

  if (parseErrors.length > 0) {
    for (const pe of parseErrors) {
      log.warn(`Failed to parse primitive: ${pe.path} — ${pe.error}`);
    }
    warnings.push(`${parseErrors.length} primitive file(s) failed to parse`);
  }

  const systemPrompt = buildSystemPrompt(harnessDir, config);
  const used_tokens = estimateTokens(systemPrompt);

  // Collect loaded file paths for the boot log
  const loaded_files: string[] = [];
  const identity = loadIdentity(harnessDir);
  if (identity.source !== 'none') loaded_files.push(identity.source);

  const statePath = canonicalStatePath(harnessDir);
  const legacyPath = join(harnessDir, 'state.md');
  if (existsSync(statePath)) loaded_files.push('memory/state.md');
  else if (existsSync(legacyPath)) loaded_files.push('state.md');

  const allPrimitives = loadAllPrimitives(harnessDir);
  for (const [, docs] of allPrimitives) {
    for (const doc of docs) {
      loaded_files.push(doc.path);
    }
  }

  const usagePercent = (used_tokens / maxTokens) * 100;
  if (usagePercent > 12) {
    warnings.push(
      `System prompt using ${usagePercent.toFixed(1)}% of total context ` +
        `(${used_tokens}/${maxTokens} tokens) — some primitives may be truncated`
    );
    log.warn(
      `Context budget high: ${used_tokens}/${maxTokens} tokens ` +
        `(${usagePercent.toFixed(1)}%), ${loaded_files.length} files loaded`
    );
  }

  const budget: ContextBudget = {
    max_tokens: maxTokens,
    used_tokens,
    remaining: maxTokens - used_tokens,
    loaded_files,
  };

  return { systemPrompt, budget, parseErrors, warnings };
}

export interface ProjectContextRule {
  name: string;
  description: string;
  body: string;
  status: 'active';
  source: string;
}

/**
 * If the harness is scaffolded inside a subdirectory and the project root
 * has an AGENTS.md / CLAUDE.md / GEMINI.md, load it as a synthetic rule
 * named `project-context` so the harness's agent sees the project's
 * existing guidance.
 *
 * Returns null if no such file exists. Wiring this into the runtime context
 * (so it appears in the agent's system prompt) is a follow-up; this helper
 * is just the loader.
 */
export function loadProjectContextRule(harnessDir: string): ProjectContextRule | null {
  const projectRoot = dirname(harnessDir);
  const candidates = [
    join(projectRoot, 'AGENTS.md'),
    join(projectRoot, 'CLAUDE.md'),
    join(projectRoot, 'GEMINI.md'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      const body = readFileSync(path, 'utf-8');
      return {
        name: 'project-context',
        description: 'Project-level guidance from the host project',
        body,
        status: 'active',
        source: path,
      };
    }
  }
  return null;
}
