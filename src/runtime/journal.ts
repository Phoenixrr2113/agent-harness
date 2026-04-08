import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parseHarnessDocument } from '../primitives/loader.js';
import { getModel, generate } from '../llm/provider.js';
import { loadConfig } from '../core/config.js';
import type { HarnessDocument } from '../core/types.js';

export interface JournalSynthesis {
  summary: string;
  insights: string[];
  instinct_candidates: string[];
  knowledge_updates: string[];
}

export interface JournalEntry {
  date: string;
  sessions: HarnessDocument[];
  synthesis: string;
  structured: JournalSynthesis;
  instinct_candidates: string[];
  tokens_used: number;
}

export async function synthesizeJournal(
  harnessDir: string,
  date?: string,
  apiKey?: string,
): Promise<JournalEntry> {
  const targetDate = date || new Date().toISOString().split('T')[0];
  const sessionsDir = join(harnessDir, 'memory', 'sessions');
  const journalDir = join(harnessDir, 'memory', 'journal');

  if (!existsSync(journalDir)) {
    mkdirSync(journalDir, { recursive: true });
  }

  // Load sessions for this date
  const sessions: HarnessDocument[] = [];
  if (existsSync(sessionsDir)) {
    const files = readdirSync(sessionsDir).filter(
      (f) => f.endsWith('.md') && f.startsWith(targetDate),
    );

    for (const file of files) {
      try {
        const doc = parseHarnessDocument(join(sessionsDir, file));
        sessions.push(doc);
      } catch {
        // Skip unparseable
      }
    }
  }

  if (sessions.length === 0) {
    return {
      date: targetDate,
      sessions: [],
      synthesis: 'No sessions recorded today.',
      structured: {
        summary: 'No sessions recorded today.',
        insights: [],
        instinct_candidates: [],
        knowledge_updates: [],
      },
      instinct_candidates: [],
      tokens_used: 0,
    };
  }

  // Build synthesis prompt
  const sessionSummaries = sessions
    .map((s, i) => {
      const prompt = s.body.match(/## Prompt\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() || '';
      const summary = s.body.match(/## Summary\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() || '';
      return `Session ${i + 1}:\n  Prompt: ${prompt}\n  Summary: ${summary}`;
    })
    .join('\n\n');

  const synthesisPrompt = `You are synthesizing today's agent sessions into a structured journal entry.

Sessions from ${targetDate}:

${sessionSummaries}

Write a journal entry with these EXACT sections (use the exact headers shown):

## Summary
2-3 sentence synthesis of what happened today.

## Insights
Bullet points (starting with "- ") of patterns, recurring themes, or notable observations.

## Instinct Candidates
Bullet points (starting with "- INSTINCT: ") of behaviors that should become reflexive rules.

## Knowledge Updates
Bullet points (starting with "- ") of new facts, corrections, or learnings that should be remembered.`;

  const config = loadConfig(harnessDir);
  const model = getModel(config, apiKey);

  const result = await generate({
    model,
    system: 'You are a reflective journal synthesizer. Be concise and insightful. Follow the output format exactly.',
    prompt: synthesisPrompt,
  });

  // Parse structured sections from the response
  const structured = parseJournalSynthesis(result.text);

  // Write journal entry
  const journalPath = join(journalDir, `${targetDate}.md`);
  const journalContent = `---
id: journal-${targetDate}
tags: [journal, daily]
created: ${targetDate}
updated: ${new Date().toISOString().split('T')[0]}
author: infrastructure
status: active
---

<!-- L0: Journal for ${targetDate} — ${sessions.length} sessions synthesized. -->
<!-- L1: ${structured.summary.slice(0, 200)} -->

# Journal: ${targetDate}

**Sessions:** ${sessions.length}
**Tokens used:** ${result.usage.totalTokens}

${result.text}
`;

  writeFileSync(journalPath, journalContent, 'utf-8');

  return {
    date: targetDate,
    sessions,
    synthesis: result.text,
    structured,
    instinct_candidates: structured.instinct_candidates,
    tokens_used: result.usage.totalTokens,
  };
}

/**
 * Parse a journal synthesis response into structured sections.
 * Resilient to missing sections — returns empty arrays/strings for missing parts.
 */
export function parseJournalSynthesis(text: string): JournalSynthesis {
  const sectionRegex = /## (Summary|Insights|Instinct Candidates|Knowledge Updates|Patterns)\n([\s\S]*?)(?=\n## |\n*$)/g;
  const sections = new Map<string, string>();

  for (const match of text.matchAll(sectionRegex)) {
    sections.set(match[1].toLowerCase(), match[2].trim());
  }

  const extractBullets = (content: string | undefined): string[] => {
    if (!content) return [];
    return content
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).trim())
      .filter(Boolean);
  };

  const summary = sections.get('summary') ?? '';

  // "Insights" or legacy "Patterns" section
  const insightsRaw = sections.get('insights') ?? sections.get('patterns') ?? '';
  const insights = extractBullets(insightsRaw);

  // Extract instinct candidates, stripping "INSTINCT:" prefix
  const instinctRaw = sections.get('instinct candidates') ?? '';
  const instinct_candidates = extractBullets(instinctRaw).map((line) =>
    line.replace(/^INSTINCT:\s*/i, ''),
  );

  const knowledgeRaw = sections.get('knowledge updates') ?? '';
  const knowledge_updates = extractBullets(knowledgeRaw);

  return { summary, insights, instinct_candidates, knowledge_updates };
}

/**
 * Synthesize journals for a date range.
 * Processes each date that has sessions, skipping dates already journaled unless force is set.
 */
export async function synthesizeJournalRange(
  harnessDir: string,
  options: { from?: string; to?: string; all?: boolean; force?: boolean; apiKey?: string },
): Promise<JournalEntry[]> {
  const sessionsDir = join(harnessDir, 'memory', 'sessions');
  if (!existsSync(sessionsDir)) return [];

  // Collect all unique dates from session filenames
  const files = readdirSync(sessionsDir).filter(
    (f) => f.endsWith('.md') && !f.startsWith('.') && !f.startsWith('_'),
  );
  const dateSet = new Set<string>();
  for (const file of files) {
    const match = file.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) dateSet.add(match[1]);
  }

  let dates = [...dateSet].sort();

  // Apply range filters
  if (!options.all) {
    const from = options.from;
    const to = options.to || new Date().toISOString().split('T')[0];
    if (from) {
      dates = dates.filter((d) => d >= from && d <= to);
    }
  }

  if (dates.length === 0) return [];

  // Check which dates already have journals
  const journalDir = join(harnessDir, 'memory', 'journal');
  const existingJournals = new Set<string>();
  if (existsSync(journalDir)) {
    for (const jf of readdirSync(journalDir)) {
      const match = jf.match(/^(\d{4}-\d{2}-\d{2})/);
      if (match) existingJournals.add(match[1]);
    }
  }

  const entries: JournalEntry[] = [];
  for (const date of dates) {
    if (!options.force && existingJournals.has(date)) continue;

    const entry = await synthesizeJournal(harnessDir, date, options.apiKey);
    entries.push(entry);
  }

  return entries;
}

/**
 * List dates that have sessions but no journal entry.
 */
export function listUnjournaled(harnessDir: string): string[] {
  const sessionsDir = join(harnessDir, 'memory', 'sessions');
  if (!existsSync(sessionsDir)) return [];

  const sessionDates = new Set<string>();
  for (const file of readdirSync(sessionsDir)) {
    if (!file.endsWith('.md') || file.startsWith('.')) continue;
    const match = file.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) sessionDates.add(match[1]);
  }

  const journalDir = join(harnessDir, 'memory', 'journal');
  const journalDates = new Set<string>();
  if (existsSync(journalDir)) {
    for (const file of readdirSync(journalDir)) {
      const match = file.match(/^(\d{4}-\d{2}-\d{2})/);
      if (match) journalDates.add(match[1]);
    }
  }

  return [...sessionDates].filter((d) => !journalDates.has(d)).sort();
}

export function listJournals(harnessDir: string): string[] {
  const journalDir = join(harnessDir, 'memory', 'journal');
  if (!existsSync(journalDir)) return [];

  return readdirSync(journalDir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .sort()
    .reverse();
}

export interface WeekSummary {
  weekStart: string;
  weekEnd: string;
  journalDates: string[];
  summary: string;
  allInsights: string[];
  allInstinctCandidates: string[];
  allKnowledgeUpdates: string[];
  filePath: string;
}

/**
 * Get the Monday of the ISO week for a given date string (YYYY-MM-DD).
 */
function getWeekStart(dateStr: string): string {
  const date = new Date(dateStr + 'T12:00:00Z');
  const day = date.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  date.setUTCDate(date.getUTCDate() - diff);
  return date.toISOString().split('T')[0];
}

/**
 * Get the Sunday of the ISO week for a given date string.
 */
function getWeekEnd(dateStr: string): string {
  const start = new Date(getWeekStart(dateStr) + 'T12:00:00Z');
  start.setUTCDate(start.getUTCDate() + 6);
  return start.toISOString().split('T')[0];
}

/**
 * Compress daily journals into weekly roll-up summaries.
 * Groups journals by ISO week, aggregates structured sections, writes
 * weekly summary files to memory/journal/weekly/. Pure file-based — no LLM calls.
 *
 * Returns only weeks that were newly created (skips existing unless force=true).
 */
export function compressJournals(
  harnessDir: string,
  options?: { force?: boolean },
): WeekSummary[] {
  const journalDir = join(harnessDir, 'memory', 'journal');
  if (!existsSync(journalDir)) return [];

  const weeklyDir = join(journalDir, 'weekly');
  if (!existsSync(weeklyDir)) {
    mkdirSync(weeklyDir, { recursive: true });
  }

  // Load all daily journals
  const files = readdirSync(journalDir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.') && !f.startsWith('_'))
    .sort();

  // Group by week
  const weeks = new Map<string, string[]>();
  for (const file of files) {
    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;
    const weekStart = getWeekStart(dateMatch[1]);
    if (!weeks.has(weekStart)) weeks.set(weekStart, []);
    weeks.get(weekStart)!.push(file);
  }

  const results: WeekSummary[] = [];

  for (const [weekStart, journalFiles] of weeks) {
    const weekEnd = getWeekEnd(weekStart);
    const weeklyFile = join(weeklyDir, `${weekStart}.md`);

    // Skip existing unless force
    if (!options?.force && existsSync(weeklyFile)) continue;

    // Only compress complete past weeks (not the current week)
    const today = new Date().toISOString().split('T')[0];
    const currentWeekStart = getWeekStart(today);
    if (weekStart === currentWeekStart) continue;

    // Aggregate structured sections from each journal
    const allSummaries: string[] = [];
    const allInsights: string[] = [];
    const allInstinctCandidates: string[] = [];
    const allKnowledgeUpdates: string[] = [];
    const journalDates: string[] = [];

    for (const file of journalFiles) {
      const content = readFileSync(join(journalDir, file), 'utf-8');
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) journalDates.push(dateMatch[1]);

      const structured = parseJournalSynthesis(content);
      if (structured.summary) allSummaries.push(`**${dateMatch?.[1]}:** ${structured.summary}`);
      allInsights.push(...structured.insights);
      allInstinctCandidates.push(...structured.instinct_candidates);
      allKnowledgeUpdates.push(...structured.knowledge_updates);
    }

    // Deduplicate
    const uniqueInsights = [...new Set(allInsights)];
    const uniqueInstincts = [...new Set(allInstinctCandidates)];
    const uniqueKnowledge = [...new Set(allKnowledgeUpdates)];

    const weekSummary = allSummaries.join('\n\n');
    const insightsBullets = uniqueInsights.map((i) => `- ${i}`).join('\n');
    const instinctBullets = uniqueInstincts.map((i) => `- INSTINCT: ${i}`).join('\n');
    const knowledgeBullets = uniqueKnowledge.map((k) => `- ${k}`).join('\n');

    const weeklyContent = `---
id: weekly-${weekStart}
tags: [journal, weekly]
created: ${weekStart}
updated: ${new Date().toISOString().split('T')[0]}
author: infrastructure
status: active
---

<!-- L0: Weekly journal roll-up ${weekStart} to ${weekEnd} (${journalDates.length} days) -->
<!-- L1: ${allSummaries[0]?.slice(0, 200) || 'No summaries available'} -->

# Weekly Journal: ${weekStart} to ${weekEnd}

**Days journaled:** ${journalDates.length}
**Dates:** ${journalDates.join(', ')}

## Summary
${weekSummary || 'No daily summaries available.'}

## Insights
${insightsBullets || '(none)'}

## Instinct Candidates
${instinctBullets || '(none)'}

## Knowledge Updates
${knowledgeBullets || '(none)'}
`;

    writeFileSync(weeklyFile, weeklyContent, 'utf-8');

    results.push({
      weekStart,
      weekEnd,
      journalDates,
      summary: weekSummary,
      allInsights: uniqueInsights,
      allInstinctCandidates: uniqueInstincts,
      allKnowledgeUpdates: uniqueKnowledge,
      filePath: weeklyFile,
    });
  }

  return results;
}
