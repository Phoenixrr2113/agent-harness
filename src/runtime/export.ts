import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, relative } from 'path';
import { getPrimitiveDirs } from '../core/types.js';
import type { HarnessConfig } from '../core/types.js';
import { loadConfig } from '../core/config.js';

export interface ExportEntry {
  path: string;
  content: string;
}

export interface HarnessBundle {
  version: string;
  exported_at: string;
  agent_name: string;
  entries: ExportEntry[];
  metadata: {
    primitives: number;
    sessions: number;
    journals: number;
  };
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
  files: string[];
}

export interface ExportOptions {
  /** Include session files (default: true) */
  sessions?: boolean;
  /** Include journal files (default: true) */
  journals?: boolean;
  /** Include memory/metrics.json (default: true) */
  metrics?: boolean;
  /** Include state.md and scratch.md (default: true) */
  state?: boolean;
}

/**
 * Collect all .md files from a directory (non-recursive, excludes dotfiles and _index).
 */
function collectMdFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.') && !f.startsWith('_'))
    .map((f) => join(dir, f));
}

/**
 * Export a harness to a portable JSON bundle.
 */
export function exportHarness(harnessDir: string, options?: ExportOptions): HarnessBundle {
  const includeSessions = options?.sessions ?? true;
  const includeJournals = options?.journals ?? true;
  const includeMetrics = options?.metrics ?? true;
  const includeState = options?.state ?? true;

  let config: HarnessConfig;
  try {
    config = loadConfig(harnessDir);
  } catch {
    config = { agent: { name: 'unknown', version: '0.0.0' } } as HarnessConfig;
  }

  const entries: ExportEntry[] = [];
  let primitiveCount = 0;
  let sessionCount = 0;
  let journalCount = 0;

  // Core files
  const coreFiles = ['CORE.md', 'SYSTEM.md', 'config.yaml'];
  for (const file of coreFiles) {
    const filePath = join(harnessDir, file);
    if (existsSync(filePath)) {
      entries.push({
        path: file,
        content: readFileSync(filePath, 'utf-8'),
      });
    }
  }

  // State files
  if (includeState) {
    const stateFiles = ['state.md', join('memory', 'scratch.md')];
    for (const file of stateFiles) {
      const filePath = join(harnessDir, file);
      if (existsSync(filePath)) {
        entries.push({
          path: file,
          content: readFileSync(filePath, 'utf-8'),
        });
      }
    }
  }

  // Primitive directories
  const dirs = getPrimitiveDirs(config);
  for (const dir of dirs) {
    const files = collectMdFiles(join(harnessDir, dir));
    for (const file of files) {
      entries.push({
        path: relative(harnessDir, file),
        content: readFileSync(file, 'utf-8'),
      });
      primitiveCount++;
    }
  }

  // Sessions
  if (includeSessions) {
    const sessionsDir = join(harnessDir, 'memory', 'sessions');
    const files = collectMdFiles(sessionsDir);
    for (const file of files) {
      entries.push({
        path: relative(harnessDir, file),
        content: readFileSync(file, 'utf-8'),
      });
      sessionCount++;
    }
  }

  // Journals
  if (includeJournals) {
    const journalDir = join(harnessDir, 'memory', 'journal');
    const files = collectMdFiles(journalDir);
    for (const file of files) {
      entries.push({
        path: relative(harnessDir, file),
        content: readFileSync(file, 'utf-8'),
      });
      journalCount++;
    }

    // Weekly journals too
    const weeklyDir = join(harnessDir, 'memory', 'journal', 'weekly');
    const weeklyFiles = collectMdFiles(weeklyDir);
    for (const file of weeklyFiles) {
      entries.push({
        path: relative(harnessDir, file),
        content: readFileSync(file, 'utf-8'),
      });
      journalCount++;
    }
  }

  // Metrics
  if (includeMetrics) {
    const metricsPath = join(harnessDir, 'memory', 'metrics.json');
    if (existsSync(metricsPath)) {
      entries.push({
        path: join('memory', 'metrics.json'),
        content: readFileSync(metricsPath, 'utf-8'),
      });
    }
  }

  return {
    version: '1.0',
    exported_at: new Date().toISOString(),
    agent_name: config.agent.name,
    entries,
    metadata: {
      primitives: primitiveCount,
      sessions: sessionCount,
      journals: journalCount,
    },
  };
}

/**
 * Write an export bundle to a JSON file.
 */
export function writeBundle(bundle: HarnessBundle, outputPath: string): void {
  writeFileSync(outputPath, JSON.stringify(bundle, null, 2), 'utf-8');
}

/**
 * Read a bundle from a JSON file.
 */
export function readBundle(bundlePath: string): HarnessBundle {
  if (!existsSync(bundlePath)) {
    throw new Error(`Bundle not found: ${bundlePath}`);
  }

  const content = readFileSync(bundlePath, 'utf-8');
  const parsed: unknown = JSON.parse(content);

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    !('entries' in parsed) ||
    !Array.isArray((parsed as HarnessBundle).entries)
  ) {
    throw new Error('Invalid bundle format: missing version or entries');
  }

  return parsed as HarnessBundle;
}

/**
 * Import a bundle into a harness directory.
 * Only writes files that don't already exist (no overwrites by default).
 */
export function importBundle(
  harnessDir: string,
  bundle: HarnessBundle,
  options?: { overwrite?: boolean },
): ImportResult {
  const overwrite = options?.overwrite ?? false;
  const result: ImportResult = {
    imported: 0,
    skipped: 0,
    errors: [],
    files: [],
  };

  for (const entry of bundle.entries) {
    const targetPath = join(harnessDir, entry.path);

    // Skip if exists and no overwrite
    if (existsSync(targetPath) && !overwrite) {
      result.skipped++;
      continue;
    }

    try {
      // Ensure parent directory exists
      const parentDir = join(targetPath, '..');
      mkdirSync(parentDir, { recursive: true });

      writeFileSync(targetPath, entry.content, 'utf-8');
      result.imported++;
      result.files.push(entry.path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${entry.path}: ${msg}`);
    }
  }

  return result;
}
