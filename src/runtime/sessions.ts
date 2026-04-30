import { writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, copyFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { withFileLockSync } from './file-lock.js';
import type { ToolCallInfo } from '../core/types.js';

export interface SessionRecord {
  id: string;
  started: string;
  ended: string;
  prompt: string;
  summary: string;
  tokens_used: number;
  steps: number;
  model_id?: string;
  delegated_to?: string;
  /** Tool calls executed during this session */
  tool_calls?: ToolCallInfo[];
}

export function createSessionId(): string {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const short = randomUUID().slice(0, 8);
  return `${date}-${short}`;
}

/** Format tool calls as markdown for session files */
function formatToolCalls(toolCalls?: ToolCallInfo[]): string {
  if (!toolCalls || toolCalls.length === 0) return '';

  const lines = ['\n## Tools Used\n'];
  for (const tc of toolCalls) {
    lines.push(`### ${tc.toolName}`);
    const argsStr = JSON.stringify(tc.args, null, 2);
    lines.push(`**Args:** \`${argsStr.length > 200 ? argsStr.slice(0, 200) + '...' : argsStr}\``);
    if (tc.result !== null && tc.result !== undefined) {
      const resultStr = typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result);
      lines.push(`**Result:** ${resultStr.length > 300 ? resultStr.slice(0, 300) + '...' : resultStr}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function writeSession(harnessDir: string, session: SessionRecord): string {
  const sessionsDir = join(harnessDir, 'memory', 'sessions');
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  const filePath = join(sessionsDir, `${session.id}.md`);
  const tags = session.delegated_to
    ? `[session, delegation, ${session.delegated_to}]`
    : '[session]';
  const modelLine = session.model_id ? `\n**Model:** ${session.model_id}` : '';
  const delegateLine = session.delegated_to ? `\n**Delegated to:** ${session.delegated_to}` : '';
  const toolSection = formatToolCalls(session.tool_calls);

  // YAML-safe quote: wrap in double quotes and escape internal " and \
  const yamlQuote = (s: string): string =>
    `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const sessionDescription = session.summary.length > 200
    ? session.summary.slice(0, 197) + '...'
    : session.summary;
  const content = `---
id: ${session.id}
description: ${yamlQuote(sessionDescription)}
tags: ${tags}
created: ${session.started}
updated: ${session.ended}
author: agent
status: active
duration_minutes: ${Math.round((new Date(session.ended).getTime() - new Date(session.started).getTime()) / 60000)}
---

# Session: ${session.id}

**Started:** ${session.started}
**Ended:** ${session.ended}
**Tokens:** ${session.tokens_used}
**Steps:** ${session.steps}${modelLine}${delegateLine}

## Prompt
${session.prompt}

## Summary
${session.summary}
${toolSection}`;

  withFileLockSync(harnessDir, filePath, () => {
    writeFileSync(filePath, content, 'utf-8');
  });
  return filePath;
}

export interface CleanupResult {
  sessionsRemoved: number;
  journalsRemoved: number;
  sessionFiles: string[];
  journalFiles: string[];
}

export interface ArchiveResult {
  sessionsArchived: number;
  journalsArchived: number;
  sessionFiles: string[];
  journalFiles: string[];
}

/**
 * Archive sessions and journals older than their configured retention periods.
 * Moves files to archive/YYYY-MM/ subdirectories instead of deleting them.
 * Archived files remain on disk for audit/query but aren't loaded by default.
 */
export function archiveOldFiles(
  harnessDir: string,
  sessionRetentionDays: number,
  journalRetentionDays: number,
): ArchiveResult {
  const result: ArchiveResult = {
    sessionsArchived: 0,
    journalsArchived: 0,
    sessionFiles: [],
    journalFiles: [],
  };

  const now = Date.now();

  // Archive sessions
  const sessionsDir = join(harnessDir, 'memory', 'sessions');
  if (existsSync(sessionsDir)) {
    const cutoff = now - sessionRetentionDays * 24 * 60 * 60 * 1000;
    const files = readdirSync(sessionsDir).filter(
      (f) => f.endsWith('.md') && !f.startsWith('.') && !f.startsWith('_'),
    );

    for (const file of files) {
      const dateStr = extractDateFromFilename(file);
      if (dateStr && new Date(dateStr).getTime() < cutoff) {
        const yearMonth = dateStr.slice(0, 7); // YYYY-MM
        const archiveDir = join(sessionsDir, 'archive', yearMonth);
        mkdirSync(archiveDir, { recursive: true });
        copyFileSync(join(sessionsDir, file), join(archiveDir, file));
        unlinkSync(join(sessionsDir, file));
        result.sessionsArchived++;
        result.sessionFiles.push(file);
      }
    }
  }

  // Archive journals
  const journalDir = join(harnessDir, 'memory', 'journal');
  if (existsSync(journalDir)) {
    const cutoff = now - journalRetentionDays * 24 * 60 * 60 * 1000;
    const files = readdirSync(journalDir).filter(
      (f) => f.endsWith('.md') && !f.startsWith('.') && !f.startsWith('_'),
    );

    for (const file of files) {
      const dateStr = extractDateFromFilename(file);
      if (dateStr && new Date(dateStr).getTime() < cutoff) {
        const yearMonth = dateStr.slice(0, 7);
        const archiveDir = join(journalDir, 'archive', yearMonth);
        mkdirSync(archiveDir, { recursive: true });
        copyFileSync(join(journalDir, file), join(archiveDir, file));
        unlinkSync(join(journalDir, file));
        result.journalsArchived++;
        result.journalFiles.push(file);
      }
    }
  }

  return result;
}

/**
 * Remove sessions and journals older than their configured retention periods.
 * @deprecated Use archiveOldFiles() instead — it preserves files in archive/.
 * This function deletes files permanently.
 */
export function cleanupOldFiles(
  harnessDir: string,
  sessionRetentionDays: number,
  journalRetentionDays: number,
): CleanupResult {
  const result: CleanupResult = {
    sessionsRemoved: 0,
    journalsRemoved: 0,
    sessionFiles: [],
    journalFiles: [],
  };

  const now = Date.now();

  // Clean sessions
  const sessionsDir = join(harnessDir, 'memory', 'sessions');
  if (existsSync(sessionsDir)) {
    const cutoff = now - sessionRetentionDays * 24 * 60 * 60 * 1000;
    const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.md') && !f.startsWith('.'));

    for (const file of files) {
      const dateStr = extractDateFromFilename(file);
      if (dateStr && new Date(dateStr).getTime() < cutoff) {
        unlinkSync(join(sessionsDir, file));
        result.sessionsRemoved++;
        result.sessionFiles.push(file);
      }
    }
  }

  // Clean journals
  const journalDir = join(harnessDir, 'memory', 'journal');
  if (existsSync(journalDir)) {
    const cutoff = now - journalRetentionDays * 24 * 60 * 60 * 1000;
    const files = readdirSync(journalDir).filter((f) => f.endsWith('.md') && !f.startsWith('.'));

    for (const file of files) {
      const dateStr = extractDateFromFilename(file);
      if (dateStr && new Date(dateStr).getTime() < cutoff) {
        unlinkSync(join(journalDir, file));
        result.journalsRemoved++;
        result.journalFiles.push(file);
      }
    }
  }

  return result;
}

/** Extract YYYY-MM-DD from filename like "2026-04-06-abcdef12.md" or "2026-04-06.md" */
function extractDateFromFilename(filename: string): string | null {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  const date = new Date(match[1]);
  return isNaN(date.getTime()) ? null : match[1];
}

/** List all session files with their dates */
export function listSessions(harnessDir: string): Array<{ id: string; date: string; path: string }> {
  const sessionsDir = join(harnessDir, 'memory', 'sessions');
  if (!existsSync(sessionsDir)) return [];

  return readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .sort()
    .reverse()
    .map((f) => ({
      id: f.replace('.md', ''),
      date: extractDateFromFilename(f) || 'unknown',
      path: join(sessionsDir, f),
    }));
}

/** List files that would be removed by cleanup (dry run — doesn't delete) */
export function listExpiredFiles(
  harnessDir: string,
  sessionRetentionDays: number,
  journalRetentionDays: number,
): { sessionFiles: string[]; journalFiles: string[] } {
  const now = Date.now();
  const sessionFiles: string[] = [];
  const journalFiles: string[] = [];

  const sessionsDir = join(harnessDir, 'memory', 'sessions');
  if (existsSync(sessionsDir)) {
    const cutoff = now - sessionRetentionDays * 24 * 60 * 60 * 1000;
    const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.md') && !f.startsWith('.'));
    for (const file of files) {
      const dateStr = extractDateFromFilename(file);
      if (dateStr && new Date(dateStr).getTime() < cutoff) {
        sessionFiles.push(file);
      }
    }
  }

  const journalDir = join(harnessDir, 'memory', 'journal');
  if (existsSync(journalDir)) {
    const cutoff = now - journalRetentionDays * 24 * 60 * 60 * 1000;
    const files = readdirSync(journalDir).filter((f) => f.endsWith('.md') && !f.startsWith('.'));
    for (const file of files) {
      const dateStr = extractDateFromFilename(file);
      if (dateStr && new Date(dateStr).getTime() < cutoff) {
        journalFiles.push(file);
      }
    }
  }

  return { sessionFiles, journalFiles };
}
