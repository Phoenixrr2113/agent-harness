import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

/** A recorded event in the sliding window */
export interface RateEvent {
  key: string;
  timestamp: number;
}

/** Rate limit rule: max requests per window_ms */
export interface RateLimit {
  key: string;
  max_requests: number;
  window_ms: number;
}

/** Result of a rate limit check */
export interface RateLimitCheck {
  allowed: boolean;
  key: string;
  current: number;
  max: number;
  window_ms: number;
  /** ms until oldest event expires (0 if allowed) */
  retry_after_ms: number;
}

/** Persisted rate limit state */
export interface RateLimitStore {
  events: RateEvent[];
  updated: string;
}

const RATE_FILE = 'rate-limits.json';
const MAX_EVENTS = 10000;

function getStorePath(harnessDir: string): string {
  return join(harnessDir, 'memory', RATE_FILE);
}

/**
 * Load rate limit events from disk.
 * Returns empty store if file doesn't exist or is corrupt.
 */
export function loadRateLimits(harnessDir: string): RateLimitStore {
  const storePath = getStorePath(harnessDir);
  if (!existsSync(storePath)) {
    return { events: [], updated: new Date().toISOString() };
  }

  try {
    const content = readFileSync(storePath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'events' in parsed &&
      Array.isArray((parsed as RateLimitStore).events)
    ) {
      return parsed as RateLimitStore;
    }
    return { events: [], updated: new Date().toISOString() };
  } catch {
    return { events: [], updated: new Date().toISOString() };
  }
}

/**
 * Save rate limit events to disk. Trims to MAX_EVENTS.
 */
export function saveRateLimits(harnessDir: string, store: RateLimitStore): void {
  const memoryDir = join(harnessDir, 'memory');
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }

  if (store.events.length > MAX_EVENTS) {
    store.events = store.events.slice(store.events.length - MAX_EVENTS);
  }

  store.updated = new Date().toISOString();
  writeFileSync(getStorePath(harnessDir), JSON.stringify(store, null, 2), 'utf-8');
}

/**
 * Prune expired events from the store (older than the largest known window).
 */
function pruneExpired(store: RateLimitStore, now: number, maxWindowMs: number): void {
  const cutoff = now - maxWindowMs;
  store.events = store.events.filter((e) => e.timestamp > cutoff);
}

/**
 * Check if a request is allowed under the given rate limit.
 * Does NOT record the event — call recordEvent() separately on success.
 */
export function checkRateLimit(
  harnessDir: string,
  limit: RateLimit,
  now?: number,
): RateLimitCheck {
  const currentTime = now ?? Date.now();
  const store = loadRateLimits(harnessDir);

  const windowStart = currentTime - limit.window_ms;
  const eventsInWindow = store.events.filter(
    (e) => e.key === limit.key && e.timestamp > windowStart,
  );

  const current = eventsInWindow.length;
  const allowed = current < limit.max_requests;

  let retryAfterMs = 0;
  if (!allowed && eventsInWindow.length > 0) {
    // Time until the oldest event in the window expires
    const oldest = eventsInWindow.reduce((min, e) => Math.min(min, e.timestamp), Infinity);
    retryAfterMs = Math.max(0, oldest + limit.window_ms - currentTime);
  }

  return {
    allowed,
    key: limit.key,
    current,
    max: limit.max_requests,
    window_ms: limit.window_ms,
    retry_after_ms: retryAfterMs,
  };
}

/**
 * Record a rate limit event for a key.
 */
export function recordEvent(harnessDir: string, key: string, now?: number): void {
  const currentTime = now ?? Date.now();
  const store = loadRateLimits(harnessDir);

  store.events.push({ key, timestamp: currentTime });

  // Prune events older than 1 hour to keep the store manageable
  pruneExpired(store, currentTime, 3600000);

  saveRateLimits(harnessDir, store);
}

/**
 * Check rate limit AND record the event if allowed.
 * Returns the check result. If not allowed, does NOT record.
 */
export function tryAcquire(
  harnessDir: string,
  limit: RateLimit,
  now?: number,
): RateLimitCheck {
  const currentTime = now ?? Date.now();
  const check = checkRateLimit(harnessDir, limit, currentTime);

  if (check.allowed) {
    recordEvent(harnessDir, limit.key, currentTime);
  }

  return check;
}

/**
 * Get current usage for a key within a window.
 */
export function getUsage(
  harnessDir: string,
  key: string,
  windowMs: number,
  now?: number,
): { count: number; oldest: number | null; newest: number | null } {
  const currentTime = now ?? Date.now();
  const store = loadRateLimits(harnessDir);

  const windowStart = currentTime - windowMs;
  const eventsInWindow = store.events.filter(
    (e) => e.key === key && e.timestamp > windowStart,
  );

  if (eventsInWindow.length === 0) {
    return { count: 0, oldest: null, newest: null };
  }

  const timestamps = eventsInWindow.map((e) => e.timestamp);
  return {
    count: eventsInWindow.length,
    oldest: Math.min(...timestamps),
    newest: Math.max(...timestamps),
  };
}

/**
 * Clear all rate limit events for a key, or all keys.
 */
export function clearRateLimits(harnessDir: string, key?: string): number {
  const store = loadRateLimits(harnessDir);
  const before = store.events.length;

  if (key) {
    store.events = store.events.filter((e) => e.key !== key);
  } else {
    store.events = [];
  }

  saveRateLimits(harnessDir, store);
  return before - store.events.length;
}
