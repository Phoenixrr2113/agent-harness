import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, relative } from 'path';
import { execSync } from 'child_process';
import { log } from '../core/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface VersionEntry {
  /** Git commit hash (short) */
  hash: string;
  /** Full commit hash */
  fullHash: string;
  /** Commit message */
  message: string;
  /** Timestamp (ISO string) */
  timestamp: string;
  /** Files changed in this version */
  filesChanged: string[];
  /** Author name */
  author: string;
  /** Tag if one was applied */
  tag?: string;
}

export interface VersionLog {
  /** Ordered list of versions (newest first) */
  entries: VersionEntry[];
  /** Current HEAD hash */
  currentHash: string;
  /** Current tag if any */
  currentTag?: string;
}

export interface RollbackResult {
  success: boolean;
  /** Hash we rolled back to */
  targetHash: string;
  /** Files that were restored */
  restoredFiles: string[];
  /** Error message if failed */
  error?: string;
}

export interface SnapshotResult {
  success: boolean;
  /** New commit hash */
  hash: string;
  /** Files included in snapshot */
  files: string[];
  /** Error if failed */
  error?: string;
}

export interface DiffEntry {
  file: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** Lines added */
  additions?: number;
  /** Lines deleted */
  deletions?: number;
}

export interface VersionDiff {
  from: string;
  to: string;
  entries: DiffEntry[];
  summary: string;
}

// ─── Git Helpers ─────────────────────────────────────────────────────────────

/**
 * Execute a git command in the harness directory.
 * Returns stdout as a string, or null if the command failed.
 */
function gitExec(harnessDir: string, args: string): string | null {
  try {
    const result = execSync(`git ${args}`, {
      cwd: harnessDir,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Check if the harness directory is a git repository.
 */
export function isGitRepo(harnessDir: string): boolean {
  return gitExec(harnessDir, 'rev-parse --is-inside-work-tree') === 'true';
}

/**
 * Initialize a git repository in the harness directory.
 * If already initialized, this is a no-op.
 */
export function initVersioning(harnessDir: string): boolean {
  if (isGitRepo(harnessDir)) return true;

  const result = gitExec(harnessDir, 'init');
  if (result === null) {
    log.warn('Failed to initialize git repository for versioning');
    return false;
  }

  // Create .gitignore for non-versioned files
  const gitignorePath = join(harnessDir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    const gitignoreContent = [
      '# Agent harness versioning',
      'memory/sessions/',
      'memory/metrics.json',
      'memory/health.json',
      'memory/costs.json',
      'memory/rate-limits.json',
      'memory/emotional-history.jsonl',
      'memory/locks/',
      '.installed/',
      'archive/',
      'node_modules/',
    ].join('\n') + '\n';
    writeFileSync(gitignorePath, gitignoreContent, 'utf-8');
  }

  // Initial commit
  gitExec(harnessDir, 'add -A');
  gitExec(harnessDir, 'commit -m "Initial harness version" --allow-empty');

  return true;
}

// ─── Snapshot (Commit) ──────────────────────────────────────────────────────

/**
 * Take a versioned snapshot of the current harness state.
 * Stages all changes and creates a git commit.
 *
 * @param harnessDir - Harness directory path
 * @param message - Commit message describing the change
 * @param options.tag - Optional tag to apply to this version
 */
export function snapshot(
  harnessDir: string,
  message: string,
  options?: { tag?: string },
): SnapshotResult {
  if (!isGitRepo(harnessDir)) {
    if (!initVersioning(harnessDir)) {
      return { success: false, hash: '', files: [], error: 'Failed to initialize git repository' };
    }
  }

  // Stage all tracked primitive directories
  const dirsToTrack = [
    'rules', 'instincts', 'skills', 'playbooks', 'workflows',
    'tools', 'agents', 'memory/journal', 'memory/state.md',
    'memory/scratch.md', 'memory/state-ownership.json',
    'memory/emotional-state.json',
    'CORE.md', 'SYSTEM.md', 'config.yaml',
  ];

  const stagedFiles: string[] = [];
  for (const dir of dirsToTrack) {
    const fullPath = join(harnessDir, dir);
    if (existsSync(fullPath)) {
      gitExec(harnessDir, `add "${dir}"`);
      stagedFiles.push(dir);
    }
  }

  // Check if there are staged changes
  const status = gitExec(harnessDir, 'diff --cached --name-only');
  if (!status || status.length === 0) {
    return { success: true, hash: getHeadHash(harnessDir) ?? '', files: [], error: 'No changes to commit' };
  }

  const changedFiles = status.split('\n').filter(Boolean);

  // Commit
  const commitResult = gitExec(harnessDir, `commit -m "${escapeMessage(message)}"`);
  if (commitResult === null) {
    return { success: false, hash: '', files: changedFiles, error: 'Git commit failed' };
  }

  const hash = getHeadHash(harnessDir) ?? '';

  // Tag if requested
  if (options?.tag) {
    gitExec(harnessDir, `tag "${escapeMessage(options.tag)}"`);
  }

  return { success: true, hash, files: changedFiles };
}

// ─── Version Log ────────────────────────────────────────────────────────────

/**
 * Get the version history of the harness.
 *
 * @param harnessDir - Harness directory path
 * @param options.limit - Maximum entries to return (default: 50)
 * @param options.file - Filter to a specific file path
 */
export function getVersionLog(
  harnessDir: string,
  options?: { limit?: number; file?: string },
): VersionLog {
  if (!isGitRepo(harnessDir)) {
    return { entries: [], currentHash: '' };
  }

  const limit = options?.limit ?? 50;
  const fileFilter = options?.file ? ` -- "${options.file}"` : '';
  const format = '%H|%h|%s|%aI|%an';

  const logOutput = gitExec(harnessDir, `log --format="${format}" -n ${limit}${fileFilter}`);
  if (!logOutput) {
    return { entries: [], currentHash: getHeadHash(harnessDir) ?? '' };
  }

  const entries: VersionEntry[] = [];

  for (const line of logOutput.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('|');
    if (parts.length < 5) continue;

    const fullHash = parts[0];
    const hash = parts[1];

    // Get files changed in this commit
    const filesOutput = gitExec(harnessDir, `diff-tree --no-commit-id --name-only -r ${fullHash}`);
    const filesChanged = filesOutput ? filesOutput.split('\n').filter(Boolean) : [];

    // Check for tags
    const tagOutput = gitExec(harnessDir, `tag --points-at ${fullHash}`);
    const tag = tagOutput && tagOutput.length > 0 ? tagOutput.split('\n')[0] : undefined;

    entries.push({
      hash,
      fullHash,
      message: parts[2],
      timestamp: parts[3],
      author: parts.slice(4).join('|'),
      filesChanged,
      tag,
    });
  }

  const currentHash = getHeadHash(harnessDir) ?? '';
  const currentTag = entries.length > 0 && entries[0].tag ? entries[0].tag : undefined;

  return { entries, currentHash, currentTag };
}

// ─── Diff ───────────────────────────────────────────────────────────────────

/**
 * Get the diff between two versions (or between a version and HEAD).
 */
export function getVersionDiff(
  harnessDir: string,
  from: string,
  to?: string,
): VersionDiff {
  if (!isGitRepo(harnessDir)) {
    return { from, to: to ?? 'HEAD', entries: [], summary: 'Not a git repository' };
  }

  const target = to ?? 'HEAD';
  const diffOutput = gitExec(harnessDir, `diff --numstat ${from} ${target}`);
  const nameOutput = gitExec(harnessDir, `diff --name-status ${from} ${target}`);

  const entries: DiffEntry[] = [];

  if (nameOutput) {
    const nameLines = nameOutput.split('\n').filter(Boolean);
    const statLines = (diffOutput ?? '').split('\n').filter(Boolean);

    for (let i = 0; i < nameLines.length; i++) {
      const nameParts = nameLines[i].split('\t');
      const statusChar = nameParts[0];
      const file = nameParts[nameParts.length - 1];

      let status: DiffEntry['status'] = 'modified';
      if (statusChar === 'A') status = 'added';
      else if (statusChar === 'D') status = 'deleted';
      else if (statusChar.startsWith('R')) status = 'renamed';

      const entry: DiffEntry = { file, status };

      // Parse numstat for additions/deletions
      if (i < statLines.length) {
        const statParts = statLines[i].split('\t');
        if (statParts.length >= 2) {
          const adds = parseInt(statParts[0], 10);
          const dels = parseInt(statParts[1], 10);
          if (!isNaN(adds)) entry.additions = adds;
          if (!isNaN(dels)) entry.deletions = dels;
        }
      }

      entries.push(entry);
    }
  }

  const added = entries.filter((e) => e.status === 'added').length;
  const modified = entries.filter((e) => e.status === 'modified').length;
  const deleted = entries.filter((e) => e.status === 'deleted').length;
  const summary = `${entries.length} file(s) changed: ${added} added, ${modified} modified, ${deleted} deleted`;

  return { from, to: target, entries, summary };
}

// ─── Rollback ───────────────────────────────────────────────────────────────

/**
 * Roll back the harness to a previous version.
 *
 * Creates a new commit that restores files to the state at `targetHash`,
 * preserving full history (no destructive rewrite).
 *
 * @param harnessDir - Harness directory path
 * @param targetHash - Commit hash or tag to roll back to
 */
export function rollback(
  harnessDir: string,
  targetHash: string,
): RollbackResult {
  if (!isGitRepo(harnessDir)) {
    return { success: false, targetHash, restoredFiles: [], error: 'Not a git repository' };
  }

  // Verify the target exists
  const resolvedHash = gitExec(harnessDir, `rev-parse --verify ${targetHash}`);
  if (!resolvedHash) {
    return { success: false, targetHash, restoredFiles: [], error: `Invalid version: ${targetHash}` };
  }

  // Get files that will change
  const diff = getVersionDiff(harnessDir, 'HEAD', resolvedHash);
  const restoredFiles = diff.entries.map((e) => e.file);

  // Restore all tracked files from the target commit
  const restoreResult = gitExec(harnessDir, `checkout ${resolvedHash} -- .`);
  if (restoreResult === null) {
    return { success: false, targetHash: resolvedHash, restoredFiles: [], error: 'Failed to restore files' };
  }

  // Stage and commit the rollback
  gitExec(harnessDir, 'add -A');
  const shortHash = resolvedHash.slice(0, 7);
  const commitResult = gitExec(harnessDir, `commit -m "Rollback to ${shortHash}" --allow-empty`);
  if (commitResult === null) {
    return { success: false, targetHash: resolvedHash, restoredFiles, error: 'Failed to commit rollback' };
  }

  return { success: true, targetHash: resolvedHash, restoredFiles };
}

// ─── Tag Management ─────────────────────────────────────────────────────────

/**
 * List all version tags.
 */
export function listTags(harnessDir: string): Array<{ tag: string; hash: string; message: string }> {
  if (!isGitRepo(harnessDir)) return [];

  const output = gitExec(harnessDir, 'tag -l');
  if (!output) return [];

  const tags: Array<{ tag: string; hash: string; message: string }> = [];

  for (const tag of output.split('\n').filter(Boolean)) {
    const hash = gitExec(harnessDir, `rev-parse ${tag}`);
    const message = gitExec(harnessDir, `log -1 --format=%s ${tag}`);
    tags.push({
      tag,
      hash: hash ? hash.slice(0, 7) : '',
      message: message ?? '',
    });
  }

  return tags;
}

/**
 * Tag the current version.
 */
export function tagVersion(harnessDir: string, tag: string, message?: string): boolean {
  if (!isGitRepo(harnessDir)) return false;

  if (message) {
    return gitExec(harnessDir, `tag -a "${escapeMessage(tag)}" -m "${escapeMessage(message)}"`) !== null;
  }
  return gitExec(harnessDir, `tag "${escapeMessage(tag)}"`) !== null;
}

// ─── Pending Changes ────────────────────────────────────────────────────────

/**
 * Get uncommitted changes in the harness.
 */
export function getPendingChanges(harnessDir: string): DiffEntry[] {
  if (!isGitRepo(harnessDir)) return [];

  const output = gitExec(harnessDir, 'status --porcelain');
  if (!output) return [];

  const entries: DiffEntry[] = [];

  for (const line of output.split('\n').filter(Boolean)) {
    const statusChar = line.substring(0, 2).trim();
    const file = line.substring(3);

    let status: DiffEntry['status'] = 'modified';
    if (statusChar === '??' || statusChar === 'A') status = 'added';
    else if (statusChar === 'D') status = 'deleted';
    else if (statusChar.startsWith('R')) status = 'renamed';

    entries.push({ file, status });
  }

  return entries;
}

// ─── File History ───────────────────────────────────────────────────────────

/**
 * Get the version history for a specific file.
 */
export function getFileHistory(
  harnessDir: string,
  filePath: string,
  options?: { limit?: number },
): VersionEntry[] {
  const relPath = relative(harnessDir, join(harnessDir, filePath));
  const log = getVersionLog(harnessDir, { limit: options?.limit ?? 20, file: relPath });
  return log.entries;
}

/**
 * Get the content of a file at a specific version.
 */
export function getFileAtVersion(
  harnessDir: string,
  filePath: string,
  hash: string,
): string | null {
  if (!isGitRepo(harnessDir)) return null;

  const relPath = relative(harnessDir, join(harnessDir, filePath));
  return gitExec(harnessDir, `show ${hash}:"${relPath}"`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getHeadHash(harnessDir: string): string | null {
  return gitExec(harnessDir, 'rev-parse HEAD');
}

function escapeMessage(msg: string): string {
  return msg.replace(/"/g, '\\"').replace(/\n/g, ' ');
}
