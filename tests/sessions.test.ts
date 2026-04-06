import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
  archiveOldFiles,
  cleanupOldFiles,
  writeSession,
  listSessions,
  listExpiredFiles,
  createSessionId,
} from '../src/runtime/sessions.js';
import type { SessionRecord } from '../src/runtime/sessions.js';

const TEST_DIR = join(__dirname, '__test_sessions__');

function makeSession(id: string, date: string): SessionRecord {
  return {
    id,
    started: `${date}T10:00:00Z`,
    ended: `${date}T10:05:00Z`,
    prompt: 'Test prompt',
    summary: 'Test summary',
    tokens_used: 100,
    steps: 1,
  };
}

function writeSessionFile(dir: string, filename: string, date: string): void {
  const sessionsDir = join(dir, 'memory', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, filename),
    `---\nid: ${filename.replace('.md', '')}\ncreated: ${date}\n---\nSession content`,
    'utf-8',
  );
}

function writeJournalFile(dir: string, filename: string, date: string): void {
  const journalDir = join(dir, 'memory', 'journal');
  mkdirSync(journalDir, { recursive: true });
  writeFileSync(
    join(journalDir, filename),
    `---\nid: ${filename.replace('.md', '')}\ncreated: ${date}\n---\nJournal content`,
    'utf-8',
  );
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('createSessionId', () => {
  it('should generate an id with date prefix and uuid suffix', () => {
    const id = createSessionId();
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}-[a-f0-9]{8}$/);
  });
});

describe('writeSession', () => {
  it('should write a session file with frontmatter and content', () => {
    const session = makeSession('2026-04-06-abc12345', '2026-04-06');
    const path = writeSession(TEST_DIR, session);
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('id: 2026-04-06-abc12345');
    expect(content).toContain('Test prompt');
    expect(content).toContain('Test summary');
  });

  it('should include model_id when provided', () => {
    const session = { ...makeSession('2026-04-06-abc12345', '2026-04-06'), model_id: 'claude-sonnet-4' };
    const path = writeSession(TEST_DIR, session);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('claude-sonnet-4');
  });

  it('should write tool calls section when tool_calls provided', () => {
    const session = {
      ...makeSession('2026-04-06-tools01', '2026-04-06'),
      tool_calls: [
        { toolName: 'weather', args: { location: 'NYC' }, result: '72°F sunny' },
        { toolName: 'search', args: { query: 'test' }, result: null },
      ],
    };
    const path = writeSession(TEST_DIR, session);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('## Tools Used');
    expect(content).toContain('### weather');
    expect(content).toContain('NYC');
    expect(content).toContain('72°F sunny');
    expect(content).toContain('### search');
  });

  it('should omit tool calls section when no tool_calls', () => {
    const session = makeSession('2026-04-06-notools', '2026-04-06');
    const path = writeSession(TEST_DIR, session);
    const content = readFileSync(path, 'utf-8');
    expect(content).not.toContain('## Tools Used');
  });

  it('should omit tool calls section when tool_calls is empty array', () => {
    const session = { ...makeSession('2026-04-06-empty', '2026-04-06'), tool_calls: [] };
    const path = writeSession(TEST_DIR, session);
    const content = readFileSync(path, 'utf-8');
    expect(content).not.toContain('## Tools Used');
  });

  it('should truncate long tool args and results', () => {
    const longArg = 'x'.repeat(300);
    const longResult = 'y'.repeat(400);
    const session = {
      ...makeSession('2026-04-06-long01', '2026-04-06'),
      tool_calls: [
        { toolName: 'bigTool', args: { data: longArg }, result: longResult },
      ],
    };
    const path = writeSession(TEST_DIR, session);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('## Tools Used');
    expect(content).toContain('...');
    // Full long strings should not appear
    expect(content).not.toContain(longArg);
    expect(content).not.toContain(longResult);
  });
});

describe('listSessions', () => {
  it('should list sessions sorted newest first', () => {
    writeSessionFile(TEST_DIR, '2026-04-01-aaa.md', '2026-04-01');
    writeSessionFile(TEST_DIR, '2026-04-06-bbb.md', '2026-04-06');
    writeSessionFile(TEST_DIR, '2026-04-03-ccc.md', '2026-04-03');

    const sessions = listSessions(TEST_DIR);
    expect(sessions).toHaveLength(3);
    expect(sessions[0].id).toBe('2026-04-06-bbb');
    expect(sessions[2].id).toBe('2026-04-01-aaa');
  });

  it('should return empty array when no sessions dir', () => {
    const sessions = listSessions(TEST_DIR);
    expect(sessions).toHaveLength(0);
  });
});

describe('archiveOldFiles', () => {
  it('should move expired sessions to archive/YYYY-MM/', () => {
    // Create a session 30 days old
    writeSessionFile(TEST_DIR, '2026-03-01-old.md', '2026-03-01');
    // Create a recent session (today)
    writeSessionFile(TEST_DIR, '2026-04-06-new.md', '2026-04-06');

    const result = archiveOldFiles(TEST_DIR, 7, 365);

    expect(result.sessionsArchived).toBe(1);
    expect(result.sessionFiles).toContain('2026-03-01-old.md');

    // Archived file should exist in archive/2026-03/
    const archivePath = join(TEST_DIR, 'memory', 'sessions', 'archive', '2026-03', '2026-03-01-old.md');
    expect(existsSync(archivePath)).toBe(true);

    // Original should be removed
    expect(existsSync(join(TEST_DIR, 'memory', 'sessions', '2026-03-01-old.md'))).toBe(false);

    // Recent file should still be there
    expect(existsSync(join(TEST_DIR, 'memory', 'sessions', '2026-04-06-new.md'))).toBe(true);
  });

  it('should move expired journals to archive/YYYY-MM/', () => {
    writeJournalFile(TEST_DIR, '2025-01-15.md', '2025-01-15');

    const result = archiveOldFiles(TEST_DIR, 7, 30);

    expect(result.journalsArchived).toBe(1);
    const archivePath = join(TEST_DIR, 'memory', 'journal', 'archive', '2025-01', '2025-01-15.md');
    expect(existsSync(archivePath)).toBe(true);
  });

  it('should not archive recent files', () => {
    writeSessionFile(TEST_DIR, '2026-04-06-new.md', '2026-04-06');

    const result = archiveOldFiles(TEST_DIR, 7, 365);

    expect(result.sessionsArchived).toBe(0);
    expect(existsSync(join(TEST_DIR, 'memory', 'sessions', '2026-04-06-new.md'))).toBe(true);
  });

  it('should handle empty directories', () => {
    const result = archiveOldFiles(TEST_DIR, 7, 365);
    expect(result.sessionsArchived).toBe(0);
    expect(result.journalsArchived).toBe(0);
  });

  it('should skip hidden and index files', () => {
    const sessionsDir = join(TEST_DIR, 'memory', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, '.hidden.md'), 'hidden', 'utf-8');
    writeFileSync(join(sessionsDir, '_index.md'), 'index', 'utf-8');

    const result = archiveOldFiles(TEST_DIR, 0, 0); // 0 retention = archive everything
    expect(result.sessionsArchived).toBe(0);
  });
});

describe('cleanupOldFiles (legacy delete)', () => {
  it('should delete expired sessions permanently', () => {
    writeSessionFile(TEST_DIR, '2026-03-01-old.md', '2026-03-01');

    const result = cleanupOldFiles(TEST_DIR, 7, 365);

    expect(result.sessionsRemoved).toBe(1);
    expect(existsSync(join(TEST_DIR, 'memory', 'sessions', '2026-03-01-old.md'))).toBe(false);
    // No archive directory should be created
    expect(existsSync(join(TEST_DIR, 'memory', 'sessions', 'archive'))).toBe(false);
  });
});

describe('listExpiredFiles', () => {
  it('should list files that would be cleaned up', () => {
    writeSessionFile(TEST_DIR, '2026-03-01-old.md', '2026-03-01');
    writeSessionFile(TEST_DIR, '2026-04-06-new.md', '2026-04-06');
    writeJournalFile(TEST_DIR, '2025-01-01.md', '2025-01-01');

    const expired = listExpiredFiles(TEST_DIR, 7, 30);

    expect(expired.sessionFiles).toContain('2026-03-01-old.md');
    expect(expired.sessionFiles).not.toContain('2026-04-06-new.md');
    expect(expired.journalFiles).toContain('2025-01-01.md');
  });
});
