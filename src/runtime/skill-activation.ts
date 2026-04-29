import { z } from 'zod';
import { loadAllPrimitives } from '../primitives/loader.js';
import type { HarnessDocument } from '../core/types.js';

export interface ActivateSkillTool {
  description: string;
  inputSchema: z.ZodTypeAny;
  execute(input: { name: string; args?: string }): Promise<string>;
}

interface SkillState {
  activated: Set<string>;
  skills: Map<string, HarnessDocument>;
}

export interface SkillCatalogOptions {
  excludeSkillNames?: string[];
}

export function getModelInvokableSkills(
  harnessDir: string,
  options: SkillCatalogOptions = {},
): HarnessDocument[] {
  const exclude = new Set(options.excludeSkillNames ?? []);
  const all = loadAllPrimitives(harnessDir);
  const skills = (all.get('skills') ?? []).filter((s) => {
    if (exclude.has(s.name)) return false;
    if (s.status === 'archived' || s.status === 'deprecated') return false;
    const trigger = s.metadata?.['harness-trigger'] as string | undefined;
    const schedule = s.metadata?.['harness-schedule'] as string | undefined;
    if (schedule) return false;
    if (trigger && trigger !== 'subagent') return false;
    return true;
  });
  return skills;
}

function listResources(_skill: HarnessDocument): string[] {
  // Return relative paths to scripts/, references/, assets/ files in the bundle.
  // For now, return empty array; doctor lints would surface them.
  // TODO: list bundle directory contents on demand once that's wired.
  return [];
}

function formatSkillContent(skill: HarnessDocument): string {
  const resources = listResources(skill);
  const resourceXml =
    resources.length > 0
      ? `\n\n<skill_resources>\n${resources.map((r) => `  <file>${r}</file>`).join('\n')}\n</skill_resources>`
      : '';
  const dirHint = skill.bundleDir
    ? `\n\nSkill directory: ${skill.bundleDir}\nRelative paths in this skill are relative to the skill directory.`
    : '';
  return `<skill_content name="${skill.name}">\n${skill.body}${dirHint}${resourceXml}\n</skill_content>`;
}

export function buildActivateSkillTool(
  harnessDir: string,
  options: SkillCatalogOptions = {},
): ActivateSkillTool | null {
  const skills = getModelInvokableSkills(harnessDir, options);
  if (skills.length === 0) return null;

  const skillMap = new Map<string, HarnessDocument>();
  for (const s of skills) skillMap.set(s.name, s);

  const state: SkillState = {
    activated: new Set(),
    skills: skillMap,
  };

  const skillNames = Array.from(skillMap.keys()) as [string, ...string[]];
  const inputSchema = z.object({
    name: z.enum(skillNames),
    args: z.string().optional(),
  });

  return {
    description:
      "Load a skill's full instructions into context. Pass the name of one of the available skills.",
    inputSchema,
    async execute({ name }) {
      if (state.activated.has(name)) {
        return `Skill ${name} is already loaded earlier in this conversation.`;
      }
      state.activated.add(name);
      const skill = state.skills.get(name);
      if (!skill) {
        return `Skill ${name} not found.`;
      }
      // For subagent-trigger skills, run in isolation (deferred — Phase 9 of this plan)
      // For now, regular skills return wrapped content.
      return formatSkillContent(skill);
    },
  };
}
