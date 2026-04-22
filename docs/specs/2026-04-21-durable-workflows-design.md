---
title: Durable workflows via Vercel Workflow Development Kit
status: draft
author: Randy Wilson
date: 2026-04-21
target_version: "0.7.0"
---

# Durable workflows via Vercel Workflow Development Kit

## Goal

Add crash-recoverable, resumable, long-running workflow execution to agent-harness
without changing the markdown user-facing surface. Users keep authoring workflows
as markdown files with cron schedules. Under the hood, scheduled workflows run
through Vercel's Workflow Development Kit (WDK) so that:

1. A process crash mid-run does not lose completed tool calls — completed steps
   replay from a cached event log.
2. A scheduler that was down when a workflow should have fired can catch up
   missed runs on boot (via suspended-run replay).
3. Long-running workflows that need to pause for hours or days (future use case)
   can call WDK's `sleep` primitive without consuming resources while paused.

## Non-goals

- Exposing `'use workflow'` / `'use step'` directives to users. Markdown stays the
  authoring surface.
- Requiring users to run a web server or Next.js / Nitro app. CLI-only.
- Distributed execution. Local World only in this spec; Postgres World is a
  follow-up if ever needed.
- Interactive `harness run` / `harness chat` durability. Those stay on the
  existing path by default.

## Context

Today, `scheduler.ts` fires a workflow at its cron time by calling
`agent.run(prompt)` once. The body of the markdown workflow is the prompt. The
AI SDK's internal tool-call loop drives tool execution. Session records are
written only after the full run completes. If the process dies mid-run, tool
calls may have fired with no record and the next cron tick starts over.

Vercel WDK is a compile-time TypeScript framework (SWC plugin transforms
`'use workflow'` / `'use step'` directives into a step bundle + workflow
bundle + client bundle). The Local World adapter stores run state in
`.workflow-data/` on the filesystem and supports `registerHandler(prefix,
handler)` for fully in-process execution, bypassing HTTP. That makes WDK
embeddable in a CLI without a web framework.

## Architecture

Agent-harness ships ONE compiled workflow file built with WDK's SWC plugin in
agent-harness's own `tsup` build. End users never see directives, never run the
SWC plugin, never add a build step.

```
@agntk/agent-harness
├── src/workflows/harness-workflow.ts   ← 'use workflow' + 'use step' directives
├── tsup.config.ts                       ← adds @workflow/swc-plugin to transforms
└── dist/workflows/harness-workflow.js  ← compiled bundle shipped to npm
```

At runtime:
- `createLocalWorld({ dataDir: '<harnessDir>/.workflow-data' })` is instantiated
  once per harness.
- In-process handlers are registered via `registerHandler('__wkf_step_', …)` and
  `registerHandler('__wkf_workflow_', …)` so no HTTP transport spins up.
- `scheduler.ts` replaces `agent.run(prompt)` with
  `start(harnessAgentWorkflow, { prompt, system, harnessDir, modelId, ... })`.
- On scheduler boot, suspended runs (paused by `sleep` whose wake time has
  passed, or runs that were mid-step when the process died) are resumed
  before new cron ticks fire.

Existing non-durable paths stay unchanged:
- `harness run` / `harness chat` / `harness delegate` keep calling `agent.run()`.
- Workflows opt in via `durable: true` in frontmatter or `workflows.durable_default: true` in `config.yaml`.
- Non-opted-in workflows retain today's behavior — zero-risk upgrade.

## Components & tool-call loop

### `src/workflows/harness-workflow.ts`

Both `llmStep` and `toolStep` receive `harnessDir` and rebuild the tool set
internally via `buildToolSet` + MCP + approval wrappers. The LLM sees the same
tool schemas whether the run is fresh or replayed (tool schemas are generated
from the rebuilt tool set on each step entry). This keeps the event log small
(just tool names + args) at the cost of rebuilding the tool set per step. For
long workflows we may cache the rebuilt tool set per run in a later revision.

```typescript
export async function harnessAgentWorkflow(input: {
  prompt: string;
  system: string;
  harnessDir: string;
  modelId: string;
  activeTools?: string[];
}) {
  'use workflow';

  const messages: Message[] = [{ role: 'user', content: input.prompt }];
  while (true) {
    const turn = await llmStep({ messages, ...input });
    messages.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls });

    if (!turn.toolCalls?.length) {
      return { text: turn.text, usage: turn.usage, messages };
    }

    for (const tc of turn.toolCalls) {
      const result = await toolStep({
        toolName: tc.toolName,
        args: tc.args,
        harnessDir: input.harnessDir,
      });
      messages.push({ role: 'tool', toolCallId: tc.id, content: result });
    }
  }
}

async function llmStep(args): Promise<LlmTurnResult> {
  'use step';
  // One LLM call. AI SDK's maxRetries set to 0 here (WDK owns retry).
  // Returns text, tool calls, usage. Classifies errors:
  //   - rate-limit / 5xx / network  → RetryableError
  //   - auth / quota / schema       → FatalError
}

async function toolStep(args): Promise<unknown> {
  'use step';
  // Reconstruct tool set (buildToolSet + MCP + approval wrappers), look up tool
  // by name, call execute(args). Thrown errors → RetryableError (maxAttempts: 2).
  // Structured {approvalDenied:...} returns pass through unchanged.
}
```

Every tool call — built-in, MCP, sub-agent, approval-wrapped — flows through
`toolStep`, so each gets an entry in the event log and replays from cache on
crash. Sub-agent delegate calls are wrapped as a single `toolStep`; the
sub-agent's internal LLM turns are not individually durable in v1.

### Provider refactor

AI SDK's `generateText` hides the tool-call loop internally. To put each tool
call on a step boundary (inside the durable workflow) we need a
`generateTurn()` that does exactly ONE model call and returns
`{ text, toolCalls, usage }` without auto-executing tools.

- New: `generateTurn(opts)` in `src/llm/provider.ts` — uses AI SDK primitives
  but stops at the first tool call, returns tool calls unexecuted. Consumed
  ONLY by `llmStep` inside the durable workflow.
- The non-durable path (`harness run`, `harness chat`, non-durable workflows)
  keeps using `generate`/`streamGenerateWithDetails` with AI SDK's internal
  loop — no behavior change, no streaming regression risk.
- `agent.run()` public signature unchanged. Durability is dispatched at the
  scheduler level (which calls `start(harnessAgentWorkflow, ...)` directly for
  opted-in workflows), not inside `agent.run()` itself.

### Scheduler integration

```typescript
// src/runtime/scheduler.ts — executeWorkflow()
const isDurable = doc.frontmatter.durable === true || config.workflows?.durable_default;

if (isDurable) {
  const run = await start(harnessAgentWorkflow, {
    prompt, system, harnessDir, modelId, activeTools,
  }, { world: getWorld(harnessDir) });
  resultText = (await run.result).text;
  tokensUsed = (await run.result).usage.totalTokens;
} else {
  // existing path: createHarness + agent.run()
}
```

On scheduler boot (before registering cron tasks), drain two buckets:

1. **Suspended runs** — paused by `sleep` whose wake time has passed. Resume
   them in wake-time order.
2. **Stale "running" runs** — marked running when the previous process died.
   These exist because WDK can't distinguish crash from live process. Resume
   in-place; WDK's step cache means completed steps return their cached result
   and only the in-flight step re-executes.

```typescript
const dueSuspended = (await listRuns({ status: 'suspended' }))
  .filter((r) => r.wakeTime && r.wakeTime <= new Date());
const stale = await listRuns({ status: 'running' });
for (const run of [...dueSuspended, ...stale]) {
  await run.resume();
}
```

Concurrency is bounded by the scheduler's existing per-workflow cooldown
logic so boot-time resume can't thundering-herd the model.

## Storage, state & ops

- `.workflow-data/` directory inside the harness dir. Automatically added to
  `.gitignore` by scaffolder.
- Contents: `runs/`, `steps/`, `hooks/`, `sleep/`, `version`. Structure is
  owned by `@workflow/world-local` — we don't manipulate it directly.
- Scoped per-harness; two harnesses on the same laptop can run concurrently
  without collision.
- Retention: `memory.workflow_retention_days` (default 30).
- `.workflow-data/version` tracks the WDK spec version. On boot, if the version
  is incompatible with the installed WDK, runs in that dir are marked stale
  (don't auto-delete — user decides).

New CLI subcommands:
- `harness workflows status` — table of pending / running / suspended / complete / failed runs.
- `harness workflows resume <run-id>` — manual resume (escape hatch for misbehaving auto-resume).
- `harness workflows cleanup` — wipes completed runs older than retention.
- `harness workflows inspect <run-id>` — prints event log for debugging.

## Error handling & retry

WDK's error taxonomy:
- `RetryableError(message, { maxAttempts? })` — step retries with exponential backoff.
- `FatalError(message)` — workflow fails immediately; no retry.
- Anything else — treated as retryable with default budget.

Classification rules:
- `llmStep`:
  - HTTP 429 / 503 / network timeouts → `RetryableError({ maxAttempts: 3 })`.
  - HTTP 401 / 403 / quota exceeded / schema errors → `FatalError`.
  - Ollama "model not found" → `FatalError` (user fixes config).
- `toolStep`:
  - Any throw → `RetryableError({ maxAttempts: 2 })`.
  - Structured `{ approvalDenied: true }` returns → pass through (not an error).
  - Tool execution timeout (`config.runtime.tool_timeout_ms`) → `RetryableError`.
- AI SDK's own `maxRetries` set to `0` inside `llmStep` — WDK owns retry.

Timeouts:
- Per-LLM-call: `config.model.timeout_ms` applied inside `llmStep`.
- Per-tool-call: existing `ToolExecutorOptions.toolTimeoutMs` applied inside `toolStep`.
- Per-workflow: future enhancement; no cap in v0.7.0.

Missed-run replay is a natural consequence of WDK's Run model — suspended runs
persist across restarts. The scheduler's boot-time resume loop drains the
backlog before starting normal cron ticks.

## Config additions

```yaml
workflows:
  # Apply durability to every markdown workflow by default, even without
  # `durable: true` in frontmatter. Default false (opt-in per-workflow).
  durable_default: false

memory:
  workflow_retention_days: 30   # cleanup age for completed runs
```

Frontmatter on markdown workflows:
```yaml
---
id: workflow-daily-summary
schedule: "0 22 * * *"
durable: true        # opt in to WDK-backed execution
---
```

## Testing

Unit tests (in-process, mock World):
- `tests/workflows/harness-workflow.test.ts` — orchestration with
  `createLocalWorld({ dataDir: tmpDir, tag: 'vitest-0' })`. Use `clear()` between tests.
- `tests/workflows/error-classification.test.ts` — llm/tool error taxonomy
  with mocked provider errors.
- `tests/workflows/schema-version.test.ts` — plant stale `.workflow-data/version`,
  verify graceful degrade.

Integration test (local-only, gated behind `INTEGRATION=1`, same pattern as
learning-loop):
- `tests/integration/workflow-resume.e2e.test.ts` — 3-tool-call workflow
  against Ollama, kill process via `AbortController` after step 2, restart with
  same run id, assert step 2's result was cached and step 3 runs.
- CI does not run it. Local-only requirement documented in CLAUDE.md like
  the existing learning-loop test.

Scheduler test:
- `tests/scheduler-resume.test.ts` — seed a suspended run with passed wake
  time, boot scheduler, assert resume fires exactly once (no duplicates).

## Deferred / future

- `sleep` exposure to markdown workflows (could be a tool the LLM calls:
  `sleep_until` / `wait_for_event`, or a magic frontmatter field).
- Hooks (external-event resume via webhooks). Likely needs a local HTTP listener
  — out of scope for v0.7.0.
- Sub-agent durability (today: whole delegate call is one step; future: nested
  workflow-in-workflow).
- Postgres World for team deployments.
- Per-workflow timeout cap.
- Workflow-in-workflow (one durable workflow calling another).

## Risks & mitigations

1. **SWC plugin in our `tsup` build may not cooperate.** tsup is esbuild-based;
   the plugin is SWC. Mitigation: run the SWC transform as a pre-build step
   producing a pre-compiled `.js` file that tsup consumes unchanged. Verify
   during implementation prototype before committing to the approach.
2. **Step args must be JSON-serializable** for the event log. Tool args already
   are (MCP protocol). LLM turn results (with usage metadata) are already plain
   objects. Low risk.
3. **WDK version churn.** WDK is beta-GA as of late 2025. Pin `workflow` to an
   exact version; bump deliberately with a regression run of the resume test.
4. **Non-idempotent tools shouldn't retry on failure.** The `RetryableError`
   default on `toolStep` will re-fire tools like `execute_shell` on failure.
   Mitigation: frontmatter `max_retries: 0` on risky tools, enforced inside
   `toolStep` by inspecting the tool descriptor. Defer full side-effect modeling
   to a later spec.

## Ship target

v0.7.0. No breaking changes — durability is opt-in per-workflow.
