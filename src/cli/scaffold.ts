import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeDefaultConfig } from '../core/config.js';

const DIRECTORIES = [
  'rules',
  'skills',
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

interface TemplateVars {
  agentName: string;
  purpose?: string;
}

/**
 * Apply template variables to a string.
 */
function applyTemplate(content: string, vars: TemplateVars): string {
  const date = new Date().toISOString().split('T')[0];
  const defaultPurpose = `I am ${vars.agentName}, an autonomous AI agent. My purpose is to help my creator build, think, and ship.`;
  const purpose = vars.purpose
    ? `I am ${vars.agentName}. ${vars.purpose}`
    : defaultPurpose;
  return content
    .replace(/\{\{AGENT_NAME\}\}/g, vars.agentName)
    .replace(/\{\{PURPOSE\}\}/g, purpose)
    .replace(/\{\{DATE\}\}/g, date);
}

/**
 * Recursively copy a directory, applying template variable substitution to
 * every .md file encountered. Non-.md files are copied verbatim.
 */
function copyDirRecursive(srcDir: string, destDir: string, vars: TemplateVars): void {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const srcPath = join(srcDir, entry);
    const destPath = join(destDir, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath, vars);
    } else if (entry.endsWith('.md')) {
      const content = readFileSync(srcPath, 'utf-8');
      writeFileSync(destPath, applyTemplate(content, vars), 'utf-8');
    } else {
      writeFileSync(destPath, readFileSync(srcPath));
    }
  }
}

/**
 * Copy markdown primitives from a source directory into a target harness.
 * Handles both flat .md files and bundle directories (e.g. skills/research/).
 * Existing files at the destination are overwritten.
 */
function copyPrimitivesFrom(srcRoot: string, targetDir: string, vars: TemplateVars): void {
  if (!existsSync(srcRoot)) return;
  const primitiveDirs = ['rules', 'skills'];
  for (const dir of primitiveDirs) {
    const srcDir = join(srcRoot, dir);
    if (!existsSync(srcDir)) continue;
    for (const entry of readdirSync(srcDir)) {
      const srcPath = join(srcDir, entry);
      const destPath = join(targetDir, dir, entry);
      if (statSync(srcPath).isDirectory()) {
        // Bundle directory — copy recursively with template substitution
        copyDirRecursive(srcPath, destPath, vars);
      } else if (entry.endsWith('.md')) {
        // Flat .md file — copy with template substitution
        const content = readFileSync(srcPath, 'utf-8');
        writeFileSync(destPath, applyTemplate(content, vars), 'utf-8');
      }
    }
  }
}

/**
 * Copy default primitives into the target harness from defaults/ and then from
 * templates/<name>/defaults/, with template-level files overriding defaults
 * of the same name.
 */
function copyDefaults(targetDir: string, templateName: string, vars: TemplateVars): void {
  const root = getPackageRoot();
  copyPrimitivesFrom(join(root, 'defaults'), targetDir, vars);
  copyPrimitivesFrom(join(root, 'templates', templateName, 'defaults'), targetDir, vars);
}

/**
 * Load a template file and apply substitutions. Returns null if not found.
 */
function loadTemplate(templateName: string, fileName: string, vars: TemplateVars): string | null {
  const templatePath = join(getPackageRoot(), 'templates', templateName, fileName);
  if (!existsSync(templatePath)) return null;
  return applyTemplate(readFileSync(templatePath, 'utf-8'), vars);
}

export interface ScaffoldOptions {
  template?: string;
  /** Custom IDENTITY.md content — overrides template */
  coreContent?: string;
  /** Agent purpose description (stored as comment in IDENTITY.md when no LLM generation) */
  purpose?: string;
}

export function scaffoldHarness(targetDir: string, agentName: string, options?: ScaffoldOptions): void {
  if (existsSync(targetDir)) {
    throw new Error(`Directory already exists: ${targetDir}`);
  }

  const template = options?.template ?? 'base';
  const vars: TemplateVars = { agentName, purpose: options?.purpose };

  // Create directory structure
  mkdirSync(targetDir, { recursive: true });
  for (const dir of DIRECTORIES) {
    mkdirSync(join(targetDir, dir), { recursive: true });
  }

  // --- IDENTITY.md (custom > template > inline fallback) ---
  if (options?.coreContent) {
    writeFileSync(join(targetDir, 'IDENTITY.md'), options.coreContent);
  } else {
    const templateContent = loadTemplate(template, 'IDENTITY.md', vars);
    writeFileSync(
      join(targetDir, 'IDENTITY.md'),
      templateContent ?? applyTemplate(`# {{AGENT_NAME}}

## Purpose
{{PURPOSE}}

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
`, vars)
    );
  }

  // SYSTEM.md is no longer emitted — it is generated content, not authored content.

  // --- config.yaml (from template, or use writeDefaultConfig) ---
  const configContent = loadTemplate(template, 'config.yaml', vars);
  writeFileSync(join(targetDir, 'config.yaml'), configContent ?? writeDefaultConfig(targetDir, agentName));

  // --- memory/state.md ---
  writeFileSync(
    join(targetDir, 'memory', 'state.md'),
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

  copyDefaults(targetDir, template, vars);

  // --- README.md (the in-scaffold quickstart, the FIRST thing a non-coder reads) ---
  writeFileSync(
    join(targetDir, 'README.md'),
    `# ${agentName}

You just created an agent. The agent IS this folder — every file is part
of its identity, behavior, knowledge, and memory.

## Try these in order

\`\`\`bash
harness run "What can you do?"            # see what's loaded
harness run "Help me decide between two options: A or B"
harness run "Plan a weekend project for me"   # watch it qualify before answering
\`\`\`

Use it for a few days with varied prompts. Then:

\`\`\`bash
harness journal              # synthesize today's sessions and find patterns
harness learn --install      # promote learned patterns into agent-authored rules
\`\`\`

The agent gets measurably better the more you use it. Every interaction
is journaled, patterns become agent-authored rules in \`rules/\`, and those
rules change behavior on the next run. **No retraining, no fine-tuning, no code.** You're
editing markdown.

## What's in this folder

| File / dir | Owner | What it is |
|---|---|---|
| \`IDENTITY.md\`    | human | Identity. Who is this agent? Frozen. |
| \`config.yaml\`    | human | Model, runtime, MCP servers, budgets |
| \`memory/state.md\` | mixed | Live state: mode, goals, last interaction |
| \`rules/\`         | mixed | Boundaries (human-authored) and learned reflexes (agent-authored, marked \`author: agent\`) |
| \`skills/\`        | mixed | Capabilities + how to think about using them. Triggers (\`prepare-call\`, \`subagent\`, etc.) and schedules live in \`metadata.harness-trigger\` / \`metadata.harness-schedule\` |
| \`memory/sessions/\` | agent | Auto-captured interaction records |
| \`memory/journal/\`  | infra | Daily synthesized reflections |

Open any file and edit it. Save. Run \`harness run "..."\` again and the
agent reads your change. That's the loop.

## Going further

\`\`\`bash
harness doctor          # check scaffold health
harness graph           # see how primitives reference each other
harness info            # what's loaded in the context budget right now
harness mcp discover    # find MCP tools already installed on your machine
harness mcp search <q>  # browse the MCP registry for new tools
harness install <url>   # install a skill, agent, or rule from a URL
\`\`\`

Tools come from MCP servers — install one with \`harness mcp install\`.

## When something feels off

- \`harness validate\` — check the harness structure for errors
- \`harness doctor\` — same, but auto-fix what it can
- \`harness contradictions\` — check rules for conflicts
- \`harness dead-primitives\` — find files you haven't used in a while

The agent journal in \`memory/journal/\` is the most interesting place
to look — it's where the agent reflects on what you've been doing
together. Read it once a week.
`,
  );

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
.workflow-data/
.env
`
  );

  // Create .gitkeep files
  writeFileSync(join(targetDir, 'memory', 'sessions', '.gitkeep'), '');
  writeFileSync(join(targetDir, 'memory', 'journal', '.gitkeep'), '');
}

/**
 * Generate SYSTEM.md content from the actual directory structure of a harness.
 * Scans for primitives and reflects the real structure.
 */
export function generateSystemMd(harnessDir: string, agentName: string): string {
  const primitiveDirs = ['rules', 'skills'];
  const sections: string[] = [];

  sections.push(`# System\n`);
  sections.push(`You are ${agentName}. This file defines how you boot and operate.\n`);

  // Boot sequence
  sections.push(`## Boot Sequence
1. Load IDENTITY.md — your identity (never changes)
2. Load memory/state.md — where you left off
3. Load memory/scratch.md — current working memory
4. Load indexes — scan all primitive directories
5. Load relevant files based on current task\n`);

  // Directory structure
  sections.push(`## Directory Structure\n`);

  for (const dir of primitiveDirs) {
    const dirPath = join(harnessDir, dir);
    if (!existsSync(dirPath)) continue;

    // Collect both flat .md files and bundle directories (treated as named primitives)
    const entries = readdirSync(dirPath).filter((f) => !f.startsWith('_'));
    const names: string[] = [];
    for (const entry of entries) {
      const entryPath = join(dirPath, entry);
      if (statSync(entryPath).isDirectory()) {
        names.push(entry);
      } else if (entry.endsWith('.md')) {
        names.push(entry.replace('.md', ''));
      }
    }
    if (names.length === 0) {
      sections.push(`- \`${dir}/\` — (empty)`);
    } else {
      sections.push(`- \`${dir}/\` — ${names.length} file(s): ${names.join(', ')}`);
    }
  }

  // Memory
  const sessionsDir = join(harnessDir, 'memory', 'sessions');
  const journalDir = join(harnessDir, 'memory', 'journal');
  const sessionCount = existsSync(sessionsDir)
    ? readdirSync(sessionsDir).filter((f) => f.endsWith('.md')).length
    : 0;
  const journalCount = existsSync(journalDir)
    ? readdirSync(journalDir).filter((f) => f.endsWith('.md')).length
    : 0;

  sections.push(`- \`memory/sessions/\` — ${sessionCount} session(s)`);
  sections.push(`- \`memory/journal/\` — ${journalCount} entry/entries`);
  sections.push('');

  // File ownership
  sections.push(`## File Ownership
| Owner | Files | Can Modify |
|-------|-------|------------|
| Human | IDENTITY.md, rules/* (without \`author: agent\`), skills/*, config.yaml | Only human edits |
| Agent | rules/* (with \`author: agent\`), memory/sessions/*, memory/state.md (goals) | During/after interactions |
| Infrastructure | */_index.md, memory/journal/* | Auto-scripts only |\n`);

  // Context loading strategy
  sections.push(`## Context Loading Strategy
- L0 (~5 tokens): One-line summary — decides relevance
- L1 (~50-100 tokens): Paragraph — enough to work with
- L2 (full body): Complete content — loaded only when actively needed
- Always load CORE + state + scratch first
- Load primitives at the appropriate level based on token budget
`);

  return sections.join('\n');
}

/**
 * Generate a rich IDENTITY.md using an LLM, given an agent name and purpose description.
 * Returns the generated markdown content, or throws on failure.
 */
export async function generateCoreMd(
  agentName: string,
  purpose: string,
  options: { provider?: string; modelId?: string; apiKey?: string },
): Promise<string> {
  try {
    const { generate, getModel } = await import('../llm/provider.js');
    const { HarnessConfigSchema } = await import('../core/types.js');

    const config = HarnessConfigSchema.parse({
      agent: { name: agentName, version: '0.1.0' },
      model: {
        provider: options.provider ?? 'openrouter',
        id: options.modelId ?? 'anthropic/claude-sonnet-4',
      },
    });

    const model = getModel(config, options.apiKey);
    const result = await generate({
      model,
      system: `You are a technical writer creating an identity document for an AI agent.
The document defines who the agent is, what it does, its values, and its ethical boundaries.
Write in first person from the agent's perspective. Be specific and practical, not generic.
Output ONLY the markdown content, no code fences.`,
      prompt: `Create an IDENTITY.md document for an AI agent with:
- Name: ${agentName}
- Purpose: ${purpose}

The document should have these sections:
# ${agentName}

## Purpose
(Detailed purpose based on the description — be specific to what this agent does)

## Values
(5-7 values tailored to this agent's purpose — not generic platitudes)

## Ethics
(4-6 ethical boundaries specific to this agent's domain)

## Capabilities
(3-5 key capabilities this agent should have based on its purpose)

## Boundaries
(3-5 things this agent should NOT do or areas where it should escalate)`,
      maxOutputTokens: 2000,
      maxRetries: 1,
      timeoutMs: 30000,
    });

    return result.text.trim();
  } catch (err: unknown) {
    if (err instanceof Error) throw err;
    throw new Error(String(err));
  }
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

export interface DetectedProvider {
  provider: 'claude' | 'codex' | 'cursor' | 'copilot' | 'gemini' | 'agents';
  evidencePath: string;
}

export function detectExistingProviders(projectRoot: string): DetectedProvider[] {
  const results: DetectedProvider[] = [];
  const checks: Array<[string, DetectedProvider['provider']]> = [
    ['.claude', 'claude'],
    ['.codex', 'codex'],
    ['.cursor', 'cursor'],
    ['.gemini', 'gemini'],
    ['.agents', 'agents'],
  ];
  for (const [rel, provider] of checks) {
    if (existsSync(join(projectRoot, rel))) {
      results.push({ provider, evidencePath: join(projectRoot, rel) });
    }
  }
  if (existsSync(join(projectRoot, '.github', 'copilot-instructions.md'))) {
    results.push({ provider: 'copilot', evidencePath: join(projectRoot, '.github', 'copilot-instructions.md') });
  } else if (existsSync(join(projectRoot, '.github', 'instructions'))) {
    results.push({ provider: 'copilot', evidencePath: join(projectRoot, '.github', 'instructions') });
  }
  // Single-file conventions — only register if not already detected from a directory
  for (const file of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    if (existsSync(join(projectRoot, file))) {
      const provider: DetectedProvider['provider'] =
        file === 'CLAUDE.md' ? 'claude' :
        file === 'GEMINI.md' ? 'gemini' : 'agents';
      if (!results.find((r) => r.provider === provider)) {
        results.push({ provider, evidencePath: join(projectRoot, file) });
      }
    }
  }
  return results;
}

export interface SubdirectoryDecision {
  useSubdirectory: boolean;
  reason: string;
  subdirName: string;
}

/**
 * If the project root has any pre-existing harness-relevant single files
 * (AGENTS.md, CLAUDE.md, GEMINI.md), the harness should scaffold into a
 * subdirectory rather than overwrite the root.
 */
export function decideScaffoldLocation(projectRoot: string): SubdirectoryDecision {
  const sentinels = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
  for (const f of sentinels) {
    if (existsSync(join(projectRoot, f))) {
      return { useSubdirectory: true, reason: `${f} already present`, subdirName: '.harness' };
    }
  }
  return { useSubdirectory: false, reason: 'no existing harness sentinels', subdirName: '' };
}
