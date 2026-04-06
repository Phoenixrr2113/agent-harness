import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { AgentState } from '../core/types.js';
import { loadState, saveState } from './state.js';
import { withFileLockSync } from './file-lock.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type StateOwner = 'human' | 'agent' | 'infrastructure';

/** Tracks which entity last modified each field of the state. */
export interface StateOwnership {
  mode: StateOwner;
  goals: StateOwner;
  active_workflows: StateOwner;
  last_interaction: StateOwner;
  unfinished_business: StateOwner;
}

/** A state change with ownership metadata. */
export interface OwnedStateChange {
  /** Who is making this change */
  author: StateOwner;
  /** Partial state to merge — only provided fields are updated */
  changes: Partial<AgentState>;
  /** Timestamp of the change (ISO string) */
  timestamp?: string;
}

/** Strategy for resolving conflicting state changes. */
export type MergeStrategy = 'human-wins' | 'agent-wins' | 'latest-wins' | 'union';

export interface MergeResult {
  /** The merged state */
  state: AgentState;
  /** Updated ownership */
  ownership: StateOwnership;
  /** Fields that had conflicts */
  conflicts: StateConflict[];
  /** Whether any conflicts were resolved */
  hadConflicts: boolean;
}

export interface StateConflict {
  field: keyof AgentState;
  humanValue: unknown;
  agentValue: unknown;
  resolvedTo: StateOwner;
  resolvedValue: unknown;
}

// ─── Ownership Tracking ─────────────────────────────────────────────────────

const DEFAULT_OWNERSHIP: StateOwnership = {
  mode: 'agent',
  goals: 'human',
  active_workflows: 'agent',
  last_interaction: 'infrastructure',
  unfinished_business: 'agent',
};

const OWNERSHIP_FILE = 'state-ownership.json';

/** Load ownership metadata from the harness directory. */
export function loadOwnership(harnessDir: string): StateOwnership {
  const ownershipPath = join(harnessDir, 'memory', OWNERSHIP_FILE);
  if (!existsSync(ownershipPath)) {
    return { ...DEFAULT_OWNERSHIP };
  }

  try {
    const raw = readFileSync(ownershipPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StateOwnership>;
    return { ...DEFAULT_OWNERSHIP, ...parsed };
  } catch {
    return { ...DEFAULT_OWNERSHIP };
  }
}

/** Save ownership metadata to the harness directory. */
export function saveOwnership(harnessDir: string, ownership: StateOwnership): void {
  const memoryDir = join(harnessDir, 'memory');
  const ownershipPath = join(memoryDir, OWNERSHIP_FILE);
  withFileLockSync(harnessDir, ownershipPath, () => {
    writeFileSync(ownershipPath, JSON.stringify(ownership, null, 2), 'utf-8');
  });
}

// ─── Merge Logic ─────────────────────────────────────────────────────────────

/**
 * Merge a state change into the current state, respecting ownership.
 *
 * Rules:
 * - `human-wins`: If a human-owned field is being changed by an agent, the human value is kept.
 * - `agent-wins`: If an agent-owned field is being changed by a human, the agent value is kept.
 * - `latest-wins`: The most recent change always wins (default).
 * - `union`: For array fields (goals, active_workflows, unfinished_business), merge by union.
 *            For scalar fields, latest-wins.
 *
 * @param harnessDir - Harness directory path
 * @param change - The state change to apply
 * @param strategy - Merge strategy (default: 'human-wins')
 */
export function mergeState(
  harnessDir: string,
  change: OwnedStateChange,
  strategy: MergeStrategy = 'human-wins',
): MergeResult {
  const currentState = loadState(harnessDir);
  const ownership = loadOwnership(harnessDir);
  const conflicts: StateConflict[] = [];

  const mergedState = { ...currentState };
  const mergedOwnership = { ...ownership };

  const fields = Object.keys(change.changes) as Array<keyof AgentState>;

  for (const field of fields) {
    const newValue = change.changes[field];
    if (newValue === undefined) continue;

    const currentOwner = ownership[field];
    const changeAuthor = change.author;

    // Same owner → no conflict, apply directly
    if (currentOwner === changeAuthor) {
      applyField(mergedState, field, newValue);
      continue;
    }

    // Different owner → potential conflict
    const currentValue = currentState[field];

    // Check if values actually differ
    if (valuesEqual(currentValue, newValue)) {
      continue; // No actual conflict
    }

    // Resolve conflict based on strategy
    const resolved = resolveConflict(
      field,
      currentValue,
      newValue,
      currentOwner,
      changeAuthor,
      strategy,
    );

    conflicts.push({
      field,
      humanValue: currentOwner === 'human' ? currentValue : newValue,
      agentValue: currentOwner === 'agent' ? currentValue : newValue,
      resolvedTo: resolved.winner,
      resolvedValue: resolved.value,
    });

    applyField(mergedState, field, resolved.value);
    mergedOwnership[field] = resolved.winner;
  }

  // Update ownership for non-conflicting changes
  for (const field of fields) {
    if (!conflicts.some((c) => c.field === field)) {
      mergedOwnership[field] = change.author;
    }
  }

  // Update last_interaction
  mergedState.last_interaction = change.timestamp ?? new Date().toISOString();
  mergedOwnership.last_interaction = 'infrastructure';

  // Persist
  saveState(harnessDir, mergedState);
  saveOwnership(harnessDir, mergedOwnership);

  return {
    state: mergedState,
    ownership: mergedOwnership,
    conflicts,
    hadConflicts: conflicts.length > 0,
  };
}

/**
 * Apply a state change without ownership — direct write.
 * Use this when ownership tracking is not needed.
 */
export function applyStateChange(
  harnessDir: string,
  changes: Partial<AgentState>,
): AgentState {
  const currentState = loadState(harnessDir);
  const mergedState = { ...currentState };

  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) {
      applyField(mergedState, key as keyof AgentState, value);
    }
  }

  saveState(harnessDir, mergedState);
  return mergedState;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveConflict(
  field: keyof AgentState,
  currentValue: unknown,
  newValue: unknown,
  currentOwner: StateOwner,
  changeAuthor: StateOwner,
  strategy: MergeStrategy,
): { value: unknown; winner: StateOwner } {
  switch (strategy) {
    case 'human-wins':
      if (currentOwner === 'human') {
        return { value: currentValue, winner: 'human' };
      }
      if (changeAuthor === 'human') {
        return { value: newValue, winner: 'human' };
      }
      // Neither is human — latest wins
      return { value: newValue, winner: changeAuthor };

    case 'agent-wins':
      if (currentOwner === 'agent') {
        return { value: currentValue, winner: 'agent' };
      }
      if (changeAuthor === 'agent') {
        return { value: newValue, winner: 'agent' };
      }
      return { value: newValue, winner: changeAuthor };

    case 'latest-wins':
      return { value: newValue, winner: changeAuthor };

    case 'union':
      if (isArrayField(field) && Array.isArray(currentValue) && Array.isArray(newValue)) {
        const union = [...new Set([...currentValue, ...newValue])];
        return { value: union, winner: changeAuthor };
      }
      // Non-array fields: latest wins
      return { value: newValue, winner: changeAuthor };

    default:
      return { value: newValue, winner: changeAuthor };
  }
}

function isArrayField(field: keyof AgentState): boolean {
  return field === 'goals' || field === 'active_workflows' || field === 'unfinished_business';
}

function applyField(state: AgentState, field: keyof AgentState, value: unknown): void {
  switch (field) {
    case 'mode':
      state.mode = value as string;
      break;
    case 'goals':
      state.goals = value as string[];
      break;
    case 'active_workflows':
      state.active_workflows = value as string[];
      break;
    case 'last_interaction':
      state.last_interaction = value as string;
      break;
    case 'unfinished_business':
      state.unfinished_business = value as string[];
      break;
  }
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}
