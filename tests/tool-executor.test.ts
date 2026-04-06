import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolveEndpoint,
  buildOperationSchema,
  buildAuthHeaders,
  buildToolSet,
  convertToolDefinition,
  createToolCallTracker,
  getToolSetSummary,
  executeHttpOperation,
} from '../src/runtime/tool-executor.js';
import type { ToolDefinition, ToolOperation } from '../src/runtime/tools.js';
import type { HarnessDocument } from '../src/core/types.js';

function makeDoc(overrides?: Partial<HarnessDocument>): HarnessDocument {
  return {
    path: '/test/tools/test-tool.md',
    frontmatter: {
      id: 'test-tool',
      tags: ['api'],
      status: 'active',
      related: [],
      author: 'human',
    },
    l0: 'Test tool for API calls',
    l1: 'Detailed description of the test tool',
    body: overrides?.body ?? '## Authentication\n\n`TEST_API_KEY`\n\n## Operations\n\n### Get Item\n\n`GET /items/{id}`\n\n### Create Item\n\n`POST /items`\n',
    raw: '',
    ...overrides,
  };
}

function makeToolDef(overrides?: Partial<ToolDefinition>): ToolDefinition {
  const doc = makeDoc();
  return {
    id: 'test-tool',
    doc,
    tags: ['api'],
    status: 'active',
    auth: [{ envVar: 'TEST_API_KEY', present: false }],
    operations: [
      { name: 'Get Item: {id}', method: 'GET', endpoint: '/items/{id}' },
      { name: 'Create Item: items', method: 'POST', endpoint: '/items' },
    ],
    rateLimits: [],
    gotchas: [],
    ...overrides,
  };
}

describe('tool-executor', () => {
  describe('resolveEndpoint', () => {
    it('should replace single parameter', () => {
      const result = resolveEndpoint('/items/{id}', { id: '123' });
      expect(result).toBe('/items/123');
    });

    it('should replace multiple parameters', () => {
      const result = resolveEndpoint('/repos/{owner}/{repo}/pulls', { owner: 'acme', repo: 'app' });
      expect(result).toBe('/repos/acme/app/pulls');
    });

    it('should URL-encode parameter values', () => {
      const result = resolveEndpoint('/search/{query}', { query: 'hello world' });
      expect(result).toBe('/search/hello%20world');
    });

    it('should leave unmatched parameters as-is', () => {
      const result = resolveEndpoint('/items/{id}', {});
      expect(result).toBe('/items/{id}');
    });

    it('should handle no parameters', () => {
      const result = resolveEndpoint('/items', {});
      expect(result).toBe('/items');
    });
  });

  describe('buildOperationSchema', () => {
    it('should create schema with URL parameters', () => {
      const op: ToolOperation = { name: 'get', method: 'GET', endpoint: '/repos/{owner}/{repo}' };
      const schema = buildOperationSchema(op);

      expect(schema).toEqual(expect.objectContaining({
        type: 'object',
        required: ['owner', 'repo'],
      }));
      const props = schema['properties'] as Record<string, { type: string }>;
      expect(props['owner']).toBeDefined();
      expect(props['repo']).toBeDefined();
      expect(props['query']).toBeDefined();
    });

    it('should include body parameter for POST', () => {
      const op: ToolOperation = { name: 'create', method: 'POST', endpoint: '/items' };
      const schema = buildOperationSchema(op);

      const props = schema['properties'] as Record<string, { type: string }>;
      expect(props['body']).toBeDefined();
      expect(props['body'].type).toBe('string');
    });

    it('should not include body parameter for GET', () => {
      const op: ToolOperation = { name: 'list', method: 'GET', endpoint: '/items' };
      const schema = buildOperationSchema(op);

      const props = schema['properties'] as Record<string, { type: string }>;
      expect(props['body']).toBeUndefined();
    });

    it('should handle endpoints with no parameters', () => {
      const op: ToolOperation = { name: 'list', method: 'GET', endpoint: '/items' };
      const schema = buildOperationSchema(op);

      expect(schema['required']).toEqual([]);
    });
  });

  describe('buildAuthHeaders', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should build Bearer auth from API key env var', () => {
      process.env['TEST_API_KEY'] = 'sk-test-123';
      const toolDef = makeToolDef({
        auth: [{ envVar: 'TEST_API_KEY', present: true }],
      });

      const headers = buildAuthHeaders(toolDef);
      expect(headers['Authorization']).toBe('Bearer sk-test-123');
    });

    it('should return empty headers when env var not set', () => {
      delete process.env['TEST_API_KEY'];
      const toolDef = makeToolDef({
        auth: [{ envVar: 'TEST_API_KEY', present: false }],
      });

      const headers = buildAuthHeaders(toolDef);
      expect(headers).toEqual({});
    });

    it('should handle bot token pattern', () => {
      process.env['DISCORD_BOT_TOKEN'] = 'bot-token-123';
      const toolDef = makeToolDef({
        auth: [{ envVar: 'DISCORD_BOT_TOKEN', present: true }],
      });

      const headers = buildAuthHeaders(toolDef);
      expect(headers['Authorization']).toBe('Bot bot-token-123');
    });

    it('should handle tools with no auth', () => {
      const toolDef = makeToolDef({ auth: [] });
      const headers = buildAuthHeaders(toolDef);
      expect(headers).toEqual({});
    });
  });

  describe('convertToolDefinition', () => {
    it('should create one tool per operation', () => {
      const toolDef = makeToolDef();
      const tools = convertToolDefinition(toolDef, {});

      const toolNames = Object.keys(tools);
      expect(toolNames).toHaveLength(2);
    });

    it('should sanitize tool names', () => {
      const toolDef = makeToolDef();
      const tools = convertToolDefinition(toolDef, {});

      const toolNames = Object.keys(tools);
      for (const name of toolNames) {
        expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
      }
    });

    it('should include tool description with method and endpoint', () => {
      const toolDef = makeToolDef();
      const tools = convertToolDefinition(toolDef, {});

      const firstTool = Object.values(tools)[0];
      expect((firstTool as { description?: string }).description).toContain('GET');
      expect((firstTool as { description?: string }).description).toContain('/items/{id}');
    });

    it('should return error when HTTP execution disabled', async () => {
      const toolDef = makeToolDef();
      const tools = convertToolDefinition(toolDef, { allowHttpExecution: false });

      const firstTool = Object.values(tools)[0] as { execute: (input: unknown) => Promise<unknown> };
      const result = await firstTool.execute({ id: '123' }) as { error: string };
      expect(result.error).toBe('HTTP tool execution is disabled');
    });

    it('should return error when auth missing', async () => {
      const originalEnv = process.env;
      process.env = { ...originalEnv };
      delete process.env['TEST_API_KEY'];

      const toolDef = makeToolDef({
        auth: [{ envVar: 'TEST_API_KEY', present: false }],
      });
      const tools = convertToolDefinition(toolDef, { allowHttpExecution: true });

      const firstTool = Object.values(tools)[0] as { execute: (input: unknown) => Promise<unknown> };
      const result = await firstTool.execute({ id: '123' }) as { error: string };
      expect(result.error).toContain('Missing required auth');
      expect(result.error).toContain('TEST_API_KEY');

      process.env = originalEnv;
    });
  });

  describe('buildToolSet', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = mkdtempSync(join(tmpdir(), 'tool-exec-test-'));
      mkdirSync(join(testDir, 'tools'), { recursive: true });
      mkdirSync(join(testDir, 'memory'), { recursive: true });
    });

    afterEach(() => {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should return empty toolset when no tools directory exists', () => {
      const emptyDir = mkdtempSync(join(tmpdir(), 'no-tools-'));
      const tools = buildToolSet(emptyDir);
      expect(Object.keys(tools)).toHaveLength(0);
      rmSync(emptyDir, { recursive: true, force: true });
    });

    it('should load tools from markdown files', () => {
      writeFileSync(
        join(testDir, 'tools', 'github.md'),
        `---
id: github
tags: [api, vcs]
status: active
---
# GitHub API

GitHub REST API integration

## Authentication

\`GITHUB_TOKEN\`

## Operations

### List Repos

\`GET /user/repos\`

### Create Issue

\`POST /repos/{owner}/{repo}/issues\`
`,
      );

      const tools = buildToolSet(testDir);
      const names = Object.keys(tools);
      expect(names.length).toBeGreaterThanOrEqual(2);
    });

    it('should skip inactive tools', () => {
      writeFileSync(
        join(testDir, 'tools', 'deprecated.md'),
        `---
id: deprecated-tool
tags: [api]
status: deprecated
---
# Deprecated Tool

Old tool

## Operations

### Get

\`GET /old\`
`,
      );

      const tools = buildToolSet(testDir);
      expect(Object.keys(tools)).toHaveLength(0);
    });

    it('should skip tools with no operations', () => {
      writeFileSync(
        join(testDir, 'tools', 'empty.md'),
        `---
id: empty-tool
tags: [api]
status: active
---
# Empty Tool

No operations here.
`,
      );

      const tools = buildToolSet(testDir);
      expect(Object.keys(tools)).toHaveLength(0);
    });
  });

  describe('createToolCallTracker', () => {
    it('should record tool calls', () => {
      const tracker = createToolCallTracker();

      tracker.record({
        toolName: 'test_tool',
        input: { id: '1' },
        output: { name: 'Test' },
        durationMs: 100,
        error: null,
      });

      tracker.record({
        toolName: 'another_tool',
        input: { q: 'search' },
        output: null,
        durationMs: 50,
        error: 'Timeout',
      });

      const record = tracker.getRecord();
      expect(record.calls).toHaveLength(2);
      expect(record.totalDurationMs).toBe(150);
      expect(record.calls[0].toolName).toBe('test_tool');
      expect(record.calls[1].error).toBe('Timeout');
    });

    it('should return empty record initially', () => {
      const tracker = createToolCallTracker();
      const record = tracker.getRecord();
      expect(record.calls).toHaveLength(0);
      expect(record.totalDurationMs).toBe(0);
    });

    it('should return a copy of calls array', () => {
      const tracker = createToolCallTracker();
      tracker.record({
        toolName: 'test',
        input: {},
        output: null,
        durationMs: 10,
        error: null,
      });

      const record1 = tracker.getRecord();
      const record2 = tracker.getRecord();
      expect(record1.calls).not.toBe(record2.calls);
      expect(record1.calls).toEqual(record2.calls);
    });
  });

  describe('getToolSetSummary', () => {
    it('should return descriptions for tools', () => {
      const toolDef = makeToolDef();
      const tools = convertToolDefinition(toolDef, {});
      const summaries = getToolSetSummary(tools);

      expect(summaries).toHaveLength(2);
      for (const summary of summaries) {
        expect(summary).toContain(':');
      }
    });
  });

  describe('executeHttpOperation', () => {
    it('should make HTTP request and return JSON', async () => {
      const mockResponse = { id: '123', name: 'Test Item' };

      // Mock global fetch
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const operation: ToolOperation = { name: 'get', method: 'GET', endpoint: '/items/{id}' };
      const result = await executeHttpOperation(
        operation,
        'https://api.example.com',
        { 'Authorization': 'Bearer test' },
        { id: '123' },
        5000,
      );

      expect(result).toEqual(mockResponse);
      expect(fetchSpy).toHaveBeenCalledOnce();
      const calledUrl = fetchSpy.mock.calls[0][0];
      expect(calledUrl).toBe('https://api.example.com/items/123');

      fetchSpy.mockRestore();
    });

    it('should throw on HTTP error', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Not Found', { status: 404, statusText: 'Not Found' }),
      );

      const operation: ToolOperation = { name: 'get', method: 'GET', endpoint: '/items/{id}' };

      await expect(
        executeHttpOperation(operation, 'https://api.example.com', {}, { id: 'bad' }, 5000),
      ).rejects.toThrow('HTTP 404 Not Found');

      fetchSpy.mockRestore();
    });

    it('should send body for POST requests', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ id: '1' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const operation: ToolOperation = { name: 'create', method: 'POST', endpoint: '/items' };
      await executeHttpOperation(
        operation,
        'https://api.example.com',
        {},
        { body: '{"name":"test"}' },
        5000,
      );

      expect(fetchSpy).toHaveBeenCalledOnce();
      const fetchOpts = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(fetchOpts.method).toBe('POST');
      expect(fetchOpts.body).toBe('{"name":"test"}');

      fetchSpy.mockRestore();
    });

    it('should append query parameters', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('[]', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const operation: ToolOperation = { name: 'list', method: 'GET', endpoint: '/items' };
      await executeHttpOperation(
        operation,
        'https://api.example.com',
        {},
        { query: 'page=1&limit=10' },
        5000,
      );

      const calledUrl = fetchSpy.mock.calls[0][0];
      expect(calledUrl).toBe('https://api.example.com/items?page=1&limit=10');

      fetchSpy.mockRestore();
    });

    it('should handle text responses', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Plain text response', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        }),
      );

      const operation: ToolOperation = { name: 'get', method: 'GET', endpoint: '/text' };
      const result = await executeHttpOperation(
        operation,
        'https://api.example.com',
        {},
        {},
        5000,
      );

      expect(result).toBe('Plain text response');
      fetchSpy.mockRestore();
    });
  });
});
