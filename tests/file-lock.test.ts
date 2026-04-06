import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  tryLock,
  releaseLock,
  acquireLock,
  withFileLock,
  withFileLockSync,
  isLocked,
  breakLock,
} from '../src/runtime/file-lock.js';

describe('file-lock', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lock-test-'));
    mkdirSync(join(testDir, 'memory'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('tryLock', () => {
    it('should acquire lock on first attempt', () => {
      const result = tryLock(testDir, join(testDir, 'state.md'));
      expect(result).toBe(true);

      // Lock file should exist
      const lockPath = join(testDir, 'memory', 'state.lock');
      expect(existsSync(lockPath)).toBe(true);

      // Lock file should contain valid JSON with pid
      const content = JSON.parse(readFileSync(lockPath, 'utf-8'));
      expect(content.pid).toBe(process.pid);
      expect(content.file).toBe(join(testDir, 'state.md'));
      expect(content.acquired).toBeDefined();
    });

    it('should fail when lock is already held by same process', () => {
      const first = tryLock(testDir, join(testDir, 'state.md'));
      expect(first).toBe(true);

      // tryLock checks ownership via PID — same process means lock file exists
      // but wx flag prevents overwrite, so second attempt fails
      const second = tryLock(testDir, join(testDir, 'state.md'));
      expect(second).toBe(false);
    });

    it('should create memory directory if missing', () => {
      const bareDir = mkdtempSync(join(tmpdir(), 'lock-bare-'));
      // No memory dir exists
      expect(existsSync(join(bareDir, 'memory'))).toBe(false);

      tryLock(bareDir, join(bareDir, 'state.md'));
      expect(existsSync(join(bareDir, 'memory'))).toBe(true);

      rmSync(bareDir, { recursive: true, force: true });
    });
  });

  describe('releaseLock', () => {
    it('should release a lock held by this process', () => {
      const filePath = join(testDir, 'state.md');
      tryLock(testDir, filePath);
      expect(isLocked(testDir, filePath)).toBe(true);

      releaseLock(testDir, filePath);
      expect(isLocked(testDir, filePath)).toBe(false);
    });

    it('should be safe to call when no lock exists', () => {
      expect(() => releaseLock(testDir, join(testDir, 'nothing.md'))).not.toThrow();
    });

    it('should allow re-acquisition after release', () => {
      const filePath = join(testDir, 'state.md');
      tryLock(testDir, filePath);
      releaseLock(testDir, filePath);

      const result = tryLock(testDir, filePath);
      expect(result).toBe(true);
    });
  });

  describe('acquireLock', () => {
    it('should acquire lock immediately when available', async () => {
      const result = await acquireLock(testDir, join(testDir, 'state.md'), {
        waitMs: 100,
        retryIntervalMs: 10,
      });
      expect(result).toBe(true);
    });

    it('should timeout when lock is held', async () => {
      const filePath = join(testDir, 'state.md');
      tryLock(testDir, filePath);

      // Second acquire should time out
      const result = await acquireLock(testDir, filePath, {
        waitMs: 100,
        retryIntervalMs: 20,
      });
      expect(result).toBe(false);
    });
  });

  describe('withFileLock', () => {
    it('should execute function and release lock', async () => {
      const filePath = join(testDir, 'test.md');
      let executed = false;

      await withFileLock(testDir, filePath, () => {
        executed = true;
        // Lock should be held during execution
        expect(isLocked(testDir, filePath)).toBe(true);
      });

      expect(executed).toBe(true);
      // Lock should be released after
      expect(isLocked(testDir, filePath)).toBe(false);
    });

    it('should release lock even on error', async () => {
      const filePath = join(testDir, 'test.md');

      await expect(
        withFileLock(testDir, filePath, () => {
          throw new Error('test error');
        }),
      ).rejects.toThrow('test error');

      expect(isLocked(testDir, filePath)).toBe(false);
    });

    it('should return function result', async () => {
      const filePath = join(testDir, 'test.md');
      const result = await withFileLock(testDir, filePath, () => 42);
      expect(result).toBe(42);
    });

    it('should proceed (fail-open) when lock cannot be acquired', async () => {
      const filePath = join(testDir, 'test.md');
      tryLock(testDir, filePath);

      // withFileLock should still run fn even if it can't acquire lock
      let executed = false;
      await withFileLock(
        testDir,
        filePath,
        () => {
          executed = true;
        },
        { waitMs: 50, retryIntervalMs: 10 },
      );

      expect(executed).toBe(true);
    });
  });

  describe('withFileLockSync', () => {
    it('should execute function and release lock', () => {
      const filePath = join(testDir, 'test.md');
      let executed = false;

      withFileLockSync(testDir, filePath, () => {
        executed = true;
        expect(isLocked(testDir, filePath)).toBe(true);
      });

      expect(executed).toBe(true);
      expect(isLocked(testDir, filePath)).toBe(false);
    });

    it('should release lock even on error', () => {
      const filePath = join(testDir, 'test.md');

      expect(() =>
        withFileLockSync(testDir, filePath, () => {
          throw new Error('sync error');
        }),
      ).toThrow('sync error');

      expect(isLocked(testDir, filePath)).toBe(false);
    });

    it('should return function result', () => {
      const filePath = join(testDir, 'test.md');
      const result = withFileLockSync(testDir, filePath, () => 'hello');
      expect(result).toBe('hello');
    });

    it('should proceed (fail-open) when lock is held', () => {
      const filePath = join(testDir, 'test.md');
      tryLock(testDir, filePath);

      let executed = false;
      withFileLockSync(testDir, filePath, () => {
        executed = true;
      });

      expect(executed).toBe(true);
    });
  });

  describe('isLocked', () => {
    it('should return false when no lock exists', () => {
      expect(isLocked(testDir, join(testDir, 'nothing.md'))).toBe(false);
    });

    it('should return true when lock is held', () => {
      const filePath = join(testDir, 'state.md');
      tryLock(testDir, filePath);
      expect(isLocked(testDir, filePath)).toBe(true);
    });

    it('should return false after lock is released', () => {
      const filePath = join(testDir, 'state.md');
      tryLock(testDir, filePath);
      releaseLock(testDir, filePath);
      expect(isLocked(testDir, filePath)).toBe(false);
    });
  });

  describe('breakLock', () => {
    it('should remove an existing lock', () => {
      const filePath = join(testDir, 'state.md');
      tryLock(testDir, filePath);
      expect(isLocked(testDir, filePath)).toBe(true);

      const result = breakLock(testDir, filePath);
      expect(result).toBe(true);
      expect(isLocked(testDir, filePath)).toBe(false);
    });

    it('should return false when no lock exists', () => {
      const result = breakLock(testDir, join(testDir, 'nothing.md'));
      expect(result).toBe(false);
    });

    it('should allow re-acquisition after break', () => {
      const filePath = join(testDir, 'state.md');
      tryLock(testDir, filePath);
      breakLock(testDir, filePath);

      const result = tryLock(testDir, filePath);
      expect(result).toBe(true);
    });
  });

  describe('different file paths', () => {
    it('should allow locks on different files simultaneously', () => {
      const fileA = join(testDir, 'a.md');
      const fileB = join(testDir, 'b.md');

      expect(tryLock(testDir, fileA)).toBe(true);
      expect(tryLock(testDir, fileB)).toBe(true);

      expect(isLocked(testDir, fileA)).toBe(true);
      expect(isLocked(testDir, fileB)).toBe(true);
    });
  });
});
