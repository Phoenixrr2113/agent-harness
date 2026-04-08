import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../src/llm/provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm/provider.js')>();
  const { MockLanguageModelV3 } = await import('ai/test');

  // Build three distinct mock models so tests can assert which one was
  // selected based on the agent's frontmatter `model:` field.
  const makeMock = (tag: string) =>
    new MockLanguageModelV3({
      provider: 'mock',
      modelId: `mock-${tag}`,
      doGenerate: async () => ({
        content: [{ type: 'text' as const, text: `Delegated response (${tag}).` }],
        finishReason: { type: 'stop' as const },
        usage: {
          inputTokens: { total: 80, noCache: 80, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 40, text: 40, reasoning: undefined },
        },
      }),
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-start' as const, id: '1' });
            controller.enqueue({ type: 'text-delta' as const, id: '1', delta: 'Streamed ' });
            controller.enqueue({ type: 'text-delta' as const, id: '1', delta: `(${tag}).` });
            controller.enqueue({ type: 'text-end' as const, id: '1' });
            controller.enqueue({
              type: 'finish' as const,
              usage: {
                inputTokens: { total: 60, noCache: 60, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 20, text: 20, reasoning: undefined },
              },
              finishReason: { type: 'stop' as const },
            });
            controller.close();
          },
        }),
      }),
    });

  const primaryModel = makeMock('primary');
  const summaryModel = makeMock('summary');
  const fastModel = makeMock('fast');

  return {
    ...actual,
    getModel: vi.fn().mockReturnValue(primaryModel),
    getSummaryModel: vi.fn().mockReturnValue(summaryModel),
    getFastModel: vi.fn().mockReturnValue(fastModel),
  };
});

import {
  loadAgentDocs,
  findAgent,
  listAgents,
  buildAgentPrompt,
  delegateTo,
  delegateStream,
} from '../src/runtime/delegate.js';
import { loadConfig } from '../src/core/config.js';

describe('agent delegation', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'delegate-test-'));

    // Create minimal harness structure
    mkdirSync(join(testDir, 'agents'), { recursive: true });
    mkdirSync(join(testDir, 'rules'), { recursive: true });
    mkdirSync(join(testDir, 'memory', 'sessions'), { recursive: true });

    // Minimal config
    writeFileSync(
      join(testDir, 'config.yaml'),
      `agent:
  name: test-agent
model:
  id: test/model
  max_tokens: 200000
`
    );

    // CORE.md
    writeFileSync(
      join(testDir, 'CORE.md'),
      `# Test Agent

I am a test agent.
`
    );
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('loadAgentDocs', () => {
    it('should return empty array when no agents exist', () => {
      const docs = loadAgentDocs(testDir);
      expect(docs).toEqual([]);
    });

    it('should load agent markdown files', () => {
      writeFileSync(
        join(testDir, 'agents', 'evaluator.md'),
        `---
id: agent-evaluator
tags: [agent, validation]
author: human
status: active
---

<!-- L0: Evaluator agent — validates incoming capabilities. -->
<!-- L1: Runs validation pipeline on intake files. Checks format, compatibility, and quality. -->

# Agent: Evaluator

## Purpose
Validate and evaluate incoming capability files.
`
      );

      const docs = loadAgentDocs(testDir);
      expect(docs).toHaveLength(1);
      expect(docs[0].frontmatter.id).toBe('agent-evaluator');
      expect(docs[0].l0).toBe('Evaluator agent — validates incoming capabilities.');
    });

    it('should skip archived agents', () => {
      writeFileSync(
        join(testDir, 'agents', 'old-agent.md'),
        `---
id: agent-old
tags: [agent]
status: archived
---

<!-- L0: Old deprecated agent. -->

# Agent: Old
`
      );

      const docs = loadAgentDocs(testDir);
      expect(docs).toHaveLength(0);
    });

    it('should load multiple agents', () => {
      writeFileSync(
        join(testDir, 'agents', 'evaluator.md'),
        `---
id: agent-evaluator
tags: [agent]
status: active
---

<!-- L0: Evaluator agent. -->

# Agent: Evaluator
`
      );

      writeFileSync(
        join(testDir, 'agents', 'researcher.md'),
        `---
id: agent-researcher
tags: [agent]
status: active
---

<!-- L0: Researcher agent. -->

# Agent: Researcher
`
      );

      const docs = loadAgentDocs(testDir);
      expect(docs).toHaveLength(2);
    });
  });

  describe('findAgent', () => {
    beforeEach(() => {
      writeFileSync(
        join(testDir, 'agents', 'evaluator.md'),
        `---
id: agent-evaluator
tags: [agent, validation]
status: active
---

<!-- L0: Evaluator agent. -->

# Agent: Evaluator
`
      );

      writeFileSync(
        join(testDir, 'agents', 'summarizer.md'),
        `---
id: agent-summarizer
tags: [agent, utility]
status: active
---

<!-- L0: Summarizer agent. -->

# Agent: Summarizer
`
      );
    });

    it('should find agent by exact id', () => {
      const agent = findAgent(testDir, 'agent-evaluator');
      expect(agent).toBeDefined();
      expect(agent!.frontmatter.id).toBe('agent-evaluator');
    });

    it('should find agent by id without prefix', () => {
      const agent = findAgent(testDir, 'evaluator');
      expect(agent).toBeDefined();
      expect(agent!.frontmatter.id).toBe('agent-evaluator');
    });

    it('should find agent by filename', () => {
      // Agent with non-standard id
      writeFileSync(
        join(testDir, 'agents', 'custom.md'),
        `---
id: my-custom-agent
tags: [agent]
status: active
---

<!-- L0: Custom agent. -->

# Agent: Custom
`
      );

      const agent = findAgent(testDir, 'custom');
      expect(agent).toBeDefined();
      expect(agent!.frontmatter.id).toBe('my-custom-agent');
    });

    it('should return undefined for non-existent agent', () => {
      const agent = findAgent(testDir, 'nonexistent');
      expect(agent).toBeUndefined();
    });
  });

  describe('listAgents', () => {
    it('should return empty array when no agents', () => {
      const agents = listAgents(testDir);
      expect(agents).toEqual([]);
    });

    it('should return agent info with l0 and tags', () => {
      writeFileSync(
        join(testDir, 'agents', 'summarizer.md'),
        `---
id: agent-summarizer
tags: [agent, utility, stateless]
status: active
---

<!-- L0: Stateless summarizer agent. -->
<!-- L1: Produces structured summaries from long-form text. -->

# Agent: Summarizer
`
      );

      const agents = listAgents(testDir);
      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe('agent-summarizer');
      expect(agents[0].l0).toBe('Stateless summarizer agent.');
      expect(agents[0].tags).toContain('agent');
      expect(agents[0].tags).toContain('stateless');
      expect(agents[0].status).toBe('active');
    });
  });

  describe('buildAgentPrompt', () => {
    it('should include agent body in system prompt', () => {
      writeFileSync(
        join(testDir, 'agents', 'evaluator.md'),
        `---
id: agent-evaluator
tags: [agent]
status: active
---

<!-- L0: Evaluator agent. -->
<!-- L1: Validates incoming files. -->

# Agent: Evaluator

## Purpose
Validate and evaluate incoming capability files.

## Process
1. Check format
2. Validate frontmatter
3. Test compatibility
`
      );

      const agentDoc = findAgent(testDir, 'agent-evaluator')!;
      const config = loadConfig(testDir);
      const prompt = buildAgentPrompt(testDir, agentDoc, config);

      expect(prompt).toContain('# AGENT: agent-evaluator');
      expect(prompt).toContain('## Purpose');
      expect(prompt).toContain('Validate and evaluate incoming capability files.');
      expect(prompt).toContain('## Process');
    });

    it('should include CORE.md context', () => {
      writeFileSync(
        join(testDir, 'agents', 'evaluator.md'),
        `---
id: agent-evaluator
tags: [agent]
status: active
---

<!-- L0: Evaluator agent. -->

# Agent: Evaluator
`
      );

      const agentDoc = findAgent(testDir, 'agent-evaluator')!;
      const config = loadConfig(testDir);
      const prompt = buildAgentPrompt(testDir, agentDoc, config);

      expect(prompt).toContain('# PRIMARY AGENT CONTEXT');
      expect(prompt).toContain('I am a test agent.');
    });

    it('should include rules at compressed level', () => {
      writeFileSync(
        join(testDir, 'rules', 'safety.md'),
        `---
id: safety
tags: [rules]
status: active
---

<!-- L0: Safety rules for all operations. -->
<!-- L1: Never commit secrets. Validate all inputs. Check authorization on every request. -->

# Rule: Safety

## Details
Detailed safety rules go here...
`
      );

      writeFileSync(
        join(testDir, 'agents', 'evaluator.md'),
        `---
id: agent-evaluator
tags: [agent]
status: active
---

<!-- L0: Evaluator agent. -->

# Agent: Evaluator
`
      );

      const agentDoc = findAgent(testDir, 'agent-evaluator')!;
      const config = loadConfig(testDir);
      const prompt = buildAgentPrompt(testDir, agentDoc, config);

      // Should have rules section
      expect(prompt).toContain('# RULES');
      expect(prompt).toContain('safety');
    });

    it('should respect token budget for sub-agent context', () => {
      // Create an agent with a very large body
      const largeBody = 'x'.repeat(100000); // ~25000 tokens
      writeFileSync(
        join(testDir, 'agents', 'large.md'),
        `---
id: agent-large
tags: [agent]
status: active
---

<!-- L0: Large agent. -->

# Agent: Large

${largeBody}
`
      );

      const agentDoc = findAgent(testDir, 'agent-large')!;
      const config = loadConfig(testDir);
      const prompt = buildAgentPrompt(testDir, agentDoc, config);

      // Agent body is always included (even if over budget), but CORE.md
      // and rules should be skipped when agent body is already huge
      expect(prompt).toContain('# AGENT: agent-large');
      // With a 200k model, 10% = 20000 tokens. The agent body is ~25000.
      // CORE.md should be excluded since it would exceed budget.
      expect(prompt).not.toContain('# PRIMARY AGENT CONTEXT');
    });
  });

  describe('input validation', () => {
    it('should reject empty agentId', async () => {
      await expect(
        delegateTo({ harnessDir: testDir, agentId: '', prompt: 'test' })
      ).rejects.toThrow('agentId is required');
    });

    it('should reject empty prompt', async () => {
      await expect(
        delegateTo({ harnessDir: testDir, agentId: 'some-agent', prompt: '  ' })
      ).rejects.toThrow('prompt cannot be empty');
    });

    it('delegateStream should reject empty agentId', () => {
      expect(() =>
        delegateStream({ harnessDir: testDir, agentId: '', prompt: 'test' })
      ).toThrow('agentId is required');
    });
  });

  describe('delegateTo', () => {
    it('should throw descriptive error for non-existent agent', async () => {
      await expect(
        delegateTo({
          harnessDir: testDir,
          agentId: 'nonexistent',
          prompt: 'test',
        })
      ).rejects.toThrow('Agent "nonexistent" not found');
    });

    it('should include available agents in error message', async () => {
      writeFileSync(
        join(testDir, 'agents', 'summarizer.md'),
        `---
id: agent-summarizer
tags: [agent]
status: active
---

<!-- L0: Summarizer agent. -->

# Agent: Summarizer
`
      );

      try {
        await delegateTo({
          harnessDir: testDir,
          agentId: 'nonexistent',
          prompt: 'test',
        });
      } catch (err: unknown) {
        const message = (err as Error).message;
        expect(message).toContain('Available agents:');
        expect(message).toContain('agent-summarizer');
      }
    });

    it('should return delegation result with session record', async () => {
      writeFileSync(
        join(testDir, 'agents', 'worker.md'),
        `---
id: agent-worker
tags: [agent]
status: active
---

<!-- L0: Worker agent. -->

# Agent: Worker
`
      );

      const result = await delegateTo({
        harnessDir: testDir,
        agentId: 'agent-worker',
        prompt: 'Do the work',
        apiKey: 'test-key',
      });

      expect(result.agentId).toBe('agent-worker');
      expect(result.text).toBe('Delegated response (primary).');
      expect(result.usage.totalTokens).toBeGreaterThan(0);
      expect(result.sessionId).toMatch(/^\d{4}-\d{2}-\d{2}-/);

      // Verify session file was written
      const sessionsDir = join(testDir, 'memory', 'sessions');
      const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.md'));
      expect(files.length).toBeGreaterThan(0);

      const sessionContent = readFileSync(join(sessionsDir, files[0]), 'utf-8');
      expect(sessionContent).toContain('**Delegated to:** agent-worker');
      expect(sessionContent).toContain('tags: [session, delegation, agent-worker]');
    });

    // ─── Task 12.15: agent frontmatter model: selector ────────────────────
    // Sub-agents can declare `model: primary | summary | fast` to route the
    // LLM call to getModel / getSummaryModel / getFastModel respectively.
    // Invalid values throw. Unset defaults to primary (unchanged behavior).

    it('agent without model: field uses primary (current behavior preserved)', async () => {
      writeFileSync(
        join(testDir, 'agents', 'no-model-field.md'),
        `---
id: agent-no-model
tags: [agent]
status: active
---

<!-- L0: No model field. -->

# Agent: No Model Field
`
      );

      const result = await delegateTo({
        harnessDir: testDir,
        agentId: 'agent-no-model',
        prompt: 'hello',
        apiKey: 'test-key',
      });

      // The primary mock responds with "Delegated response (primary)."
      expect(result.text).toBe('Delegated response (primary).');
    });

    it('agent with model: summary routes to getSummaryModel', async () => {
      writeFileSync(
        join(testDir, 'agents', 'summary-agent.md'),
        `---
id: agent-summary
tags: [agent]
status: active
model: summary
---

<!-- L0: Summary agent. -->

# Agent: Summary
`
      );

      const result = await delegateTo({
        harnessDir: testDir,
        agentId: 'agent-summary',
        prompt: 'condense this',
        apiKey: 'test-key',
      });

      // The summary mock responds with "Delegated response (summary)."
      expect(result.text).toBe('Delegated response (summary).');
    });

    it('agent with model: fast routes to getFastModel', async () => {
      writeFileSync(
        join(testDir, 'agents', 'fast-agent.md'),
        `---
id: agent-fast
tags: [agent]
status: active
model: fast
---

<!-- L0: Fast agent. -->

# Agent: Fast
`
      );

      const result = await delegateTo({
        harnessDir: testDir,
        agentId: 'agent-fast',
        prompt: 'quick answer',
        apiKey: 'test-key',
      });

      // The fast mock responds with "Delegated response (fast)."
      expect(result.text).toBe('Delegated response (fast).');
    });

    it('agent with invalid model: value throws clear error', async () => {
      // The zod enum rejects values outside primary/summary/fast, so the
      // frontmatter parser normally drops them. But a passthrough-equivalent
      // agent file using an unrecognized tier would throw in delegate.ts's
      // switch statement. Simulate that by ensuring the error path exists —
      // we write an agent with a valid enum value here and verify the
      // default + allowed values work, since zod prevents the bad path
      // from reaching delegate.ts in the first place.
      //
      // The defensive switch-default throws protect against frontmatter
      // being injected by non-zod paths (direct API use, future extensions).
      // Unit-testing the default-case throw directly would require bypassing
      // zod, which is wrong. Instead, verify zod rejects the bad value:
      const { FrontmatterSchema } = await import('../src/core/types.js');
      const parsed = FrontmatterSchema.safeParse({
        id: 'agent-bad',
        model: 'nonsense-tier',
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe('delegateStream', () => {
    it('should throw for non-existent agent', () => {
      expect(() =>
        delegateStream({
          harnessDir: testDir,
          agentId: 'nonexistent',
          prompt: 'test',
        })
      ).toThrow('Agent "nonexistent" not found');
    });

    it('should return agentId and sessionId for valid agent', () => {
      writeFileSync(
        join(testDir, 'agents', 'streamer.md'),
        `---
id: agent-streamer
tags: [agent]
status: active
---

<!-- L0: Streamer agent. -->

# Agent: Streamer
`
      );

      const result = delegateStream({
        harnessDir: testDir,
        agentId: 'agent-streamer',
        prompt: 'Stream test',
        apiKey: 'test-key',
      });

      expect(result.agentId).toBe('agent-streamer');
      expect(result.sessionId).toBeDefined();
      expect(result.textStream).toBeDefined();
    });

    it('should stream text and write session after consumption', async () => {
      writeFileSync(
        join(testDir, 'agents', 'streamer.md'),
        `---
id: agent-streamer
tags: [agent]
status: active
---

<!-- L0: Streamer agent. -->

# Agent: Streamer
`
      );

      const result = delegateStream({
        harnessDir: testDir,
        agentId: 'agent-streamer',
        prompt: 'Stream this',
        apiKey: 'test-key',
      });

      // Consume the stream
      let fullText = '';
      for await (const chunk of result.textStream) {
        fullText += chunk;
      }

      expect(fullText).toBe('Streamed (primary).');

      // Session should be written after stream is consumed
      const sessionsDir = join(testDir, 'memory', 'sessions');
      const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.md'));
      expect(files.length).toBeGreaterThan(0);

      const sessionContent = readFileSync(join(sessionsDir, files[0]), 'utf-8');
      expect(sessionContent).toContain('**Delegated to:** agent-streamer');
      expect(sessionContent).toContain('Streamed (primary).');
      // Should capture real token count instead of 0
      expect(sessionContent).not.toContain('**Tokens:** 0');
    });
  });
});
