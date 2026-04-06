import { writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

export interface SessionRecord {
  id: string;
  started: string;
  ended: string;
  prompt: string;
  summary: string;
  tokens_used: number;
  steps: number;
}

export function createSessionId(): string {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const short = randomUUID().slice(0, 8);
  return `${date}-${short}`;
}

export function writeSession(harnessDir: string, session: SessionRecord): string {
  const sessionsDir = join(harnessDir, 'memory', 'sessions');
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  const filePath = join(sessionsDir, `${session.id}.md`);
  const content = `---
id: ${session.id}
tags: [session]
created: ${session.started}
updated: ${session.ended}
author: agent
status: active
duration_minutes: ${Math.round((new Date(session.ended).getTime() - new Date(session.started).getTime()) / 60000)}
---

<!-- L0: Session ${session.id} — ${session.summary.slice(0, 60)} -->
<!-- L1: ${session.summary} -->

# Session: ${session.id}

**Started:** ${session.started}
**Ended:** ${session.ended}
**Tokens:** ${session.tokens_used}
**Steps:** ${session.steps}

## Prompt
${session.prompt}

## Summary
${session.summary}
`;

  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

export interface CleanupResult {
  sessionsRemoved: number;
  journalsRemoved: number;
  sessionFiles: string[];
  journalFiles: string[];
}

/**
 * Remove sessions and journals older than their configured retention periods.
 * Session filenames start with YYYY-MM-DD, so we parse the date from the filename.
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
