import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadAgentDocs,
  findAgent,
  listAgents,
  buildAgentPrompt,
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

  describe('delegateTo', () => {
    it('should throw descriptive error for non-existent agent', async () => {
      const { delegateTo } = await import('../src/runtime/delegate.js');

      await expect(
        delegateTo({
          harnessDir: testDir,
          agentId: 'nonexistent',
          prompt: 'test',
        })
      ).rejects.toThrow('Agent "nonexistent" not found');
    });

    it('should include available agents in error message', async () => {
      const { delegateTo } = await import('../src/runtime/delegate.js');

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
  });

  describe('delegateStream', () => {
    it('should throw for non-existent agent', async () => {
      const { delegateStream } = await import('../src/runtime/delegate.js');

      expect(() =>
        delegateStream({
          harnessDir: testDir,
          agentId: 'nonexistent',
          prompt: 'test',
        })
      ).toThrow('Agent "nonexistent" not found');
    });

    it('should return agentId and sessionId for valid agent', async () => {
      const { delegateStream } = await import('../src/runtime/delegate.js');

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
  });
});
