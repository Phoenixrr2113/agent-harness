import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { loadDirectory } from '../primitives/loader.js';
import type { IndexEntry } from '../core/types.js';

const INDEXABLE_DIRS = ['rules', 'instincts', 'skills', 'playbooks', 'workflows', 'tools', 'agents'];

export function buildIndex(harnessDir: string, directory: string): IndexEntry[] {
  const dirPath = join(harnessDir, directory);
  if (!existsSync(dirPath)) return [];

  const docs = loadDirectory(dirPath);

  return docs.map((doc) => ({
    id: doc.frontmatter.id,
    path: doc.path,
    tags: doc.frontmatter.tags,
    l0: doc.l0,
    created: doc.frontmatter.created || '',
    status: doc.frontmatter.status,
  }));
}

export function writeIndexFile(harnessDir: string, directory: string): void {
  const entries = buildIndex(harnessDir, directory);
  const dirPath = join(harnessDir, directory);

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
    const summary = entry.l0.slice(0, 80);
    lines.push(`| ${entry.id} | ${tags} | ${entry.created} | ${entry.status} | ${summary} |`);
  }

  lines.push('');

  writeFileSync(join(dirPath, '_index.md'), lines.join('\n'), 'utf-8');
}

export function rebuildAllIndexes(harnessDir: string): void {
  for (const dir of INDEXABLE_DIRS) {
    const dirPath = join(harnessDir, dir);
    if (existsSync(dirPath)) {
      writeIndexFile(harnessDir, dir);
    }
  }
}
