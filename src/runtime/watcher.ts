import { watch, type FSWatcher } from 'chokidar';
import { relative } from 'path';
import { writeIndexFile } from './indexer.js';
import { CORE_PRIMITIVE_DIRS } from '../core/types.js';

export interface WatcherOptions {
  harnessDir: string;
  extraDirs?: string[];
  onChange?: (path: string, event: string) => void;
  onIndexRebuild?: (directory: string) => void;
}

export function createWatcher(options: WatcherOptions): FSWatcher {
  const { harnessDir, extraDirs, onChange, onIndexRebuild } = options;

  const watchedDirs: string[] = [...CORE_PRIMITIVE_DIRS];
  if (extraDirs) {
    for (const dir of extraDirs) {
      if (!watchedDirs.includes(dir)) watchedDirs.push(dir);
    }
  }

  const patterns = watchedDirs.map((dir) => `${harnessDir}/${dir}/**/*.md`);

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

    const rel = relative(harnessDir, filePath);
    const dir = rel.split('/')[0];

    if (watchedDirs.includes(dir)) {
      // Rebuild index for this directory
      writeIndexFile(harnessDir, dir);
      onIndexRebuild?.(dir);
    }

    onChange?.(filePath, event);
  };

  watcher.on('add', (path) => handleChange(path, 'add'));
  watcher.on('change', (path) => handleChange(path, 'change'));
  watcher.on('unlink', (path) => handleChange(path, 'unlink'));

  return watcher;
}
