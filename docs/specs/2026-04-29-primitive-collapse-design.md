# Primitive collapse + AI SDK trigger mapping — design

**Date:** 2026-04-29
**Status:** Draft (pending review)
**Spec:** 2 of 5 in the Agent Skills alignment series
**Depends on:** 1 of 5 — `2026-04-28-skills-spec-conformance-design.md` (skills must be spec-conformant before this collapse)
**Related specs:**
- 3 of 5 — `2026-04-30-skill-content-rewrite-design.md`
- 4 of 5 — `2026-05-01-skill-evals-design.md`
- 5 of 5 — `2026-05-02-provider-integration-design.md`

## 1. Goal

Collapse agent-harness's 7 primitive types (skills, rules, instincts, playbooks, workflows, tools, agents) into 2 (skills + rules), with all behavior previously expressed via primitive type now expressed via skill metadata (`harness-trigger`, `harness-schedule`) and bundled scripts. Expose the [Vercel AI SDK ToolLoopAgent](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent) lifecycle (`prepareCall`, `prepareStep`, `onStepFinish`, `onFinish`, `experimental_repairToolCall`, `stopWhen`, `experimental_transform`) as authorable trigger types so users can write lifecycle hooks as skills. Replace agent-harness's invented L0/L1/L2 system-prompt budgeting with the Agent Skills three-tier disclosure model: identity + rules always loaded, skill `name`+`description` always loaded for discovery, full skill body loaded only on activation.

## 2. Non-goals (handled in later specs)

- Rewriting default skill content as proper script-bundled skills with structured feedback — spec #3.
- Eval infrastructure for trigger and quality optimization — spec #4.
- Provider integration (`harness export`, `.claude/`/`.cursor/`/`.gemini/` detection) — spec #5.
- Sandboxing or security isolation of skill scripts (non-goal for this entire series; the harness trusts the user's local filesystem).

## 3. Background

### 3.1 The 7 primitives today

`agent-harness@0.8.0` ships with seven top-level primitive directories ([README.md:142](../../README.md):142):

| Primitive | Owner | Purpose | Activation |
|---|---|---|---|
| Rules | Human | Operational boundaries | Always loaded |
| Instincts | Agent | Learned reflexive behaviors | Always loaded |
| Skills | Mixed | Capabilities with embedded judgment | L1 in system prompt; L2 inferred from context |
| Playbooks | Mixed | Adaptive guidance for outcomes | L1 in system prompt; L2 inferred from context |
| Workflows | Infra | Cron-driven deterministic automations | Scheduler invokes |
| Tools | External | HTTP API knowledge | HTTP executor calls when invoked |
| Agents | External | Sub-agent roster and capabilities | Exposed as virtual tools |

### 3.2 Why the count is wrong

The Agent Skills specification defines exactly one primitive type: a skill is a directory containing `SKILL.md`. Reading the spec corpus end-to-end ([specification](https://agentskills.io/specification), [best practices](https://agentskills.io/skill-creation/best-practices), [using scripts](https://agentskills.io/skill-creation/using-scripts), [adding skills support](https://agentskills.io/client-implementation/adding-skills-support)) makes clear that what agent-harness calls "playbooks," "workflows," "tools," and "agents" are all *skills with different activation patterns or bundled artifacts.*

Concrete redundancies:

1. **Tools** are markdown HTTP descriptions that *teach* the agent how to call an API every time. The Agent Skills "using scripts" guide says explicitly: *"When you notice the agent independently reinventing the same logic each run — building charts, parsing a specific format, validating output — that's a signal to write a tested script once and bundle it in `scripts/`."* The right shape is a skill bundle whose `scripts/` directory contains a tested wrapper that calls the API and returns structured output. The "tools" primitive is a less-correct alternative to skill scripts.

2. **Playbooks** have no format or activation difference from skills. Their "adaptive guidance for outcomes" is just what a skill is.

3. **Workflows** are skills with a cron trigger. Cron is metadata, not a primitive distinction. The harness's scheduler can read `metadata.harness-schedule` from any skill.

4. **Agents** (sub-agents) are the [Subagent delegation pattern](https://agentskills.io/client-implementation/adding-skills-support#subagent-delegation-optional) explicitly named in the spec's client-implementation guide as *"a pattern only supported by some clients...the skill is run in a separate subagent session."* It's a pattern within a skill, not a separate primitive type.

5. **Instincts** are learned behavioral guidance. They're rules that came from journal synthesis instead of human authoring — same activation pattern (always loaded), same content shape, different provenance. "Instinct" is a journal-time concept (a proposal awaiting promotion), not a primitive type.

That leaves **rules** (always-loaded behavioral constraints, distinct activation pattern from skills) and **skills** as the two genuinely-different primitive types.

### 3.3 What the Vercel AI SDK already gives us

agent-harness uses the AI SDK as its model layer. The [ToolLoopAgent](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent) constructor exposes a complete lifecycle:

| AI SDK option | Fires | Receives | Can return / mutate |
|---|---|---|---|
| `prepareCall({ options, ...settings })` | Once per `agent.generate()` / `agent.stream()` | Runtime call options | Modified `model`, `instructions`, `tools`, `activeTools`, `providerOptions` |
| `prepareStep` | Each step in the tool loop | Step context | Modified per-step settings |
| `onStepFinish(stepResult)` | After each step completes | Tool results, text, usage, finishReason | (observation hook) |
| `onFinish(runResult)` | Once per `generate`/`stream` after the loop ends | Full run result | (observation hook) |
| `experimental_repairToolCall` | When a tool call fails to parse/validate | Failed call, error | Repaired call args |
| `stopWhen: StopCondition[]` | Each step boundary | Run state | Boolean: stop now |
| `experimental_transform` (stream only) | Per stream chunk | Chunk | Transformed chunk |
| `experimental_context` | Available throughout | (passed at construction) | (read-only context) |
| `abortSignal` | Any time | (caller-controlled) | Cancels the run |

Each tool's `execute` function is itself wrappable: `wrapToolSet({ tools }) => tools` can decorate every tool with pre/post logic. agent-harness already uses this for approval ([src/runtime/approval.ts](../../src/runtime/approval.ts)) and for durable-execution caching ([src/runtime/durable-engine.ts](../../src/runtime/durable-engine.ts)).

This is everything we'd need from a "hook system" and we shouldn't invent our own. We expose AI SDK options as authorable triggers.

## 4. Design

### 4.1 The two primitive types

#### 4.1.1 Skills (`skills/`)

The Agent Skills bundle, per [spec #1](2026-04-28-skills-spec-conformance-design.md#411-skills-strict-spec-compliance). A skill is a directory containing `SKILL.md` plus optional `scripts/`, `references/`, `assets/`. Activation is *progressive disclosure*: discovery via `name`+`description`, full body loaded on activation.

Skills can be activated via four mechanisms, distinguished by metadata:

| `metadata.harness-trigger` | Activation source | Loaded into |
|---|---|---|
| (unset, default) | Model decides via `activate_skill` tool | Conversation context (full body) |
| `subagent` | Same as default, but body is loaded into a separate subagent's context | Subagent context, summary returned |
| One of the AI SDK lifecycle events (§4.4) | Harness fires script at the AI SDK hook point | Hook script invoked, JSON merged into call options |
| (any of the above) + `metadata.harness-schedule: <cron>` | Harness scheduler fires at clock time | Fresh agent run with skill as system prompt |

A single skill can have at most one trigger and optionally a schedule. (Multiple triggers per skill is rejected by the validator — split into separate skills.)

#### 4.1.2 Rules (`rules/`)

Always-loaded behavioral guidance. Plain markdown with frontmatter. The body of every active rule is concatenated into the system prompt at boot, after IDENTITY.md. Rules don't activate; they're just there.

Rule frontmatter is the harness-extended Agent Skills shape per [spec #1 §4.1.2](2026-04-28-skills-spec-conformance-design.md#412-non-skill-primitives), with one rule-specific top-level field:

| Field | Type | Notes |
|---|---|---|
| `name` | required | parent-dir match if bundled |
| `description` | required | summary of the rule's purpose |
| `tags` | string[] | filtering / organization |
| `status` | enum | filter inactive |
| `author` | enum | `human`, `agent`, `infrastructure`. `agent` indicates a learned/promoted rule (was an "instinct") |
| `created`, `updated`, `related` | strings/string[] | metadata |
| `metadata.harness-source` | string | optional provenance — "learned", "migrated-from-system-md", or a session ID |

Rule bundles are allowed (`rules/foo/RULE.md`) for rules that ship with `references/` material, but most rules are flat single-file markdown.

There are no other primitive directories.

### 4.2 Migration mapping (old → new)

| Old primitive | New shape | Migration logic |
|---|---|---|
| `skills/foo.md` (flat) | `skills/foo/SKILL.md` | Move file into directory; spec-conform frontmatter (covered by spec #1) |
| `skills/foo/SKILL.md` (already bundled) | unchanged | spec-conform frontmatter (covered by spec #1) |
| `rules/foo.md` (flat) | unchanged | spec-conform frontmatter |
| `instincts/foo.md` | `rules/foo.md` with `author: agent`, `metadata.harness-source: learned` | Move file; rewrite frontmatter |
| `playbooks/foo.md` (flat) | `skills/foo/SKILL.md` | Restructure as bundle; spec-conform frontmatter |
| `playbooks/foo/PLAYBOOK.md` (bundled) | `skills/foo/SKILL.md` | Rename entry file; move directory |
| `workflows/foo.md` (flat) | `skills/foo/SKILL.md` with `metadata.harness-schedule: <cron>` | Restructure; lift `schedule` field into metadata |
| `workflows/foo/WORKFLOW.md` (bundled) | `skills/foo/SKILL.md` with `metadata.harness-schedule: <cron>` | Rename entry; lift `schedule` |
| `tools/foo.md` (markdown HTTP tool) | `skills/foo/SKILL.md` with `scripts/call.sh` (or `.py`) that wraps the API | Generate a script from the markdown's `## Operations` section; SKILL.md body becomes thin: "When you need to call the foo API, run `scripts/call.sh`. See `references/api.md` for the full interface." |
| `agents/foo.md` (sub-agent definition) | `skills/foo/SKILL.md` with `metadata.harness-trigger: subagent` | Restructure; the agent's prompt content becomes the SKILL.md body, which becomes the subagent's system prompt when activated |

For the `tools/` migration specifically (most invasive): the existing markdown HTTP executor at [src/runtime/tool-executor.ts](../../src/runtime/tool-executor.ts) is **deleted** along with the tools/ primitive. The auto-generated wrapper script handles the same calls but as bundled, testable code with structured output (per spec #3's contract).

### 4.3 System prompt assembly

The new strategy replaces the L0/L1/L2 token-budget logic at [src/runtime/context-loader.ts](../../src/runtime/context-loader.ts).

#### 4.3.1 Always-loaded section

```
<identity>
[contents of IDENTITY.md]
</identity>

<rules>
[concatenated body of every active rule, in stable order (alphabetical by name)]
</rules>

<state>
[contents of memory/state.md]
</state>
```

Token cost: bounded by IDENTITY.md size + sum of rule bodies + state size. Typical: 1k–5k tokens. Doctor warns when total exceeds 10k.

#### 4.3.2 Skill catalog

Following the [Adding skills support guide](https://agentskills.io/client-implementation/adding-skills-support#step-3-disclose-available-skills-to-the-model):

```xml
<available_skills>
  <skill>
    <name>research</name>
    <description>Conducts deep research using web search and document analysis. Use when the user asks to investigate a topic, gather sources, or compare options.</description>
    <location>/path/to/.harness/skills/research/SKILL.md</location>
  </skill>
  <skill>
    <name>brainstorming</name>
    <description>...</description>
    <location>...</location>
  </skill>
  ...
</available_skills>

When a task matches a skill's description, call the activate_skill tool with the skill's name to load its full instructions.
```

Only skills with `harness-trigger` unset (or set to `subagent`) appear in the catalog. Lifecycle-triggered skills (those with `harness-trigger: prepare-call` etc.) and schedule-triggered skills are *not* in the catalog — they're invoked by the harness, not the model.

Token cost per skill in the catalog: ~50–100 tokens. A harness with 50 skills costs ~3k–5k tokens for the catalog. The Adding-skills-support guide considers this acceptable; we adopt the same budget.

#### 4.3.3 Lifecycle-triggered skills are invisible to the catalog

Skills with a lifecycle trigger don't go in the system prompt at all. Their body is documentation for the *human author*; the harness invokes their `scripts/run.sh` (or equivalent) directly at the AI SDK hook point. The model never sees them.

### 4.4 AI SDK trigger mapping

| `metadata.harness-trigger` | AI SDK integration | Skill MUST have | Script returns |
|---|---|---|---|
| `prepare-call` | `prepareCall` | `scripts/run.sh` (or `.py`/`.ts`/`.js`) | JSON: `{ instructions?, tools?, activeTools?, providerOptions? }` merged into call settings |
| `prepare-step` | `prepareStep` | `scripts/run.sh` | JSON: `{ instructions?, tools?, activeTools? }` for the next step |
| `step-finish` | `onStepFinish` | `scripts/run.sh` | JSON: `{ status, result?, error? }` (observation only; ignored unless `error.action: "abort"` is returned) |
| `run-finish` | `onFinish` | `scripts/run.sh` | JSON: `{ status, result?, error? }` (observation only; can mark session for re-run) |
| `repair-tool-call` | `experimental_repairToolCall` | `scripts/run.sh` | JSON: `{ status, repaired_args?, error? }` |
| `stop-condition` | contributes to `stopWhen` | `scripts/run.sh` | JSON: `{ stop: boolean, reason?: string }` |
| `tool-pre` | wraps each tool's `execute` (before) | `scripts/run.sh` | JSON: `{ status, args?, error? }` (modified args replace the original) |
| `tool-post` | wraps each tool's `execute` (after) | `scripts/run.sh` | JSON: `{ status, result?, error? }` (modified result replaces the original) |
| `stream-transform` | `experimental_transform` (stream only) | `scripts/run.sh` | streaming output (line-delimited or chunked) |
| `subagent` | (model invokes via `activate_skill`) | optional `scripts/run.sh` | If script exists, runs in subagent context; else SKILL.md body becomes the subagent's system prompt |
| (unset) | none — model activation only | optional | (skill body goes into context) |

#### 4.4.1 Trigger argument passing

The harness invokes the script with arguments and stdin payload conventions:

- **Argv**: `scripts/run.sh <trigger-name> <skill-dir-absolute>` so the script can resolve sibling files (`references/`, `assets/`).
- **Stdin**: a JSON payload with the AI SDK hook context. For example, `prepare-call` receives `{ options, settings: { model, instructions, tools, activeTools, providerOptions, ... } }` on stdin. `step-finish` receives `{ stepResult: { text, toolCalls, toolResults, usage, finishReason } }`.
- **Stdout**: the script's structured JSON response per the table above.
- **Stderr**: diagnostics (logged by the harness; not fed back to the model).
- **Exit code**: 0 = `status: ok`, non-zero = `status: error`. The harness logs and propagates accordingly.

The script contract is fully specified in spec #3 (skill content rewrite). This spec only fixes the AI SDK integration shape.

#### 4.4.2 Multiple skills with the same trigger

If two skills both have `metadata.harness-trigger: prepare-call`, the harness composes them in deterministic order:

1. Sort by `metadata.harness-trigger-priority` (number, default 100; lower first).
2. Tiebreak by skill `name` (alphabetical).

Each script's output is merged into the running settings, so later scripts see the prior scripts' modifications. The merge for object-typed fields (`instructions`, `tools`) is *append* (concat strings, merge tool sets); for scalar fields the last writer wins.

#### 4.4.3 Trigger errors don't crash the run by default

If a trigger script returns `status: error`, the harness logs the error and continues with the unmodified settings (for `prepare-*`) or treats the observation as a no-op (for `*-finish`). Exception: if the script returns `{ status: error, error: { action: "abort" } }`, the harness aborts the run with `error.message` as the reason. This mirrors how `stopWhen` and tool-execution errors propagate today.

### 4.5 Schedule integration

`metadata.harness-schedule: "<cron>"` causes the harness scheduler at boot to register a job that fires `agent.generate(...)` at the cron times. The fired call uses the skill itself as the system prompt:

```
[ identity ]
[ rules ]
[ state ]

You are running the "<skill-name>" workflow on schedule.

[ skill body ]
```

Scheduled skills don't appear in the catalog (they're not user-invoked). They run in their own session with `metadata.harness-source: scheduled` recorded in the session for later analytics.

The existing scheduler ([src/runtime/scheduler.ts](../../src/runtime/scheduler.ts) — path to verify) is updated to:
1. Read `metadata.harness-schedule` from every skill at boot.
2. Register cron jobs.
3. On fire, construct an `agent.generate()` with the skill as system prompt.
4. Honor existing rate-limit / quiet-hours / proactive config.

The current `workflows/` cron logic is removed once migration is complete.

### 4.6 Subagent delegation

Skills with `metadata.harness-trigger: subagent` are activated via the same `activate_skill` tool the model uses for ordinary skills, but instead of inserting the body into the current conversation, the harness:

1. Spawns a fresh `agent.generate()` with the skill body as system prompt.
2. Passes the `args` from the `activate_skill` call as the user prompt of the subagent.
3. Optionally narrows the subagent's tool set via `metadata.harness-active-tools` (a comma-separated list — namespaced under `harness-` because spec mandates string-only metadata for skills).
4. Returns the subagent's final text as the tool result to the parent.

This implements [Subagent delegation](https://agentskills.io/client-implementation/adding-skills-support#subagent-delegation-optional) directly. It also subsumes the current `agents/` primitive: every `agents/foo.md` becomes `skills/foo/SKILL.md` with the subagent trigger.

A skill that has both `metadata.harness-trigger: subagent` AND `scripts/run.sh` runs the script INSTEAD of the LLM-based subagent. The script's output (per the structured contract) is returned. Use case: deterministic delegations like "summarize this file" that don't need an LLM call.

### 4.7 The `activate_skill` tool

A built-in tool registered automatically when the harness has any non-lifecycle skills. Schema:

```typescript
{
  name: 'activate_skill',
  description: 'Load a skill\'s full instructions into context. Pass the name of one of the available skills.',
  inputSchema: z.object({
    name: z.enum([...availableSkillNames]),  // dynamically populated
    args: z.string().optional(),              // for subagent skills
  }),
  execute: async ({ name, args }) => {
    const skill = lookup(name);
    if (skill.trigger === 'subagent') return runSubagent(skill, args);
    return formatSkillContent(skill);
  }
}
```

The `name` parameter is constrained to the literal set of available skill names (per the [Adding skills support guide](https://agentskills.io/client-implementation/adding-skills-support#step-4-activate-skills) tip about preventing hallucination). When the harness has zero non-lifecycle skills, `activate_skill` is not registered (the catalog is also empty in that case).

#### 4.7.1 Tool result format

Following the spec's [Structured wrapping](https://agentskills.io/client-implementation/adding-skills-support#structured-wrapping) recommendation:

```xml
<skill_content name="research">
[skill body, with frontmatter stripped]

Skill directory: /absolute/path/to/skills/research
Relative paths in this skill are relative to the skill directory.

<skill_resources>
  <file>scripts/search.sh</file>
  <file>references/sources.md</file>
  <file>assets/report-template.md</file>
</skill_resources>
</skill_content>
```

The wrapping serves two purposes per the spec: distinguishing skill content from other conversation, and enabling the harness to identify and protect skill content during context compaction (see §4.9).

#### 4.7.2 Activation deduplication

The harness tracks which skills have been activated in the current session. If the model calls `activate_skill` for a name already activated this session, the harness returns a short result (`"Skill <name> is already loaded earlier in this conversation."`) instead of re-injecting the body. This prevents accidental duplicate loading.

### 4.8 Loader and primitive directory changes

Required updates beyond spec #1:

| File | Change |
|---|---|
| [src/core/types.ts](../../src/core/types.ts) | `CORE_PRIMITIVE_DIRS` becomes `['skills', 'rules']`. `PrimitiveType` enum loses `'instinct' \| 'playbook' \| 'workflow' \| 'tool' \| 'agent'`. |
| [src/primitives/loader.ts](../../src/primitives/loader.ts) | `BUNDLE_ENTRY_BY_KIND` becomes `{ skills: 'SKILL.md', rules: 'RULE.md' }`. The "bundling not supported" error for non-listed kinds becomes irrelevant since those kinds no longer exist as directories. |
| [src/runtime/context-loader.ts](../../src/runtime/context-loader.ts) | New system-prompt assembly per §4.3. Drop all per-kind-specific context logic. |
| [src/runtime/scheduler.ts](../../src/runtime/scheduler.ts) | Read schedule metadata from skills, not from a workflows directory. |
| [src/runtime/tool-executor.ts](../../src/runtime/tool-executor.ts) | Delete the markdown HTTP tool execution path. The file may still exist for AI-SDK tool wrapping; if so, gut the markdown-tool half. |
| [src/runtime/dispatch.ts](../../src/runtime/dispatch.ts) (or wherever the agent loop lives) | Wire `prepareCall`/`prepareStep`/`onStepFinish`/`onFinish` to invoke matching skills' scripts. |
| [src/runtime/agent-tools.ts](../../src/runtime/agent-tools.ts) (or wherever sub-agents are exposed) | Replace `agents/` registration with `skills/` filtered by `metadata.harness-trigger === 'subagent'`. |
| [src/cli/index.ts](../../src/cli/index.ts) | Remove `harness agents`, remove or repurpose `harness delegate`, remove `harness workflow list/run` (replaced by listing skills with schedule metadata). The durable-workflow commands (`harness workflows status/inspect/resume/cleanup`) **stay** — they manage runs, not workflow-as-primitive. |

### 4.9 Context compaction protection

Per [Adding skills support: Step 5](https://agentskills.io/client-implementation/adding-skills-support#step-5-manage-skill-context-over-time): skill instructions in conversation context must be exempt from compaction. The harness flags every `activate_skill` tool result as protected. The compaction routine ([src/runtime/conversation.ts](../../src/runtime/conversation.ts) — path to verify) checks the `<skill_content>` tag and skips messages that contain it.

### 4.10 Harness doctor migration (extends spec #1)

`harness doctor --migrate` is extended with the primitive collapse logic. New steps after the spec #1 migration completes:

1. **Move `instincts/*` → `rules/*`**: each file is moved into `rules/` with `author: agent` and `metadata.harness-source: learned` added. Existing `rules/` entries with the same name produce a conflict, reported and skipped.

2. **Move `playbooks/*` → `skills/*`**: bundled playbooks (`playbooks/foo/PLAYBOOK.md`) move directory and entry-file rename. Flat playbooks (`playbooks/foo.md`) restructure into bundles.

3. **Move `workflows/*` → `skills/*`**: same as playbooks, plus lift `schedule` from top-level frontmatter into `metadata.harness-schedule`. Lift `durable`, `max_retries`, `retry_delay_ms`, `channel` similarly.

4. **Move `agents/*` → `skills/*`**: same restructure, plus add `metadata.harness-trigger: subagent` and lift `model` and `active_tools`.

5. **Convert `tools/*` → `skills/*` with auto-generated scripts**: this is the most invasive migration. The harness reads each `tools/foo.md`, parses its `## Operations` and `## Authentication` sections, generates a `scripts/call.sh` (Bash + curl + jq) wrapping the API, and writes a thin SKILL.md body that points at the script. The user is told to review the generated script before deploying. **If the tool's markdown is too unstructured to parse safely, the migration skips it with an error message and the user must convert manually.**

6. **Delete empty primitive directories** after migration: `instincts/`, `playbooks/`, `workflows/`, `tools/`, `agents/` are removed once empty.

7. **Update `config.yaml`**: any references to `extensions.directories` that name removed primitive types are stripped or renamed.

The migration log records each move so the user has a clean audit trail.

## 5. Behavior changes (user-visible)

| Before | After |
|---|---|
| 7 primitive directories at the harness root | 2 primitive directories: `skills/` and `rules/` |
| `workflows/foo.md` with `schedule: "0 22 * * *"` top-level | `skills/foo/SKILL.md` with `metadata.harness-schedule: "0 22 * * *"` |
| `tools/foo.md` (markdown HTTP description) | `skills/foo/SKILL.md` + `scripts/call.sh` (auto-generated, user-reviewable) |
| `agents/foo.md` (sub-agent definition) | `skills/foo/SKILL.md` with `metadata.harness-trigger: subagent` |
| `playbooks/foo.md` | `skills/foo/SKILL.md` |
| `instincts/foo.md` (auto-installed by `harness learn`) | `rules/foo.md` with `author: agent`, `metadata.harness-source: learned` |
| System prompt loads all primitives at L1 (~50–100 tok each) | Identity + rules always full body; skills only `name`+`description` until activated |
| `harness workflow list` / `harness workflow run` | `harness skill list --scheduled` / `harness skill run` (or just rely on the scheduler) |
| `harness agents` / `harness delegate <agent-id>` | `harness skill list --trigger subagent` / model invokes via `activate_skill` |
| Lifecycle hooks via TypeScript `HarnessHooks` only | Lifecycle hooks authorable as skills with `metadata.harness-trigger: <event>` |

## 6. Implementation plan

Phase numbers continue from spec #1 to make the overall implementation order explicit.

### Phase 7: Loader & types

| # | File | Change |
|---|---|---|
| 7.1 | [src/core/types.ts](../../src/core/types.ts) | `CORE_PRIMITIVE_DIRS` → `['skills', 'rules']`. Drop `PrimitiveType` values for removed kinds. |
| 7.2 | [src/primitives/loader.ts](../../src/primitives/loader.ts) | `BUNDLE_ENTRY_BY_KIND` → `{ skills: 'SKILL.md', rules: 'RULE.md' }`. |
| 7.3 | [src/core/types.ts](../../src/core/types.ts) | Add validation for `harness-trigger` enum and `harness-schedule` cron format on skill metadata. |

### Phase 8: System prompt assembly

| # | File | Change |
|---|---|---|
| 8.1 | [src/runtime/context-loader.ts](../../src/runtime/context-loader.ts) | New assembly per §4.3. Identity + rules always full body; skill catalog with `name`+`description`+`location`; lifecycle-triggered and scheduled skills excluded from catalog. |
| 8.2 | [src/runtime/conversation.ts](../../src/runtime/conversation.ts) | Add compaction protection for `<skill_content>` blocks per §4.9. |

### Phase 9: Activation tool

| # | File | Change |
|---|---|---|
| 9.1 | [src/runtime/skill-activation.ts](../../src/runtime/skill-activation.ts) (new) | Implement `activate_skill` tool: enum-constrained name parameter, lookup, body-formatting with `<skill_content>` wrapping, resource listing, deduplication. |
| 9.2 | [src/runtime/tool-executor.ts](../../src/runtime/tool-executor.ts) | Auto-register `activate_skill` when there are non-lifecycle skills. |
| 9.3 | [src/runtime/skill-activation.ts](../../src/runtime/skill-activation.ts) | Implement subagent path: spawn `agent.generate()` with skill body as system prompt, return final text. |

### Phase 10: AI SDK trigger wiring

| # | File | Change |
|---|---|---|
| 10.1 | [src/runtime/triggers.ts](../../src/runtime/triggers.ts) (new) | Group skills by `harness-trigger`, expose as functions matching AI SDK signatures: `composedPrepareCall(options)`, `composedOnStepFinish(stepResult)`, etc. Each composed function invokes matching scripts in priority order, merges results. |
| 10.2 | [src/runtime/triggers.ts](../../src/runtime/triggers.ts) | Implement script invocation: spawn process with argv (trigger name, skill dir), pipe JSON to stdin, capture stdout+exit code, parse and merge. Timeout per script (default 5s, configurable). |
| 10.3 | [src/core/harness.ts](../../src/core/harness.ts) (or wherever `agent.generate()` is constructed) | Pass composed trigger functions to ToolLoopAgent options. |
| 10.4 | [src/runtime/triggers.ts](../../src/runtime/triggers.ts) | Implement `tool-pre` / `tool-post` via existing `wrapToolSet` plumbing. |

### Phase 11: Scheduler

| # | File | Change |
|---|---|---|
| 11.1 | [src/runtime/scheduler.ts](../../src/runtime/scheduler.ts) | Read `metadata.harness-schedule` from skills (not from `workflows/`). Register cron jobs. On fire, construct an `agent.generate()` with skill as system prompt. |
| 11.2 | [src/runtime/scheduler.ts](../../src/runtime/scheduler.ts) | Carry over existing rate-limit / quiet-hours / proactive config — none of those concepts change. |
| 11.3 | [src/runtime/durable-engine.ts](../../src/runtime/durable-engine.ts) | If a scheduled skill has `metadata.harness-durable: true`, route through `durableRun()` (existing path). |

### Phase 12: Doctor migration

| # | File | Change |
|---|---|---|
| 12.1 | [src/runtime/doctor.ts](../../src/runtime/doctor.ts) | Add migration steps for instincts → rules, playbooks → skills, workflows → skills with schedule, agents → skills with subagent, tools → skills with auto-generated scripts. |
| 12.2 | [src/runtime/doctor.ts](../../src/runtime/doctor.ts) | Empty-directory cleanup. |
| 12.3 | [src/runtime/doctor.ts](../../src/runtime/doctor.ts) | Auto-generation of `scripts/call.sh` from a `tools/foo.md` `## Operations` section. Bash + curl + jq template. Refuse if the tool's markdown lacks a parseable `## Operations` section. |

### Phase 13: CLI

| # | File | Change |
|---|---|---|
| 13.1 | [src/cli/index.ts](../../src/cli/index.ts) | Remove `harness agents` and `harness delegate`. Add `harness skill list [--scheduled \| --trigger=<name>]`. Update `harness workflow run <name>` to `harness skill run <name>`. |
| 13.2 | [src/cli/index.ts](../../src/cli/index.ts) | The durable workflow management commands (`harness workflows status/inspect/resume/cleanup`) stay — they manage *runs*, not workflow-as-primitive. The naming feels off post-migration ("workflows" vs "skills") but renaming is a follow-up; keep the names for backward-compat. |

### Phase 14: Defaults migration

| # | File/Dir | Change |
|---|---|---|
| 14.1 | [defaults/instincts/](../../defaults/instincts/) | Migrate all 4 (`lead-with-answer.md`, `read-before-edit.md`, `search-before-create.md`, `qualify-before-recommending.md`) to `defaults/rules/` with `author: agent`, `metadata.harness-source: learned`. |
| 14.2 | [defaults/playbooks/ship-feature.md](../../defaults/playbooks/ship-feature.md) | Convert to `defaults/skills/ship-feature/SKILL.md`. Spec-conform frontmatter. |
| 14.3 | [defaults/workflows/daily-reflection.md](../../defaults/workflows/daily-reflection.md) | Convert to `defaults/skills/daily-reflection/SKILL.md` with `metadata.harness-schedule`. |
| 14.4 | [defaults/tools/](../../defaults/tools/) | Each tool gets a converted skill bundle with auto-generated `scripts/call.sh` (or hand-written if doctor's auto-generation refuses). |
| 14.5 | [defaults/agents/](../../defaults/agents/) | Each agent → `defaults/skills/<name>/SKILL.md` with `metadata.harness-trigger: subagent`. |

### Phase 15: Documentation

| # | File | Change |
|---|---|---|
| 15.1 | [README.md](../../README.md) | Replace "The 7 primitives" table with the 2-primitive shape. Update directory diagram. Document the trigger metadata table from §4.4. |
| 15.2 | [README.md](../../README.md) | Update "Sub-agents and delegation" section to reflect the subagent-trigger pattern. Update "CLI agent delegation" if it references the agents primitive type. |
| 15.3 | [docs/skill-authoring.md](../../docs/skill-authoring.md) (created in spec #1) | Add sections on writing lifecycle-triggered skills, scheduled skills, and subagent skills. |

## 7. Tests

### 7.1 Loader & types

| Test | Asserts |
|---|---|
| `loader — only skills/ and rules/ scanned` | Files in `instincts/`, `playbooks/`, etc. are NOT loaded after migration |
| `loader — harness-trigger validation` | Invalid trigger value rejected; valid values accepted |
| `loader — harness-schedule validation` | Invalid cron rejected; valid cron accepted |
| `loader — multiple triggers per skill rejected` | Skill with both `harness-trigger: prepare-call` and `harness-trigger: subagent` errors |

### 7.2 System prompt

| Test | Asserts |
|---|---|
| `system-prompt — identity loaded` | IDENTITY.md content is in the prompt |
| `system-prompt — rules concatenated full body` | All active rules appear in full |
| `system-prompt — skill catalog contains discoverable skills` | Skills with no trigger appear with name+description+location |
| `system-prompt — lifecycle skills NOT in catalog` | A skill with `harness-trigger: prepare-call` is excluded |
| `system-prompt — scheduled skills NOT in catalog` | A skill with `harness-schedule` is excluded |
| `system-prompt — subagent skills appear in catalog` | A skill with `harness-trigger: subagent` IS in the catalog (model can invoke it) |

### 7.3 Activation

| Test | Asserts |
|---|---|
| `activate_skill — registered when skills exist` | Tool present in tool set |
| `activate_skill — not registered when zero skills` | Tool absent |
| `activate_skill — name enum-constrained` | Calling with an unknown name fails validation, doesn't reach lookup |
| `activate_skill — body returned with structured wrapping` | Response contains `<skill_content name="...">` and `<skill_resources>` |
| `activate_skill — deduplication` | Second call for same skill returns short "already loaded" message |
| `activate_skill — subagent path` | Skill with `harness-trigger: subagent` runs in fresh agent.generate() and returns final text |
| `activate_skill — subagent with script path` | Skill with both `harness-trigger: subagent` and `scripts/run.sh` runs the script, not the LLM |

### 7.4 Triggers

| Test | Asserts |
|---|---|
| `prepare-call — instructions injected` | Script returning `{ instructions: "extra" }` causes the next call to include "extra" appended |
| `prepare-call — multiple skills compose in priority order` | Two scripts with priorities 50 and 100 fire in that order; output reflects both |
| `prepare-call — error doesn't crash` | Script returning `status: error` is logged, run continues |
| `prepare-call — abort action terminates` | Script returning `{ status: error, error: { action: 'abort' } }` aborts the run |
| `step-finish — observation only` | Returned `instructions` from step-finish are ignored (it's an observation hook) |
| `tool-pre — args modification` | Script returning modified args replaces the original args before tool execution |
| `tool-post — result modification` | Same for tool result |
| `repair-tool-call — fix invalid args` | Script returning repaired args makes the failing call succeed |
| `stop-condition — early stop` | Script returning `{ stop: true }` halts the run at step boundary |

### 7.5 Schedule

| Test | Asserts |
|---|---|
| `schedule — cron parsed` | Invalid cron rejected; valid cron registered |
| `schedule — fires at expected time` | Mock clock; scheduler fires within tolerance |
| `schedule — quiet hours respected` | Cron during quiet hours doesn't fire |
| `schedule — durable: true routes through durableRun` | Same scheduled skill but durable triggers the right execution path |

### 7.6 Migration

| Test | Asserts |
|---|---|
| `migrate — instincts → rules` | All instincts moved; frontmatter rewritten with `author: agent` |
| `migrate — playbooks → skills bundle` | Restructured correctly |
| `migrate — workflows → skills with schedule metadata` | `schedule` field lifted into `metadata.harness-schedule` |
| `migrate — agents → skills with subagent trigger` | Trigger metadata added; original removed |
| `migrate — tools → skills with auto-generated script` | Script generated from `## Operations`; SKILL.md body is thin pointer |
| `migrate — tools that can't be auto-generated` | Skipped with clear error message; manual conversion required |
| `migrate — empty primitive dirs removed` | After migration, `instincts/`, `playbooks/`, etc. don't exist |
| `migrate — idempotent` | Running twice on a fresh harness leaves it unchanged on the second run |

### 7.7 End-to-end

| Test | Asserts |
|---|---|
| `e2e — old harness migrates and runs` | A harness with all 7 primitive types migrates cleanly and runs an agent.generate() |
| `e2e — scheduled skill fires and produces session` | Schedule fires; session record written with `metadata.harness-source: scheduled` |
| `e2e — lifecycle script modifies call` | A `prepare-call` skill alters the system prompt for one run; baseline run unaffected |

## 8. Open questions and risks

### 8.1 Resolved during brainstorming

- **Lifecycle events as primitive type vs. metadata trigger**: resolved — metadata trigger on skills, no new primitive type.
- **AI SDK primitives vs. inventing our own hooks**: resolved — use AI SDK options; only `boot`/`shutdown`/`error`/`pre-compact` stay as harness-level since they're outside the per-call lifecycle.
- **Activation mechanism**: resolved — dedicated `activate_skill` tool with enum-constrained name, structured wrapping per spec.
- **Subagent delegation**: resolved — same `activate_skill` path with skill metadata indicating subagent execution.

### 8.2 Open

- **Auto-generation of scripts from `tools/*.md` markdown**: how robust can the parser be? The fallback (skip with error) is safe, but we'd like a high success rate on common cases. Plan: ship a hand-tested generator that supports the documented `## Authentication` + `## Operations` shape from existing default tools, document the limitations, and accept manual rewrites for everything else. If success rate is below ~70% on default tools, escalate to "manual conversion only" as the migration policy.
- **Should `metadata.harness-active-tools` for subagent skills accept comma-separated string (per spec's metadata constraint) or array (which would require non-skill metadata semantics)?** Skills are spec-strict. Comma-separated string is the only spec-conformant option. The loader splits at parse time. Acceptable — documenting in skill-authoring guide.
- **Naming**: post-migration, the durable-workflow CLI commands (`harness workflows status/resume`) refer to `runs`, not the now-defunct workflows directory. Renaming to `harness runs status/resume` is cleaner but a follow-up. Leaving as-is for spec #2; flag for future.

### 8.3 Risks

- **R1**: Auto-generated scripts from `tools/*.md` may have security issues (curl with user-controlled URLs, jq filters from markdown). Mitigation: generated scripts log every external call, the user is told to review before deploying, and the doctor command emits a banner: *"Auto-generated scripts at <paths>. Review before running."* Spec #3 will tighten the script contract further.
- **R2**: Lifecycle scripts run as subprocesses on every relevant AI SDK event. A prepare-call hook on every call could add 20–500ms per call. Mitigation: timeout (default 5s), warn if a hook exceeds 1s, document the cost.
- **R3**: The `activate_skill` tool's enum-constrained name means schema regenerates whenever skills change. Adding a new skill mid-session won't be visible until restart. Mitigation: document this; users dev-mode (`harness dev`) restarts on file change anyway.
- **R4**: Migrating a heavy-customized harness may produce noisy output. Mitigation: doctor `--migrate --dry-run` shows a preview before writing.
- **R5**: Some users may have built custom tooling that walks the old primitive directories. Mitigation: the migration is opt-in (must run `--migrate`), and the loader can run in lenient mode for one minor version while users adapt.

## 9. Backward compatibility & migration path

This is a major breaking change on top of spec #1. Combined release:

- **0.9.0**: spec #1 schema changes + spec #2 primitive collapse, both behind `harness doctor --migrate`. Old harnesses load with strict errors pointing at the migration command. Lenient mode (set via `config.yaml: loader.lenient: true`) downgrades errors to warnings during the transition.
- **1.0.0**: lenient mode removed. CORE.md fallback removed. Strict only.

Users on 0.8.x:

1. `npm install -g @agntk/agent-harness@0.9.0`
2. `harness doctor --check` to preview
3. `harness doctor --migrate` to apply
4. Manual review of any tool migrations (banner on auto-generated scripts)
5. Commit

The migration is non-destructive: deleted directories are tracked in the migration log, and the user has git for true rollback.

## 10. Definition of done

- All loader, system-prompt, activation, trigger, schedule, and migration tests in §7 pass
- `harness doctor --migrate` is idempotent on the migrated repo's own [defaults/](../../defaults/) and [templates/](../../templates/)
- A migration test fixture (`tests/fixtures/old-harness-7-primitives/`) successfully migrates to 2-primitive shape and runs cleanly
- README "The 7 primitives" section replaced with the new shape
- Skill-authoring guide updated with trigger/schedule/subagent sections
- The `activate_skill` tool name-enum is correctly populated and the model can successfully invoke at least one skill in a smoke test
- A scheduled skill fires within tolerance and produces a session record
- A `prepare-call` lifecycle skill modifies a call as expected in an integration test
- A `subagent`-trigger skill runs in a fresh `agent.generate()` and returns a result
- A `tools/*.md` migration test produces a runnable, structured-output `scripts/call.sh` for at least 3 of the existing default tools
- `npm test` passes
- `npm run lint` passes
- `npm run build` produces a working `dist/cli/index.js`
- Post-publish smoke test (per user CLAUDE.md §10) verifies `harness --version`, `harness init test-agent`, `harness doctor --check`, and `harness skill list` all succeed

---

*End of design.*
