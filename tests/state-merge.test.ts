import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scaffoldHarness } from '../src/cli/scaffold.js';
import { saveState, loadState } from '../src/runtime/state.js';
import {
  mergeState,
  applyStateChange,
  loadOwnership,
  saveOwnership,
} from '../src/runtime/state-merge.js';
import type { AgentState } from '../src/core/types.js';

describe('state-merge', () => {
  let harnessDir: string;
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'state-merge-'));
    harnessDir = join(tmpBase, 'test-agent');
    scaffoldHarness(harnessDir, 'test-agent', { template: 'base' });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  describe('loadOwnership / saveOwnership', () => {
    it('should return defaults when no ownership file exists', () => {
      const ownership = loadOwnership(harnessDir);
      expect(ownership.mode).toBe('agent');
      expect(ownership.goals).toBe('human');
      expect(ownership.last_interaction).toBe('infrastructure');
    });

    it('should persist and reload ownership', () => {
      saveOwnership(harnessDir, {
        mode: 'human',
        goals: 'agent',
        active_workflows: 'infrastructure',
        last_interaction: 'agent',
        unfinished_business: 'human',
      });

      const loaded = loadOwnership(harnessDir);
      expect(loaded.mode).toBe('human');
      expect(loaded.goals).toBe('agent');
      expect(loaded.active_workflows).toBe('infrastructure');
    });
  });

  describe('mergeState', () => {
    it('should apply changes from the same owner without conflict', () => {
      saveState(harnessDir, {
        mode: 'idle',
        goals: ['goal-1'],
        active_workflows: [],
        last_interaction: new Date().toISOString(),
        unfinished_business: [],
      });

      const result = mergeState(harnessDir, {
        author: 'agent',
        changes: { mode: 'active' },
      });

      expect(result.state.mode).toBe('active');
      expect(result.hadConflicts).toBe(false);
    });

    it('should detect conflicts when different owner changes same field', () => {
      // Set ownership: goals owned by human
      saveOwnership(harnessDir, {
        mode: 'agent',
        goals: 'human',
        active_workflows: 'agent',
        last_interaction: 'infrastructure',
        unfinished_business: 'agent',
      });

      saveState(harnessDir, {
        mode: 'idle',
        goals: ['human-goal'],
        active_workflows: [],
        last_interaction: new Date().toISOString(),
        unfinished_business: [],
      });

      // Agent tries to change goals (owned by human)
      const result = mergeState(harnessDir, {
        author: 'agent',
        changes: { goals: ['agent-goal'] },
      }, 'human-wins');

      expect(result.hadConflicts).toBe(true);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].field).toBe('goals');
      // Human wins — original value preserved
      expect(result.state.goals).toEqual(['human-goal']);
    });

    it('should let agent win with agent-wins strategy', () => {
      saveOwnership(harnessDir, {
        mode: 'agent',
        goals: 'human',
        active_workflows: 'agent',
        last_interaction: 'infrastructure',
        unfinished_business: 'agent',
      });

      saveState(harnessDir, {
        mode: 'idle',
        goals: ['human-goal'],
        active_workflows: [],
        last_interaction: new Date().toISOString(),
        unfinished_business: [],
      });

      const result = mergeState(harnessDir, {
        author: 'agent',
        changes: { goals: ['agent-goal'] },
      }, 'agent-wins');

      expect(result.hadConflicts).toBe(true);
      expect(result.state.goals).toEqual(['agent-goal']);
      expect(result.conflicts[0].resolvedTo).toBe('agent');
    });

    it('should merge arrays with union strategy', () => {
      saveOwnership(harnessDir, {
        mode: 'agent',
        goals: 'human',
        active_workflows: 'agent',
        last_interaction: 'infrastructure',
        unfinished_business: 'agent',
      });

      saveState(harnessDir, {
        mode: 'idle',
        goals: ['goal-A', 'goal-B'],
        active_workflows: [],
        last_interaction: new Date().toISOString(),
        unfinished_business: [],
      });

      const result = mergeState(harnessDir, {
        author: 'agent',
        changes: { goals: ['goal-B', 'goal-C'] },
      }, 'union');

      expect(result.hadConflicts).toBe(true);
      // Union of ['goal-A', 'goal-B'] and ['goal-B', 'goal-C']
      expect(result.state.goals).toContain('goal-A');
      expect(result.state.goals).toContain('goal-B');
      expect(result.state.goals).toContain('goal-C');
      expect(result.state.goals).toHaveLength(3);
    });

    it('should skip fields with identical values', () => {
      saveOwnership(harnessDir, {
        mode: 'human',
        goals: 'human',
        active_workflows: 'agent',
        last_interaction: 'infrastructure',
        unfinished_business: 'agent',
      });

      saveState(harnessDir, {
        mode: 'active',
        goals: [],
        active_workflows: [],
        last_interaction: new Date().toISOString(),
        unfinished_business: [],
      });

      // Agent sets mode to same value as current
      const result = mergeState(harnessDir, {
        author: 'agent',
        changes: { mode: 'active' },
      });

      expect(result.hadConflicts).toBe(false);
    });

    it('should update last_interaction timestamp', () => {
      saveState(harnessDir, {
        mode: 'idle',
        goals: [],
        active_workflows: [],
        last_interaction: '2024-01-01T00:00:00.000Z',
        unfinished_business: [],
      });

      const result = mergeState(harnessDir, {
        author: 'agent',
        changes: { mode: 'working' },
        timestamp: '2025-04-06T12:00:00.000Z',
      });

      expect(result.state.last_interaction).toBe('2025-04-06T12:00:00.000Z');
    });
  });

  describe('applyStateChange', () => {
    it('should apply partial state changes directly', () => {
      saveState(harnessDir, {
        mode: 'idle',
        goals: ['old-goal'],
        active_workflows: [],
        last_interaction: new Date().toISOString(),
        unfinished_business: [],
      });

      const result = applyStateChange(harnessDir, {
        mode: 'working',
        goals: ['new-goal'],
      });

      expect(result.mode).toBe('working');
      expect(result.goals).toEqual(['new-goal']);
      // Unchanged fields preserved
      expect(result.active_workflows).toEqual([]);
    });

    it('should persist changes', () => {
      saveState(harnessDir, {
        mode: 'idle',
        goals: [],
        active_workflows: [],
        last_interaction: new Date().toISOString(),
        unfinished_business: [],
      });

      applyStateChange(harnessDir, { mode: 'busy' });

      const loaded = loadState(harnessDir);
      expect(loaded.mode).toBe('busy');
    });
  });
});
