import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parseHarnessDocument } from '../primitives/loader.js';
import { getModel, generate } from '../llm/provider.js';
import { loadConfig } from '../core/config.js';
import type { HarnessConfig, HarnessDocument } from '../core/types.js';

export interface JournalEntry {
  date: string;
  sessions: HarnessDocument[];
  synthesis: string;
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

  const synthesisPrompt = `You are synthesizing today's agent sessions into a journal entry.

Sessions from ${targetDate}:

${sessionSummaries}

Write a journal entry that:
1. Summarizes what happened today (2-3 sentences)
2. Notes any patterns or recurring themes
3. Identifies potential instinct candidates — behaviors that should become reflexive

Format your response as:

## Summary
[2-3 sentence synthesis]

## Patterns
[Bullet points of patterns noticed]

## Instinct Candidates
[Bullet points of potential new instincts, each starting with "INSTINCT:" followed by the behavior]`;

  const config = loadConfig(harnessDir);
  const model = getModel(config, apiKey);

  const result = await generate({
    model,
    system: 'You are a reflective journal synthesizer. Be concise and insightful.',
    prompt: synthesisPrompt,
  });

  // Extract instinct candidates
  const instinctCandidates: string[] = [];
  const instinctMatches = result.text.matchAll(/INSTINCT:\s*(.+)/g);
  for (const match of instinctMatches) {
    instinctCandidates.push(match[1].trim());
  }

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
<!-- L1: ${result.text.slice(0, 200)} -->

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
    instinct_candidates: instinctCandidates,
    tokens_used: result.usage.totalTokens,
  };
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
