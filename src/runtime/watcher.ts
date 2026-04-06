import { watch, type FSWatcher } from 'chokidar';
import { relative } from 'path';
import { writeIndexFile } from './indexer.js';
import { log } from '../core/logger.js';
import { CORE_PRIMITIVE_DIRS } from '../core/types.js';
import { autoProcessFile, type AutoProcessResult } from './auto-processor.js';

export interface WatcherOptions {
  harnessDir: string;
  extraDirs?: string[];
  onChange?: (path: string, event: string) => void;
  onIndexRebuild?: (directory: string) => void;
  onError?: (error: Error) => void;
  /** Also watch config.yaml for changes */
  watchConfig?: boolean;
  onConfigChange?: () => void;
  /** Enable auto-processing of primitives on save (default: false) */
  autoProcess?: boolean;
  /** Called after auto-processing a file */
  onAutoProcess?: (result: AutoProcessResult) => void;
}

export function createWatcher(options: WatcherOptions): FSWatcher {
  const { harnessDir, extraDirs, onChange, onIndexRebuild, onError, watchConfig, onConfigChange, autoProcess, onAutoProcess } = options;

  const watchedDirs: string[] = [...CORE_PRIMITIVE_DIRS];
  if (extraDirs) {
    for (const dir of extraDirs) {
      if (!watchedDirs.includes(dir)) watchedDirs.push(dir);
    }
  }

  const patterns: string[] = watchedDirs.map((dir) => `${harnessDir}/${dir}/**/*.md`);

  // Optionally watch config.yaml for live reload
  if (watchConfig) {
    patterns.push(`${harnessDir}/config.yaml`);
  }

  const watcher = watch(patterns, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  const handleChange = (filePath: string, event: string) => {
    // Skip index files
    if (filePath.includes('_index.md')) return;

    // Config change handler
    if (filePath.endsWith('config.yaml')) {
      log.info('Config file changed');
      try { onConfigChange?.(); } catch (e) {
        log.warn(`onConfigChange callback failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    const rel = relative(harnessDir, filePath);
    const dir = rel.split('/')[0];

    // Auto-process primitives on add/change (before index rebuild so index sees fixes)
    if (autoProcess && event !== 'unlink' && filePath.endsWith('.md') && watchedDirs.includes(dir)) {
      try {
        const processResult = autoProcessFile(filePath, { harnessDir });
        if (processResult.modified) {
          log.info(`Auto-processed ${rel}: ${processResult.fixes.join(', ')}`);
        }
        try { onAutoProcess?.(processResult); } catch (e) {
          log.warn(`onAutoProcess callback failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } catch (err) {
        log.warn(`Auto-process failed for ${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (watchedDirs.includes(dir)) {
      // Rebuild index for this directory — wrapped for resilience
      try {
        writeIndexFile(harnessDir, dir);
        try { onIndexRebuild?.(dir); } catch (e) {
          log.warn(`onIndexRebuild callback failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        log.warn(`Failed to rebuild index for ${dir}: ${error.message}`);
        try { onError?.(error); } catch (e) {
          log.warn(`Watcher onError callback failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    try { onChange?.(filePath, event); } catch (e) {
      log.warn(`onChange callback failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  watcher.on('add', (path) => handleChange(path, 'add'));
  watcher.on('change', (path) => handleChange(path, 'change'));
  watcher.on('unlink', (path) => handleChange(path, 'unlink'));

  // Handle file system errors gracefully
  watcher.on('error', (err) => {
    const error = err instanceof Error ? err : new Error(String(err));
    log.warn(`File watcher error: ${error.message}`);
    try { onError?.(error); } catch (e) {
      log.warn(`Watcher onError callback failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  return watcher;
}
