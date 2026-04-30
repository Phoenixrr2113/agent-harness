import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { loadDirectory } from '../primitives/loader.js';
import { CORE_PRIMITIVE_DIRS, type IndexEntry } from '../core/types.js';

export function buildIndex(harnessDir: string, directory: string): IndexEntry[] {
  const dirPath = join(harnessDir, directory);
  if (!existsSync(dirPath)) return [];

  const docs = loadDirectory(dirPath);

  return docs.map((doc) => ({
    id: doc.id,
    path: doc.path,
    tags: doc.tags,
    description: doc.description ?? doc.id,
    created: doc.created || '',
    status: doc.status,
  }));
}

export interface IndexOptions {
  /** Max characters for description in index table. Defaults to 120. */
  summaryMaxLength?: number;
}

export function writeIndexFile(harnessDir: string, directory: string, options?: IndexOptions): void {
  const entries = buildIndex(harnessDir, directory);
  const dirPath = join(harnessDir, directory);
  const maxLen = options?.summaryMaxLength ?? 120;

  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }

  const lines: string[] = [
    `<!-- Auto-generated index for ${directory}. Do not edit manually. -->`,
    '',
    `# ${directory.charAt(0).toUpperCase() + directory.slice(1)} Index`,
    '',
    `| ID | Tags | Created | Status | Summary |`,
    `|----|------|---------|--------|---------|`,
  ];

  for (const entry of entries) {
    const tags = entry.tags.join(', ');
    const summary = entry.description.length > maxLen
      ? entry.description.slice(0, maxLen - 3) + '...'
      : entry.description;
    lines.push(`| ${entry.id} | ${tags} | ${entry.created} | ${entry.status} | ${summary} |`);
  }

  lines.push('');

  writeFileSync(join(dirPath, '_index.md'), lines.join('\n'), 'utf-8');
}

export function rebuildAllIndexes(harnessDir: string, extraDirs?: string[]): void {
  const dirs: string[] = [...CORE_PRIMITIVE_DIRS];
  if (extraDirs) {
    for (const dir of extraDirs) {
      if (!dirs.includes(dir)) dirs.push(dir);
    }
  }
  for (const dir of dirs) {
    const dirPath = join(harnessDir, dir);
    if (existsSync(dirPath)) {
      writeIndexFile(harnessDir, dir);
    }
  }
}
