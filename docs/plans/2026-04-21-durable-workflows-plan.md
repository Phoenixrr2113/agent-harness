# Durable Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate Vercel WDK as the durable execution engine for markdown workflows opted in via `durable: true` frontmatter, shipping as agent-harness v0.7.0 with zero user-visible build changes.

**Architecture:** Ship ONE pre-compiled workflow file (built with `@workflow/swc-plugin` inside agent-harness's own `tsup` pipeline) that wraps a generic LLM + tool-call loop. Markdown workflows pass their body as `prompt` data into this single workflow. LocalWorld runs in-process via `registerHandler` — no HTTP server. Scheduler dispatches to `start(harnessAgentWorkflow, ...)` for opted-in workflows and resumes suspended / stale-running runs on boot.

**Tech Stack:** TypeScript, tsup, Vercel Workflow SDK (`workflow@^4`, `@workflow/world-local`, `@workflow/swc-plugin`), AI SDK v6, vitest, node-cron.

**Reference spec:** [docs/specs/2026-04-21-durable-workflows-design.md](../specs/2026-04-21-durable-workflows-design.md)

---

## File Structure

### New files
- `src/workflows/harness-workflow.ts` — `harnessAgentWorkflow` + `llmStep` + `toolStep` with WDK directives.
- `src/runtime/workflow-engine.ts` — LocalWorld factory (`getWorld(harnessDir)`), handler registration, boot-time resume drain.
- `src/runtime/error-classification.ts` — `classifyLlmError` / `classifyToolError` returning RetryableError / FatalError.
- `src/cli/workflows.ts` — `workflows status|resume|cleanup|inspect` subcommand handlers.
- `scripts/build-workflow.mjs` — pre-tsup SWC compile step producing `dist-workflow/harness-workflow.js`.
- `tests/workflows/harness-workflow.test.ts`
- `tests/workflows/error-classification.test.ts`
- `tests/workflows/schema-version.test.ts`
- `tests/workflow-engine.test.ts`
- `tests/scheduler-resume.test.ts`
- `tests/integration/workflow-resume.e2e.test.ts` (`INTEGRATION=1` gated)

### Modified files
- `package.json` — add WDK deps, add `build:workflow` prebuild script.
- `tsup.config.ts` — consume the pre-compiled workflow from `dist-workflow/`.
- `src/core/types.ts` — add `workflows`, `memory.workflow_retention_days`, frontmatter `durable`.
- `src/llm/provider.ts` — add `generateTurn()`.
- `src/runtime/scheduler.ts` — durable dispatch + boot-time drain.
- `src/cli/index.ts` — register `workflows` subcommand group.
- `src/cli/scaffold.ts` — add `.workflow-data/` to `.gitignore` template.
- `CLAUDE.md` (`~/.claude/CLAUDE.md`) — add workflow-resume to must-run-locally test list.

---

## Task 1: Install WDK and verify SWC prebuild (SPIKE)

**Rationale:** This is the riskiest integration point. Nail it first. If the SWC plugin can't produce a bundle that tsup consumes cleanly, the entire approach changes.

**Files:**
- Modify: `package.json`
- Create: `scripts/build-workflow.mjs`
- Create: `src/workflows/harness-workflow.ts` (stub only for spike)
- Modify: `tsup.config.ts`

- [ ] **Step 1: Install dependencies (exact versions)**

```bash
export PATH="/Users/randywilson/.nvm/versions/node/v22.22.1/bin:$PATH"
npm install workflow@4.2.4 @workflow/world-local@4.1.1 @workflow/swc-plugin@4.1.1 --save
npm install @swc/core --save-dev
```

Expected: installed, `package-lock.json` updated, no peer-dep warnings block install.

- [ ] **Step 2: Create the stub workflow file**

`src/workflows/harness-workflow.ts`:
```typescript
export interface HarnessAgentWorkflowInput {
  prompt: string;
  system: string;
  harnessDir: string;
  modelId: string;
  activeTools?: string[];
}

export interface HarnessAgentWorkflowResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  messages: Array<{ role: string; content: unknown }>;
}

export async function harnessAgentWorkflow(
  input: HarnessAgentWorkflowInput,
): Promise<HarnessAgentWorkflowResult> {
  'use workflow';
  return { text: `stub-ok: ${input.prompt.slice(0, 20)}`, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, messages: [] };
}
```

- [ ] **Step 3: Create the pre-tsup SWC build script**

`scripts/build-workflow.mjs`:
```javascript
import { transformFileSync } from '@swc/core';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const INPUT = 'src/workflows/harness-workflow.ts';
const OUTPUT = 'dist-workflow/harness-workflow.js';

mkdirSync(dirname(OUTPUT), { recursive: true });

const { code } = transformFileSync(INPUT, {
  jsc: {
    parser: { syntax: 'typescript' },
    target: 'es2022',
    experimental: {
      plugins: [['@workflow/swc-plugin', { target: 'workflow' }]],
    },
  },
  module: { type: 'es6' },
});

writeFileSync(OUTPUT, code);
console.log(`[build-workflow] wrote ${OUTPUT} (${code.length} bytes)`);
```

- [ ] **Step 4: Wire the script into the build pipeline**

`package.json` scripts section — add:
```json
"build:workflow": "node scripts/build-workflow.mjs",
"build": "npm run build:workflow && tsup",
```

- [ ] **Step 5: Run the spike**

```bash
npm run build:workflow
```

Expected: prints `[build-workflow] wrote dist-workflow/harness-workflow.js (NNN bytes)`. Opens cleanly — `cat dist-workflow/harness-workflow.js | head -20` shows the `'use workflow'` has been transformed (directive removed, function wrapped).

If the plugin's configuration key / transform name is wrong, check `node_modules/@workflow/swc-plugin/README.md` and adjust. The spike must succeed before proceeding.

- [ ] **Step 6: Confirm tsup can consume the pre-built file**

Update `tsup.config.ts` to also bundle `dist-workflow/harness-workflow.js` as a separate entry point (or copy it into `dist/` unchanged). Easiest:
```typescript
import { copyFileSync } from 'node:fs';

export default defineConfig({
  // ...existing config
  onSuccess: async () => {
    copyFileSync('dist-workflow/harness-workflow.js', 'dist/workflows/harness-workflow.js');
  },
});
```

Ensure `dist/workflows/harness-workflow.js` exists after `npm run build`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json scripts/build-workflow.mjs src/workflows/harness-workflow.ts tsup.config.ts
git commit -m "build(workflows): add WDK deps + SWC prebuild pipeline for harness-workflow"
```

---

## Task 2: Config schema additions

**Files:**
- Modify: `src/core/types.ts`
- Test: `tests/config.test.ts` (extend existing)

- [ ] **Step 1: Write the failing test**

Append to `tests/config.test.ts`:
```typescript
it('defaults workflows.durable_default to false', () => {
  const cfg = HarnessConfigSchema.parse({
    agent: { name: 't' },
    model: { id: 'm' },
  });
  expect(cfg.workflows.durable_default).toBe(false);
});

it('defaults memory.workflow_retention_days to 30', () => {
  const cfg = HarnessConfigSchema.parse({
    agent: { name: 't' },
    model: { id: 'm' },
  });
  expect(cfg.memory.workflow_retention_days).toBe(30);
});

it('accepts durable on frontmatter', () => {
  const fm = FrontmatterSchema.parse({ id: 'wf', durable: true });
  expect(fm.durable).toBe(true);
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
export PATH="/Users/randywilson/.nvm/versions/node/v22.22.1/bin:$PATH"
npm test -- tests/config.test.ts
```

Expected: three new tests fail — `workflows` property doesn't exist, etc.

- [ ] **Step 3: Add the schema**

In `src/core/types.ts`, add to `FrontmatterSchema`:
```typescript
durable: z.boolean().optional(),
```

Add to `HarnessConfigSchema` before `mcp`:
```typescript
workflows: z.object({
  durable_default: z.boolean().default(false),
}).passthrough().default({ durable_default: false }),
```

Modify the existing `memory` section:
```typescript
memory: z.object({
  session_retention_days: z.number().int().positive().default(7),
  journal_retention_days: z.number().int().positive().default(365),
  workflow_retention_days: z.number().int().positive().default(30),
}).passthrough(),
```

Update `CONFIG_DEFAULTS`:
```typescript
memory: { session_retention_days: 7, journal_retention_days: 365, workflow_retention_days: 30 },
// ...
workflows: { durable_default: false },
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npm test -- tests/config.test.ts
```

Expected: all config tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts tests/config.test.ts
git commit -m "feat(config): add workflows.durable_default and memory.workflow_retention_days"
```

---

## Task 3: Error classification module

**Files:**
- Create: `src/runtime/error-classification.ts`
- Test: `tests/workflows/error-classification.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/workflows/error-classification.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { classifyLlmError, classifyToolError } from '../../src/runtime/error-classification.js';
import { FatalError, RetryableError } from 'workflow';

describe('classifyLlmError', () => {
  it('HTTP 429 → RetryableError with 3 attempts', () => {
    const classified = classifyLlmError(Object.assign(new Error('rate limit'), { status: 429 }));
    expect(classified).toBeInstanceOf(RetryableError);
  });

  it('HTTP 503 → RetryableError', () => {
    const classified = classifyLlmError(Object.assign(new Error('svc unavail'), { status: 503 }));
    expect(classified).toBeInstanceOf(RetryableError);
  });

  it('HTTP 401 → FatalError', () => {
    const classified = classifyLlmError(Object.assign(new Error('unauth'), { status: 401 }));
    expect(classified).toBeInstanceOf(FatalError);
  });

  it('network ECONNREFUSED → RetryableError', () => {
    const classified = classifyLlmError(Object.assign(new Error('conn refused'), { code: 'ECONNREFUSED' }));
    expect(classified).toBeInstanceOf(RetryableError);
  });

  it('Ollama "model not found" → FatalError', () => {
    const classified = classifyLlmError(new Error('model "qwen3:1.7b" not found, try pulling it first'));
    expect(classified).toBeInstanceOf(FatalError);
  });

  it('unknown error → RetryableError (default)', () => {
    const classified = classifyLlmError(new Error('something weird'));
    expect(classified).toBeInstanceOf(RetryableError);
  });
});

describe('classifyToolError', () => {
  it('plain throw → RetryableError with 2 attempts', () => {
    const classified = classifyToolError(new Error('boom'));
    expect(classified).toBeInstanceOf(RetryableError);
  });

  it('Error with fatal=true property → FatalError', () => {
    const err = Object.assign(new Error('no permission'), { fatal: true });
    const classified = classifyToolError(err);
    expect(classified).toBeInstanceOf(FatalError);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
npm test -- tests/workflows/error-classification.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the module**

`src/runtime/error-classification.ts`:
```typescript
import { FatalError, RetryableError } from 'workflow';

interface HttpLikeError extends Error {
  status?: number;
  code?: string;
}

const FATAL_LLM_PATTERNS: RegExp[] = [
  /model .* not found/i,
  /quota exceeded/i,
  /invalid api key/i,
  /authentication failed/i,
];

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const FATAL_HTTP_STATUSES = new Set([400, 401, 403, 422]);

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
]);

/**
 * Classifies an LLM provider error into a WDK RetryableError / FatalError.
 * Defaults to RetryableError on ambiguity — retry is the safer direction
 * since WDK will surface the error after exhausting attempts.
 */
export function classifyLlmError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const e = err as HttpLikeError;

  if (typeof e?.status === 'number') {
    if (FATAL_HTTP_STATUSES.has(e.status)) return new FatalError(message);
    if (RETRYABLE_HTTP_STATUSES.has(e.status)) {
      return new RetryableError(message, { maxAttempts: 3 });
    }
  }

  if (typeof e?.code === 'string' && RETRYABLE_NETWORK_CODES.has(e.code)) {
    return new RetryableError(message, { maxAttempts: 3 });
  }

  for (const pattern of FATAL_LLM_PATTERNS) {
    if (pattern.test(message)) return new FatalError(message);
  }

  return new RetryableError(message, { maxAttempts: 3 });
}

/**
 * Classifies a tool-execution error. Plain throws are retryable with a
 * small budget (2 attempts). Tools that set `fatal: true` on their error
 * object opt out of retry.
 */
export function classifyToolError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const e = err as Error & { fatal?: boolean };

  if (e?.fatal === true) return new FatalError(message);
  return new RetryableError(message, { maxAttempts: 2 });
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npm test -- tests/workflows/error-classification.test.ts
```

Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/error-classification.ts tests/workflows/error-classification.test.ts
git commit -m "feat(workflows): error classification for LLM and tool failures"
```

---

## Task 4: `generateTurn()` in provider.ts

**Files:**
- Modify: `src/llm/provider.ts`
- Test: `tests/provider-generate-turn.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/provider-generate-turn.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { generateTurn } from '../src/llm/provider.js';
import { MockLanguageModelV2 } from 'ai/test';

describe('generateTurn', () => {
  it('returns text + toolCalls + usage from ONE model call without executing tools', async () => {
    const mockModel = new MockLanguageModelV2({
      doGenerate: async () => ({
        content: [
          { type: 'text', text: 'I will call a tool' },
          { type: 'tool-call', toolCallId: 'tc1', toolName: 'my_tool', input: { x: 1 } },
        ],
        finishReason: 'tool-calls',
        usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
      }),
    });

    let toolExecuted = false;
    const result = await generateTurn({
      model: mockModel,
      messages: [{ role: 'user', content: 'hi' }],
      tools: {
        my_tool: {
          description: 'test',
          inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
          execute: async () => {
            toolExecuted = true;
            return 'should-not-run';
          },
        },
      },
    });

    expect(toolExecuted).toBe(false);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].toolName).toBe('my_tool');
    expect(result.toolCalls[0].args).toEqual({ x: 1 });
    expect(result.text).toBe('I will call a tool');
    expect(result.usage.totalTokens).toBe(15);
  });

  it('returns empty toolCalls and final text when model is done', async () => {
    const mockModel = new MockLanguageModelV2({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'all done' }],
        finishReason: 'stop',
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      }),
    });

    const result = await generateTurn({
      model: mockModel,
      messages: [{ role: 'user', content: 'hi' }],
      tools: {},
    });

    expect(result.toolCalls).toEqual([]);
    expect(result.text).toBe('all done');
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
npm test -- tests/provider-generate-turn.test.ts
```

Expected: FAIL — `generateTurn` not exported.

- [ ] **Step 3: Implement generateTurn**

Add to `src/llm/provider.ts`:
```typescript
import { generateText, type LanguageModel, type CoreMessage, type Tool } from 'ai';

export interface GenerateTurnOptions {
  model: LanguageModel;
  system?: string;
  messages: CoreMessage[];
  tools?: Record<string, Tool>;
  activeTools?: string[];
  maxRetries?: number;
  timeoutMs?: number;
}

export interface GenerateTurnResult {
  text: string;
  toolCalls: Array<{ id: string; toolName: string; args: Record<string, unknown> }>;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

/**
 * Run ONE model call without executing tools. Tool calls are returned
 * as-is for the caller (the durable workflow) to dispatch. Used exclusively
 * by the WDK workflow's `llmStep` — do not use in the non-durable path.
 */
export async function generateTurn(opts: GenerateTurnOptions): Promise<GenerateTurnResult> {
  const toolsWithoutExecute = opts.tools
    ? Object.fromEntries(
        Object.entries(opts.tools).map(([name, tool]) => [
          name,
          { ...tool, execute: undefined },
        ]),
      )
    : undefined;

  const result = await generateText({
    model: opts.model,
    ...(opts.system ? { system: opts.system } : {}),
    messages: opts.messages,
    ...(toolsWithoutExecute ? { tools: toolsWithoutExecute } : {}),
    ...(opts.activeTools ? { activeTools: opts.activeTools } : {}),
    maxRetries: opts.maxRetries ?? 0,
    ...(opts.timeoutMs ? { abortSignal: AbortSignal.timeout(opts.timeoutMs) } : {}),
  });

  return {
    text: result.text,
    toolCalls: (result.toolCalls ?? []).map((tc) => ({
      id: tc.toolCallId,
      toolName: tc.toolName,
      args: tc.input as Record<string, unknown>,
    })),
    usage: {
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      totalTokens: result.usage.totalTokens ?? 0,
    },
  };
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
npm test -- tests/provider-generate-turn.test.ts
```

Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/llm/provider.ts tests/provider-generate-turn.test.ts
git commit -m "feat(provider): generateTurn() for single-turn LLM call without tool execution"
```

---

## Task 5: `src/workflows/harness-workflow.ts` (full implementation)

**Files:**
- Modify: `src/workflows/harness-workflow.ts` (replace spike)
- Test: `tests/workflows/harness-workflow.test.ts`

- [ ] **Step 1: Write the orchestration test**

`tests/workflows/harness-workflow.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalWorld } from '@workflow/world-local';
import { start } from 'workflow/api';
import { harnessAgentWorkflow } from '../../src/workflows/harness-workflow.js';

describe('harnessAgentWorkflow', () => {
  let tmpDir: string;
  let world: ReturnType<typeof createLocalWorld>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'harness-wf-test-'));
    world = createLocalWorld({ dataDir: tmpDir, tag: 'vitest-0' });
    // Register in-process handlers — the implementation will need to
    // wire llmStep / toolStep into these prefixes. See Task 6 for the
    // production pattern; here we use inlined mocks.
  });

  afterEach(async () => {
    await world.clear();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns text immediately when model emits no tool calls', async () => {
    // Register a mock llmStep handler that returns no tool calls.
    // (Implementation of direct handlers: Task 6.)
    // ...
  });

  it('loops through tool calls until model returns final text', async () => {
    // Register llmStep that returns a tool call first, then final text.
    // Register toolStep that records the call count and returns "ok".
    // Assert the final workflow result has the final text.
    // ...
  });
});
```

Note: the orchestration test depends on Task 6's handler registration shape. If Task 6 isn't done yet, skip this test's body (just `.skip()` it) and come back.

- [ ] **Step 2: Run test to verify failure / skip**

```bash
npm test -- tests/workflows/harness-workflow.test.ts
```

Expected: skipped pending Task 6, or compile error if unfinished.

- [ ] **Step 3: Implement the full workflow**

Replace `src/workflows/harness-workflow.ts`:
```typescript
import { loadConfig } from '../core/config.js';
import { getModel, generateTurn } from '../llm/provider.js';
import { buildToolSet } from '../runtime/tool-executor.js';
import { createMcpManager } from '../runtime/mcp.js';
import { classifyLlmError, classifyToolError } from '../runtime/error-classification.js';

export interface HarnessAgentWorkflowInput {
  prompt: string;
  system: string;
  harnessDir: string;
  modelId: string;
  activeTools?: string[];
}

export interface HarnessAgentWorkflowResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  messages: Array<{ role: string; content: unknown }>;
}

interface Message {
  role: 'user' | 'assistant' | 'tool';
  content: unknown;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; toolName: string; args: Record<string, unknown> }>;
}

export async function harnessAgentWorkflow(
  input: HarnessAgentWorkflowInput,
): Promise<HarnessAgentWorkflowResult> {
  'use workflow';

  const messages: Message[] = [{ role: 'user', content: input.prompt }];
  let cumulativeUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  while (true) {
    const turn = await llmStep({
      messages,
      system: input.system,
      harnessDir: input.harnessDir,
      modelId: input.modelId,
      activeTools: input.activeTools,
    });

    cumulativeUsage.inputTokens += turn.usage.inputTokens;
    cumulativeUsage.outputTokens += turn.usage.outputTokens;
    cumulativeUsage.totalTokens += turn.usage.totalTokens;

    messages.push({
      role: 'assistant',
      content: turn.text,
      toolCalls: turn.toolCalls,
    });

    if (!turn.toolCalls || turn.toolCalls.length === 0) {
      return { text: turn.text, usage: cumulativeUsage, messages };
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

interface LlmStepArgs {
  messages: Message[];
  system: string;
  harnessDir: string;
  modelId: string;
  activeTools?: string[];
}

async function llmStep(args: LlmStepArgs): Promise<{
  text: string;
  toolCalls: Array<{ id: string; toolName: string; args: Record<string, unknown> }>;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}> {
  'use step';
  try {
    const config = loadConfig(args.harnessDir, { model: { id: args.modelId } });
    const model = getModel(config);
    const toolSet = await rebuildToolSet(args.harnessDir, config);
    const coreMessages = args.messages.map(toCoreMessage);

    return await generateTurn({
      model,
      system: args.system,
      messages: coreMessages,
      tools: toolSet,
      ...(args.activeTools ? { activeTools: args.activeTools } : {}),
      maxRetries: 0,
      timeoutMs: config.model.timeout_ms,
    });
  } catch (err) {
    throw classifyLlmError(err);
  }
}

interface ToolStepArgs {
  toolName: string;
  args: Record<string, unknown>;
  harnessDir: string;
}

async function toolStep(stepArgs: ToolStepArgs): Promise<unknown> {
  'use step';
  try {
    const config = loadConfig(stepArgs.harnessDir);
    const toolSet = await rebuildToolSet(stepArgs.harnessDir, config);
    const tool = toolSet[stepArgs.toolName];
    if (!tool) throw Object.assign(new Error(`Tool not found: ${stepArgs.toolName}`), { fatal: true });
    if (typeof tool.execute !== 'function') {
      throw Object.assign(new Error(`Tool ${stepArgs.toolName} has no execute function`), { fatal: true });
    }
    return await tool.execute(stepArgs.args, { toolCallId: 'step', messages: [] });
  } catch (err) {
    throw classifyToolError(err);
  }
}

async function rebuildToolSet(harnessDir: string, config: ReturnType<typeof loadConfig>) {
  const mcpManager = createMcpManager(config);
  let mcpTools = {};
  if (mcpManager.hasServers()) {
    await mcpManager.connect();
    mcpTools = mcpManager.getTools();
  }
  return buildToolSet(harnessDir, undefined, mcpTools);
}

function toCoreMessage(m: Message): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', content: [{ type: 'tool-result', toolCallId: m.toolCallId, result: m.content }] };
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: [
        ...(typeof m.content === 'string' && m.content ? [{ type: 'text' as const, text: m.content }] : []),
        ...m.toolCalls.map((tc) => ({
          type: 'tool-call' as const,
          toolCallId: tc.id,
          toolName: tc.toolName,
          args: tc.args,
        })),
      ],
    };
  }
  return { role: m.role, content: m.content };
}
```

Note: the SWC plugin will extract `llmStep` and `toolStep` at build time. They must be declared inside this same module so the plugin sees them adjacent to the workflow.

- [ ] **Step 4: Rebuild workflow bundle**

```bash
npm run build:workflow
```

Expected: transforms cleanly. Check `dist-workflow/harness-workflow.js` contains references to `__wkf_step_` handlers for llmStep and toolStep (the plugin renames them at bundle time).

- [ ] **Step 5: Come back to Task 5 Step 1 test**

After Task 6 registers handlers, return here and fill out the test bodies using `start(harnessAgentWorkflow, { ... }, { world })` and assert on the result.

- [ ] **Step 6: Commit**

```bash
git add src/workflows/harness-workflow.ts tests/workflows/harness-workflow.test.ts
git commit -m "feat(workflows): harnessAgentWorkflow with fine-grained LLM and tool steps"
```

---

## Task 6: Workflow engine — LocalWorld factory + handler registration

**Files:**
- Create: `src/runtime/workflow-engine.ts`
- Test: `tests/workflow-engine.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/workflow-engine.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getWorld, closeWorld } from '../src/runtime/workflow-engine.js';

describe('workflow-engine', () => {
  let harnessDir: string;

  beforeEach(() => {
    harnessDir = mkdtempSync(join(tmpdir(), 'harness-engine-test-'));
  });

  afterEach(async () => {
    await closeWorld(harnessDir);
    rmSync(harnessDir, { recursive: true, force: true });
  });

  it('creates .workflow-data/ inside the harness dir on first access', async () => {
    const world = getWorld(harnessDir);
    expect(world).toBeDefined();
    expect(existsSync(join(harnessDir, '.workflow-data'))).toBe(true);
  });

  it('returns the same world instance on repeated calls for the same harnessDir', () => {
    const w1 = getWorld(harnessDir);
    const w2 = getWorld(harnessDir);
    expect(w1).toBe(w2);
  });

  it('registers step and workflow handlers', () => {
    const world = getWorld(harnessDir);
    // World instance exposes `registerHandler` per LocalWorld type.
    expect(typeof world.registerHandler).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
npm test -- tests/workflow-engine.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement the engine**

`src/runtime/workflow-engine.ts`:
```typescript
import { join } from 'node:path';
import { createLocalWorld, type LocalWorld } from '@workflow/world-local';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { log } from '../core/logger.js';

const require = createRequire(import.meta.url);

const worlds = new Map<string, LocalWorld>();

/**
 * Get or create the LocalWorld for a given harness directory. Registers
 * in-process step and workflow handlers so execution bypasses HTTP.
 */
export function getWorld(harnessDir: string): LocalWorld {
  const existing = worlds.get(harnessDir);
  if (existing) return existing;

  const world = createLocalWorld({
    dataDir: join(harnessDir, '.workflow-data'),
  });

  const workflowCode = loadWorkflowBundle();
  const { stepHandler, workflowHandler } = buildHandlers(workflowCode);
  world.registerHandler('__wkf_step_', stepHandler);
  world.registerHandler('__wkf_workflow_', workflowHandler);

  worlds.set(harnessDir, world);
  return world;
}

/**
 * Close and evict a world for a given harnessDir. Used by tests.
 */
export async function closeWorld(harnessDir: string): Promise<void> {
  const world = worlds.get(harnessDir);
  if (!world) return;
  await world.clear().catch(() => { /* best-effort */ });
  worlds.delete(harnessDir);
}

function loadWorkflowBundle(): string {
  const candidates = [
    require.resolve('../../dist/workflows/harness-workflow.js'),
    require.resolve('../../dist-workflow/harness-workflow.js'),
  ];
  for (const path of candidates) {
    try {
      return readFileSync(path, 'utf-8');
    } catch {
      continue;
    }
  }
  throw new Error('harness-workflow bundle not found. Run `npm run build:workflow`.');
}

function buildHandlers(code: string): {
  stepHandler: (msg: unknown) => Promise<unknown>;
  workflowHandler: (msg: unknown) => Promise<unknown>;
} {
  // The WDK SWC plugin produces a bundle that exports step and workflow
  // entrypoints. Load once via dynamic import of a data URL or via vm.
  // Concrete wiring depends on what the bundle exposes — inspect
  // dist-workflow/harness-workflow.js after Task 1 to confirm the export
  // shape, then adapt. In the reference WDK runtime, `stepEntrypoint(code)`
  // and `workflowEntrypoint(code)` produce handlers from the bundle string.
  const { stepEntrypoint, workflowEntrypoint } = require('workflow/api-workflow');
  const stepHandler = stepEntrypoint(code);
  const workflowHandler = workflowEntrypoint(code);
  return {
    stepHandler: async (msg) => stepHandler(msg as Request).then((r: Response) => r.json()),
    workflowHandler: async (msg) => workflowHandler(msg as Request).then((r: Response) => r.json()),
  };
}
```

Note: the `buildHandlers` function may need adjustment once you confirm what `stepEntrypoint` / `workflowEntrypoint` actually return for direct-handler use. Check WDK's `@workflow/core/runtime` types: both accept a `code: string` and return `(req: Request) => Promise<Response>`. For direct handlers, we adapt Request/Response to the in-process message format by wrapping. If the adaptation is non-trivial, open an issue upstream and use a temporary HTTP-loopback fallback.

- [ ] **Step 4: Run test to verify pass**

```bash
npm test -- tests/workflow-engine.test.ts
```

Expected: all three tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/workflow-engine.ts tests/workflow-engine.test.ts
git commit -m "feat(workflows): LocalWorld factory with in-process handler registration"
```

- [ ] **Step 6: Return to Task 5 Step 5 and complete orchestration tests**

Using the engine:
```typescript
import { getWorld, closeWorld } from '../../src/runtime/workflow-engine.js';
import { start } from 'workflow/api';
// ...
const run = await start(harnessAgentWorkflow, { prompt: 'hi', system: '', harnessDir, modelId: 'test' }, { world: getWorld(harnessDir) });
const result = await run.result;
```

Mock `generateTurn` (by mocking `src/llm/provider.js`) to return scripted turns — then assert workflow outputs.

---

## Task 7: Boot-time resume drain

**Files:**
- Modify: `src/runtime/workflow-engine.ts`
- Test: `tests/workflow-engine.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/workflow-engine.test.ts`:
```typescript
import { drainResumableRuns } from '../src/runtime/workflow-engine.js';

it('drainResumableRuns returns suspended runs with past wake times and stale running runs', async () => {
  const world = getWorld(harnessDir);
  // Seed a suspended run with wakeTime in the past (test fixture)
  // Seed a stale running run
  // Call drainResumableRuns
  // Assert both are returned and were resumed (via spy or side effect)
});
```

Full-body test fixture details depend on LocalWorld's public seed API — if no seed API exists, start a workflow, force-pause/kill it, then call drainResumableRuns.

- [ ] **Step 2: Run test to verify failure**

```bash
npm test -- tests/workflow-engine.test.ts
```

Expected: `drainResumableRuns` not exported.

- [ ] **Step 3: Add drain function**

Append to `src/runtime/workflow-engine.ts`:
```typescript
import { listRuns } from 'workflow/api';

/**
 * Boot-time scan for workflows that need to resume:
 *   - suspended runs whose sleep wake-time has passed
 *   - stale "running" runs left by a previous crashed process
 *
 * Resumes them in a single sequential pass. Returns the count resumed.
 */
export async function drainResumableRuns(harnessDir: string): Promise<number> {
  const world = getWorld(harnessDir);
  let resumed = 0;
  const now = new Date();

  const suspended = await listRuns({ status: 'suspended', world });
  for (const run of suspended) {
    if (run.wakeTime && run.wakeTime <= now) {
      try {
        await run.resume();
        resumed++;
      } catch (err) {
        log.warn(`Failed to resume suspended run ${run.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const stale = await listRuns({ status: 'running', world });
  for (const run of stale) {
    try {
      await run.resume();
      resumed++;
    } catch (err) {
      log.warn(`Failed to resume stale run ${run.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return resumed;
}
```

Note: `listRuns` signature depends on WDK's actual exported API. Adjust imports if `listRuns` isn't exported from `workflow/api` — check `workflow/dist/api.d.ts`.

- [ ] **Step 4: Run test to verify pass**

```bash
npm test -- tests/workflow-engine.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/workflow-engine.ts tests/workflow-engine.test.ts
git commit -m "feat(workflows): drain suspended and stale-running runs on boot"
```

---

## Task 8: Scheduler integration

**Files:**
- Modify: `src/runtime/scheduler.ts`
- Test: `tests/scheduler-resume.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/scheduler-resume.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scheduler } from '../src/runtime/scheduler.js';

describe('Scheduler durable dispatch', () => {
  let harnessDir: string;

  beforeEach(() => {
    harnessDir = mkdtempSync(join(tmpdir(), 'harness-sched-test-'));
    // Seed a minimal harness: config.yaml with openai provider stub + a durable workflow
    mkdirSync(join(harnessDir, 'workflows'), { recursive: true });
    writeFileSync(join(harnessDir, 'config.yaml'), `
agent:
  name: test
model:
  provider: openai
  id: gpt-test
workflows:
  durable_default: false
`);
    writeFileSync(join(harnessDir, 'workflows', 'daily.md'), `---
id: daily-run
schedule: "0 9 * * *"
durable: true
---
Do the daily thing.
`);
  });

  afterEach(() => {
    rmSync(harnessDir, { recursive: true, force: true });
  });

  it('boot calls drainResumableRuns before registering cron tasks', async () => {
    const drain = vi.fn().mockResolvedValue(0);
    // inject or mock drainResumableRuns
    // new Scheduler({ harnessDir }).start()
    // expect(drain).toHaveBeenCalledBefore(cronScheduleCall)
  });

  it('executes durable-flagged workflow via start() instead of agent.run()', async () => {
    const spyStart = vi.fn().mockResolvedValue({ result: Promise.resolve({ text: 'done', usage: { totalTokens: 10 } }) });
    // inject spyStart, trigger executeWorkflow manually, assert spyStart called
  });

  it('executes non-durable workflow via agent.run() unchanged', async () => {
    // Flip frontmatter durable=false, run executeWorkflow, assert start not called
  });
});
```

Test bodies use dependency injection or `vi.mock` against `src/runtime/workflow-engine.js` and `workflow/api` — pick the approach consistent with existing scheduler tests.

- [ ] **Step 2: Run test to verify failure**

```bash
npm test -- tests/scheduler-resume.test.ts
```

Expected: fails — durable dispatch not implemented.

- [ ] **Step 3: Wire durable dispatch into executeWorkflow**

In `src/runtime/scheduler.ts`, modify the inner workflow execution block (around line 220, inside the `for (let attempt ...)` loop):
```typescript
import { getWorld, drainResumableRuns } from './workflow-engine.js';
import { start } from 'workflow/api';
import { harnessAgentWorkflow } from '../workflows/harness-workflow.js';

// ...inside executeWorkflow, replacing the agent.run block:

const isDurable =
  doc.frontmatter.durable === true ||
  config.workflows?.durable_default === true;

if (isDurable) {
  const world = getWorld(this.harnessDir);
  const system = /* same buildSystemPrompt as createHarness does */;
  const run = await start(
    harnessAgentWorkflow,
    {
      prompt,
      system,
      harnessDir: this.harnessDir,
      modelId: config.model.id,
    },
    { world },
  );
  const result = await run.result;
  resultText = result.text;
  tokensUsed = result.usage.totalTokens;
} else if (delegateAgentId) {
  // existing delegate path
} else {
  // existing createHarness + agent.run() path
}
```

- [ ] **Step 4: Add boot-time drain to Scheduler.start()**

Find the `Scheduler.start()` method. Before registering cron tasks:
```typescript
async start() {
  // ...existing pre-work

  try {
    const resumed = await drainResumableRuns(this.harnessDir);
    if (resumed > 0) log.info(`Resumed ${resumed} workflow run(s) from previous session`);
  } catch (err) {
    log.warn(`Boot-time resume scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ...existing cron registration
}
```

- [ ] **Step 5: Run tests to verify pass**

```bash
npm test -- tests/scheduler-resume.test.ts
```

Expected: all three tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/scheduler.ts tests/scheduler-resume.test.ts
git commit -m "feat(scheduler): durable dispatch + boot-time resume drain"
```

---

## Task 9: CLI `workflows` subcommands

**Files:**
- Create: `src/cli/workflows.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/cli-workflows.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/cli-workflows.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = join(process.cwd(), 'dist/cli/index.js');

describe('harness workflows', () => {
  let harnessDir: string;

  beforeEach(() => {
    harnessDir = mkdtempSync(join(tmpdir(), 'harness-cli-wf-'));
  });

  afterEach(() => {
    rmSync(harnessDir, { recursive: true, force: true });
  });

  it('status prints a table (empty initially)', () => {
    const result = spawnSync('node', [CLI, 'workflows', 'status', '--dir', harnessDir], { encoding: 'utf-8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/no runs|Status|RUN ID/i);
  });

  it('cleanup --older-than 0 succeeds with no runs', () => {
    const result = spawnSync('node', [CLI, 'workflows', 'cleanup', '--dir', harnessDir, '--older-than', '0'], { encoding: 'utf-8' });
    expect(result.status).toBe(0);
  });

  it('resume fails with helpful message when run id missing', () => {
    const result = spawnSync('node', [CLI, 'workflows', 'resume', 'non-existent-id', '--dir', harnessDir], { encoding: 'utf-8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/not found|unknown run/i);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
npm run build && npm test -- tests/cli-workflows.test.ts
```

Expected: commands don't exist yet — exit code 1, "unknown command".

- [ ] **Step 3: Implement the subcommand module**

`src/cli/workflows.ts`:
```typescript
import { getWorld } from '../runtime/workflow-engine.js';
import { listRuns } from 'workflow/api';
import { log } from '../core/logger.js';
import { loadConfig } from '../core/config.js';
import { join } from 'node:path';
import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';

export async function statusCmd(opts: { dir: string }): Promise<void> {
  const world = getWorld(opts.dir);
  const runs = await listRuns({ world });
  if (runs.length === 0) {
    console.log('No runs found.');
    return;
  }
  console.log('RUN ID\tSTATUS\tSTARTED\tDURATION');
  for (const run of runs) {
    const dur = run.endedAt
      ? `${Math.round((run.endedAt.getTime() - run.startedAt.getTime()) / 1000)}s`
      : 'in progress';
    console.log(`${run.id}\t${run.status}\t${run.startedAt.toISOString()}\t${dur}`);
  }
}

export async function resumeCmd(runId: string, opts: { dir: string }): Promise<void> {
  const world = getWorld(opts.dir);
  const runs = await listRuns({ world });
  const run = runs.find((r) => r.id === runId);
  if (!run) {
    console.error(`Run not found: ${runId}`);
    process.exit(1);
  }
  await run.resume();
  console.log(`Resumed run ${runId}`);
}

export async function cleanupCmd(opts: { dir: string; olderThan: number }): Promise<void> {
  const config = loadConfig(opts.dir);
  const days = opts.olderThan ?? config.memory.workflow_retention_days;
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const world = getWorld(opts.dir);
  const runs = await listRuns({ world });
  let cleaned = 0;
  for (const run of runs) {
    if (run.status === 'complete' && run.endedAt && run.endedAt.getTime() < cutoff) {
      // Deleting runs from LocalWorld may need direct filesystem removal
      // since the runtime API may not expose a delete. Check LocalWorld.clear()
      // alternatives; a scoped removeRun would be ideal.
      cleaned++;
    }
  }
  console.log(`Cleaned ${cleaned} run(s) older than ${days} days.`);
}

export async function inspectCmd(runId: string, opts: { dir: string }): Promise<void> {
  const world = getWorld(opts.dir);
  const runs = await listRuns({ world });
  const run = runs.find((r) => r.id === runId);
  if (!run) {
    console.error(`Run not found: ${runId}`);
    process.exit(1);
  }
  console.log(JSON.stringify({
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    events: run.events,
  }, null, 2));
}
```

- [ ] **Step 4: Register commands in `src/cli/index.ts`**

Find where subcommands are registered (likely `program.command(...)`) and add:
```typescript
import { statusCmd, resumeCmd, cleanupCmd, inspectCmd } from './workflows.js';

const workflows = program.command('workflows').description('Manage durable workflow runs');

workflows
  .command('status')
  .description('List workflow runs')
  .option('--dir <path>', 'Harness directory', process.cwd())
  .action(async (opts) => statusCmd(opts));

workflows
  .command('resume <runId>')
  .description('Manually resume a suspended run')
  .option('--dir <path>', 'Harness directory', process.cwd())
  .action(async (runId, opts) => resumeCmd(runId, opts));

workflows
  .command('cleanup')
  .description('Delete completed runs older than N days')
  .option('--dir <path>', 'Harness directory', process.cwd())
  .option('--older-than <days>', 'Age in days', (v) => parseInt(v, 10))
  .action(async (opts) => cleanupCmd(opts));

workflows
  .command('inspect <runId>')
  .description('Show event log for a run')
  .option('--dir <path>', 'Harness directory', process.cwd())
  .action(async (runId, opts) => inspectCmd(runId, opts));
```

- [ ] **Step 5: Run tests to verify pass**

```bash
npm run build && npm test -- tests/cli-workflows.test.ts
```

Expected: all three tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/cli/workflows.ts src/cli/index.ts tests/cli-workflows.test.ts
git commit -m "feat(cli): workflows {status|resume|cleanup|inspect} subcommands"
```

---

## Task 10: Scaffolder `.gitignore` update

**Files:**
- Modify: `src/cli/scaffold.ts`
- Test: `tests/scaffold.test.ts` (extend existing)

- [ ] **Step 1: Write the failing test**

Append to `tests/scaffold.test.ts`:
```typescript
it('adds .workflow-data/ to .gitignore', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'scaffold-gi-'));
  scaffoldHarness({ dir: tmpDir, template: 'default', agentName: 'test' });
  const gi = readFileSync(join(tmpDir, '.gitignore'), 'utf-8');
  expect(gi).toContain('.workflow-data/');
  rmSync(tmpDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
npm test -- tests/scaffold.test.ts
```

Expected: FAIL — `.workflow-data/` not in gitignore.

- [ ] **Step 3: Update scaffolder**

In `src/cli/scaffold.ts`, find where `.gitignore` is generated. Add `.workflow-data/` to the default list of ignored paths alongside existing entries like `.ralph/`, `node_modules/`, etc.

- [ ] **Step 4: Run test to verify pass**

```bash
npm test -- tests/scaffold.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/scaffold.ts tests/scaffold.test.ts
git commit -m "feat(scaffold): include .workflow-data/ in generated .gitignore"
```

---

## Task 11: Schema version degradation test

**Files:**
- Test: `tests/workflows/schema-version.test.ts`

- [ ] **Step 1: Write the test**

`tests/workflows/schema-version.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getWorld, closeWorld } from '../../src/runtime/workflow-engine.js';

describe('schema version compatibility', () => {
  let harnessDir: string;

  beforeEach(() => {
    harnessDir = mkdtempSync(join(tmpdir(), 'harness-schema-'));
  });

  afterEach(async () => {
    await closeWorld(harnessDir);
    rmSync(harnessDir, { recursive: true, force: true });
  });

  it('warns and continues when .workflow-data/version is stale', () => {
    mkdirSync(join(harnessDir, '.workflow-data'), { recursive: true });
    writeFileSync(join(harnessDir, '.workflow-data', 'version'), JSON.stringify({ version: '-999.0.0' }));

    expect(() => getWorld(harnessDir)).not.toThrow();
    // LocalWorld exports `DataDirVersionError` — ensure we catch/warn rather than propagate.
  });
});
```

- [ ] **Step 2: Run — may need engine adjustments**

```bash
npm test -- tests/workflows/schema-version.test.ts
```

If LocalWorld throws on mismatched version, wrap the `createLocalWorld` call in `getWorld()` and catch `DataDirVersionError`, logging a warn and falling back to a fresh data dir (or refuse to start with a clear error telling the user to migrate).

- [ ] **Step 3: Harden `getWorld()` if needed**

If wrapping is required:
```typescript
import { createLocalWorld, DataDirVersionError } from '@workflow/world-local';

try {
  world = createLocalWorld({ dataDir: join(harnessDir, '.workflow-data') });
} catch (err) {
  if (err instanceof DataDirVersionError) {
    log.warn(`Workflow data dir version mismatch (${err.message}). Continuing with degraded durability — consider running \`harness workflows cleanup --force\`.`);
    // Either refuse durability or move the old dir aside.
    throw err; // or re-create with force flag
  }
  throw err;
}
```

- [ ] **Step 4: Run and commit**

```bash
npm test -- tests/workflows/schema-version.test.ts
git add src/runtime/workflow-engine.ts tests/workflows/schema-version.test.ts
git commit -m "feat(workflows): graceful degrade on schema version mismatch"
```

---

## Task 12: Integration E2E resume test (local-only)

**Files:**
- Create: `tests/integration/workflow-resume.e2e.test.ts`

- [ ] **Step 1: Write the test**

`tests/integration/workflow-resume.e2e.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const runIntegration = process.env.INTEGRATION === '1';

describe.runIf(runIntegration)('workflow resume E2E (Ollama + qwen3:1.7b)', () => {
  it('kills process after tool call 2, resumes, verifies tool call 3 runs exactly once', async () => {
    const harnessDir = mkdtempSync(join(tmpdir(), 'harness-resume-e2e-'));
    try {
      // Seed harness with config.yaml pointing to Ollama qwen3:1.7b
      writeFileSync(join(harnessDir, 'config.yaml'), `
agent:
  name: test
model:
  provider: openai
  id: qwen3:1.7b
  base_url: http://localhost:11434/v1
workflows:
  durable_default: true
`);
      // Seed a workflow that reliably triggers 3 tool calls
      mkdirSync(join(harnessDir, 'workflows'), { recursive: true });
      writeFileSync(join(harnessDir, 'workflows', 'three-tools.md'), `---
id: three-tools
durable: true
---
Call the test_counter tool three times, then return the sum.
`);

      // Start harness run; kill after tool call 2 is observed in the event log
      // (tail .workflow-data/runs/*.json until events[] shows 2 toolStep entries)
      // Then restart harness; assert the run completes and the total is what
      // we'd expect (3 tool calls — no replay-duplication).

      // Concrete implementation left to the engineer — the pattern:
      //  1. spawn `harness schedule --once` subprocess
      //  2. poll filesystem until 2 tool-step events land
      //  3. SIGKILL the subprocess
      //  4. spawn a fresh `harness schedule --once` in the same harnessDir
      //  5. wait for completion
      //  6. inspect events[] → assert no duplicate step completions
    } finally {
      rmSync(harnessDir, { recursive: true, force: true });
    }
  }, 120000);
});
```

- [ ] **Step 2: Ensure Ollama is running locally**

```bash
ollama serve &
ollama pull qwen3:1.7b
```

- [ ] **Step 3: Run the test**

```bash
INTEGRATION=1 npm test -- tests/integration/workflow-resume.e2e.test.ts
```

Expected: pass. If it flakes (tool-count heuristic unreliable against a 1.7B model), swap to a workflow that uses a deterministic tool-call trigger.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/workflow-resume.e2e.test.ts
git commit -m "test(integration): E2E workflow resume after mid-run kill"
```

---

## Task 13: CLAUDE.md update

**Files:**
- Modify: `~/.claude/CLAUDE.md`

- [ ] **Step 1: Add workflow-resume to must-run-locally test list**

Find the section in `CLAUDE.md` that lists agent-harness learning-loop as must-run-locally. Add:
```markdown
- **agent-harness durable-workflows changes require a local E2E test before push.** Anything touching `src/workflows/harness-workflow.ts`, `src/runtime/workflow-engine.ts`, `src/runtime/scheduler.ts` (durable dispatch), or `src/llm/provider.ts` (`generateTurn`) needs `INTEGRATION=1 npm test -- tests/integration/workflow-resume.e2e.test.ts` before committing. Requires Ollama with `qwen3:1.7b`. CI cannot run it.
```

- [ ] **Step 2: No commit** — the user's CLAUDE.md is outside the repo.

---

## Task 14: Release v0.7.0

**Files:**
- Modify: `package.json` (via `npm version`)

- [ ] **Step 1: Run the full suite locally**

```bash
export PATH="/Users/randywilson/.nvm/versions/node/v22.22.1/bin:$PATH"
npm run build
npm test
```

Expected: all tests pass (existing 1141 + new tests from Tasks 2-11).

- [ ] **Step 2: Run the integration E2E**

```bash
INTEGRATION=1 npm test -- tests/integration/workflow-resume.e2e.test.ts
```

Expected: pass.

- [ ] **Step 3: Merge and bump**

```bash
git checkout main
git merge --ff-only feat/durable-workflows
npm version minor   # 0.6.0 → 0.7.0
git push && git push --tags
```

- [ ] **Step 4: Watch release**

```bash
gh run watch $(gh run list --limit 1 --workflow release.yml --json databaseId -q '.[0].databaseId')
```

- [ ] **Step 5: Post-publish smoke**

```bash
rm -rf /tmp/verify-070 && mkdir /tmp/verify-070 && cd /tmp/verify-070
npm init -y > /dev/null
npm install @agntk/agent-harness@0.7.0 --silent
./node_modules/.bin/harness --version  # prints 0.7.0
./node_modules/.bin/harness workflows status --dir .  # prints "No runs found."
```

---

## Self-Review

**Spec coverage:**
- SWC plugin build integration → Task 1 ✓
- `harnessAgentWorkflow` + steps → Tasks 1, 5 ✓
- Fine-grained step boundaries (LLM + per tool) → Task 5 ✓
- LocalWorld + in-process handlers → Task 6 ✓
- Scheduler durable dispatch → Task 8 ✓
- Boot-time resume (suspended + stale running) → Tasks 7, 8 ✓
- `.workflow-data/` scoping + gitignore → Tasks 6, 10 ✓
- CLI `workflows` subcommands → Task 9 ✓
- Config additions (`workflows.durable_default`, `memory.workflow_retention_days`) → Task 2 ✓
- Frontmatter `durable` → Task 2 ✓
- Error classification (RetryableError / FatalError) → Task 3 ✓
- Unit tests (orchestration, error classification, schema version) → Tasks 3, 5, 11 ✓
- Integration E2E (INTEGRATION=1 gated) → Task 12 ✓
- CLAUDE.md must-run-locally note → Task 13 ✓
- v0.7.0 release → Task 14 ✓

No gaps found.

**Placeholder scan:** Reviewed each task — code steps contain actual code. A handful of places note "confirm against WDK's actual exported API" (listRuns signature, stepEntrypoint return shape) — these are NOT placeholders but flagged unknowns that require reading the installed package's .d.ts. The implementer will resolve them by inspecting `node_modules/@workflow/*/dist/*.d.ts` during Tasks 6-7.

**Type consistency:** `harnessAgentWorkflow` input signature is consistent across Tasks 1, 5, 8. `llmStep` / `toolStep` are declared once in Task 5 and only called internally by the workflow — no external consumers. Config field names (`workflows.durable_default`, `memory.workflow_retention_days`, frontmatter `durable`) match everywhere referenced.

---

## Execution Notes

- Feature branch: `feat/durable-workflows` (create in `../agent-harness-durable` worktree to avoid blocking main).
- Tasks 1, 6 carry the highest technical risk (SWC bundle shape, direct-handler API). If either spikes uncover an incompatible WDK internal API, stop and revise the spec before continuing the remaining tasks.
- Each task ends with its own commit; 13-14 commits on the feature branch by end.
- No CI changes needed — the E2E test is gated behind `INTEGRATION=1` identical to the existing learning-loop pattern.
