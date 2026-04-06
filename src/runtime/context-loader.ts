import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { loadAllPrimitives, estimateTokens, getAtLevel, parseHarnessDocument } from '../primitives/loader.js';
import type { HarnessConfig, HarnessDocument, ContextBudget } from '../core/types.js';

interface LoadedContext {
  systemPrompt: string;
  budget: ContextBudget;
}

export function buildSystemPrompt(harnessDir: string, config: HarnessConfig): LoadedContext {
  const maxTokens = config.model.max_tokens;
  const budget: ContextBudget = {
    max_tokens: maxTokens,
    used_tokens: 0,
    remaining: maxTokens,
    loaded_files: [],
  };

  const sections: string[] = [];

  // --- Step 1: Load CORE.md (always, full content) ---
  const corePath = join(harnessDir, 'CORE.md');
  if (existsSync(corePath)) {
    const core = readFileSync(corePath, 'utf-8');
    sections.push(`# CORE IDENTITY\n\n${core}`);
    budget.used_tokens += estimateTokens(core);
    budget.loaded_files.push('CORE.md');
  }

  // --- Step 2: Load state.md ---
  const statePath = join(harnessDir, 'state.md');
  if (existsSync(statePath)) {
    const state = readFileSync(statePath, 'utf-8');
    sections.push(`# CURRENT STATE\n\n${state}`);
    budget.used_tokens += estimateTokens(state);
    budget.loaded_files.push('state.md');
  }

  // --- Step 3: Load SYSTEM.md (boot instructions) ---
  const systemPath = join(harnessDir, 'SYSTEM.md');
  if (existsSync(systemPath)) {
    const system = readFileSync(systemPath, 'utf-8');
    sections.push(`# SYSTEM\n\n${system}`);
    budget.used_tokens += estimateTokens(system);
    budget.loaded_files.push('SYSTEM.md');
  }

  // --- Step 4: Load all primitives at appropriate level ---
  const primitives = loadAllPrimitives(harnessDir);
  const targetBudget = maxTokens * 0.15; // Use 15% of context for harness

  // Priority order for loading primitives
  const priorityOrder = ['rules', 'instincts', 'skills', 'playbooks', 'tools', 'workflows', 'agents'];

  // Collect all docs to estimate total demand before deciding levels
  const allDocs: { category: string; doc: HarnessDocument }[] = [];
  for (const category of priorityOrder) {
    const docs = primitives.get(category);
    if (!docs || docs.length === 0) continue;
    for (const doc of docs) {
      allDocs.push({ category, doc });
    }
  }

  // Estimate total L2 demand vs available budget for primitives
  const primitiveBudget = targetBudget - budget.used_tokens;
  let totalL2Demand = 0;
  for (const { doc } of allDocs) {
    totalL2Demand += estimateTokens(getAtLevel(doc, 2));
  }

  // Choose a global disclosure level based on how much fits
  let globalLevel: 0 | 1 | 2;
  if (totalL2Demand <= primitiveBudget) {
    globalLevel = 2; // Everything fits at full
  } else {
    // Estimate L1 demand
    let totalL1Demand = 0;
    for (const { doc } of allDocs) {
      totalL1Demand += estimateTokens(getAtLevel(doc, 1));
    }
    globalLevel = totalL1Demand <= primitiveBudget ? 1 : 0;
  }

  for (const category of priorityOrder) {
    const docs = primitives.get(category);
    if (!docs || docs.length === 0) continue;

    const categoryLabel = category.toUpperCase();
    const categoryDocs: string[] = [];

    for (const doc of docs) {
      // Start from global level, fall back if this doc would exceed budget
      let level = globalLevel;
      let content = getAtLevel(doc, level);
      let tokens = estimateTokens(content);

      while (budget.used_tokens + tokens > targetBudget && level > 0) {
        level = (level - 1) as 0 | 1;
        content = getAtLevel(doc, level);
        tokens = estimateTokens(content);
      }

      categoryDocs.push(`### ${doc.frontmatter.id}\n${content}`);
      budget.used_tokens += tokens;
      budget.loaded_files.push(doc.path);
    }

    if (categoryDocs.length > 0) {
      sections.push(`# ${categoryLabel}\n\n${categoryDocs.join('\n\n')}`);
    }
  }

  // --- Step 5: Load scratch.md if exists ---
  const scratchPath = join(harnessDir, 'memory', 'scratch.md');
  if (existsSync(scratchPath)) {
    const scratch = readFileSync(scratchPath, 'utf-8');
    if (scratch.trim()) {
      sections.push(`# SCRATCH (Current Working Memory)\n\n${scratch}`);
      budget.used_tokens += estimateTokens(scratch);
      budget.loaded_files.push('memory/scratch.md');
    }
  }

  budget.remaining = maxTokens - budget.used_tokens;

  return {
    systemPrompt: sections.join('\n\n---\n\n'),
    budget,
  };
}
