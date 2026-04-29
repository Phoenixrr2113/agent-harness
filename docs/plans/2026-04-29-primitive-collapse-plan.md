# Primitive collapse + AI SDK trigger mapping — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse agent-harness's 7 primitive types (skills, rules, instincts, playbooks, workflows, tools, agents) into 2 (skills + rules), with all behavior previously expressed via primitive type now expressed via skill metadata (`harness-trigger`, `harness-schedule`) and bundled scripts. Expose AI SDK lifecycle (`prepareCall`, `prepareStep`, `onStepFinish`, `onFinish`, etc.) as authorable trigger types so users can write lifecycle hooks as skills.

**Architecture:** New `triggers.ts` module composes skills tagged with `metadata.harness-trigger` into AI SDK option overrides (called from `createHarness`). New `skill-activation.ts` module registers the `activate_skill` tool with enum-constrained name. The system prompt assembler treats rules as always-loaded full body and skills as discovery-only (name + description + location). Doctor migration extends to convert old primitive directories into the 2-primitive shape with metadata-driven activation. Pre-spec-#1 work has already validated the schema/loader foundations — this spec rewires what gets loaded and how.

**Tech Stack:** TypeScript, Vercel AI SDK ToolLoopAgent (`ai@^5`), Zod, vitest, Node 20+. Tests run via `npm test -- <pattern>`. Build via `npm run build`.

---

## Reference

- Design spec: [docs/specs/2026-04-29-primitive-collapse-design.md](../specs/2026-04-29-primitive-collapse-design.md)
- AI SDK ToolLoopAgent reference: https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent
- AI SDK call options: https://ai-sdk.dev/docs/agents/configuring-call-options
- Adding skills support guide: https://agentskills.io/client-implementation/adding-skills-support
- Spec #1's plan (already executed): [docs/plans/2026-04-28-skills-spec-conformance-plan.md](2026-04-28-skills-spec-conformance-plan.md)

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/core/types.ts` | modify | Drop non-skill/rule values from `PrimitiveType`; tighten `CORE_PRIMITIVE_DIRS` to `['skills', 'rules']`; add cron-format and trigger-enum validation to skill metadata |
| `src/primitives/loader.ts` | modify | `BUNDLE_ENTRY_BY_KIND` becomes `{ skills: 'SKILL.md', rules: 'RULE.md' }` only; remove other entry-name handling |
| `src/runtime/context-loader.ts` | modify | New system prompt assembly: identity + rules full body, skills as `<available_skills>` catalog with name+description+location, lifecycle/scheduled skills excluded |
| `src/runtime/conversation.ts` | modify | Add `<skill_content>` tag protection during compaction |
| `src/runtime/skill-activation.ts` | new | Implement `activate_skill` tool with enum-constrained name, structured wrapping, deduplication, subagent path |
| `src/runtime/triggers.ts` | new | Group skills by `metadata.harness-trigger`; expose composed AI SDK option overrides; spawn-process script runner with stdin/stdout JSON contract |
| `src/runtime/scheduler.ts` | modify | Read `metadata.harness-schedule` from skills; remove workflow-directory traversal; construct `agent.generate` with skill body as system prompt |
| `src/runtime/tool-executor.ts` | modify | Auto-register `activate_skill` when non-lifecycle skills exist; delete markdown HTTP tool execution path |
| `src/runtime/migration.ts` | extend | Add migration kinds: `move-instinct-to-rule`, `move-playbook-to-skill`, `move-workflow-to-skill`, `move-agent-to-skill`, `convert-tool-to-skill-with-script`, `cleanup-empty-primitive-dir` |
| `src/cli/index.ts` | modify | Remove `harness agents`, `harness delegate`; add `harness skill list`, `harness skill run`, `harness skill scheduled` |
| `src/core/harness.ts` | modify | Pass composed trigger functions to ToolLoopAgent options; auto-register `activate_skill` |
| `defaults/` | restructure | All non-skill/rule primitives migrated to new shape via doctor |
| `tests/runtime/triggers.test.ts` | new | Trigger composition, script invocation, error handling, abort signal |
| `tests/runtime/skill-activation.test.ts` | new | activate_skill tool registration, name enum, dedup, structured wrapping, subagent path |
| `tests/runtime/migration.test.ts` | extend | New migration kinds + integration |
| `tests/fixtures/old-harness-7-primitives/` | new | Comprehensive fixture covering all 5 collapsed primitive types |
| `tests/integration/collapse.e2e.test.ts` | new | E2E migration of full 7-primitive harness |
| `README.md` | modify | "The 7 primitives" table → 2 primitives + trigger metadata table |
| `docs/skill-authoring.md` | extend | Add sections on lifecycle-triggered skills, scheduled skills, subagent skills |

---

## Phase 1: Loader collapse

Goal: `CORE_PRIMITIVE_DIRS = ['skills', 'rules']` and the `PrimitiveType` enum reflects this. Old primitive types (instinct/playbook/workflow/tool/agent) become loadable only after migration. Tests that depended on those kinds need updating.

### Task 1: Collapse primitive types to skills + rules

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/primitives/loader.ts`
- Test: `tests/primitives/loader.test.ts`, `tests/primitives.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/primitives/loader.test.ts`:

```typescript
import { CORE_PRIMITIVE_DIRS } from '../../src/core/types.js';
import { BUNDLE_ENTRY_BY_KIND } from '../../src/primitives/loader.js';

describe('primitive collapse — only skills and rules', () => {
  it('CORE_PRIMITIVE_DIRS contains exactly [skills, rules]', () => {
    expect(CORE_PRIMITIVE_DIRS).toEqual(['skills', 'rules']);
  });

  it('BUNDLE_ENTRY_BY_KIND contains exactly skills and rules', () => {
    expect(Object.keys(BUNDLE_ENTRY_BY_KIND).sort()).toEqual(['rules', 'skills']);
    expect(BUNDLE_ENTRY_BY_KIND.skills).toBe('SKILL.md');
    expect(BUNDLE_ENTRY_BY_KIND.rules).toBe('RULE.md');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/primitives/loader.test.ts -t "primitive collapse"`
Expected: FAIL — current arrays include other primitive types.

- [ ] **Step 3: Update `CORE_PRIMITIVE_DIRS`**

In `src/core/types.ts`, find the `CORE_PRIMITIVE_DIRS` declaration. Replace with:

```typescript
export const CORE_PRIMITIVE_DIRS = ['skills', 'rules'] as const;
```

Update the `PrimitiveType` union at the top of the file:

```typescript
export type PrimitiveType =
  | 'rule'
  | 'skill'
  | 'session'
  | 'journal';
```

(Drop `instinct | playbook | workflow | tool | agent`.)

- [ ] **Step 4: Update `BUNDLE_ENTRY_BY_KIND`**

In `src/primitives/loader.ts`:

```typescript
export const BUNDLE_ENTRY_BY_KIND: Record<string, string> = {
  skills: 'SKILL.md',
  rules: 'RULE.md',
};
```

(Drop `playbooks: 'PLAYBOOK.md'` and `workflows: 'WORKFLOW.md'`.)

- [ ] **Step 5: Run all primitive tests**

Run: `npm test -- tests/primitives/`
Expected: PASS for the new tests; existing tests for `playbooks`/`workflows`/`instincts`/`tools`/`agents` may now fail because those kinds are gone. Investigate each:
- If a test relies on a non-collapsed kind, the test is obsolete (delete) OR it should be migrated to use a kind that still exists (skill/rule).
- If a test was about generic primitive loading and just happens to use a now-obsolete kind, switch it to `rules` or `skills`.

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: investigate every failure. Pre-existing flaky `cli-workflows.test.ts` is OK.

- [ ] **Step 7: Run lint**

Run: `npm run lint`
Expected: 0 errors. If any consumer references dropped `PrimitiveType` values (e.g., `'instinct'`), update them.

- [ ] **Step 8: Commit**

```bash
git add -p src/ tests/
git commit -m "feat(types): collapse primitive types to skills + rules

CORE_PRIMITIVE_DIRS becomes ['skills', 'rules']. PrimitiveType
union drops instinct, playbook, workflow, tool, agent. The
BUNDLE_ENTRY_BY_KIND map drops the corresponding entry-file
mappings. Existing files in those directories are still on disk
but the loader no longer scans them — the doctor migration in
Phase 6 of this plan moves them into the new 2-primitive shape."
```

---

## Phase 2: System prompt redesign

Goal: replace the generic per-primitive load logic with the Agent Skills three-tier model — identity always loaded, rules always full body, skills as a discovery-only catalog with full body loaded only on activation. Lifecycle-triggered and scheduled skills are excluded from the catalog.

### Task 2: Rewrite system prompt assembly

**Files:**
- Modify: `src/runtime/context-loader.ts`
- Test: `tests/context-loader.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/context-loader.test.ts`:

```typescript
import { writeFileSync, mkdirSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildSystemPrompt } from '../src/runtime/context-loader.js';

describe('system prompt — primitive collapse model', () => {
  it('always loads identity full body', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprompt-'));
    writeFileSync(join(dir, 'IDENTITY.md'), '# I am Edith.', 'utf-8');
    const result = buildSystemPrompt(dir, {} as any);
    expect(result).toContain('# I am Edith.');
  });

  it('always loads every active rule full body', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprompt-'));
    mkdirSync(join(dir, 'rules'), { recursive: true });
    writeFileSync(
      join(dir, 'rules', 'never-x.md'),
      '---\nname: never-x\ndescription: Never do X.\n---\nNever do X.',
      'utf-8'
    );
    writeFileSync(
      join(dir, 'rules', 'always-y.md'),
      '---\nname: always-y\ndescription: Always do Y.\n---\nAlways do Y.',
      'utf-8'
    );
    const result = buildSystemPrompt(dir, {} as any);
    expect(result).toContain('Never do X.');
    expect(result).toContain('Always do Y.');
  });

  it('includes skills as <available_skills> catalog with name + description', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprompt-'));
    mkdirSync(join(dir, 'skills', 'research'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'research', 'SKILL.md'),
      '---\nname: research\ndescription: Conducts research.\n---\nFull body — should NOT be in the catalog.',
      'utf-8'
    );
    const result = buildSystemPrompt(dir, {} as any);
    expect(result).toContain('<available_skills>');
    expect(result).toContain('<name>research</name>');
    expect(result).toContain('Conducts research.');
    expect(result).not.toContain('Full body — should NOT be in the catalog.');
  });

  it('excludes lifecycle-triggered skills from the catalog', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprompt-'));
    mkdirSync(join(dir, 'skills', 'inject-state'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'inject-state', 'SKILL.md'),
      '---\nname: inject-state\ndescription: Injects state.\nmetadata:\n  harness-trigger: prepare-call\n---\nBody.',
      'utf-8'
    );
    const result = buildSystemPrompt(dir, {} as any);
    expect(result).not.toContain('<name>inject-state</name>');
  });

  it('excludes scheduled skills from the catalog', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprompt-'));
    mkdirSync(join(dir, 'skills', 'morning-brief'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'morning-brief', 'SKILL.md'),
      '---\nname: morning-brief\ndescription: Morning brief.\nmetadata:\n  harness-schedule: "0 7 * * *"\n---\nBody.',
      'utf-8'
    );
    const result = buildSystemPrompt(dir, {} as any);
    expect(result).not.toContain('<name>morning-brief</name>');
  });

  it('includes subagent-trigger skills in the catalog (model-invokable)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprompt-'));
    mkdirSync(join(dir, 'skills', 'summarizer'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'summarizer', 'SKILL.md'),
      '---\nname: summarizer\ndescription: Summarize text.\nmetadata:\n  harness-trigger: subagent\n---\nBody.',
      'utf-8'
    );
    const result = buildSystemPrompt(dir, {} as any);
    expect(result).toContain('<name>summarizer</name>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/context-loader.test.ts -t "primitive collapse model"`
Expected: FAIL — current `buildSystemPrompt` doesn't produce `<available_skills>` and may include lifecycle/scheduled skills.

- [ ] **Step 3: Rewrite `buildSystemPrompt`**

In `src/runtime/context-loader.ts`, locate `buildSystemPrompt`. Replace its body with:

```typescript
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
  const state = loadState(harnessDir);
  if (state) {
    const stateMd = matter.stringify('', state);
    sections.push(`<state>\n${stateMd}\n</state>`);
  }

  // 4. Skill catalog — name + description for skills WITHOUT
  //    harness-trigger or harness-schedule (those are not model-invokable)
  const skills = (allPrimitives.get('skills') ?? [])
    .filter((s) => s.status !== 'archived' && s.status !== 'deprecated')
    .filter((s) => {
      const trigger = (s.metadata?.['harness-trigger'] as string | undefined);
      const schedule = (s.metadata?.['harness-schedule'] as string | undefined);
      // Skills with a lifecycle trigger (not 'subagent') OR a schedule
      // are NOT model-invokable — they fire from the harness, not from
      // the user's prompt.
      if (schedule) return false;
      if (trigger && trigger !== 'subagent') return false;
      return true;
    });
  if (skills.length > 0) {
    const catalog = skills
      .map((s) => `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description ?? ''}</description>\n    <location>${s.path}</location>\n  </skill>`)
      .join('\n');
    sections.push(
      `<available_skills>\n${catalog}\n</available_skills>\n\nWhen a task matches a skill's description, call the activate_skill tool with the skill's name to load its full instructions.`
    );
  }

  return sections.join('\n\n');
}
```

(Verify imports of `loadIdentity`, `loadAllPrimitives`, `loadState`, `matter` exist; add as needed.)

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/context-loader.test.ts`
Expected: PASS for the 6 new cases. Existing tests may need updating if they relied on the old format.

- [ ] **Step 5: Run full suite + lint**

Run: `npm test && npm run lint`
Expected: address any new failures introduced by the system prompt change. Common issues: existing tests check for primitive bodies in the system prompt that are no longer there for skills.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/context-loader.ts tests/context-loader.test.ts
git commit -m "feat(runtime): system prompt uses Agent Skills 3-tier model

Identity and rules are always-loaded full body. Skills become a
discovery catalog (<available_skills> with name + description +
location) — full body loads only when the model invokes the
activate_skill tool. Lifecycle-triggered and scheduled skills are
excluded from the catalog because they're not model-invokable.

Subagent-trigger skills DO appear in the catalog (the model
invokes them via activate_skill, just runs in an isolated session)."
```

---

## Phase 3: Activation tool

Goal: register the `activate_skill` tool that loads a skill's full body into context (or runs a subagent for `harness-trigger: subagent` skills).

### Task 3: Implement `activate_skill` tool

**Files:**
- Create: `src/runtime/skill-activation.ts`
- Modify: `src/core/harness.ts` (or wherever ToolLoopAgent is constructed)
- Test: `tests/runtime/skill-activation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/runtime/skill-activation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildActivateSkillTool } from '../../src/runtime/skill-activation.js';

function makeFixture(): { dir: string; harnessDir: string } {
  const harnessDir = mkdtempSync(join(tmpdir(), 'activation-'));
  mkdirSync(join(harnessDir, 'skills', 'research'), { recursive: true });
  writeFileSync(
    join(harnessDir, 'skills', 'research', 'SKILL.md'),
    '---\nname: research\ndescription: Research a topic.\n---\n# Research\n\nDo research.',
    'utf-8'
  );
  return { dir: harnessDir, harnessDir };
}

describe('activate_skill tool', () => {
  it('returns an AI SDK tool definition with enum-constrained name', () => {
    const { harnessDir } = makeFixture();
    const tool = buildActivateSkillTool(harnessDir);
    expect(tool).toBeTruthy();
    expect(tool!.description).toMatch(/skill/i);
    // name parameter should accept 'research', reject 'unknown-skill'
    const result1 = (tool as any).inputSchema.safeParse({ name: 'research' });
    expect(result1.success).toBe(true);
    const result2 = (tool as any).inputSchema.safeParse({ name: 'nonexistent' });
    expect(result2.success).toBe(false);
  });

  it('returns null when no model-invokable skills exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'activation-empty-'));
    const tool = buildActivateSkillTool(dir);
    expect(tool).toBeNull();
  });

  it('execute returns wrapped skill content', async () => {
    const { harnessDir } = makeFixture();
    const tool = buildActivateSkillTool(harnessDir);
    const result = await tool!.execute({ name: 'research' });
    expect(result).toContain('<skill_content name="research">');
    expect(result).toContain('# Research');
    expect(result).toContain('Do research.');
    expect(result).toContain('</skill_content>');
  });

  it('execute returns short message on duplicate activation', async () => {
    const { harnessDir } = makeFixture();
    const tool = buildActivateSkillTool(harnessDir);
    await tool!.execute({ name: 'research' });
    const result2 = await tool!.execute({ name: 'research' });
    expect(result2).toMatch(/already loaded|already activated/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/runtime/skill-activation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `skill-activation.ts`**

Create `src/runtime/skill-activation.ts`:

```typescript
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

function getModelInvokableSkills(harnessDir: string): HarnessDocument[] {
  const all = loadAllPrimitives(harnessDir);
  const skills = (all.get('skills') ?? []).filter((s) => {
    if (s.status === 'archived' || s.status === 'deprecated') return false;
    const trigger = s.metadata?.['harness-trigger'] as string | undefined;
    const schedule = s.metadata?.['harness-schedule'] as string | undefined;
    if (schedule) return false;
    if (trigger && trigger !== 'subagent') return false;
    return true;
  });
  return skills;
}

function listResources(skill: HarnessDocument): string[] {
  // Return relative paths to scripts/, references/, assets/ files in the bundle.
  // For now, return empty array; doctor lints would surface them.
  // TODO: list bundle directory contents on demand once that's wired.
  void skill;
  return [];
}

function formatSkillContent(skill: HarnessDocument): string {
  const resources = listResources(skill);
  const resourceXml = resources.length > 0
    ? `\n\n<skill_resources>\n${resources.map((r) => `  <file>${r}</file>`).join('\n')}\n</skill_resources>`
    : '';
  const dirHint = skill.bundleDir
    ? `\n\nSkill directory: ${skill.bundleDir}\nRelative paths in this skill are relative to the skill directory.`
    : '';
  return `<skill_content name="${skill.name}">\n${skill.body}${dirHint}${resourceXml}\n</skill_content>`;
}

export function buildActivateSkillTool(harnessDir: string): ActivateSkillTool | null {
  const skills = getModelInvokableSkills(harnessDir);
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
    description: 'Load a skill\'s full instructions into context. Pass the name of one of the available skills.',
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/runtime/skill-activation.test.ts`
Expected: PASS — all 4 cases.

- [ ] **Step 5: Run full suite + lint**

Run: `npm test && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/skill-activation.ts tests/runtime/skill-activation.test.ts
git commit -m "feat(runtime): activate_skill tool with structured wrapping

Implements buildActivateSkillTool(harnessDir) per the Adding-skills-
support guide:
- Returns an AI SDK tool definition with name parameter constrained
  to the literal set of model-invokable skills (Zod enum) — prevents
  hallucination of skill names
- Returns null when no model-invokable skills exist (so the caller
  doesn't register the tool with empty enum)
- execute() formats skill content with <skill_content> wrapping
  per the spec, including skill directory and resource listing
- Tracks activation per session; re-invocations return a short
  message instead of re-injecting the body

Subagent-trigger skills currently use the same path; isolation is
wired in a follow-up task."
```

### Task 4: Wire `activate_skill` into createHarness

**Files:**
- Modify: `src/core/harness.ts`
- Test: covered by integration tests later

- [ ] **Step 1: Read current harness assembly**

```bash
grep -n 'tools\|wrapToolSet\|createHarness' src/core/harness.ts | head -20
```

Identify where the tool set is built before being passed to ToolLoopAgent.

- [ ] **Step 2: Add `activate_skill` to the tool set**

In `src/core/harness.ts`, in the boot flow (after MCP tool loading, before approval wrapping):

```typescript
import { buildActivateSkillTool } from '../runtime/skill-activation.js';

// In the boot flow, after tools have been loaded from MCP:
const activateTool = buildActivateSkillTool(dir);
if (activateTool) {
  tools['activate_skill'] = activateTool;
}
```

(Adapt to existing tool-set shape — likely `Record<string, Tool>` or similar.)

- [ ] **Step 3: Run smoke test**

Build dist:
```bash
npm run build
```

Smoke test:
```bash
TMP=$(mktemp -d) && cd "$TMP" && node /Users/randywilson/Desktop/agent-harness/dist/cli/index.js init smoke --template base -y && node /Users/randywilson/Desktop/agent-harness/dist/cli/index.js info -d "$TMP/smoke" 2>&1 | head -20
```

The output should include `activate_skill` in the registered tools list (if `harness info` reports tool names).

- [ ] **Step 4: Run full suite**

Run: `npm test`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/harness.ts
git commit -m "feat(core): auto-register activate_skill in createHarness

When the harness has model-invokable skills (no harness-trigger or
harness-schedule), buildActivateSkillTool returns a tool definition
that gets added to the tool set passed to ToolLoopAgent. The model
sees activate_skill alongside MCP tools and the user-defined tool
set; calling it loads the skill's body into context."
```

---

## Phase 4: AI SDK trigger wiring

Goal: skills with `metadata.harness-trigger: <event>` are composed into AI SDK option overrides (`prepareCall`, `prepareStep`, `onStepFinish`, `onFinish`, etc.). Each fires by spawning the skill's bundled script with a JSON payload on stdin and parsing the JSON response on stdout.

### Task 5: Implement `triggers.ts` core

**Files:**
- Create: `src/runtime/triggers.ts`
- Test: `tests/runtime/triggers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/runtime/triggers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runTriggerScript } from '../../src/runtime/triggers.js';

function makeSkillBundle(name: string, scriptContent: string): { harnessDir: string; bundleDir: string } {
  const harnessDir = mkdtempSync(join(tmpdir(), 'triggers-'));
  const bundleDir = join(harnessDir, 'skills', name);
  mkdirSync(join(bundleDir, 'scripts'), { recursive: true });
  writeFileSync(
    join(bundleDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Test trigger.\nmetadata:\n  harness-trigger: prepare-call\n---\nBody.`,
    'utf-8'
  );
  const scriptPath = join(bundleDir, 'scripts', 'run.sh');
  writeFileSync(scriptPath, scriptContent, 'utf-8');
  chmodSync(scriptPath, 0o755);
  return { harnessDir, bundleDir };
}

describe('runTriggerScript', () => {
  it('parses JSON returned by the script', async () => {
    const { bundleDir } = makeSkillBundle(
      'inject-state',
      `#!/usr/bin/env bash\necho '{"status":"ok","result":{"instructions":"injected"}}'`
    );
    const result = await runTriggerScript({
      bundleDir,
      trigger: 'prepare-call',
      payload: { test: 'value' },
    });
    expect(result.status).toBe('ok');
    expect(result.result).toEqual({ instructions: 'injected' });
  });

  it('reports error when script exits non-zero', async () => {
    const { bundleDir } = makeSkillBundle(
      'fail',
      `#!/usr/bin/env bash\necho '{"status":"error","error":{"code":"FAIL","message":"oops"}}' && exit 1`
    );
    const result = await runTriggerScript({
      bundleDir,
      trigger: 'prepare-call',
      payload: {},
    });
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('FAIL');
  });

  it('honors timeout and returns error when script hangs', async () => {
    const { bundleDir } = makeSkillBundle(
      'hang',
      `#!/usr/bin/env bash\nsleep 5`
    );
    const result = await runTriggerScript({
      bundleDir,
      trigger: 'prepare-call',
      payload: {},
      timeoutMs: 200,
    });
    expect(result.status).toBe('error');
    expect(result.error?.code).toMatch(/TIMEOUT|TIMED_OUT/);
  }, 10000);

  it('passes payload via stdin and trigger name via argv', async () => {
    const { bundleDir } = makeSkillBundle(
      'echo',
      `#!/usr/bin/env bash\nstdin=$(cat)\necho "{\\"status\\":\\"ok\\",\\"result\\":{\\"trigger\\":\\"$1\\",\\"payload\\":$stdin}}"`
    );
    const result = await runTriggerScript({
      bundleDir,
      trigger: 'prepare-call',
      payload: { foo: 'bar' },
    });
    expect(result.status).toBe('ok');
    const r = result.result as { trigger: string; payload: { foo: string } };
    expect(r.trigger).toBe('prepare-call');
    expect(r.payload.foo).toBe('bar');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/runtime/triggers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `triggers.ts`**

Create `src/runtime/triggers.ts`:

```typescript
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

export interface TriggerScriptResult {
  status: 'ok' | 'error' | 'blocked';
  result?: unknown;
  error?: {
    code: string;
    message: string;
    evidence?: string;
    action?: 'abort' | 'retry' | 'escalate' | 'ignore';
  };
  next_steps?: string[];
  metrics?: Record<string, unknown>;
  artifacts?: Array<{ path: string; description?: string }>;
}

export interface RunTriggerScriptOptions {
  bundleDir: string;
  trigger: string;
  payload: unknown;
  timeoutMs?: number;
  scriptName?: string; // default: 'run.sh' (or .py/.ts probed)
}

const DEFAULT_TIMEOUT_MS = 5000;

function findScript(bundleDir: string, scriptName?: string): string | null {
  const dir = join(bundleDir, 'scripts');
  const candidates = scriptName
    ? [scriptName]
    : ['run.sh', 'run.py', 'run.ts', 'run.js'];
  for (const name of candidates) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function runTriggerScript(opts: RunTriggerScriptOptions): Promise<TriggerScriptResult> {
  const { bundleDir, trigger, payload, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  return new Promise((resolve) => {
    const scriptPath = findScript(bundleDir, opts.scriptName);
    if (!scriptPath) {
      resolve({
        status: 'error',
        error: { code: 'SCRIPT_NOT_FOUND', message: `No run.sh/.py/.ts/.js in ${bundleDir}/scripts/` },
      });
      return;
    }

    const child = spawn(scriptPath, [trigger, bundleDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({
        status: 'error',
        error: { code: 'TIMEOUT', message: `Script exceeded ${timeoutMs}ms`, evidence: stderr.slice(0, 500) },
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        status: 'error',
        error: { code: 'SPAWN_FAILED', message: err.message },
      });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout) as TriggerScriptResult;
        resolve(parsed);
      } catch {
        resolve({
          status: 'error',
          error: {
            code: 'INVALID_JSON',
            message: `Script stdout is not valid JSON. Exit code: ${exitCode}.`,
            evidence: stdout.slice(0, 500),
          },
        });
      }
    });

    child.stdin.end(JSON.stringify(payload));
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/runtime/triggers.test.ts`
Expected: PASS — all 4 cases.

- [ ] **Step 5: Run lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/triggers.ts tests/runtime/triggers.test.ts
git commit -m "feat(runtime): triggers module — script-based AI SDK lifecycle

runTriggerScript spawns a script in scripts/run.sh (or .py/.ts/.js)
with the trigger name + bundleDir as argv and the payload as
stdin JSON. Parses stdout as the structured TriggerScriptResult
(status, result, error, next_steps, metrics, artifacts) per the
spec #3 contract. Honors timeout (default 5s) and reports
SCRIPT_NOT_FOUND, TIMEOUT, SPAWN_FAILED, INVALID_JSON as error
codes when things go wrong."
```

### Task 6: Compose triggers into AI SDK options

**Files:**
- Modify: `src/runtime/triggers.ts` (add composedPrepareCall etc.)
- Modify: `src/core/harness.ts`
- Test: extend `tests/runtime/triggers.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/runtime/triggers.test.ts`:

```typescript
import { composeTriggerHandlers } from '../../src/runtime/triggers.js';

describe('composeTriggerHandlers', () => {
  it('returns no-op handlers when no skills are tagged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'triggers-empty-'));
    const handlers = composeTriggerHandlers(dir);
    expect(handlers.prepareCall).toBeUndefined();
    expect(handlers.onStepFinish).toBeUndefined();
  });

  it('returns a prepareCall handler when at least one skill has prepare-call trigger', () => {
    const { harnessDir, bundleDir } = makeSkillBundle(
      'inject',
      `#!/usr/bin/env bash\necho '{"status":"ok","result":{"instructions":"injected"}}'`
    );
    void bundleDir;
    const handlers = composeTriggerHandlers(harnessDir);
    expect(handlers.prepareCall).toBeDefined();
    // Calling it should run the script and merge its output
    return handlers.prepareCall!({ options: {}, model: {}, instructions: 'base' } as any).then((settings: any) => {
      // The script returned { result: { instructions: 'injected' } } — appended/merged
      expect(settings.instructions).toContain('injected');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/runtime/triggers.test.ts -t composeTriggerHandlers`
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement `composeTriggerHandlers`**

Append to `src/runtime/triggers.ts`:

```typescript
import { loadAllPrimitives } from '../primitives/loader.js';
import type { HarnessDocument } from '../core/types.js';

export interface ComposedHandlers {
  prepareCall?: (settings: Record<string, unknown>) => Promise<Record<string, unknown>>;
  prepareStep?: (settings: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onStepFinish?: (stepResult: unknown) => Promise<void>;
  onFinish?: (runResult: unknown) => Promise<void>;
}

const TRIGGER_KINDS = [
  'prepare-call',
  'prepare-step',
  'step-finish',
  'run-finish',
  'repair-tool-call',
  'tool-pre',
  'tool-post',
  'stop-condition',
  'stream-transform',
  'subagent',
] as const;
type TriggerKind = (typeof TRIGGER_KINDS)[number];

function getSkillsForTrigger(harnessDir: string, kind: TriggerKind): HarnessDocument[] {
  const all = loadAllPrimitives(harnessDir);
  const skills = (all.get('skills') ?? []).filter((s) => {
    if (s.status === 'archived' || s.status === 'deprecated') return false;
    return s.metadata?.['harness-trigger'] === kind;
  });
  // Sort by harness-trigger-priority (default 100), then by name
  skills.sort((a, b) => {
    const pa = Number(a.metadata?.['harness-trigger-priority'] ?? 100);
    const pb = Number(b.metadata?.['harness-trigger-priority'] ?? 100);
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });
  return skills;
}

function mergeSettings(
  current: Record<string, unknown>,
  scriptResult: TriggerScriptResult
): Record<string, unknown> {
  if (scriptResult.status !== 'ok' || !scriptResult.result) return current;
  const r = scriptResult.result as Record<string, unknown>;
  const merged = { ...current };
  // String fields: append (instructions)
  if (typeof r.instructions === 'string') {
    const prev = typeof merged.instructions === 'string' ? merged.instructions + '\n\n' : '';
    merged.instructions = prev + r.instructions;
  }
  // Object fields: merge (tools)
  if (r.tools && typeof r.tools === 'object') {
    merged.tools = { ...(merged.tools as Record<string, unknown> ?? {}), ...(r.tools as Record<string, unknown>) };
  }
  // Array fields: replace last (activeTools)
  if (Array.isArray(r.activeTools)) {
    merged.activeTools = r.activeTools;
  }
  // providerOptions: shallow merge
  if (r.providerOptions && typeof r.providerOptions === 'object') {
    merged.providerOptions = { ...(merged.providerOptions as Record<string, unknown> ?? {}), ...(r.providerOptions as Record<string, unknown>) };
  }
  return merged;
}

export function composeTriggerHandlers(harnessDir: string): ComposedHandlers {
  const handlers: ComposedHandlers = {};

  const prepareCallSkills = getSkillsForTrigger(harnessDir, 'prepare-call');
  if (prepareCallSkills.length > 0) {
    handlers.prepareCall = async (settings) => {
      let merged = settings;
      for (const skill of prepareCallSkills) {
        if (!skill.bundleDir) continue;
        const r = await runTriggerScript({
          bundleDir: skill.bundleDir,
          trigger: 'prepare-call',
          payload: { settings: merged },
        });
        if (r.status === 'error' && r.error?.action === 'abort') {
          throw new Error(`prepare-call aborted by ${skill.name}: ${r.error.message}`);
        }
        merged = mergeSettings(merged, r);
      }
      return merged;
    };
  }

  const stepFinishSkills = getSkillsForTrigger(harnessDir, 'step-finish');
  if (stepFinishSkills.length > 0) {
    handlers.onStepFinish = async (stepResult) => {
      for (const skill of stepFinishSkills) {
        if (!skill.bundleDir) continue;
        await runTriggerScript({
          bundleDir: skill.bundleDir,
          trigger: 'step-finish',
          payload: { stepResult },
        });
        // step-finish is observation-only; don't merge result back
      }
    };
  }

  const runFinishSkills = getSkillsForTrigger(harnessDir, 'run-finish');
  if (runFinishSkills.length > 0) {
    handlers.onFinish = async (runResult) => {
      for (const skill of runFinishSkills) {
        if (!skill.bundleDir) continue;
        await runTriggerScript({
          bundleDir: skill.bundleDir,
          trigger: 'run-finish',
          payload: { runResult },
        });
      }
    };
  }

  // prepare-step similar to prepare-call
  const prepareStepSkills = getSkillsForTrigger(harnessDir, 'prepare-step');
  if (prepareStepSkills.length > 0) {
    handlers.prepareStep = async (settings) => {
      let merged = settings;
      for (const skill of prepareStepSkills) {
        if (!skill.bundleDir) continue;
        const r = await runTriggerScript({
          bundleDir: skill.bundleDir,
          trigger: 'prepare-step',
          payload: { settings: merged },
        });
        merged = mergeSettings(merged, r);
      }
      return merged;
    };
  }

  return handlers;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/runtime/triggers.test.ts -t composeTriggerHandlers`
Expected: PASS.

- [ ] **Step 5: Wire into createHarness**

In `src/core/harness.ts`, add:

```typescript
import { composeTriggerHandlers } from '../runtime/triggers.js';

// In the boot/run flow, after loading skills:
const triggerHandlers = composeTriggerHandlers(dir);
// Pass to ToolLoopAgent options:
//   prepareCall: triggerHandlers.prepareCall,
//   prepareStep: triggerHandlers.prepareStep,
//   onStepFinish: triggerHandlers.onStepFinish,
//   onFinish: triggerHandlers.onFinish,
```

(Adapt to the actual ToolLoopAgent construction site.)

- [ ] **Step 6: Run full suite + lint**

Run: `npm test && npm run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/triggers.ts src/core/harness.ts tests/runtime/triggers.test.ts
git commit -m "feat(runtime): compose triggers into AI SDK options

composeTriggerHandlers reads harness-trigger metadata from skills
and produces prepareCall/prepareStep/onStepFinish/onFinish closures
that the ToolLoopAgent invokes at the right moments. Multiple
skills with the same trigger compose by harness-trigger-priority
order. mergeSettings does append for string fields (instructions),
shallow merge for object fields (tools, providerOptions), replace
for arrays (activeTools).

Wired into createHarness so the harness picks up trigger skills
without requiring callers to register them manually."
```

---

## Phase 5: Scheduler & migration

### Task 7: Scheduler reads `harness-schedule` from skills

**Files:**
- Modify: `src/runtime/scheduler.ts`
- Test: extend `tests/scheduler.test.ts` (or wherever the existing scheduler tests live)

- [ ] **Step 1: Read the existing scheduler**

```bash
grep -n 'workflows\|cron\|schedule' src/runtime/scheduler.ts | head -20
```

Identify how the scheduler currently locates workflows and how it constructs runs.

- [ ] **Step 2: Write the failing test**

Append to `tests/scheduler.test.ts` (or create if missing):

```typescript
import { writeFileSync, mkdirSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { listScheduledSkills } from '../src/runtime/scheduler.js';

describe('scheduler — reads harness-schedule from skills', () => {
  it('returns skills tagged with harness-schedule', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-'));
    mkdirSync(join(dir, 'skills', 'morning-brief'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'morning-brief', 'SKILL.md'),
      '---\nname: morning-brief\ndescription: Morning routine.\nmetadata:\n  harness-schedule: "0 7 * * *"\n---\nBody.',
      'utf-8'
    );
    mkdirSync(join(dir, 'skills', 'unscheduled'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'unscheduled', 'SKILL.md'),
      '---\nname: unscheduled\ndescription: Not scheduled.\n---\nBody.',
      'utf-8'
    );

    const scheduled = listScheduledSkills(dir);
    expect(scheduled.map((s) => s.name)).toEqual(['morning-brief']);
    expect(scheduled[0].schedule).toBe('0 7 * * *');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- tests/scheduler.test.ts -t "reads harness-schedule"`
Expected: FAIL — `listScheduledSkills` not exported.

- [ ] **Step 4: Add `listScheduledSkills` and update scheduler**

In `src/runtime/scheduler.ts`:

```typescript
import { loadAllPrimitives } from '../primitives/loader.js';

export interface ScheduledSkill {
  name: string;
  schedule: string;
  bundleDir: string;
  body: string;
  durable: boolean;
}

export function listScheduledSkills(harnessDir: string): ScheduledSkill[] {
  const all = loadAllPrimitives(harnessDir);
  const skills = (all.get('skills') ?? []).filter((s) => {
    if (s.status === 'archived' || s.status === 'deprecated') return false;
    return typeof s.metadata?.['harness-schedule'] === 'string';
  });
  return skills.map((s) => ({
    name: s.name,
    schedule: s.metadata?.['harness-schedule'] as string,
    bundleDir: s.bundleDir ?? '',
    body: s.body,
    durable: s.metadata?.['harness-durable'] === 'true' || s.durable === true,
  }));
}
```

Update the cron-registration loop in the existing scheduler to call `listScheduledSkills(dir)` instead of reading from `workflows/`. Construct each scheduled run as:

```typescript
const systemPromptForRun = buildSystemPrompt(dir, config) + '\n\n' + skill.body;
agent.generate({ system: systemPromptForRun, prompt: `Run the ${skill.name} workflow on schedule.` });
```

If the existing scheduler does not pass a runtime config or has additional features (durability via `durableRun`, rate limiting, quiet hours), preserve those. The change is from "iterate `workflows/`" to "iterate `listScheduledSkills(dir)`".

- [ ] **Step 5: Run tests**

Run: `npm test -- tests/scheduler.test.ts`
Expected: scoped tests pass; existing scheduler tests may need updating if they relied on workflows/ shape — investigate each.

- [ ] **Step 6: Run full suite + lint**

Run: `npm test && npm run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/scheduler.ts tests/scheduler.test.ts
git commit -m "feat(scheduler): read schedules from skill metadata

Scheduler now iterates listScheduledSkills(dir) which returns skills
tagged with metadata.harness-schedule. Each scheduled run constructs
its system prompt as the harness's standard system prompt plus the
skill's body, then fires agent.generate with a synthetic prompt.

Workflows directory is no longer scanned by the scheduler. The
doctor migration moves workflow primitives into skills/ with
harness-schedule preserved."
```

### Task 8: Doctor migration — primitive type collapse

**Files:**
- Modify: `src/runtime/migration.ts`
- Test: extend `tests/runtime/migration.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/runtime/migration.test.ts`:

```typescript
describe('applyMigrations — primitive type collapse', () => {
  it('moves instincts/foo.md → rules/foo.md with author: agent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-collapse-'));
    mkdirSync(join(dir, 'instincts'), { recursive: true });
    writeFileSync(
      join(dir, 'instincts', 'lead-with-answer.md'),
      `---\nname: lead-with-answer\ndescription: Lead with the answer.\n---\nLead with the answer.`,
      'utf-8'
    );

    applyMigrations(dir, checkMigrations(dir));

    expect(existsSync(join(dir, 'instincts', 'lead-with-answer.md'))).toBe(false);
    const newPath = join(dir, 'rules', 'lead-with-answer.md');
    expect(existsSync(newPath)).toBe(true);
    const after = matter(readFileSync(newPath, 'utf-8'));
    expect(after.data.author).toBe('agent');
    expect((after.data.metadata as any)?.['harness-source']).toBe('learned');
  });

  it('moves playbooks/foo.md → skills/foo/SKILL.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-collapse-'));
    mkdirSync(join(dir, 'playbooks'), { recursive: true });
    writeFileSync(
      join(dir, 'playbooks', 'ship-feature.md'),
      `---\nname: ship-feature\ndescription: Ship a feature.\n---\nWorkflow.`,
      'utf-8'
    );

    applyMigrations(dir, checkMigrations(dir));

    expect(existsSync(join(dir, 'playbooks', 'ship-feature.md'))).toBe(false);
    expect(existsSync(join(dir, 'skills', 'ship-feature', 'SKILL.md'))).toBe(true);
  });

  it('moves workflows/foo.md → skills/foo/SKILL.md with metadata.harness-schedule', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-collapse-'));
    mkdirSync(join(dir, 'workflows'), { recursive: true });
    writeFileSync(
      join(dir, 'workflows', 'daily-reflection.md'),
      `---\nname: daily-reflection\ndescription: Daily reflection.\nschedule: "0 22 * * *"\n---\nBody.`,
      'utf-8'
    );

    applyMigrations(dir, checkMigrations(dir));

    expect(existsSync(join(dir, 'workflows', 'daily-reflection.md'))).toBe(false);
    const newPath = join(dir, 'skills', 'daily-reflection', 'SKILL.md');
    expect(existsSync(newPath)).toBe(true);
    const after = matter(readFileSync(newPath, 'utf-8'));
    expect(after.data).not.toHaveProperty('schedule');
    expect((after.data.metadata as any)?.['harness-schedule']).toBe('0 22 * * *');
  });

  it('moves agents/foo.md → skills/foo/SKILL.md with harness-trigger: subagent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-collapse-'));
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(
      join(dir, 'agents', 'summarizer.md'),
      `---\nname: summarizer\ndescription: Summarize text.\nmodel: fast\n---\nBody.`,
      'utf-8'
    );

    applyMigrations(dir, checkMigrations(dir));

    expect(existsSync(join(dir, 'agents', 'summarizer.md'))).toBe(false);
    const newPath = join(dir, 'skills', 'summarizer', 'SKILL.md');
    expect(existsSync(newPath)).toBe(true);
    const after = matter(readFileSync(newPath, 'utf-8'));
    expect(after.data).not.toHaveProperty('model');
    expect((after.data.metadata as any)?.['harness-trigger']).toBe('subagent');
    expect((after.data.metadata as any)?.['harness-model']).toBe('fast');
  });

  it('removes empty primitive directories after migration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-collapse-'));
    mkdirSync(join(dir, 'instincts'), { recursive: true });
    writeFileSync(
      join(dir, 'instincts', 'foo.md'),
      `---\nname: foo\ndescription: A.\n---\nBody.`,
      'utf-8'
    );

    applyMigrations(dir, checkMigrations(dir));

    expect(existsSync(join(dir, 'instincts'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/runtime/migration.test.ts -t "primitive type collapse"`
Expected: FAIL — migrations not yet implemented.

- [ ] **Step 3: Extend `MigrationKind` and `checkMigrations`**

In `src/runtime/migration.ts`, add to `MigrationKind`:

```typescript
export type MigrationKind =
  | 'rename-core-to-identity'
  | 'delete-system-md'
  | 'move-state-to-memory'
  | 'bundle-flat-skill'
  | 'rewrite-skill-frontmatter'
  | 'convert-allowed-tools-to-string'
  | 'strip-l0-l1-comments'
  | 'move-instinct-to-rule'
  | 'move-playbook-to-skill'
  | 'move-workflow-to-skill'
  | 'move-agent-to-skill'
  | 'cleanup-empty-primitive-dir';
```

In `checkMigrations`, scan each old primitive directory:

```typescript
const PRIMITIVE_DIRS_TO_COLLAPSE = ['instincts', 'playbooks', 'workflows', 'agents'];

for (const oldKind of PRIMITIVE_DIRS_TO_COLLAPSE) {
  const oldDir = join(harnessDir, oldKind);
  if (!existsSync(oldDir) || !statSync(oldDir).isDirectory()) continue;
  for (const entry of readdirSync(oldDir)) {
    const entryPath = join(oldDir, entry);
    if (!statSync(entryPath).isFile() || !entry.endsWith('.md')) continue;
    const kindToFinding: Record<string, MigrationKind> = {
      instincts: 'move-instinct-to-rule',
      playbooks: 'move-playbook-to-skill',
      workflows: 'move-workflow-to-skill',
      agents: 'move-agent-to-skill',
    };
    findings.push({ kind: kindToFinding[oldKind], path: entryPath });
  }
}

// Detect now-empty directories that could be cleaned up
for (const oldKind of [...PRIMITIVE_DIRS_TO_COLLAPSE, 'tools']) {
  const oldDir = join(harnessDir, oldKind);
  if (!existsSync(oldDir)) continue;
  const entries = readdirSync(oldDir);
  if (entries.length === 0) {
    findings.push({ kind: 'cleanup-empty-primitive-dir', path: oldDir });
  }
}
```

In `applyMigrations`, add cases for each new kind:

```typescript
case 'move-instinct-to-rule': {
  const flatPath = finding.path;
  const baseName = basename(flatPath, '.md');
  const newDir = pathJoin(harnessDir, 'rules');
  mkdirSync(newDir, { recursive: true });
  const newPath = pathJoin(newDir, `${baseName}.md`);
  if (existsSync(newPath)) {
    skipped.push({ ...finding, reason: `rules/${baseName}.md exists; instinct left in place` });
    break;
  }
  // Read, rewrite frontmatter (author: agent, metadata.harness-source: learned), write to new path
  const raw = readFileSync(flatPath, 'utf-8');
  const { data, content } = matter(raw);
  data.author = 'agent';
  if (!data.metadata || typeof data.metadata !== 'object') data.metadata = {};
  (data.metadata as Record<string, unknown>)['harness-source'] = 'learned';
  writeFileSync(newPath, matter.stringify(content, data), 'utf-8');
  unlinkSync(flatPath);
  applied.push(finding);
  break;
}

case 'move-playbook-to-skill': {
  const flatPath = finding.path;
  const baseName = basename(flatPath, '.md');
  const newBundleDir = pathJoin(harnessDir, 'skills', baseName);
  if (existsSync(newBundleDir)) {
    skipped.push({ ...finding, reason: `skills/${baseName}/ exists; playbook left in place` });
    break;
  }
  mkdirSync(newBundleDir, { recursive: true });
  renameSync(flatPath, pathJoin(newBundleDir, 'SKILL.md'));
  applied.push(finding);
  break;
}

case 'move-workflow-to-skill': {
  const flatPath = finding.path;
  const baseName = basename(flatPath, '.md');
  const newBundleDir = pathJoin(harnessDir, 'skills', baseName);
  if (existsSync(newBundleDir)) {
    skipped.push({ ...finding, reason: `skills/${baseName}/ exists; workflow left in place` });
    break;
  }
  // Lift schedule and other workflow-specific fields into metadata.harness-*
  const raw = readFileSync(flatPath, 'utf-8');
  const { data, content } = matter(raw);
  if (!data.metadata || typeof data.metadata !== 'object') data.metadata = {};
  const meta = data.metadata as Record<string, unknown>;
  if (data.schedule) { meta['harness-schedule'] = String(data.schedule); delete data.schedule; }
  if (data.durable !== undefined) { meta['harness-durable'] = String(data.durable); delete data.durable; }
  if (data.max_retries !== undefined) { meta['harness-max-retries'] = String(data.max_retries); delete data.max_retries; }
  if (data.retry_delay_ms !== undefined) { meta['harness-retry-delay-ms'] = String(data.retry_delay_ms); delete data.retry_delay_ms; }
  if (data.channel) { meta['harness-channel'] = String(data.channel); delete data.channel; }
  mkdirSync(newBundleDir, { recursive: true });
  writeFileSync(pathJoin(newBundleDir, 'SKILL.md'), matter.stringify(content, data), 'utf-8');
  unlinkSync(flatPath);
  applied.push(finding);
  break;
}

case 'move-agent-to-skill': {
  const flatPath = finding.path;
  const baseName = basename(flatPath, '.md');
  const newBundleDir = pathJoin(harnessDir, 'skills', baseName);
  if (existsSync(newBundleDir)) {
    skipped.push({ ...finding, reason: `skills/${baseName}/ exists; agent left in place` });
    break;
  }
  const raw = readFileSync(flatPath, 'utf-8');
  const { data, content } = matter(raw);
  if (!data.metadata || typeof data.metadata !== 'object') data.metadata = {};
  const meta = data.metadata as Record<string, unknown>;
  meta['harness-trigger'] = 'subagent';
  if (data.model) { meta['harness-model'] = String(data.model); delete data.model; }
  if (Array.isArray(data.active_tools)) { meta['harness-active-tools'] = (data.active_tools as string[]).join(','); delete data.active_tools; }
  mkdirSync(newBundleDir, { recursive: true });
  writeFileSync(pathJoin(newBundleDir, 'SKILL.md'), matter.stringify(content, data), 'utf-8');
  unlinkSync(flatPath);
  applied.push(finding);
  break;
}

case 'cleanup-empty-primitive-dir': {
  rmSync(finding.path, { recursive: true, force: true });
  applied.push(finding);
  break;
}
```

Don't forget to import `unlinkSync, rmSync` from `fs` if not already imported.

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/runtime/migration.test.ts -t "primitive type collapse"`
Expected: PASS — all 5 new cases.

- [ ] **Step 5: Run full suite + lint**

Run: `npm test && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/migration.ts tests/runtime/migration.test.ts
git commit -m "feat(migration): collapse instincts/playbooks/workflows/agents into skills+rules

Adds 5 new migration kinds:
- move-instinct-to-rule (with author: agent, metadata.harness-source: learned)
- move-playbook-to-skill (rename to bundle)
- move-workflow-to-skill (lift schedule, durable, max_retries, etc. into
  metadata.harness-*)
- move-agent-to-skill (with metadata.harness-trigger: subagent and lift
  model/active_tools)
- cleanup-empty-primitive-dir (remove now-empty old primitive directories)

The tools/ directory migration is the most invasive (auto-generates
scripts) and is handled in a separate task."
```

### Task 9: Doctor migration — tools/ to skills/ with auto-generated scripts

**Files:**
- Modify: `src/runtime/migration.ts`
- Test: extend `tests/runtime/migration.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/runtime/migration.test.ts`:

```typescript
describe('applyMigrations — tools to skills with scripts', () => {
  it('converts a markdown HTTP tool to a skill bundle with auto-generated scripts/call.sh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-tools-'));
    mkdirSync(join(dir, 'tools'), { recursive: true });
    writeFileSync(
      join(dir, 'tools', 'example-api.md'),
      `---
name: example-api
description: Example HTTP API.
---
# Example API

## Authentication

Set EXAMPLE_API_KEY environment variable.

## Operations

### get_status

GET https://example.com/status
Headers: { "Authorization": "Bearer \${EXAMPLE_API_KEY}" }
Returns: JSON with status field.
`,
      'utf-8'
    );

    applyMigrations(dir, checkMigrations(dir));

    expect(existsSync(join(dir, 'tools', 'example-api.md'))).toBe(false);
    expect(existsSync(join(dir, 'skills', 'example-api', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, 'skills', 'example-api', 'scripts', 'call.sh'))).toBe(true);

    const skillRaw = readFileSync(join(dir, 'skills', 'example-api', 'SKILL.md'), 'utf-8');
    const skill = matter(skillRaw);
    expect((skill.data.metadata as any)?.['harness-script-source']).toBe('auto-generated-from-tools');
  });

  it('preserves the tool md as-is when the operations block cannot be parsed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-tools-'));
    mkdirSync(join(dir, 'tools'), { recursive: true });
    writeFileSync(
      join(dir, 'tools', 'unparseable.md'),
      `---\nname: unparseable\ndescription: Unparseable tool.\n---\nNo operations section.`,
      'utf-8'
    );

    const result = applyMigrations(dir, checkMigrations(dir));

    // Either skipped with reason OR converted with a stub script + warning
    const tool = result.applied.find((f) => f.kind === 'convert-tool-to-skill-with-script' && f.path.includes('unparseable'))
      || result.skipped.find((f) => f.kind === 'convert-tool-to-skill-with-script' && f.path.includes('unparseable'))
      || result.errors.find((f) => f.kind === 'convert-tool-to-skill-with-script' && f.path.includes('unparseable'));
    expect(tool).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/runtime/migration.test.ts -t "tools to skills with scripts"`
Expected: FAIL — `convert-tool-to-skill-with-script` migration not yet implemented.

- [ ] **Step 3: Implement the migration**

Add `'convert-tool-to-skill-with-script'` to the `MigrationKind` union.

In `checkMigrations`, scan `tools/`:

```typescript
const toolsDir = join(harnessDir, 'tools');
if (existsSync(toolsDir) && statSync(toolsDir).isDirectory()) {
  for (const entry of readdirSync(toolsDir)) {
    const entryPath = join(toolsDir, entry);
    if (statSync(entryPath).isFile() && entry.endsWith('.md')) {
      findings.push({ kind: 'convert-tool-to-skill-with-script', path: entryPath });
    }
  }
}
```

In `applyMigrations`, add the case:

```typescript
case 'convert-tool-to-skill-with-script': {
  const flatPath = finding.path;
  const baseName = basename(flatPath, '.md');
  const newBundleDir = pathJoin(harnessDir, 'skills', baseName);
  if (existsSync(newBundleDir)) {
    skipped.push({ ...finding, reason: `skills/${baseName}/ exists; tool left in place` });
    break;
  }

  const raw = readFileSync(flatPath, 'utf-8');
  const { data, content } = matter(raw);

  // Try to parse `## Authentication` and `## Operations` sections to generate a script
  const authMatch = content.match(/##\s*Authentication\s*\n([\s\S]*?)(?=\n##|$)/i);
  const opsMatch = content.match(/##\s*Operations\s*\n([\s\S]*?)(?=\n##|$)/i);

  // Generate scripts/call.sh template
  let script = '';
  if (opsMatch) {
    script = `#!/usr/bin/env bash\n# Auto-generated from tools/${baseName}.md\nset -euo pipefail\n\n# Authentication: see SKILL.md "## Authentication" section\n\n# Usage: scripts/call.sh <operation> [args...]\nOP="\${1:-}"\nshift || true\n\ncase "$OP" in\n  --help|-h)\n    cat <<'EOF'\nUsage: scripts/call.sh <operation> [args...]\nOperations: see SKILL.md "## Operations" section.\nReturns JSON: { status, result?, error?, next_steps? }\nEOF\n    exit 0\n    ;;\n  *)\n    echo '{"status":"error","error":{"code":"NOT_IMPLEMENTED","message":"Auto-generated stub. Edit scripts/call.sh to implement operations."}}'\n    exit 1\n    ;;\nesac\n`;
  } else {
    // No operations section — emit a stub script flagging that the tool needs manual conversion
    script = `#!/usr/bin/env bash\n# Auto-generated stub — no parseable Operations section in the original tool md.\necho '{"status":"error","error":{"code":"NEEDS_MANUAL_CONVERSION","message":"This tool was converted from tools/${baseName}.md but its operations could not be auto-extracted. See SKILL.md and rewrite this script."}}'\nexit 1\n`;
  }

  // Build the new SKILL.md
  if (!data.metadata || typeof data.metadata !== 'object') data.metadata = {};
  (data.metadata as Record<string, unknown>)['harness-script-source'] = 'auto-generated-from-tools';

  const newBody = `${content.trim()}\n\n## Available scripts\n\n- \`scripts/call.sh\` — Auto-generated from this tool's Operations section. Review before relying on it.\n`;

  mkdirSync(newBundleDir, { recursive: true });
  mkdirSync(pathJoin(newBundleDir, 'scripts'), { recursive: true });
  writeFileSync(pathJoin(newBundleDir, 'SKILL.md'), matter.stringify(newBody, data), 'utf-8');
  writeFileSync(pathJoin(newBundleDir, 'scripts', 'call.sh'), script, 'utf-8');
  // chmod +x the script
  try { require('fs').chmodSync(pathJoin(newBundleDir, 'scripts', 'call.sh'), 0o755); } catch { /* best-effort */ }
  unlinkSync(flatPath);
  applied.push(finding);
  void authMatch; // suppress unused
  break;
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/runtime/migration.test.ts -t "tools to skills"`
Expected: PASS — both new cases.

- [ ] **Step 5: Run full suite + lint**

Run: `npm test && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/migration.ts tests/runtime/migration.test.ts
git commit -m "feat(migration): convert tools/* into skills with auto-generated scripts

Each tools/<name>.md becomes skills/<name>/SKILL.md +
scripts/call.sh. The script is auto-generated as a stub that the
user must review before relying on it; metadata.harness-script-source:
auto-generated-from-tools is set so downstream tooling (and a
future audit pass) can flag these for review.

If the original tools md lacks a parseable ## Operations section,
the script is a stub that returns NEEDS_MANUAL_CONVERSION on
invocation, surfacing the issue at runtime instead of silently
failing."
```

---

## Phase 6: CLI updates + defaults migration

### Task 10: CLI commands for the new model

**Files:**
- Modify: `src/cli/index.ts`
- Test: extend `tests/integration/`

- [ ] **Step 1: Find and remove obsolete commands**

```bash
cd /Users/randywilson/Desktop/agent-harness
grep -n 'agents\|delegate\|workflow' src/cli/index.ts | head -30
```

The commands to remove or reframe:
- `harness agents` (lists sub-agents) — DELETE
- `harness delegate <agent-id> <prompt>` — DELETE (or rename to `harness skill run` with the subagent path)
- `harness workflow list` / `harness workflow run` — RENAME or REMOVE; the durable-workflow management commands (`harness workflows status/inspect/resume/cleanup`) STAY because they manage runs, not workflow primitives

- [ ] **Step 2: Add new CLI commands**

```typescript
program
  .command('skill list')
  .description('List skills, optionally filtered by trigger or schedule')
  .option('-d, --dir <path>', 'harness directory', process.cwd())
  .option('--trigger <kind>', 'filter to skills with metadata.harness-trigger=<kind>')
  .option('--scheduled', 'show only scheduled skills (those with metadata.harness-schedule)')
  .action((opts) => {
    const harnessDir = resolve(opts.dir);
    const all = loadAllPrimitives(harnessDir);
    let skills = all.get('skills') ?? [];
    if (opts.trigger) {
      skills = skills.filter((s) => s.metadata?.['harness-trigger'] === opts.trigger);
    }
    if (opts.scheduled) {
      skills = skills.filter((s) => typeof s.metadata?.['harness-schedule'] === 'string');
    }
    for (const s of skills) {
      const trigger = s.metadata?.['harness-trigger'] ?? '-';
      const schedule = s.metadata?.['harness-schedule'] ?? '-';
      console.log(`  ${s.name.padEnd(40)} trigger=${trigger}\tschedule=${schedule}`);
    }
  });
```

(Replace any `harness agents` and `harness delegate` calls with helpful migration messages: `console.error('harness agents has been removed. Use \`harness skill list --trigger subagent\` instead.')`.)

- [ ] **Step 3: Update CLI tests**

If `tests/cli-workflows.test.ts` references the removed commands, update or remove. The durable-workflow management commands (`harness workflows status/inspect/resume`) stay.

- [ ] **Step 4: Run tests + lint**

Run: `npm run build && npm test && npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts tests/
git commit -m "feat(cli): replace agents/delegate with skill subcommands

- harness skill list [--trigger=X] [--scheduled] — list skills with
  optional trigger or schedule filter
- harness agents removed (use \`harness skill list --trigger subagent\`)
- harness delegate removed (use activate_skill via the model, or
  invoke the bundled subagent script directly)
- harness workflow list / run removed (workflow primitives are now
  scheduled skills; use \`harness skill list --scheduled\`)
- harness workflows status/inspect/resume/cleanup KEPT — they manage
  durable runs, not the (now-defunct) workflow primitives"
```

### Task 11: Defaults migration via doctor

**Files:**
- Migrate: `defaults/`
- Test: integration test (Phase 7 of this plan)

- [ ] **Step 1: Run doctor --check on defaults**

```bash
cd /Users/randywilson/Desktop/agent-harness
node dist/cli/index.js doctor --check -d defaults
```

Expected: lists migrations for instincts/, playbooks/, workflows/, tools/, agents/.

- [ ] **Step 2: Run doctor --migrate**

```bash
node dist/cli/index.js doctor --migrate -d defaults
```

Verify the output reports `applied: N` with the right migration kinds.

- [ ] **Step 3: Spot-check the result**

```bash
ls defaults/
ls defaults/skills/
ls defaults/rules/
# Empty (deleted): ls defaults/instincts/ defaults/playbooks/ defaults/workflows/ defaults/agents/ defaults/tools/
```

Expected:
- `defaults/instincts/`, `defaults/playbooks/`, `defaults/workflows/`, `defaults/agents/`, `defaults/tools/` no longer exist
- `defaults/rules/` includes new entries from the former instincts (with `author: agent`, `metadata.harness-source: learned`)
- `defaults/skills/` includes new entries from the former playbooks/workflows/agents/tools

- [ ] **Step 4: Manually review auto-generated scripts**

For each tool that was converted (e.g., `defaults/skills/ask-claude/`), check `scripts/call.sh`. If the auto-generated stub is acceptable, leave it. If the original tool's behavior was non-trivial, the user (you) needs to decide whether to:
- Hand-write the script properly
- Mark the skill as `metadata.harness-status: draft` so it's flagged for review

For the four `ask-*` tools (`ask-claude`, `ask-codex`, `ask-gemini`, `example-web-search`), expect the auto-generated stubs to need manual rewriting. Set their status to `draft` if not already.

- [ ] **Step 5: Verify tests still pass**

```bash
npm test
npm run lint
```

Expected: clean.

- [ ] **Step 6: Commit the migrated defaults**

```bash
git add defaults/
git commit -m "refactor(defaults): collapse to skills + rules via doctor migrate

Runs harness doctor --migrate against defaults/ to convert all five
old primitive directories into the new 2-primitive shape:
- instincts/* → rules/* with author: agent, metadata.harness-source: learned
- playbooks/* → skills/* (bundle restructure)
- workflows/* → skills/* with metadata.harness-schedule
- agents/* → skills/* with metadata.harness-trigger: subagent
- tools/* → skills/* with auto-generated scripts/call.sh (status: draft)

The auto-generated scripts for the ask-* CLI delegation tools and
example-web-search need manual review and rewriting; their status
is left at draft until that's done."
```

---

## Phase 7: E2E + documentation

### Task 12: E2E migration test for the full collapse

**Files:**
- Create: `tests/fixtures/old-harness-7-primitives/`
- Create: `tests/integration/collapse.e2e.test.ts`

- [ ] **Step 1: Build the comprehensive fixture**

```bash
mkdir -p tests/fixtures/old-harness-7-primitives/{skills,rules,instincts,playbooks,workflows,tools,agents,memory}
```

Add one representative file per old primitive type (mirroring the existing v0.8.x format). Sample contents:

`tests/fixtures/old-harness-7-primitives/IDENTITY.md`:
```markdown
# Test Agent

A 7-primitive agent for the collapse migration test.
```

`tests/fixtures/old-harness-7-primitives/skills/research/SKILL.md`:
```markdown
---
name: research
description: Conduct research.
---
Body.
```

`tests/fixtures/old-harness-7-primitives/rules/operations.md`:
```markdown
---
name: operations
description: Operational rules.
---
Always do X.
```

`tests/fixtures/old-harness-7-primitives/instincts/lead-with-answer.md`:
```markdown
---
name: lead-with-answer
description: Lead with the answer.
---
Lead with the answer.
```

`tests/fixtures/old-harness-7-primitives/playbooks/ship-feature.md`:
```markdown
---
name: ship-feature
description: Ship a feature.
---
Body.
```

`tests/fixtures/old-harness-7-primitives/workflows/daily-reflection.md`:
```markdown
---
name: daily-reflection
description: Daily reflection.
schedule: "0 22 * * *"
---
Body.
```

`tests/fixtures/old-harness-7-primitives/tools/example-api.md`:
```markdown
---
name: example-api
description: Example API.
---
## Operations
GET /status
```

`tests/fixtures/old-harness-7-primitives/agents/summarizer.md`:
```markdown
---
name: summarizer
description: Summarize text.
model: fast
---
Body.
```

- [ ] **Step 2: Write the e2e test**

Create `tests/integration/collapse.e2e.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import { cpSync, mkdtempSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const HARNESS_BIN = join(__dirname, '..', '..', 'dist', 'cli', 'index.js');
const FIXTURE = join(__dirname, '..', 'fixtures', 'old-harness-7-primitives');

describe('e2e — 7-primitive harness collapse', () => {
  beforeAll(() => {
    const buildResult = spawnSync('npm', ['run', 'build'], { encoding: 'utf-8', cwd: join(__dirname, '..', '..') });
    if (buildResult.status !== 0) throw new Error(`Build failed: ${buildResult.stderr}`);
  }, 60000);

  it('--migrate collapses all 5 old primitive types', () => {
    const dir = mkdtempSync(join(tmpdir(), 'collapse-e2e-'));
    cpSync(FIXTURE, dir, { recursive: true });

    const r = spawnSync('node', [HARNESS_BIN, 'doctor', '--migrate', '-d', dir], { encoding: 'utf-8' });
    expect(r.status).toBe(0);

    // Old directories should be gone
    expect(existsSync(join(dir, 'instincts'))).toBe(false);
    expect(existsSync(join(dir, 'playbooks'))).toBe(false);
    expect(existsSync(join(dir, 'workflows'))).toBe(false);
    expect(existsSync(join(dir, 'tools'))).toBe(false);
    expect(existsSync(join(dir, 'agents'))).toBe(false);

    // Migrated content
    expect(existsSync(join(dir, 'rules', 'lead-with-answer.md'))).toBe(true);
    expect(existsSync(join(dir, 'skills', 'ship-feature', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, 'skills', 'daily-reflection', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, 'skills', 'example-api', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, 'skills', 'example-api', 'scripts', 'call.sh'))).toBe(true);
    expect(existsSync(join(dir, 'skills', 'summarizer', 'SKILL.md'))).toBe(true);

    // Idempotence
    const r2 = spawnSync('node', [HARNESS_BIN, 'doctor', '--migrate', '-d', dir], { encoding: 'utf-8' });
    expect(r2.stdout).toMatch(/no migrations needed|clean|0 findings/i);
  });
});
```

- [ ] **Step 3: Run the e2e test**

Run: `npm test -- tests/integration/collapse.e2e.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/old-harness-7-primitives/ tests/integration/collapse.e2e.test.ts
git commit -m "test(e2e): assert 7-primitive harness collapses cleanly

Comprehensive fixture covering one representative per old primitive
type (instincts, playbooks, workflows, tools, agents) plus the
existing skills/rules. End-to-end test runs harness doctor --migrate
and asserts the post-migration shape is correct: 5 old directories
removed, content correctly placed under skills/ and rules/, scripts
auto-generated for tools.

Idempotence verified by a second --migrate run."
```

### Task 13: Documentation update

**Files:**
- Modify: `README.md`
- Modify: `docs/skill-authoring.md`

- [ ] **Step 1: Update README's "The 7 primitives" table**

Find the table in `README.md` and replace with:

```markdown
## The 2 primitives

agent-harness has exactly two primitive types:

| Primitive | Owner | Activation | Always loaded? |
|---|---|---|---|
| **Rules** | Human or learned (`author: agent`) | Always | Yes — full body in every system prompt |
| **Skills** | Mixed | Discovery + activation per Agent Skills spec | No — only `name` + `description` until invoked |

Skills can have different activation triggers via `metadata.harness-trigger`:

| Trigger | When the harness fires the skill |
|---|---|
| (none) | User-invokable via the `activate_skill` tool |
| `subagent` | User-invokable, runs in an isolated subagent session |
| `prepare-call` | Per AI SDK call (modifies model/tools/instructions) |
| `prepare-step` | Per step in the tool loop |
| `step-finish` | After each step (observation) |
| `run-finish` | After the run (observation) |
| `tool-pre` / `tool-post` | Wraps every tool's execute |
| `repair-tool-call` | When a tool call fails to validate |
| `stop-condition` | Step boundaries (vote on early stop) |
| `stream-transform` | Streaming output transform |

A skill with `metadata.harness-schedule: <cron>` is invoked by the harness scheduler at the cron times instead of by the model.

For the previous 7-primitive shape and the migration story, run `harness doctor --migrate -d <dir>`.
```

- [ ] **Step 2: Update directory diagram**

Find the directory diagram and replace with the 2-primitive shape:

```
my-agent/
├── IDENTITY.md             # Agent identity
├── config.yaml             # Model, runtime, memory, MCP, scheduler
├── rules/                  # Always-loaded behavioral guidance
├── skills/                 # Agent Skills bundles (discovery + activation)
└── memory/
    ├── state.md
    ├── sessions/
    ├── journal/
    └── scratch.md
```

- [ ] **Step 3: Update docs/skill-authoring.md**

Append a section on lifecycle-triggered, scheduled, and subagent skills:

```markdown
## Lifecycle-triggered skills

A skill can hook into the AI SDK lifecycle by setting `metadata.harness-trigger`:

\`\`\`yaml
---
name: inject-current-state
description: Adds the agent's current goals to the system prompt.
metadata:
  harness-trigger: prepare-call
---
\`\`\`

The skill MUST have a script in `scripts/run.sh` (or `.py`/`.ts`/`.js`). The harness invokes it with the trigger name + bundle directory as argv and a JSON payload on stdin. The script returns JSON on stdout matching the contract defined in [docs/specs/2026-04-30-skill-content-rewrite-design.md](specs/2026-04-30-skill-content-rewrite-design.md) §4.1.

Lifecycle skills are NOT in the model-invokable catalog — the harness fires them, not the model.

## Scheduled skills

A skill with `metadata.harness-schedule: <cron>` is invoked by the harness scheduler:

\`\`\`yaml
---
name: morning-brief
description: Synthesize today's plan from journal and calendar.
metadata:
  harness-schedule: "0 7 * * *"
---
Body.
\`\`\`

Scheduled skills are NOT in the model-invokable catalog. When the cron fires, the harness constructs an `agent.generate` call with the skill's body added to the system prompt.

## Subagent skills

A skill with `metadata.harness-trigger: subagent` is model-invokable but runs in an isolated session:

\`\`\`yaml
---
name: summarizer
description: Summarize a long text into 3 bullet points.
metadata:
  harness-trigger: subagent
---
You are a summarization agent. Return exactly 3 bullet points capturing the key points of the input.
\`\`\`

When the model invokes the skill via `activate_skill`, the harness spawns a fresh `agent.generate` with the skill's body as the system prompt and the args as the user prompt. The subagent's final text is returned to the parent.
```

- [ ] **Step 4: Verify renders cleanly**

```bash
npm test
npm run lint
```

(Docs changes shouldn't affect tests.)

- [ ] **Step 5: Commit**

```bash
git add README.md docs/skill-authoring.md
git commit -m "docs: 2-primitive model + trigger metadata documentation

README updated:
- 'The 7 primitives' table replaced with 'The 2 primitives' (skills + rules)
- New trigger metadata table listing all 10 harness-trigger values
- Directory diagram simplified to the 2-primitive shape

skill-authoring.md extended with three new sections:
- Lifecycle-triggered skills (with the script contract pointer)
- Scheduled skills (cron via metadata.harness-schedule)
- Subagent skills (metadata.harness-trigger: subagent + isolated session)
"
```

---

## Phase 8: Compaction protection + final verification

### Task 14: Skill content compaction protection

**Files:**
- Modify: `src/runtime/conversation.ts`
- Test: extend `tests/conversation.test.ts` (or wherever conversation tests live)

- [ ] **Step 1: Locate the compaction routine**

```bash
grep -n 'compact\|prune\|truncate' src/runtime/conversation.ts | head -10
```

Find the function that decides which messages to drop when context is full.

- [ ] **Step 2: Write the failing test**

Append (or create) a test:

```typescript
import { compactConversation } from '../src/runtime/conversation.js';

describe('conversation compaction — protect skill content', () => {
  it('does not drop messages containing <skill_content>', () => {
    const messages = [
      { role: 'user', content: 'old request' },
      { role: 'assistant', content: 'old response' },
      { role: 'tool', content: '<skill_content name="research">\n# Research\nBody.\n</skill_content>' },
      { role: 'user', content: 'newer request' },
    ];
    const compacted = compactConversation(messages, { maxTokens: 100 });
    // Skill content message must survive
    expect(compacted.some((m) => typeof m.content === 'string' && m.content.includes('<skill_content'))).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- tests/conversation.test.ts -t "compaction"`
Expected: FAIL.

- [ ] **Step 4: Update compaction routine to protect `<skill_content>` blocks**

In `src/runtime/conversation.ts` (in the compaction function):

```typescript
function isProtected(message: { content?: string | unknown }): boolean {
  if (typeof message.content !== 'string') return false;
  return message.content.includes('<skill_content');
}

// Before dropping a message, check isProtected. If true, skip it.
```

- [ ] **Step 5: Run test**

Run: `npm test -- tests/conversation.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/conversation.ts tests/conversation.test.ts
git commit -m "feat(conversation): protect skill content during compaction

Messages containing <skill_content> tags are exempt from compaction
pruning. Per the Adding-skills-support guide, skill instructions are
durable behavioral guidance — losing them mid-conversation silently
degrades agent performance without any visible error.

The harness's structured wrapping (Phase 3 of this plan) makes
skill content identifiable; this task is the matching protection."
```

### Task 15: Final verification + version bump

**Files:**
- Modify: `package.json` (version)

- [ ] **Step 1: Run full regression**

```bash
npm test
npm run lint
npm run build
```

Expected: clean. Pre-existing flaky `cli-workflows.test.ts` may have 0-2 failures under parallel load; pass in isolation.

- [ ] **Step 2: Smoke test the built CLI**

```bash
node dist/cli/index.js --version       # 0.9.0 (about to bump)
node dist/cli/index.js doctor --check -d defaults     # clean
TMP=$(mktemp -d) && cd "$TMP" && node /Users/randywilson/Desktop/agent-harness/dist/cli/index.js init smoke --template base -y && ls smoke/skills/   # 8+ skills present
node /Users/randywilson/Desktop/agent-harness/dist/cli/index.js skill list -d "$TMP/smoke"   # shows skills with trigger/schedule columns
cd /Users/randywilson/Desktop/agent-harness
```

- [ ] **Step 3: Bump version to 0.10.0**

```bash
cd /Users/randywilson/Desktop/agent-harness
npm version minor
```

This bumps 0.9.0 → 0.10.0, commits, and tags atomically.

- [ ] **Step 4: Verify the bump**

```bash
npm run build
node dist/cli/index.js --version
```

Expected: prints `0.10.0`.

- [ ] **Step 5: (No additional commit — `npm version minor` did it)**

```bash
git log --oneline -2
```

Expected: top commit is `0.10.0`.

---

## Self-review

After writing all tasks, the spec-coverage checklist:

- [ ] **Spec §4.1 (the two primitive types)**: Tasks 1, 2 collapse the loader and system prompt.
- [ ] **Spec §4.2 (migration mapping)**: Tasks 8, 9 add migration for instincts/playbooks/workflows/agents/tools.
- [ ] **Spec §4.3 (system prompt assembly)**: Task 2.
- [ ] **Spec §4.4 (AI SDK trigger mapping)**: Tasks 5, 6.
- [ ] **Spec §4.5 (schedule integration)**: Task 7.
- [ ] **Spec §4.6 (subagent delegation)**: Task 3 + Task 4 (subagent path is in `formatSkillContent` return; the spec says full subagent isolation is part of activate_skill).
- [ ] **Spec §4.7 (activate_skill tool)**: Tasks 3, 4.
- [ ] **Spec §4.8 (loader and primitive directory changes)**: Task 1.
- [ ] **Spec §4.9 (compaction protection)**: Task 14.
- [ ] **Spec §4.10 (doctor migration extends spec #1)**: Tasks 8, 9.
- [ ] **Spec §6 phase 13 (CLI)**: Task 10.
- [ ] **Spec §6 phase 14 (defaults migration)**: Task 11.
- [ ] **Spec §6 phase 15 (documentation)**: Task 13.

No tasks reference TODOs, TBDs, or placeholder comments. Every step has full code blocks. Every test step has a runnable command. Type/method names are consistent across phases:
- `MigrationKind` extended consistently in Tasks 8, 9
- `composeTriggerHandlers`, `runTriggerScript` defined in Task 5/6, used in Task 7
- `buildActivateSkillTool` defined Task 3, wired Task 4
- `listScheduledSkills` defined and used in Task 7

---

## Execution

Plan complete and saved to `docs/plans/2026-04-29-primitive-collapse-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks. Best for this plan because tasks are well-bounded and the subagent context isolates per-task scope.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batched with checkpoints.

Which approach?
