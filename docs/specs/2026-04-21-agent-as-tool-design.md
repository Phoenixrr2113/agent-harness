# Agent-as-Tool — Design Spec

**Date:** 2026-04-21
**Status:** draft, awaiting approval

## Problem

`agents/*.md` primitives today are only invokable via the `harness delegate` CLI. The PRIMARY agent in a `harness run` cannot call them during its own reasoning. This forces multi-agent workflows to be orchestrated by the human across multiple CLI invocations, defeating the point of having a delegation primitive.

## Goal

Auto-expose every `agents/*.md` file as a callable tool on the primary agent's tool set. Primary agents can then delegate subtasks mid-reasoning — "I need to research X, I'll call the researcher" — and receive the subagent's final text as a tool result. Matches the AI SDK's canonical subagent pattern: a subagent wrapped in a `tool()` whose execute calls `subagent.generate({ prompt })`.

## Non-goals

- **Workflow orchestration primitives** (sequential, parallel, evaluator-optimizer). The AI SDK treats these as patterns in user code, not runtime features. Same stance here.
- **toModelOutput-equivalent summarization.** Subagents return their raw final text; if they want to summarize, their own instructions should say so.
- **Nested delegation** (subagent calling another subagent). Explicit block in v1 to prevent runaway cost/loops.
- **Parallel subagent invocation.** Primary can call subagents sequentially; parallel is future scope.
- **Refactoring existing commands** (`harness journal`, `harness learn`, `harness harvest`) onto this primitive. They work as hardcoded functions; converting them is scope creep.

## Design decisions

### 1. Auto-registration

**Decision:** every file in `agents/*.md` with `status: active` is auto-registered as a tool on the primary. No opt-in flag required.

**Rationale:** matches how MCP tools work (no per-tool opt-in), keeps the primitive simple. Users who want to hide an agent can set `status: draft` or use `active_tools` on the primary to narrow.

### 2. Tool naming

**Decision:** tool name = agent's frontmatter `id`. No prefix (e.g., not `delegate_to_`).

**Rationale:** the existing `id` field is already kebab-case and unique; adding a prefix bloats the tool name without improving clarity. Users naming an agent `researcher` get a tool called `researcher`. Reads naturally in model reasoning traces ("I'll use the researcher...").

**Collision handling:** if an agent's id matches an MCP tool name, emit a `warn` log ("tool name collision: agent 'foo' shadows MCP tool 'foo'"). The agent tool takes precedence. Users can rename the agent.

### 3. Tool input schema

**Decision:** single required field, `prompt: string`. No optional fields in v1.

**Rationale:** matches the AI SDK's canonical subagent pattern. Keeps the parent model's invocation simple. Structured inputs can be encoded in the prompt text; future schema evolution is backward-compatible additive.

### 4. Tool description

**Decision:** use agent doc's `l1` summary as the tool description. Fall back to `l0` if `l1` is empty. Allow explicit override via new optional frontmatter field `description?: string`.

**Rationale:** existing agents already have l0/l1 summaries (required by the primitive system). Reusing them avoids redundancy. Explicit override is there for agents whose L1 isn't the best tool description.

### 5. Subagent tool access (no nesting in v1)

**Decision:** when a subagent is invoked, its tool set includes MCP tools, markdown HTTP tools, and programmatic tools — but **NOT** other agent-tools. Nested delegation is blocked by construction, not by runtime check.

**Rationale:** two wins — (a) no depth counter needed, (b) prevents accidental infinite recursion. The mechanism: a new `buildAgentTools(harnessDir)` function builds just the agent-tool wrappers; primary's tool set includes MCP + HTTP + agent-tools; subagent's tool set includes MCP + HTTP only.

### 6. Subagent's own tools/MCP

**Decision:** the subagent receives the same MCP/HTTP tool set the primary sees (minus agent-tools). Narrowing is via the subagent's own `active_tools` frontmatter field (already in as of feat/active-tools).

**Rationale:** matches how `delegate.ts` works today. Allows a subagent to declare "I only need read_text_file and search_files" via `active_tools`. No change needed to delegate.ts for this.

### 7. Session tracking

**Decision:** each subagent invocation writes a session file with `delegated_to: <agent-id>` (delegate.ts already does this). Parent's session references child sessions via the tool-call record.

**Rationale:** no changes — delegate.ts's existing session-writing behavior is correct. Journal synthesis will see both the parent's session and the subagents' sessions, which is useful for learning ("agent X kept invoking researcher to do Y — make that an instinct").

### 8. Error handling

**Decision:** subagent errors surface to the parent as a tool result with an `error` field: `{ error: "message", agentId: "..." }`. Parent model can retry, ask for help, or give up. AbortSignal from parent propagates to subagent (SDK handles this).

**Rationale:** matches the AI SDK pattern. Letting errors bubble up as tool failures (throwing in `execute`) would abort the parent loop, which is too brittle.

### 9. Model routing per subagent

**Decision:** existing `model: primary | summary | fast` frontmatter on the agent selects which config-level model the subagent uses. No change.

### 10. Nesting depth

**Decision:** hard block at depth 1 (parent → child, no grandchildren). Enforced structurally by point 5 (subagent's tool set excludes agent-tools), so no runtime check needed.

**Future:** if N-level nesting is valuable, add a `max_delegation_depth` config field + per-invocation counter.

## Schema changes

### `src/core/types.ts` — FrontmatterSchema

Add one optional field:

```typescript
/** Explicit tool description when this agent is exposed as a tool. Falls back to l1 then l0. */
description: z.string().optional(),
```

No other schema changes required. `active_tools` already added in feat/active-tools. `model` tier already exists.

## Code touch points

### NEW: `src/runtime/agent-tools.ts`

Exposes one function:

```typescript
export function buildAgentTools(
  harnessDir: string,
  apiKey?: string,
): AIToolSet
```

Loads `agents/*.md` docs, filters to `status: active`, wraps each in a `tool()` from the AI SDK with:
- `description` = doc.frontmatter.description ?? doc.l1 ?? doc.l0
- `inputSchema` = `z.object({ prompt: z.string() })`
- `execute` = calls `delegate({ harnessDir, agentId, prompt, apiKey })` and returns `result.text` (on success) or `{ error: msg, agentId }` (on failure)

### MODIFY: `src/runtime/tool-executor.ts`

`buildToolSet(harnessDir, opts?, mcpTools?)` currently merges MCP + markdown HTTP + programmatic tools. Update: also merge `buildAgentTools(harnessDir)` result when called from the primary path.

Introduce a new param or a sibling function so `delegate.ts` can get a tool set WITHOUT the agent-tools (to enforce depth-1 non-nesting). Proposed approach:

```typescript
export function buildToolSet(harnessDir, opts?, mcpTools?, options?: { includeAgentTools?: boolean })
```

Default `includeAgentTools` to `true` for primary invocations; `delegate.ts`'s internal call to `buildToolSet` passes `false`.

### MODIFY: `src/runtime/delegate.ts`

Single change: in `prepareDelegation` (line 222 today), pass `includeAgentTools: false` when calling `buildToolSet`. One-line change.

### NO CHANGES needed elsewhere

- `src/core/harness.ts` — already calls `buildToolSet`; will transparently pick up agent-tools
- CLI — no flag changes; `harness run` just works
- `src/cli/scaffold.ts` — no changes (defaults/templates will ship new `agents/*.md` files; scaffold copies them as-is)

## Flow (primary run)

1. User: `harness run "I need to ship a release"`.
2. `harness run` → `createHarness()` → `buildToolSet(dir)` returns: `{...MCP, ...HTTP, ...agentTools}`.
3. Primary model sees e.g. `shell`, `read_text_file`, `writer_file`, `edit_file`, `list_directory`, `summarizer`, `reviewer`, `shipper` (or whatever agents/ contains).
4. Primary decides: "shipping needs the shipper checks."
5. Primary calls tool `shipper({ prompt: "check release readiness for..." })`.
6. The tool's `execute` runs `delegate({ harnessDir, agentId: 'shipper', prompt })`.
7. Delegate loads `agents/shipper.md`, its model tier, its active_tools. `buildToolSet` with `includeAgentTools: false` — subagent gets MCP/HTTP but not other agents.
8. Subagent runs its generation loop, returns final text.
9. `delegate` writes a session record with `delegated_to: 'shipper'` and returns `{ text, usage, sessionId }`.
10. Tool's execute returns `result.text` to the parent.
11. Parent continues reasoning with the shipper's findings.

## Which existing tools become agents (and which new ones to ship)

### Keep as direct tools (NOT subagents)

- **Filesystem MCP** — data access, not reasoning
- **shell-exec MCP** — command execution, not reasoning
- **Markdown HTTP tools** — single API call per invocation

### Ship as subagents in DEFAULTS (every `harness init`)

- **`summarizer`** (already exists, `model: fast`) — text summarization. Already usable via delegate CLI; with this feature, primary can call it mid-reasoning.
- **`planner`** (NEW) — given any ambiguous ask, return a bounded plan (Atomic Task Spec style). Generic across all domains. Primary can call it to decompose complex asks.

### Ship as subagents in `-t dev` TEMPLATE

- **`reviewer`** (NEW) — given a diff or file change, check for bugs / security / style / test coverage. Model: `primary` (needs strong reasoning).
- **`test-runner`** (NEW) — run `npm test` (or project equivalent), parse failure output, report. Model: `fast` (output parsing is cheap). Uses shell tool.

Deferred to later (not in v0.2.0):

- `committer` — writes commit messages from staged changes
- `researcher` — codebase search + synthesis
- `shipper` — release-readiness checks from CLAUDE.md §10
- Refactor of `harness journal` / `harness learn` / `harness harvest` to use subagent pattern internally

### Why these four, not more

- `summarizer` + `planner` are generic → good defaults
- `reviewer` + `test-runner` exercise the feature end-to-end on a realistic dev workflow → good v1 demo for `-t dev`
- Any more and we're shipping unvalidated design. Add subagents incrementally as real use cases emerge.

## Testing strategy

**Unit tests (`tests/runtime/agent-tools.test.ts`):**

- `buildAgentTools` returns ToolSet with correct keys for each `agents/*.md` with `status: active`
- Agents with `status: draft` or `status: archived` are excluded
- Tool description falls back through `description → l1 → l0`
- Tool input schema validates `{ prompt: string }`
- Collision with MCP tool name emits a warn and agent wins

**Integration test (`tests/integration/agent-as-tool.test.ts`):**

- Create temp harness with `agents/test-echo.md` (instruction: "echo the prompt verbatim")
- Call `harness.run("Use test-echo to repeat this back: HELLO_SUBAGENT")`
- Assert: subagent session written with `delegated_to: test-echo`
- Assert: primary's final output contains "HELLO_SUBAGENT"
- Assert: delegate.ts's toolSet does NOT contain other agent-tools

**E2E smoke (not in CI; manual via dogfooder):**

- Update dogfooder (`~/agents/harness-dev/`) to add `agents/reviewer.md`
- Prompt: "Review the diff between HEAD and HEAD~1"
- Verify primary invokes `reviewer` via tool call, reviewer produces a review, primary surfaces it

## Scalability notes

- Each active agent = +1 tool on the primary. At 10 agents + 16 MCP tools = 26 total. Model tool-selection accuracy degrades past ~20 tools. **Use `active_tools` on the primary (via CLI `--tools` or programmatic API) to narrow.**
- Subagent doc + CORE.md + rules loaded on every delegate call — not zero cost. For many rapid delegations in one run, primary will burn tokens. Mitigation: subagent body kept tight (tight = easier instruction-following AND cheaper).
- Session writes: each subagent call writes one session file. Ten delegations = ten session files. Journal synthesis handles this (already batched by day).

## Open questions

1. **Should the subagent see the parent's conversation history?** AI SDK allows passing `messages` through the tool's execute context. Default: NO (isolated context, matches AI SDK default). Allow later via a frontmatter flag if needed.
2. **What happens if `agents/` has zero files?** `buildAgentTools` returns `{}`, no change to primary's tool set. Already handled.
3. **Do we expose the session id back to the parent in the tool result?** Include `{ text, sessionId }` as the tool output object so parent can cite the session. Low cost, high transparency.
4. **Version bump semantics:** this is a NEW capability (not a fix); bump `0.1.8 → 0.2.0` and document the new tool surface.

## Scope tally

- `src/core/types.ts` — +3 lines (description field)
- `src/runtime/agent-tools.ts` — NEW, ~80-120 LOC
- `src/runtime/tool-executor.ts` — +5-10 LOC (includeAgentTools flag)
- `src/runtime/delegate.ts` — +1 LOC (pass flag)
- `defaults/agents/planner.md` — NEW, ~40 LOC markdown
- `templates/dev/defaults/agents/reviewer.md` — NEW, ~40 LOC markdown
- `templates/dev/defaults/agents/test-runner.md` — NEW, ~40 LOC markdown
- Tests — ~150-200 LOC

Total: ~300-500 LOC net, most of it markdown primitives and tests. Core feature is ~100 LOC.

## Rollout

- Branch: `feat/agent-as-tool`
- Build, lint, test 1076+ passing
- Ship as part of v0.2.0 alongside other queued features
