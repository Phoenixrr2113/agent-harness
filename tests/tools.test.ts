import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import {
  loadTools,
  getToolById,
  listToolSummaries,
  checkToolAuth,
  parseToolDefinition,
} from '../src/runtime/tools.js';
import { parseHarnessDocument } from '../src/primitives/loader.js';

const TEST_DIR = join(__dirname, '__test_tools__');

const GITHUB_TOOL = `---
id: tool-github
tags: [source-control, prs, issues]
created: 2026-04-01
author: human
status: active
---
<!-- L0: GitHub — source control, PRs, issues, CI. Auth via GITHUB_TOKEN. -->
<!-- L1: Read: list PRs, get diffs. Write: post reviews, create issues. 5K req/hr. -->

# Tool: GitHub

## Authentication
- \`GITHUB_TOKEN\` environment variable
- Scopes: \`repo\`, \`read:org\`

## Common Operations

### Read
- List open PRs: \`GET /repos/{owner}/{repo}/pulls\`
- Get diff: \`GET /repos/{owner}/{repo}/pulls/{number}\`

### Write
- Post review: \`POST /repos/{owner}/{repo}/pulls/{number}/reviews\`
- Create issue: \`POST /repos/{owner}/{repo}/issues\`

## Rate Limits
- 5,000 requests/hour authenticated
- Search: 30 requests/minute

## Gotchas
- PR diffs truncated at 300 files
- Draft PRs skip some webhook events
`;

const TELEGRAM_TOOL = `---
id: tool-telegram
tags: [communication, notifications]
created: 2026-04-01
author: human
status: active
---
<!-- L0: Telegram — async comms. Bot token auth. -->
<!-- L1: Send/edit with MarkdownV2. 30 msg/sec rate limit. -->

# Tool: Telegram

## Authentication
- \`TELEGRAM_BOT_TOKEN\` environment variable
- \`TELEGRAM_CHAT_ID\` environment variable

## Common Operations
- Send: \`POST /sendMessage\`
- Edit: \`POST /editMessageText\`

## Rate Limits
- 30 messages/second to same chat

## Gotchas
- MarkdownV2 requires escaping special chars
- Max 4096 chars per message
`;

const NO_AUTH_TOOL = `---
id: tool-calculator
tags: [utility]
created: 2026-04-01
author: human
status: draft
---
<!-- L0: Calculator — basic arithmetic operations. No auth required. -->

# Tool: Calculator

## Common Operations
- Add: \`GET /add?a=1&b=2\`
- Multiply: \`POST /multiply\`
`;

function setupTools() {
  mkdirSync(join(TEST_DIR, 'tools'), { recursive: true });
  writeFileSync(join(TEST_DIR, 'CORE.md'), '# Core', 'utf-8');
  writeFileSync(
    join(TEST_DIR, 'config.yaml'),
    `agent:\n  name: test\n  version: "0.1.0"\nmodel:\n  provider: openrouter\n  id: test-model\n  max_tokens: 200000\n`,
    'utf-8',
  );
  writeFileSync(join(TEST_DIR, 'tools', 'github.md'), GITHUB_TOOL, 'utf-8');
  writeFileSync(join(TEST_DIR, 'tools', 'telegram.md'), TELEGRAM_TOOL, 'utf-8');
  writeFileSync(join(TEST_DIR, 'tools', 'calculator.md'), NO_AUTH_TOOL, 'utf-8');
}

describe('tools', () => {
  beforeEach(() => {
    setupTools();
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should load all tools from directory', () => {
    const tools = loadTools(TEST_DIR);
    expect(tools).toHaveLength(3);
    const ids = tools.map((t) => t.id).sort();
    expect(ids).toEqual(['tool-calculator', 'tool-github', 'tool-telegram']);
  });

  it('should return empty array when no tools directory', () => {
    rmSync(join(TEST_DIR, 'tools'), { recursive: true, force: true });
    const tools = loadTools(TEST_DIR);
    expect(tools).toEqual([]);
  });

  it('should extract auth env vars from github tool', () => {
    const tool = getToolById(TEST_DIR, 'tool-github');
    expect(tool).not.toBeNull();
    expect(tool!.auth).toHaveLength(1);
    expect(tool!.auth[0].envVar).toBe('GITHUB_TOKEN');
  });

  it('should extract multiple auth env vars from telegram tool', () => {
    const tool = getToolById(TEST_DIR, 'tool-telegram');
    expect(tool).not.toBeNull();
    expect(tool!.auth).toHaveLength(2);
    const envVars = tool!.auth.map((a) => a.envVar);
    expect(envVars).toContain('TELEGRAM_BOT_TOKEN');
    expect(envVars).toContain('TELEGRAM_CHAT_ID');
  });

  it('should extract operations from github tool', () => {
    const tool = getToolById(TEST_DIR, 'tool-github');
    expect(tool).not.toBeNull();
    expect(tool!.operations).toHaveLength(4);
    const methods = tool!.operations.map((o) => o.method);
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
  });

  it('should extract rate limits', () => {
    const tool = getToolById(TEST_DIR, 'tool-github');
    expect(tool!.rateLimits).toHaveLength(2);
    expect(tool!.rateLimits[0]).toContain('5,000');
  });

  it('should extract gotchas', () => {
    const tool = getToolById(TEST_DIR, 'tool-github');
    expect(tool!.gotchas).toHaveLength(2);
    expect(tool!.gotchas[0]).toContain('truncated');
  });

  it('should return null for unknown tool id', () => {
    const tool = getToolById(TEST_DIR, 'nonexistent');
    expect(tool).toBeNull();
  });

  it('should list tool summaries with auth status', () => {
    const summaries = listToolSummaries(TEST_DIR);
    expect(summaries).toHaveLength(3);

    const calc = summaries.find((s) => s.id === 'tool-calculator');
    expect(calc).toBeDefined();
    expect(calc!.authReady).toBe(true); // no auth required = ready
    expect(calc!.status).toBe('draft');
  });

  it('should check tool auth', () => {
    const results = checkToolAuth(TEST_DIR);
    expect(results).toHaveLength(3);

    const github = results.find((r) => r.tool === 'tool-github');
    expect(github).toBeDefined();
    expect(github!.auth).toHaveLength(1);
  });

  it('should check auth for a specific tool', () => {
    const results = checkToolAuth(TEST_DIR, 'tool-telegram');
    expect(results).toHaveLength(1);
    expect(results[0].tool).toBe('tool-telegram');
    expect(results[0].auth).toHaveLength(2);
  });

  it('should handle tool with no auth section', () => {
    const tool = getToolById(TEST_DIR, 'tool-calculator');
    expect(tool).not.toBeNull();
    expect(tool!.auth).toHaveLength(0);
    expect(tool!.operations).toHaveLength(2);
  });

  it('should parse operations without subsections', () => {
    const tool = getToolById(TEST_DIR, 'tool-telegram');
    expect(tool!.operations).toHaveLength(2);
    expect(tool!.operations[0].method).toBe('POST');
    expect(tool!.operations[0].endpoint).toBe('/sendMessage');
  });
});
