import { watch, type FSWatcher } from 'chokidar';
import { dirname, relative } from 'path';
import { writeIndexFile } from './indexer.js';

const WATCHED_DIRS = ['rules', 'instincts', 'skills', 'playbooks', 'workflows', 'tools', 'agents'];

export interface WatcherOptions {
  harnessDir: string;
  onChange?: (path: string, event: string) => void;
  onIndexRebuild?: (directory: string) => void;
}

export function createWatcher(options: WatcherOptions): FSWatcher {
  const { harnessDir, onChange, onIndexRebuild } = options;

  const patterns = WATCHED_DIRS.map((dir) => `${harnessDir}/${dir}/**/*.md`);

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

    if (WATCHED_DIRS.includes(dir)) {
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
