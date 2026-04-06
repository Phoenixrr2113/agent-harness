import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';

export interface SessionData {
  id: string;
  date: string;
  started: string;
  ended: string;
  tokens: number;
  steps: number;
  durationMinutes: number;
  model?: string;
  delegatedTo?: string;
}

export interface SessionAnalytics {
  totalSessions: number;
  totalTokens: number;
  totalDurationMinutes: number;
  avgTokensPerSession: number;
  avgDurationMinutes: number;
  sessionsPerDay: Map<string, number>;
  tokensPerDay: Map<string, number>;
  modelUsage: Map<string, number>;
  delegationCount: number;
  dateRange: { earliest: string; latest: string } | null;
  topDays: Array<{ date: string; sessions: number; tokens: number }>;
}

/**
 * Parse a session markdown file to extract structured data.
 */
function parseSessionFile(filePath: string): SessionData | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const { data, content: body } = matter(content);

    const id = typeof data.id === 'string' ? data.id : '';
    const created = typeof data.created === 'string'
      ? data.created
      : data.created instanceof Date
        ? data.created.toISOString()
        : '';
    const updated = typeof data.updated === 'string'
      ? data.updated
      : data.updated instanceof Date
        ? data.updated.toISOString()
        : '';
    const durationMinutes = typeof data.duration_minutes === 'number' ? data.duration_minutes : 0;

    // Extract date from id (YYYY-MM-DD-xxxxxxxx format)
    const dateMatch = id.match(/^(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch ? dateMatch[1] : '';

    // Extract tokens and steps from body
    const tokensMatch = body.match(/\*\*Tokens:\*\*\s*(\d+)/);
    const stepsMatch = body.match(/\*\*Steps:\*\*\s*(\d+)/);
    const modelMatch = body.match(/\*\*Model:\*\*\s*(.+)/);
    const delegateMatch = body.match(/\*\*Delegated to:\*\*\s*(.+)/);

    const tokens = tokensMatch ? parseInt(tokensMatch[1], 10) : 0;
    const steps = stepsMatch ? parseInt(stepsMatch[1], 10) : 0;
    const model = modelMatch ? modelMatch[1].trim() : undefined;
    const delegatedTo = delegateMatch ? delegateMatch[1].trim() : undefined;

    return {
      id,
      date,
      started: created,
      ended: updated,
      tokens,
      steps,
      durationMinutes,
      model,
      delegatedTo,
    };
  } catch {
    return null;
  }
}

/**
 * Load all sessions and compute analytics.
 */
export function getSessionAnalytics(harnessDir: string): SessionAnalytics {
  const sessionsDir = join(harnessDir, 'memory', 'sessions');
  const sessions: SessionData[] = [];

  if (existsSync(sessionsDir)) {
    const files = readdirSync(sessionsDir)
      .filter((f) => f.endsWith('.md') && !f.startsWith('.') && !f.startsWith('_'));

    for (const file of files) {
      const data = parseSessionFile(join(sessionsDir, file));
      if (data) sessions.push(data);
    }
  }

  const sessionsPerDay = new Map<string, number>();
  const tokensPerDay = new Map<string, number>();
  const modelUsage = new Map<string, number>();
  let totalTokens = 0;
  let totalDurationMinutes = 0;
  let delegationCount = 0;
  let earliest = '';
  let latest = '';

  for (const session of sessions) {
    totalTokens += session.tokens;
    totalDurationMinutes += session.durationMinutes;

    if (session.delegatedTo) delegationCount++;

    if (session.date) {
      sessionsPerDay.set(session.date, (sessionsPerDay.get(session.date) ?? 0) + 1);
      tokensPerDay.set(session.date, (tokensPerDay.get(session.date) ?? 0) + session.tokens);

      if (!earliest || session.date < earliest) earliest = session.date;
      if (!latest || session.date > latest) latest = session.date;
    }

    if (session.model) {
      modelUsage.set(session.model, (modelUsage.get(session.model) ?? 0) + 1);
    }
  }

  // Top days by session count
  const topDays = Array.from(sessionsPerDay.entries())
    .map(([date, count]) => ({
      date,
      sessions: count,
      tokens: tokensPerDay.get(date) ?? 0,
    }))
    .sort((a, b) => b.sessions - a.sessions || b.tokens - a.tokens)
    .slice(0, 7);

  return {
    totalSessions: sessions.length,
    totalTokens,
    totalDurationMinutes,
    avgTokensPerSession: sessions.length > 0 ? Math.round(totalTokens / sessions.length) : 0,
    avgDurationMinutes: sessions.length > 0 ? Math.round(totalDurationMinutes / sessions.length) : 0,
    sessionsPerDay,
    tokensPerDay,
    modelUsage,
    delegationCount,
    dateRange: earliest && latest ? { earliest, latest } : null,
    topDays,
  };
}

/**
 * Load raw session data for a date range.
 */
export function getSessionsInRange(
  harnessDir: string,
  from?: string,
  to?: string,
): SessionData[] {
  const sessionsDir = join(harnessDir, 'memory', 'sessions');
  if (!existsSync(sessionsDir)) return [];

  const files = readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.') && !f.startsWith('_'));

  const sessions: SessionData[] = [];
  for (const file of files) {
    const data = parseSessionFile(join(sessionsDir, file));
    if (!data || !data.date) continue;

    if (from && data.date < from) continue;
    if (to && data.date > to) continue;

    sessions.push(data);
  }

  return sessions.sort((a, b) => a.date.localeCompare(b.date));
}
