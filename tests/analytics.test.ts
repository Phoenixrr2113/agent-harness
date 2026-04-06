import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { getSessionAnalytics, getSessionsInRange } from '../src/runtime/analytics.js';

const TEST_DIR = join(__dirname, '__test_analytics__');

function makeSession(id: string, tokens: number, steps: number, durationMinutes: number, model?: string, delegatedTo?: string): string {
  const dateMatch = id.match(/^(\d{4}-\d{2}-\d{2})/);
  const date = dateMatch ? dateMatch[1] : '2026-04-01';
  const started = `${date}T10:00:00Z`;
  const ended = `${date}T10:${String(durationMinutes).padStart(2, '0')}:00Z`;
  const modelLine = model ? `\n**Model:** ${model}` : '';
  const delegateLine = delegatedTo ? `\n**Delegated to:** ${delegatedTo}` : '';

  return `---
id: ${id}
tags: [session]
created: ${started}
updated: ${ended}
author: agent
status: active
duration_minutes: ${durationMinutes}
---

<!-- L0: Session ${id} -->

# Session: ${id}

**Started:** ${started}
**Ended:** ${ended}
**Tokens:** ${tokens}
**Steps:** ${steps}${modelLine}${delegateLine}

## Prompt
Test prompt

## Summary
Test summary
`;
}

describe('analytics', () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, 'memory', 'sessions'), { recursive: true });
    writeFileSync(join(TEST_DIR, 'CORE.md'), '# Core', 'utf-8');
    writeFileSync(
      join(TEST_DIR, 'config.yaml'),
      `agent:\n  name: test\n  version: "0.1.0"\nmodel:\n  provider: openrouter\n  id: test-model\n  max_tokens: 200000\n`,
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should return empty analytics when no sessions', () => {
    const analytics = getSessionAnalytics(TEST_DIR);
    expect(analytics.totalSessions).toBe(0);
    expect(analytics.totalTokens).toBe(0);
    expect(analytics.dateRange).toBeNull();
  });

  it('should compute analytics from sessions', () => {
    writeFileSync(
      join(TEST_DIR, 'memory', 'sessions', '2026-04-01-aaaa1111.md'),
      makeSession('2026-04-01-aaaa1111', 500, 3, 5, 'claude-sonnet'),
      'utf-8',
    );
    writeFileSync(
      join(TEST_DIR, 'memory', 'sessions', '2026-04-01-bbbb2222.md'),
      makeSession('2026-04-01-bbbb2222', 300, 2, 3, 'claude-sonnet'),
      'utf-8',
    );
    writeFileSync(
      join(TEST_DIR, 'memory', 'sessions', '2026-04-02-cccc3333.md'),
      makeSession('2026-04-02-cccc3333', 1000, 5, 10, 'gpt-4o'),
      'utf-8',
    );

    const analytics = getSessionAnalytics(TEST_DIR);
    expect(analytics.totalSessions).toBe(3);
    expect(analytics.totalTokens).toBe(1800);
    expect(analytics.avgTokensPerSession).toBe(600);
    expect(analytics.avgDurationMinutes).toBe(6);
    expect(analytics.dateRange).toEqual({ earliest: '2026-04-01', latest: '2026-04-02' });

    // Sessions per day
    expect(analytics.sessionsPerDay.get('2026-04-01')).toBe(2);
    expect(analytics.sessionsPerDay.get('2026-04-02')).toBe(1);

    // Model usage
    expect(analytics.modelUsage.get('claude-sonnet')).toBe(2);
    expect(analytics.modelUsage.get('gpt-4o')).toBe(1);
  });

  it('should count delegations', () => {
    writeFileSync(
      join(TEST_DIR, 'memory', 'sessions', '2026-04-01-aaaa1111.md'),
      makeSession('2026-04-01-aaaa1111', 500, 3, 5),
      'utf-8',
    );
    writeFileSync(
      join(TEST_DIR, 'memory', 'sessions', '2026-04-01-bbbb2222.md'),
      makeSession('2026-04-01-bbbb2222', 300, 2, 3, undefined, 'summarizer'),
      'utf-8',
    );

    const analytics = getSessionAnalytics(TEST_DIR);
    expect(analytics.delegationCount).toBe(1);
  });

  it('should show top days sorted by session count', () => {
    writeFileSync(
      join(TEST_DIR, 'memory', 'sessions', '2026-04-01-a.md'),
      makeSession('2026-04-01-aaaa0001', 100, 1, 1),
      'utf-8',
    );
    writeFileSync(
      join(TEST_DIR, 'memory', 'sessions', '2026-04-01-b.md'),
      makeSession('2026-04-01-aaaa0002', 200, 1, 1),
      'utf-8',
    );
    writeFileSync(
      join(TEST_DIR, 'memory', 'sessions', '2026-04-01-c.md'),
      makeSession('2026-04-01-aaaa0003', 300, 1, 1),
      'utf-8',
    );
    writeFileSync(
      join(TEST_DIR, 'memory', 'sessions', '2026-04-02-a.md'),
      makeSession('2026-04-02-bbbb0001', 500, 1, 1),
      'utf-8',
    );

    const analytics = getSessionAnalytics(TEST_DIR);
    expect(analytics.topDays.length).toBe(2);
    expect(analytics.topDays[0].date).toBe('2026-04-01');
    expect(analytics.topDays[0].sessions).toBe(3);
  });

  it('should filter sessions by date range', () => {
    writeFileSync(
      join(TEST_DIR, 'memory', 'sessions', '2026-04-01-a.md'),
      makeSession('2026-04-01-aaaa0001', 100, 1, 1),
      'utf-8',
    );
    writeFileSync(
      join(TEST_DIR, 'memory', 'sessions', '2026-04-03-a.md'),
      makeSession('2026-04-03-bbbb0001', 200, 1, 1),
      'utf-8',
    );
    writeFileSync(
      join(TEST_DIR, 'memory', 'sessions', '2026-04-05-a.md'),
      makeSession('2026-04-05-cccc0001', 300, 1, 1),
      'utf-8',
    );

    const sessions = getSessionsInRange(TEST_DIR, '2026-04-02', '2026-04-04');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].date).toBe('2026-04-03');
  });

  it('should return empty for nonexistent sessions dir', () => {
    rmSync(join(TEST_DIR, 'memory', 'sessions'), { recursive: true, force: true });

    const analytics = getSessionAnalytics(TEST_DIR);
    expect(analytics.totalSessions).toBe(0);

    const sessions = getSessionsInRange(TEST_DIR);
    expect(sessions).toHaveLength(0);
  });

  it('should handle session files with missing data gracefully', () => {
    writeFileSync(
      join(TEST_DIR, 'memory', 'sessions', 'malformed.md'),
      '---\nid: malformed\n---\n# Bad session\nNo tokens info here.',
      'utf-8',
    );

    const analytics = getSessionAnalytics(TEST_DIR);
    expect(analytics.totalSessions).toBe(1);
    expect(analytics.totalTokens).toBe(0); // No tokens parseable
  });
});
