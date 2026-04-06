/**
 * Builtin starter workflow packs — installable bundles of workflow files
 * with cron schedules that users can customize after installation.
 *
 * Install via: `harness install pack:<name>`
 * List available: `harness install pack:list`
 */

import type { PackedBundle, BundleManifest, BundleFileEntry } from './primitive-registry.js';

export interface StarterPack {
  name: string;
  description: string;
  tags: string[];
  files: Array<{ path: string; content: string; id: string; l0: string }>;
}

const PACKS: Record<string, StarterPack> = {
  'daily-briefs': {
    name: 'daily-briefs',
    description: 'Morning briefing and evening review workflows — summarize upcoming tasks, review completed work, and plan next steps.',
    tags: ['daily', 'briefing', 'review', 'productivity'],
    files: [
      {
        path: 'workflows/morning-brief.md',
        id: 'morning-brief',
        l0: 'Morning briefing workflow that summarizes recent sessions and plans the day.',
        content: `---
id: morning-brief
tags: [workflow, daily, morning]
author: infrastructure
status: active
schedule: "0 8 * * 1-5"
---
# Morning Brief

Review yesterday's sessions and journal, then produce a concise daily brief.

## Instructions

1. Load the most recent journal entry and any sessions from the last 24 hours.
2. Summarize key accomplishments, open questions, and blockers.
3. List the top 3 priorities for today based on recent activity patterns.
4. Note any instincts or rules that were frequently triggered.
5. Keep the output under 500 words — this is a quick scan, not a deep analysis.

## Output Format

**Yesterday's highlights:**
- [bullet points]

**Today's priorities:**
1. [priority]
2. [priority]
3. [priority]

**Open questions / blockers:**
- [if any]
`,
      },
      {
        path: 'workflows/evening-review.md',
        id: 'evening-review',
        l0: 'Evening review workflow that synthesizes the day and prepares for tomorrow.',
        content: `---
id: evening-review
tags: [workflow, daily, evening, review]
author: infrastructure
status: active
schedule: "0 18 * * 1-5"
---
# Evening Review

Synthesize today's work and prepare handoff notes for tomorrow.

## Instructions

1. Load all sessions from today.
2. Identify what was accomplished vs. what was planned (from morning brief if available).
3. Note any recurring patterns, surprises, or friction points.
4. Suggest 1-2 instinct candidates if behavioral patterns emerge.
5. Write a brief handoff note for tomorrow's morning brief.

## Output Format

**Completed today:**
- [bullet points]

**Planned but not completed:**
- [if any, with reasons]

**Observations:**
- [patterns, friction, surprises]

**Tomorrow's handoff:**
- [brief note for morning brief]
`,
      },
    ],
  },

  'weekly-review': {
    name: 'weekly-review',
    description: 'End-of-week review workflow — analyze the week, compress journals, surface trends, and set goals for next week.',
    tags: ['weekly', 'review', 'retrospective', 'planning'],
    files: [
      {
        path: 'workflows/weekly-review.md',
        id: 'weekly-review',
        l0: 'Weekly review workflow that analyzes the week and sets goals.',
        content: `---
id: weekly-review
tags: [workflow, weekly, review, retrospective]
author: infrastructure
status: active
schedule: "0 17 * * 5"
---
# Weekly Review

Analyze the past week's work, compress journals, and plan next week.

## Instructions

1. Load all journal entries from this week (Monday through today).
2. Identify the top 3-5 themes across the week's work.
3. Note which instincts fired most often and whether they were helpful.
4. Identify any skills or playbooks that were missing or underperforming.
5. Suggest concrete goals for next week (2-3 maximum).
6. Flag any rules that seem outdated or contradictory.

## Output Format

**Week of [date range]**

**Key themes:**
1. [theme with brief explanation]
2. [theme]
3. [theme]

**Instinct effectiveness:**
- [instinct name]: [helpful / needs tuning / remove]

**Gaps identified:**
- [missing skill or playbook suggestion]

**Next week's goals:**
1. [specific, actionable goal]
2. [goal]

**Maintenance notes:**
- [rules to review, primitives to archive, etc.]
`,
      },
    ],
  },

  'code-review': {
    name: 'code-review',
    description: 'Code review workflow — analyzes recent code changes, checks for patterns and anti-patterns, and generates review notes.',
    tags: ['code-review', 'development', 'quality'],
    files: [
      {
        path: 'workflows/code-review.md',
        id: 'code-review-workflow',
        l0: 'Code review workflow that analyzes recent changes and generates review notes.',
        content: `---
id: code-review-workflow
tags: [workflow, code-review, development]
author: infrastructure
status: active
---
# Code Review Workflow

Analyze recent code changes and generate structured review notes.

## Instructions

1. Review the most recent session where code was written or modified.
2. Check for common issues:
   - Missing error handling (empty catches, unhandled promises)
   - Type safety violations (any usage, missing return types)
   - Security concerns (unsanitized input, hardcoded secrets)
   - Code duplication or missed reuse opportunities
3. Check adherence to project rules and instincts.
4. Note positive patterns worth reinforcing as instincts.
5. Generate a structured review with severity levels.

## Output Format

**Review of [session/change description]**

**Critical issues:**
- [severity: high] [description]

**Improvements:**
- [severity: medium] [suggestion]

**Good patterns:**
- [pattern worth keeping / promoting to instinct]

**Summary:**
[1-2 sentence overall assessment]
`,
      },
      {
        path: 'workflows/pr-checklist.md',
        id: 'pr-checklist',
        l0: 'PR checklist workflow that generates a pre-merge review checklist.',
        content: `---
id: pr-checklist
tags: [workflow, code-review, pr, checklist]
author: infrastructure
status: active
---
# PR Checklist

Generate a pre-merge checklist based on project rules and recent changes.

## Instructions

1. Load all active rules from the harness.
2. For each rule category, generate a checklist item.
3. Add standard items: tests pass, no type errors, no lint warnings.
4. Include project-specific checks based on instincts.
5. Output as a copy-pasteable markdown checklist.

## Output Format

**Pre-merge checklist:**

- [ ] All tests pass
- [ ] No TypeScript errors (tsc --noEmit)
- [ ] No lint warnings
- [ ] Error handling: no empty catches, async errors handled
- [ ] Types: no \`any\`, explicit return types on exports
- [ ] Security: no hardcoded secrets, input validated
- [rule-specific items from harness rules]
`,
      },
    ],
  },
};

/**
 * Get a builtin starter pack by name.
 * Returns null if the pack doesn't exist.
 */
export function getStarterPack(name: string): PackedBundle | null {
  const pack = PACKS[name];
  if (!pack) return null;

  const now = new Date().toISOString();
  const fileEntries: BundleFileEntry[] = pack.files.map(f => ({
    path: f.path,
    type: f.path.split('/')[0],
    id: f.id,
    l0: f.l0,
  }));

  const manifest: BundleManifest = {
    version: '1',
    name: `pack:${pack.name}`,
    description: pack.description,
    author: 'agent-harness',
    bundle_version: '1.0.0',
    created: now,
    types: [...new Set(fileEntries.map(f => f.type))],
    tags: pack.tags,
    files: fileEntries,
  };

  return {
    manifest,
    files: pack.files.map(f => ({ path: f.path, content: f.content })),
  };
}

/**
 * List all available builtin starter packs.
 */
export function listStarterPacks(): Array<{ name: string; description: string; fileCount: number; tags: string[] }> {
  return Object.values(PACKS).map(p => ({
    name: p.name,
    description: p.description,
    fileCount: p.files.length,
    tags: p.tags,
  }));
}

/**
 * Check if a source string is a pack reference (starts with "pack:").
 */
export function isPackReference(source: string): boolean {
  return source.startsWith('pack:');
}

/**
 * Parse the pack name from a "pack:<name>" reference.
 */
export function parsePackName(source: string): string {
  return source.slice(5); // Remove "pack:" prefix
}
