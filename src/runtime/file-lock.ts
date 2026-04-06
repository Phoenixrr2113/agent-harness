import { writeFileSync, unlinkSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, basename } from 'path';

export interface LockInfo {
  pid: number;
  acquired: string;
  file: string;
}

export interface LockOptions {
  /** Stale lock timeout in ms (default: 30000 = 30s) */
  staleMs?: number;
  /** How often to retry in ms (default: 50) */
  retryIntervalMs?: number;
  /** Max time to wait for lock in ms (default: 5000 = 5s) */
  waitMs?: number;
}

const DEFAULT_STALE_MS = 30000;
const DEFAULT_RETRY_MS = 50;
const DEFAULT_WAIT_MS = 5000;

function getLockDir(harnessDir: string): string {
  return join(harnessDir, 'memory');
}

function getLockPath(harnessDir: string, filePath: string): string {
  const lockDir = getLockDir(harnessDir);
  const lockName = basename(filePath).replace(/\.[^.]+$/, '') + '.lock';
  return join(lockDir, lockName);
}

/**
 * Read lock info from a lock file. Returns null if missing or corrupt.
 */
function readLockInfo(lockPath: string): LockInfo | null {
  if (!existsSync(lockPath)) return null;
  try {
    const content = readFileSync(lockPath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'pid' in parsed &&
      'acquired' in parsed
    ) {
      return parsed as LockInfo;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if a lock is stale (older than staleMs or held by dead process).
 */
function isStale(info: LockInfo, staleMs: number): boolean {
  const age = Date.now() - new Date(info.acquired).getTime();
  if (age > staleMs) return true;

  // Check if the process that holds the lock is still alive
  try {
    process.kill(info.pid, 0);
    return false; // Process exists
  } catch {
    return true; // Process is dead
  }
}

/**
 * Try to acquire a file lock. Non-blocking — returns immediately.
 * Returns true if lock was acquired, false if already held.
 */
export function tryLock(harnessDir: string, filePath: string, options?: LockOptions): boolean {
  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  const lockPath = getLockPath(harnessDir, filePath);

  // Ensure lock directory exists
  const lockDir = getLockDir(harnessDir);
  if (!existsSync(lockDir)) {
    mkdirSync(lockDir, { recursive: true });
  }

  // Check existing lock
  const existing = readLockInfo(lockPath);
  if (existing) {
    if (isStale(existing, staleMs)) {
      // Stale lock — remove it
      try {
        unlinkSync(lockPath);
      } catch {
        // Another process may have already cleaned it up
      }
    } else {
      // Lock is valid and held by another process
      return false;
    }
  }

  // Write our lock file
  const info: LockInfo = {
    pid: process.pid,
    acquired: new Date().toISOString(),
    file: filePath,
  };

  try {
    // Use wx flag — fails if file already exists (atomic-ish on most systems)
    writeFileSync(lockPath, JSON.stringify(info), { flag: 'wx' });
    return true;
  } catch {
    // Another process got the lock between our check and write
    return false;
  }
}

/**
 * Release a file lock. Safe to call even if we don't hold it.
 */
export function releaseLock(harnessDir: string, filePath: string): void {
  const lockPath = getLockPath(harnessDir, filePath);

  if (!existsSync(lockPath)) return;

  // Only release if we own it
  const info = readLockInfo(lockPath);
  if (info && info.pid === process.pid) {
    try {
      unlinkSync(lockPath);
    } catch {
      // Already cleaned up
    }
  }
}

/**
 * Wait to acquire a file lock with timeout.
 * Polls at retryIntervalMs until lock is acquired or waitMs expires.
 */
export async function acquireLock(
  harnessDir: string,
  filePath: string,
  options?: LockOptions,
): Promise<boolean> {
  const retryMs = options?.retryIntervalMs ?? DEFAULT_RETRY_MS;
  const waitMs = options?.waitMs ?? DEFAULT_WAIT_MS;
  const deadline = Date.now() + waitMs;

  while (Date.now() < deadline) {
    if (tryLock(harnessDir, filePath, options)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }

  return false;
}

/**
 * Execute a function while holding a file lock.
 * Acquires lock, runs fn, releases lock (even on error).
 * If lock cannot be acquired within waitMs, runs fn anyway (fail-open).
 */
export async function withFileLock<T>(
  harnessDir: string,
  filePath: string,
  fn: () => T | Promise<T>,
  options?: LockOptions,
): Promise<T> {
  const acquired = await acquireLock(harnessDir, filePath, options);

  try {
    return await fn();
  } finally {
    if (acquired) {
      releaseLock(harnessDir, filePath);
    }
  }
}

/**
 * Synchronous version of withFileLock for use in sync code paths.
 * Tries lock once — if fails, proceeds anyway (fail-open).
 */
export function withFileLockSync<T>(
  harnessDir: string,
  filePath: string,
  fn: () => T,
  options?: LockOptions,
): T {
  const acquired = tryLock(harnessDir, filePath, options);

  try {
    return fn();
  } finally {
    if (acquired) {
      releaseLock(harnessDir, filePath);
    }
  }
}

/**
 * Check if a file is currently locked (by any process).
 */
export function isLocked(harnessDir: string, filePath: string, options?: LockOptions): boolean {
  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  const lockPath = getLockPath(harnessDir, filePath);
  const info = readLockInfo(lockPath);
  if (!info) return false;
  return !isStale(info, staleMs);
}

/**
 * Force-remove a lock regardless of who owns it.
 * Use only for manual cleanup via CLI.
 */
export function breakLock(harnessDir: string, filePath: string): boolean {
  const lockPath = getLockPath(harnessDir, filePath);
  if (!existsSync(lockPath)) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}
