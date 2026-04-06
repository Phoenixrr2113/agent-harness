import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeDefaultConfig } from '../core/config.js';

const DIRECTORIES = [
  'rules',
  'instincts',
  'skills',
  'playbooks',
  'workflows',
  'tools',
  'agents',
  'intake',
  'memory/sessions',
  'memory/journal',
];

/**
 * Resolve the package root directory by walking up from import.meta.url
 * until we find package.json. Works in both dev (src/) and prod (dist/).
 */
function getPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  // Fallback: assume 2 levels up from source
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/**
 * Apply template variables to a string.
 */
function applyTemplate(content: string, agentName: string): string {
  const date = new Date().toISOString().split('T')[0];
  return content
    .replace(/\{\{AGENT_NAME\}\}/g, agentName)
    .replace(/\{\{DATE\}\}/g, date);
}

/**
 * Copy default primitives from defaults/ directory into the target harness.
 */
function copyDefaults(targetDir: string, agentName: string): void {
  const defaultsDir = join(getPackageRoot(), 'defaults');
  if (!existsSync(defaultsDir)) return;

  const primitiveDirs = ['rules', 'instincts', 'skills', 'playbooks', 'agents'];
  for (const dir of primitiveDirs) {
    const srcDir = join(defaultsDir, dir);
    if (!existsSync(srcDir)) continue;
    const files = readdirSync(srcDir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const content = readFileSync(join(srcDir, file), 'utf-8');
      writeFileSync(join(targetDir, dir, file), applyTemplate(content, agentName), 'utf-8');
    }
  }
}

/**
 * Load a template file and apply substitutions. Returns null if not found.
 */
function loadTemplate(templateName: string, fileName: string, agentName: string): string | null {
  const templatePath = join(getPackageRoot(), 'templates', templateName, fileName);
  if (!existsSync(templatePath)) return null;
  return applyTemplate(readFileSync(templatePath, 'utf-8'), agentName);
}

export interface ScaffoldOptions {
  template?: string;
}

export function scaffoldHarness(targetDir: string, agentName: string, options?: ScaffoldOptions): void {
  if (existsSync(targetDir)) {
    throw new Error(`Directory already exists: ${targetDir}`);
  }

  const template = options?.template ?? 'base';

  // Create directory structure
  mkdirSync(targetDir, { recursive: true });
  for (const dir of DIRECTORIES) {
    mkdirSync(join(targetDir, dir), { recursive: true });
  }

  // --- CORE.md (from template, or inline fallback) ---
  const coreContent = loadTemplate(template, 'CORE.md', agentName);
  writeFileSync(
    join(targetDir, 'CORE.md'),
    coreContent ?? `# ${agentName}

## Purpose
I am ${agentName}, an autonomous AI agent. My purpose is to help my creator build, think, and ship.

## Values
- **Honesty**: I tell the truth, even when it's uncomfortable.
- **Action**: I bias toward doing, not discussing.
- **Autonomy**: I act independently within my boundaries.
- **Growth**: I learn from every interaction.
- **Protection**: I guard my creator's time, money, and reputation.

## Ethics
- I never deceive my creator or others.
- I never take irreversible actions without confirmation.
- I never expose secrets, credentials, or private information.
- I escalate when uncertain rather than guessing.
`
  );

  // --- SYSTEM.md (from template, or inline fallback) ---
  const systemContent = loadTemplate(template, 'SYSTEM.md', agentName);
  writeFileSync(
    join(targetDir, 'SYSTEM.md'),
    systemContent ?? `# System

You are ${agentName}. This file defines how you boot and operate.

## Boot Sequence
1. Load CORE.md — your identity (never changes)
2. Load state.md — where you left off
3. Load memory/scratch.md — current working memory
4. Load indexes — scan all primitive directories
5. Load relevant files based on current task

## File Ownership
| Owner | Files | Can Modify |
|-------|-------|------------|
| Human | CORE.md, rules/*, config.yaml | Only human edits |
| Agent | instincts/*, memory/sessions/*, state.md (goals) | During/after interactions |
| Infrastructure | */_index.md, memory/journal/* | Auto-scripts only |

## Context Loading Strategy
- L0 (~5 tokens): One-line summary — decides relevance
- L1 (~50-100 tokens): Paragraph — enough to work with
- L2 (full body): Complete content — loaded only when actively needed
- Always load CORE + state + scratch first
- Load primitives at the appropriate level based on token budget
`
  );

  // --- config.yaml (from template, or use writeDefaultConfig) ---
  const configContent = loadTemplate(template, 'config.yaml', agentName);
  writeFileSync(join(targetDir, 'config.yaml'), configContent ?? writeDefaultConfig(targetDir, agentName));

  // --- state.md ---
  writeFileSync(
    join(targetDir, 'state.md'),
    `# Agent State

## Mode
idle

## Goals

## Active Workflows

## Last Interaction
${new Date().toISOString()}

## Unfinished Business
`
  );

  // --- memory/scratch.md ---
  writeFileSync(join(targetDir, 'memory', 'scratch.md'), '');

  // --- Copy default primitives from defaults/ directory ---
  copyDefaults(targetDir, agentName);

  // --- .gitignore ---
  writeFileSync(
    join(targetDir, '.gitignore'),
    `memory/scratch.md
memory/context.jsonl
memory/context.md
memory/sessions/*
memory/journal/*
!memory/sessions/.gitkeep
!memory/journal/.gitkeep
.env
`
  );

  // Create .gitkeep files
  writeFileSync(join(targetDir, 'memory', 'sessions', '.gitkeep'), '');
  writeFileSync(join(targetDir, 'memory', 'journal', '.gitkeep'), '');
}

/**
 * List available templates.
 */
export function listTemplates(): string[] {
  const templatesDir = join(getPackageRoot(), 'templates');
  if (!existsSync(templatesDir)) return [];
  return readdirSync(templatesDir).filter((f) => {
    try {
      return readdirSync(join(templatesDir, f)).length > 0;
    } catch {
      return false;
    }
  });
}
