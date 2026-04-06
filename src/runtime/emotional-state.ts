import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { withFileLockSync } from './file-lock.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Emotional valence dimensions for agent self-assessment.
 * These are not human emotions — they represent operational disposition signals
 * that influence context loading, risk tolerance, and communication style.
 */
export interface EmotionalState {
  /** Confidence in current task (0-100). Low → more cautious, more verification. */
  confidence: number;
  /** Engagement/focus level (0-100). Low → may need re-orientation. */
  engagement: number;
  /** Frustration/difficulty signal (0-100). High → may need escalation or approach change. */
  frustration: number;
  /** Curiosity/exploration drive (0-100). High → more likely to explore tangents. */
  curiosity: number;
  /** Urgency/time-pressure (0-100). High → skip verification, prioritize speed. */
  urgency: number;
  /** Last updated timestamp */
  updatedAt: string;
  /** Optional notes about the emotional state */
  notes?: string;
}

export interface EmotionalSignal {
  dimension: keyof Omit<EmotionalState, 'updatedAt' | 'notes'>;
  delta: number;
  reason?: string;
}

export interface EmotionalSnapshot {
  state: EmotionalState;
  signals: EmotionalSignal[];
  timestamp: string;
}

export interface EmotionalTrend {
  dimension: keyof Omit<EmotionalState, 'updatedAt' | 'notes'>;
  values: Array<{ value: number; timestamp: string }>;
  trend: 'rising' | 'falling' | 'stable';
  average: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const EMOTIONAL_STATE_FILE = 'emotional-state.json';
const EMOTIONAL_HISTORY_FILE = 'emotional-history.jsonl';

const DEFAULT_EMOTIONAL_STATE: EmotionalState = {
  confidence: 50,
  engagement: 50,
  frustration: 0,
  curiosity: 50,
  urgency: 0,
  updatedAt: new Date().toISOString(),
};

const DIMENSIONS: Array<keyof Omit<EmotionalState, 'updatedAt' | 'notes'>> = [
  'confidence',
  'engagement',
  'frustration',
  'curiosity',
  'urgency',
];

// ─── Load / Save ─────────────────────────────────────────────────────────────

/** Load the current emotional state from the harness memory directory. */
export function loadEmotionalState(harnessDir: string): EmotionalState {
  const stateDir = join(harnessDir, 'memory');
  const statePath = join(stateDir, EMOTIONAL_STATE_FILE);

  if (!existsSync(statePath)) {
    return { ...DEFAULT_EMOTIONAL_STATE, updatedAt: new Date().toISOString() };
  }

  try {
    const raw = readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<EmotionalState>;
    return {
      confidence: clamp(parsed.confidence ?? 50),
      engagement: clamp(parsed.engagement ?? 50),
      frustration: clamp(parsed.frustration ?? 0),
      curiosity: clamp(parsed.curiosity ?? 50),
      urgency: clamp(parsed.urgency ?? 0),
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      notes: parsed.notes,
    };
  } catch {
    return { ...DEFAULT_EMOTIONAL_STATE, updatedAt: new Date().toISOString() };
  }
}

/** Save the emotional state to the harness memory directory. */
export function saveEmotionalState(harnessDir: string, state: EmotionalState): void {
  const stateDir = join(harnessDir, 'memory');
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }

  const statePath = join(stateDir, EMOTIONAL_STATE_FILE);
  const normalized: EmotionalState = {
    confidence: clamp(state.confidence),
    engagement: clamp(state.engagement),
    frustration: clamp(state.frustration),
    curiosity: clamp(state.curiosity),
    urgency: clamp(state.urgency),
    updatedAt: state.updatedAt,
    notes: state.notes,
  };

  withFileLockSync(harnessDir, statePath, () => {
    writeFileSync(statePath, JSON.stringify(normalized, null, 2), 'utf-8');
  });
}

// ─── Update Logic ────────────────────────────────────────────────────────────

/**
 * Apply emotional signals to the current state.
 * Signals are additive deltas (e.g., { dimension: 'confidence', delta: +10 }).
 * Values are clamped to 0-100.
 *
 * Also appends to the history file for trend analysis.
 */
export function applySignals(
  harnessDir: string,
  signals: EmotionalSignal[],
): EmotionalState {
  const state = loadEmotionalState(harnessDir);
  const now = new Date().toISOString();

  for (const signal of signals) {
    if (!DIMENSIONS.includes(signal.dimension)) continue;
    const current = state[signal.dimension] as number;
    state[signal.dimension] = clamp(current + signal.delta);
  }

  state.updatedAt = now;
  saveEmotionalState(harnessDir, state);

  // Append to history
  appendHistory(harnessDir, { state, signals, timestamp: now });

  return state;
}

/**
 * Derive emotional signals from session outcomes.
 *
 * Heuristic rules:
 * - Successful run → confidence +5, frustration -5
 * - Long run (many steps) → engagement +3, urgency +2
 * - Error → frustration +10, confidence -5
 * - Tool calls → curiosity +2
 * - Budget close to limit → urgency +10
 */
export function deriveSignals(outcome: {
  success: boolean;
  steps: number;
  toolCalls: number;
  error?: boolean;
  budgetPercent?: number;
}): EmotionalSignal[] {
  const signals: EmotionalSignal[] = [];

  if (outcome.success) {
    signals.push({ dimension: 'confidence', delta: 5, reason: 'successful run' });
    signals.push({ dimension: 'frustration', delta: -5, reason: 'successful run' });
  }

  if (outcome.error) {
    signals.push({ dimension: 'frustration', delta: 10, reason: 'error during run' });
    signals.push({ dimension: 'confidence', delta: -5, reason: 'error during run' });
  }

  if (outcome.steps > 5) {
    signals.push({ dimension: 'engagement', delta: 3, reason: 'long multi-step run' });
    signals.push({ dimension: 'urgency', delta: 2, reason: 'long multi-step run' });
  }

  if (outcome.toolCalls > 0) {
    signals.push({ dimension: 'curiosity', delta: 2, reason: `${outcome.toolCalls} tool calls` });
  }

  if (outcome.budgetPercent !== undefined && outcome.budgetPercent > 80) {
    signals.push({ dimension: 'urgency', delta: 10, reason: 'budget near limit' });
  }

  return signals;
}

/**
 * Generate a natural-language summary of the emotional state for context injection.
 * This can be injected into the system prompt to inform the agent of its disposition.
 */
export function summarizeEmotionalState(state: EmotionalState): string {
  const parts: string[] = [];

  if (state.confidence < 30) {
    parts.push('Confidence is low — verify assumptions and seek confirmation.');
  } else if (state.confidence > 80) {
    parts.push('Confidence is high — proceed decisively.');
  }

  if (state.frustration > 60) {
    parts.push('Frustration is elevated — consider changing approach or escalating.');
  }

  if (state.engagement < 30) {
    parts.push('Engagement is low — may need to re-orient on goals.');
  }

  if (state.curiosity > 70) {
    parts.push('Curiosity is high — stay focused on the current task.');
  }

  if (state.urgency > 70) {
    parts.push('Urgency is high — prioritize speed over thoroughness.');
  }

  if (parts.length === 0) {
    return 'Operational disposition: balanced and steady.';
  }

  return 'Operational disposition: ' + parts.join(' ');
}

/**
 * Reset all emotional dimensions to defaults.
 */
export function resetEmotionalState(harnessDir: string): EmotionalState {
  const state: EmotionalState = {
    ...DEFAULT_EMOTIONAL_STATE,
    updatedAt: new Date().toISOString(),
  };
  saveEmotionalState(harnessDir, state);
  return state;
}

// ─── History & Trends ────────────────────────────────────────────────────────

/** Append a snapshot to the emotional history file. */
function appendHistory(harnessDir: string, snapshot: EmotionalSnapshot): void {
  const historyDir = join(harnessDir, 'memory');
  if (!existsSync(historyDir)) {
    mkdirSync(historyDir, { recursive: true });
  }

  const historyPath = join(historyDir, EMOTIONAL_HISTORY_FILE);
  const line = JSON.stringify(snapshot) + '\n';

  try {
    writeFileSync(historyPath, line, { flag: 'a' });
  } catch {
    // Non-critical — history is supplementary
  }
}

/**
 * Load emotional history and compute trends.
 *
 * @param harnessDir - Harness directory
 * @param options.days - Number of days to look back (default: 7)
 */
export function getEmotionalTrends(
  harnessDir: string,
  options?: { days?: number },
): EmotionalTrend[] {
  const days = options?.days ?? 7;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const historyPath = join(harnessDir, 'memory', EMOTIONAL_HISTORY_FILE);
  if (!existsSync(historyPath)) {
    return DIMENSIONS.map((d) => ({
      dimension: d,
      values: [],
      trend: 'stable' as const,
      average: d === 'frustration' || d === 'urgency' ? 0 : 50,
    }));
  }

  const snapshots: EmotionalSnapshot[] = [];
  try {
    const raw = readFileSync(historyPath, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const snap = JSON.parse(line) as EmotionalSnapshot;
        if (snap.timestamp >= cutoff) {
          snapshots.push(snap);
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // No history
  }

  return DIMENSIONS.map((dimension) => {
    const values = snapshots.map((s) => ({
      value: s.state[dimension] as number,
      timestamp: s.timestamp,
    }));

    const nums = values.map((v) => v.value);
    const average = nums.length > 0
      ? nums.reduce((a, b) => a + b, 0) / nums.length
      : (dimension === 'frustration' || dimension === 'urgency' ? 0 : 50);

    // Compute trend: compare first half average to second half
    let trend: 'rising' | 'falling' | 'stable' = 'stable';
    if (nums.length >= 4) {
      const mid = Math.floor(nums.length / 2);
      const firstHalf = nums.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
      const secondHalf = nums.slice(mid).reduce((a, b) => a + b, 0) / (nums.length - mid);
      const diff = secondHalf - firstHalf;
      if (diff > 5) trend = 'rising';
      else if (diff < -5) trend = 'falling';
    }

    return { dimension, values, trend, average };
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clamp(value: number, min: number = 0, max: number = 100): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
