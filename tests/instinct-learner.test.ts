import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../src/llm/provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm/provider.js')>();
  const { MockLanguageModelV3 } = await import('ai/test');
  let mockResponse = 'NONE';
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: mockResponse }],
      finishReason: { type: 'stop' as const },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 50, text: 50, reasoning: undefined },
      },
    }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'text-start' as const, id: '1' });
          controller.enqueue({ type: 'text-delta' as const, id: '1', delta: mockResponse });
          controller.enqueue({ type: 'text-end' as const, id: '1' });
          controller.enqueue({
            type: 'finish' as const,
            usage: {
              inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 50, text: 50, reasoning: undefined },
            },
            finishReason: { type: 'stop' as const },
          });
          controller.close();
        },
      }),
    }),
  });
  return {
    ...actual,
    getModel: vi.fn().mockReturnValue(model),
    // Allow tests to control mock response
    __setMockResponse: (text: string) => { mockResponse = text; },
  };
});

import { installInstinct, proposeInstincts, learnFromSessions } from '../src/runtime/instinct-learner.js';
import type { InstinctCandidate } from '../src/runtime/instinct-learner.js';

function makeTestDir(): string {
  const dir = join(tmpdir(), `instinct-learner-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'memory', 'sessions'), { recursive: true });
  mkdirSync(join(dir, 'memory', 'journal'), { recursive: true });
  mkdirSync(join(dir, 'instincts'), { recursive: true });
  mkdirSync(join(dir, 'rules'), { recursive: true });
  mkdirSync(join(dir, 'skills'), { recursive: true });
  writeFileSync(join(dir, 'CORE.md'), '# Test Agent\n\nTest.\n', 'utf-8');
  writeFileSync(
    join(dir, 'config.yaml'),
    `agent:\n  name: test-learner\nmodel:\n  id: test/model\n  max_tokens: 200000\n`,
    'utf-8',
  );
  return dir;
}

describe('installInstinct', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should create a markdown file for the instinct', () => {
    const candidate: InstinctCandidate = {
      id: 'validate-inputs',
      behavior: 'Always validate user inputs at boundaries',
      provenance: 'session:2026-03-20',
      confidence: 0.85,
    };

    const path = installInstinct(testDir, candidate);
    expect(path).toBe(join(testDir, 'instincts', 'validate-inputs.md'));
    expect(existsSync(path)).toBe(true);

    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('id: validate-inputs');
    expect(content).toContain('tags: [instinct, auto-learned]');
    expect(content).toContain('author: agent');
    expect(content).toContain('status: active');
    expect(content).toContain('Always validate user inputs at boundaries');
    expect(content).toContain('session:2026-03-20');
    expect(content).toContain('0.85');
  });

  it('should not overwrite existing instinct file', () => {
    const candidate: InstinctCandidate = {
      id: 'existing-instinct',
      behavior: 'New behavior',
      provenance: 'test',
      confidence: 0.9,
    };

    // Pre-create the file
    writeFileSync(
      join(testDir, 'instincts', 'existing-instinct.md'),
      'original content',
      'utf-8',
    );

    const path = installInstinct(testDir, candidate);
    expect(path).toBe('');

    // Original content preserved
    const content = readFileSync(join(testDir, 'instincts', 'existing-instinct.md'), 'utf-8');
    expect(content).toBe('original content');
  });

  it('should create instincts dir if it does not exist', () => {
    rmSync(join(testDir, 'instincts'), { recursive: true, force: true });

    const candidate: InstinctCandidate = {
      id: 'new-instinct',
      behavior: 'Some behavior',
      provenance: 'test',
      confidence: 0.8,
    };

    const path = installInstinct(testDir, candidate);
    expect(path).toBeTruthy();
    expect(existsSync(path)).toBe(true);
  });

  it('should title-case the instinct name from kebab-case id', () => {
    const candidate: InstinctCandidate = {
      id: 'check-error-codes',
      behavior: 'Check error codes after API calls',
      provenance: 'test',
      confidence: 0.75,
    };

    const path = installInstinct(testDir, candidate);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('# Instinct: Check Error Codes');
  });
});

describe('proposeInstincts', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return empty array when no sessions or journals exist', async () => {
    const candidates = await proposeInstincts(testDir);
    expect(candidates).toEqual([]);
  });

  it('should return empty array when LLM responds with NONE', async () => {
    // Create a session file so there's context to analyze
    writeFileSync(
      join(testDir, 'memory', 'sessions', 'session-1.md'),
      '# Session\n\nSome content here for the LLM to analyze.',
      'utf-8',
    );

    const { __setMockResponse } = await import('../src/llm/provider.js') as { __setMockResponse: (t: string) => void };
    __setMockResponse('NONE');

    const candidates = await proposeInstincts(testDir);
    expect(candidates).toEqual([]);
  });

  it('should parse JSON instinct candidates from LLM response', async () => {
    writeFileSync(
      join(testDir, 'memory', 'sessions', 'session-1.md'),
      '# Session\n\nUser asked about error handling.',
      'utf-8',
    );

    const { __setMockResponse } = await import('../src/llm/provider.js') as { __setMockResponse: (t: string) => void };
    __setMockResponse(
      '{"id": "handle-errors", "behavior": "Always handle errors explicitly", "provenance": "session observation", "confidence": 0.85}\n' +
      '{"id": "log-context", "behavior": "Include context in log messages", "provenance": "session observation", "confidence": 0.75}',
    );

    const candidates = await proposeInstincts(testDir);
    expect(candidates).toHaveLength(2);
    expect(candidates[0].id).toBe('handle-errors');
    expect(candidates[0].behavior).toBe('Always handle errors explicitly');
    expect(candidates[0].confidence).toBe(0.85);
    expect(candidates[1].id).toBe('log-context');
  });

  it('should skip candidates with confidence below 0.7', async () => {
    writeFileSync(
      join(testDir, 'memory', 'sessions', 'session-1.md'),
      '# Session\n\nSome content.',
      'utf-8',
    );

    const { __setMockResponse } = await import('../src/llm/provider.js') as { __setMockResponse: (t: string) => void };
    __setMockResponse(
      '{"id": "high-conf", "behavior": "Good instinct", "provenance": "test", "confidence": 0.9}\n' +
      '{"id": "low-conf", "behavior": "Weak instinct", "provenance": "test", "confidence": 0.5}',
    );

    const candidates = await proposeInstincts(testDir);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe('high-conf');
  });

  it('should skip malformed JSON lines', async () => {
    writeFileSync(
      join(testDir, 'memory', 'sessions', 'session-1.md'),
      '# Session\n\nContent.',
      'utf-8',
    );

    const { __setMockResponse } = await import('../src/llm/provider.js') as { __setMockResponse: (t: string) => void };
    __setMockResponse(
      'Here are some candidates:\n' +
      '{"id": "valid-one", "behavior": "Valid instinct", "provenance": "test", "confidence": 0.8}\n' +
      'not-json\n' +
      '{"id": "valid-two", "behavior": "Another valid one", "provenance": "test", "confidence": 0.75}',
    );

    const candidates = await proposeInstincts(testDir);
    expect(candidates).toHaveLength(2);
  });

  it('should load from journal when fromJournalDate is provided', async () => {
    writeFileSync(
      join(testDir, 'memory', 'journal', '2026-03-20.md'),
      '# Journal\n\nDiscovered that error handling patterns are important.',
      'utf-8',
    );

    const { __setMockResponse } = await import('../src/llm/provider.js') as { __setMockResponse: (t: string) => void };
    __setMockResponse(
      '{"id": "from-journal", "behavior": "Handle errors at boundaries", "provenance": "journal:2026-03-20", "confidence": 0.9}',
    );

    const candidates = await proposeInstincts(testDir, '2026-03-20');
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe('from-journal');
  });
});

describe('learnFromSessions', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return candidates without installing when autoInstall is false', async () => {
    writeFileSync(
      join(testDir, 'memory', 'sessions', 'session-1.md'),
      '# Session\n\nContent for learning.',
      'utf-8',
    );

    const { __setMockResponse } = await import('../src/llm/provider.js') as { __setMockResponse: (t: string) => void };
    __setMockResponse(
      '{"id": "test-learn", "behavior": "Test behavior", "provenance": "session", "confidence": 0.8}',
    );

    const result = await learnFromSessions(testDir, false);
    expect(result.candidates).toHaveLength(1);
    expect(result.installed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);

    // File should NOT be created
    expect(existsSync(join(testDir, 'instincts', 'test-learn.md'))).toBe(false);
  });

  it('should install candidates when autoInstall is true', async () => {
    writeFileSync(
      join(testDir, 'memory', 'sessions', 'session-1.md'),
      '# Session\n\nContent for learning.',
      'utf-8',
    );

    const { __setMockResponse } = await import('../src/llm/provider.js') as { __setMockResponse: (t: string) => void };
    __setMockResponse(
      '{"id": "auto-installed", "behavior": "Auto installed behavior", "provenance": "session", "confidence": 0.8}',
    );

    const result = await learnFromSessions(testDir, true);
    expect(result.candidates).toHaveLength(1);
    expect(result.installed).toHaveLength(1);
    expect(result.installed[0]).toBe('auto-installed');

    // File should be created
    expect(existsSync(join(testDir, 'instincts', 'auto-installed.md'))).toBe(true);
  });

  it('should skip already-existing instincts during auto-install', async () => {
    writeFileSync(
      join(testDir, 'memory', 'sessions', 'session-1.md'),
      '# Session\n\nContent.',
      'utf-8',
    );

    // Pre-create the instinct
    writeFileSync(
      join(testDir, 'instincts', 'already-exists.md'),
      'existing content',
      'utf-8',
    );

    const { __setMockResponse } = await import('../src/llm/provider.js') as { __setMockResponse: (t: string) => void };
    __setMockResponse(
      '{"id": "already-exists", "behavior": "Some behavior", "provenance": "session", "confidence": 0.8}',
    );

    const result = await learnFromSessions(testDir, true);
    expect(result.candidates).toHaveLength(1);
    expect(result.installed).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toBe('already-exists');
  });

  it('should return empty result when no context available', async () => {
    const { __setMockResponse } = await import('../src/llm/provider.js') as { __setMockResponse: (t: string) => void };
    __setMockResponse('NONE');

    const result = await learnFromSessions(testDir);
    expect(result.candidates).toEqual([]);
    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});
