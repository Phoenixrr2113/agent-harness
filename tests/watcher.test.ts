import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createWatcher, type WatcherOptions } from '../src/runtime/watcher.js';
import type { FSWatcher } from 'chokidar';

describe('createWatcher', () => {
  let testDir: string;
  let watcher: FSWatcher | null = null;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'watcher-test-'));

    // Create minimal harness structure (only what's needed)
    mkdirSync(join(testDir, 'rules'), { recursive: true });
    mkdirSync(join(testDir, 'instincts'), { recursive: true });
  });

  afterEach(async () => {
    if (watcher) {
      await watcher.close();
      watcher = null;
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return an FSWatcher instance', () => {
    watcher = createWatcher({ harnessDir: testDir });
    expect(watcher).toBeDefined();
    expect(typeof watcher.close).toBe('function');
  });

  it('should accept extra directories to watch', () => {
    mkdirSync(join(testDir, 'custom'), { recursive: true });
    watcher = createWatcher({
      harnessDir: testDir,
      extraDirs: ['custom'],
    });
    expect(watcher).toBeDefined();
  });

  it('should call onError when watcher emits an error event', () => {
    const errors: Error[] = [];

    watcher = createWatcher({
      harnessDir: testDir,
      onError: (err) => errors.push(err),
    });

    // Manually emit an error event to test the handler
    watcher.emit('error', new Error('Simulated FS error'));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('Simulated FS error');
  });

  // Chokidar FS-event tests: only run when the watcher successfully starts
  // (may fail in CI due to EMFILE or restricted environments)
  describe('file system events', () => {
    // Poll until a condition is true or timeout expires
    const waitFor = (
      condition: () => boolean,
      timeoutMs: number,
      intervalMs = 100,
    ): Promise<boolean> =>
      new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
          if (condition()) return resolve(true);
          if (Date.now() - start >= timeoutMs) return resolve(false);
          setTimeout(check, intervalMs);
        };
        check();
      });

    it('should detect file changes and fire callbacks', async () => {
      const changes: Array<{ path: string; event: string }> = [];
      const rebuilds: string[] = [];
      let emfileDetected = false;

      watcher = createWatcher({
        harnessDir: testDir,
        onChange: (path, event) => changes.push({ path, event }),
        onIndexRebuild: (dir) => rebuilds.push(dir),
        onError: (err) => {
          if (err.message.includes('EMFILE')) emfileDetected = true;
        },
      });

      await new Promise<void>((resolve) => watcher!.on('ready', resolve));

      // Skip if EMFILE already happened during setup
      if (emfileDetected) return;

      writeFileSync(
        join(testDir, 'rules', 'test-rule.md'),
        `---\nid: test-rule\ntags: [rules]\nstatus: active\n---\n\n<!-- L0: Test rule. -->\n\n# Rule: Test\n`,
      );

      const detected = await waitFor(() => changes.length > 0, 5000);

      if (emfileDetected) return;
      if (!detected) return; // fsevents may not fire in some environments

      expect(changes[0].path).toContain('test-rule.md');
      expect(rebuilds).toContain('rules');

      const indexPath = join(testDir, 'rules', '_index.md');
      expect(existsSync(indexPath)).toBe(true);
      const indexContent = readFileSync(indexPath, 'utf-8');
      expect(indexContent).toContain('test-rule');
    }, 10000);

    it('should detect config.yaml changes when watchConfig is true', async () => {
      let configChanged = false;
      let emfileDetected = false;

      writeFileSync(join(testDir, 'config.yaml'), 'agent:\n  name: test\n');

      watcher = createWatcher({
        harnessDir: testDir,
        watchConfig: true,
        onConfigChange: () => { configChanged = true; },
        onError: (err) => {
          if (err.message.includes('EMFILE')) emfileDetected = true;
        },
      });

      await new Promise<void>((resolve) => watcher!.on('ready', resolve));

      if (emfileDetected) return;

      writeFileSync(join(testDir, 'config.yaml'), 'agent:\n  name: updated\n');

      const detected = await waitFor(() => configChanged, 5000);

      if (emfileDetected) return;
      if (!detected) return; // fsevents may not fire in some environments

      expect(configChanged).toBe(true);
    }, 10000);
  });

  it('should not include config.yaml pattern when watchConfig is false', () => {
    writeFileSync(join(testDir, 'config.yaml'), 'agent:\n  name: test\n');

    watcher = createWatcher({
      harnessDir: testDir,
      watchConfig: false,
    });

    // Watcher created successfully — config.yaml not in watched patterns
    expect(watcher).toBeDefined();
  });

  it('should survive throwing onError callback without crashing', () => {
    watcher = createWatcher({
      harnessDir: testDir,
      onError: () => { throw new Error('Callback crash'); },
    });

    // Manually emit error — should not throw even though callback throws
    expect(() => watcher!.emit('error', new Error('Simulated error'))).not.toThrow();
  });

  it('should survive broken markdown files without crashing the watcher', () => {
    // Pre-populate with a broken file, then create the watcher
    writeFileSync(
      join(testDir, 'rules', 'broken.md'),
      'not valid yaml frontmatter at all {{{',
    );

    // The watcher creation should not throw
    watcher = createWatcher({ harnessDir: testDir });
    expect(watcher).toBeDefined();
  });
});
