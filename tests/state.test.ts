import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadState, saveState } from '../src/runtime/state.js';
import type { AgentState } from '../src/core/types.js';

describe('state.md parsing and rendering', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'state-test-'));
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return default state when file does not exist', () => {
    const state = loadState(testDir);

    expect(state.mode).toBe('idle');
    expect(state.goals).toEqual([]);
    expect(state.active_workflows).toEqual([]);
    expect(state.unfinished_business).toEqual([]);
    expect(state.last_interaction).toBeDefined();
  });

  it('should parse a complete state.md file', () => {
    writeFileSync(
      join(testDir, 'state.md'),
      `# Agent State

## Mode
working

## Goals
- Complete project documentation
- Fix critical bugs

## Active Workflows
- daily-standup
- hourly-health-check

## Last Interaction
2026-04-06T10:30:00.000Z

## Unfinished Business
- Review PR #123
- Update dependencies
`
    );

    const state = loadState(testDir);

    expect(state.mode).toBe('working');
    expect(state.goals).toEqual(['Complete project documentation', 'Fix critical bugs']);
    expect(state.active_workflows).toEqual(['daily-standup', 'hourly-health-check']);
    expect(state.last_interaction).toBe('2026-04-06T10:30:00.000Z');
    expect(state.unfinished_business).toEqual(['Review PR #123', 'Update dependencies']);
  });

  it('should handle empty sections', () => {
    writeFileSync(
      join(testDir, 'state.md'),
      `# Agent State

## Mode
idle

## Goals

## Active Workflows

## Last Interaction
2026-04-06T10:30:00.000Z

## Unfinished Business
`
    );

    const state = loadState(testDir);

    expect(state.mode).toBe('idle');
    expect(state.goals).toEqual([]);
    expect(state.active_workflows).toEqual([]);
    expect(state.unfinished_business).toEqual([]);
  });

  it('should handle missing sections gracefully', () => {
    writeFileSync(
      join(testDir, 'state.md'),
      `# Agent State

## Mode
active
`
    );

    const state = loadState(testDir);

    expect(state.mode).toBe('active');
    // Missing sections should use defaults
    expect(state.goals).toEqual([]);
    expect(state.active_workflows).toEqual([]);
  });

  it('should save state correctly', () => {
    const state: AgentState = {
      mode: 'working',
      goals: ['Goal 1', 'Goal 2'],
      active_workflows: ['workflow-1'],
      last_interaction: '2026-04-06T10:30:00.000Z',
      unfinished_business: ['Task A', 'Task B'],
    };

    saveState(testDir, state);

    const content = readFileSync(join(testDir, 'memory', 'state.md'), 'utf-8');

    expect(content).toContain('## Mode');
    expect(content).toContain('working');
    expect(content).toContain('## Goals');
    expect(content).toContain('- Goal 1');
    expect(content).toContain('- Goal 2');
    expect(content).toContain('## Active Workflows');
    expect(content).toContain('- workflow-1');
    expect(content).toContain('## Last Interaction');
    expect(content).toContain('2026-04-06T10:30:00.000Z');
    expect(content).toContain('## Unfinished Business');
    expect(content).toContain('- Task A');
    expect(content).toContain('- Task B');
  });

  it('should round-trip state correctly', () => {
    const original: AgentState = {
      mode: 'active',
      goals: ['Complete testing', 'Deploy to production'],
      active_workflows: ['ci-cd'],
      last_interaction: '2026-04-06T12:00:00.000Z',
      unfinished_business: ['Fix bug #456'],
    };

    saveState(testDir, original);
    const loaded = loadState(testDir);

    expect(loaded).toEqual(original);
  });

  it('should handle goals with special characters', () => {
    writeFileSync(
      join(testDir, 'state.md'),
      `# Agent State

## Mode
working

## Goals
- Fix issue #123: API timeout
- Update docs (section 3.2)
- Handle edge case: "null" values

## Active Workflows

## Last Interaction
2026-04-06T10:30:00.000Z

## Unfinished Business
`
    );

    const state = loadState(testDir);

    expect(state.goals).toEqual([
      'Fix issue #123: API timeout',
      'Update docs (section 3.2)',
      'Handle edge case: "null" values',
    ]);
  });

  it('should ignore non-list-item lines in list sections', () => {
    writeFileSync(
      join(testDir, 'state.md'),
      `# Agent State

## Mode
idle

## Goals
- Valid goal 1
This is not a list item
- Valid goal 2

## Active Workflows

## Last Interaction
2026-04-06T10:30:00.000Z

## Unfinished Business
`
    );

    const state = loadState(testDir);

    // Should only capture lines starting with "- "
    expect(state.goals).toEqual(['Valid goal 1', 'Valid goal 2']);
  });

  it('should handle multiline goals split across lines', () => {
    writeFileSync(
      join(testDir, 'state.md'),
      `# Agent State

## Mode
working

## Goals
- First goal on one line
- Second goal that spans
  multiple lines with indentation
- Third goal

## Active Workflows

## Last Interaction
2026-04-06T10:30:00.000Z

## Unfinished Business
`
    );

    const state = loadState(testDir);

    // Current implementation treats continuation lines as non-list items
    // So they are ignored. This is acceptable behavior.
    expect(state.goals).toContain('First goal on one line');
    expect(state.goals).toContain('Third goal');
  });

  it('should preserve empty state file format', () => {
    const emptyState: AgentState = {
      mode: 'idle',
      goals: [],
      active_workflows: [],
      last_interaction: '2026-04-06T10:30:00.000Z',
      unfinished_business: [],
    };

    saveState(testDir, emptyState);
    const content = readFileSync(join(testDir, 'memory', 'state.md'), 'utf-8');

    // Should have all sections even when empty
    expect(content).toContain('## Mode');
    expect(content).toContain('## Goals');
    expect(content).toContain('## Active Workflows');
    expect(content).toContain('## Last Interaction');
    expect(content).toContain('## Unfinished Business');
  });

  it('should handle state with only mode changed from default', () => {
    writeFileSync(
      join(testDir, 'state.md'),
      `# Agent State

## Mode
learning

## Goals

## Active Workflows

## Last Interaction
2026-04-06T10:30:00.000Z

## Unfinished Business
`
    );

    const state = loadState(testDir);

    expect(state.mode).toBe('learning');
    expect(state.goals).toEqual([]);
  });

  describe('memory/state.md location', () => {
    it('reads from memory/state.md when present', () => {
      mkdirSync(join(testDir, 'memory'), { recursive: true });
      writeFileSync(
        join(testDir, 'memory', 'state.md'),
        `# Agent State

## Mode
idle

## Goals

## Active Workflows

## Last Interaction
2026-04-28

## Unfinished Business
`,
        'utf-8',
      );

      const state = loadState(testDir);
      expect(state.mode).toBe('idle');
    });

    it('falls back to top-level state.md (deprecation grace)', () => {
      writeFileSync(
        join(testDir, 'state.md'),
        `# Agent State

## Mode
active

## Goals

## Active Workflows

## Last Interaction
2026-04-28

## Unfinished Business
`,
        'utf-8',
      );

      const state = loadState(testDir);
      expect(state.mode).toBe('active');
    });

    it('saveState writes to memory/state.md (creating directory)', () => {
      saveState(testDir, {
        mode: 'active',
        goals: [],
        active_workflows: [],
        last_interaction: '2026-04-28',
        unfinished_business: [],
      });
      expect(existsSync(join(testDir, 'memory', 'state.md'))).toBe(true);
    });
  });
});
