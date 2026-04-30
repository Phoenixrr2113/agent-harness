/**
 * Skill picker — interactive multi-select prompt + metadata for shipped skills.
 *
 * Used by `harness init` to let the user choose which default skills to
 * scaffold into their new harness. The default-checked set is the four
 * "superpowers" skills that make an agent useful out of the box (plan, execute,
 * brainstorm, parallel-coordinate); everything else is opt-in.
 */
import { checkbox, Separator } from '@inquirer/prompts';

/** Shipped skills that get pre-checked in the interactive picker AND are the
 *  non-interactive default when no `--skills` flag is passed. */
export const DEFAULT_SKILLS: readonly string[] = [
  'brainstorming',
  'writing-plans',
  'executing-plans',
  'dispatching-parallel-agents',
] as const;

interface SkillEntry {
  /** Skill directory name in `defaults/skills/<name>/`. Must match `name:` in SKILL.md frontmatter. */
  id: string;
  /** Short one-liner shown in the picker (NOT the full SKILL.md description — too long). */
  short: string;
  /** Group label — controls Separator placement in the picker. */
  group: 'default' | 'planning' | 'methodology' | 'role' | 'cli-delegation' | 'example';
}

/**
 * The catalog. Order within a group is the display order in the picker.
 * Adding a new shipped skill: append here, choose its group, write a short
 * one-liner. Removing a shipped skill: also remove its directory under
 * `defaults/skills/`.
 */
export const SHIPPED_SKILLS: readonly SkillEntry[] = [
  // Default — the four superpowers skills, pre-checked.
  { id: 'brainstorming', group: 'default', short: 'Turn ideas into specs through dialogue' },
  { id: 'writing-plans', group: 'default', short: 'Write detailed implementation plans' },
  { id: 'executing-plans', group: 'default', short: 'Execute plans task-by-task' },
  { id: 'dispatching-parallel-agents', group: 'default', short: 'Coordinate multiple subagents in parallel' },

  // Planning / methodology — useful for many agents but not universal.
  { id: 'planner', group: 'planning', short: 'Decompose ambiguous tasks into ordered plans' },
  { id: 'research', group: 'planning', short: 'Find primary sources, verify, deliver recommendations' },
  { id: 'ship-feature', group: 'methodology', short: 'End-to-end feature delivery methodology' },
  { id: 'summarizer', group: 'methodology', short: 'Condense long text into bullet points' },

  // Reflection / journal — opt-in (some agents won't use the journal loop).
  { id: 'daily-reflection', group: 'methodology', short: 'End-of-day journal synthesis (scheduled 18:00)' },
  { id: 'delegate-to-cli', group: 'methodology', short: 'Hand bounded subtasks to a local CLI agent' },

  // Role-prompts — domain-specific.
  { id: 'business-analyst', group: 'role', short: 'BI / dashboards / KPI strategy' },
  { id: 'content-marketer', group: 'role', short: 'SEO / social / content distribution' },

  // CLI delegation stubs — only useful if the user has those CLIs installed.
  { id: 'ask-claude', group: 'cli-delegation', short: 'Delegate to local claude CLI (requires Claude subscription)' },
  { id: 'ask-codex', group: 'cli-delegation', short: 'Delegate to local codex CLI (requires ChatGPT subscription)' },
  { id: 'ask-gemini', group: 'cli-delegation', short: 'Delegate to local gemini CLI (requires Gemini subscription)' },

  // Examples / templates — for reference, not intended to ship in user agents.
  { id: 'example-web-search', group: 'example', short: 'Template for HTTP-tool skills (copy and adapt)' },
];

const GROUP_LABELS: Record<SkillEntry['group'], string> = {
  default: '— Default — agent uses these out of the box',
  planning: '— Planning',
  methodology: '— Methodology / journal',
  role: '— Role prompts (domain-specific)',
  'cli-delegation': '— CLI delegation (requires those CLIs installed)',
  example: '— Examples / templates',
};

/** Display order for the groups in the picker. */
const GROUP_ORDER: readonly SkillEntry['group'][] = [
  'default',
  'planning',
  'methodology',
  'role',
  'cli-delegation',
  'example',
];

/**
 * Show the multi-select prompt and return the user's selection.
 * Throws if stdin is not a TTY (caller should check first).
 */
export async function promptForSkills(): Promise<string[]> {
  // Build choices grouped by section, with a Separator label per group.
  const choices: Array<Separator | { name: string; value: string; checked?: boolean }> = [];
  for (const group of GROUP_ORDER) {
    const inGroup = SHIPPED_SKILLS.filter((s) => s.group === group);
    if (inGroup.length === 0) continue;
    choices.push(new Separator(GROUP_LABELS[group]));
    for (const skill of inGroup) {
      // Pad the id so the short descriptions align in the terminal.
      const padded = skill.id.padEnd(28);
      choices.push({
        name: `${padded} ${skill.short}`,
        value: skill.id,
        checked: DEFAULT_SKILLS.includes(skill.id),
      });
    }
  }

  return checkbox({
    message: 'Which skills do you want? (space to toggle, a to toggle all, enter to confirm)',
    choices,
    pageSize: choices.length, // show everything; the list is ~22 lines
  });
}

/**
 * Resolve the `--skills` CLI flag to a concrete selection.
 *
 * Accepts:
 *   - `'all'`  → every shipped skill
 *   - `'none'` → empty array
 *   - `'a,b,c'` (comma- or space-separated) → those exact ids
 *
 * Throws if any id in the list isn't a known shipped skill.
 */
export function parseSkillsFlag(flag: string): string[] | 'all' {
  const trimmed = flag.trim();
  if (trimmed === 'all') return 'all';
  if (trimmed === 'none' || trimmed === '') return [];
  const ids = trimmed.split(/[,\s]+/).filter((s) => s.length > 0);
  const known = new Set(SHIPPED_SKILLS.map((s) => s.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    const knownList = SHIPPED_SKILLS.map((s) => s.id).join(', ');
    throw new Error(
      `Unknown skill(s): ${unknown.join(', ')}\nKnown skills: ${knownList}\nUse \`harness init <name> --skills all\` for everything, or \`--skills none\` for none.`,
    );
  }
  return ids;
}
