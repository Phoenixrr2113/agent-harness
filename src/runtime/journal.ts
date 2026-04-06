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

export function listJournals(harnessDir: string): string[] {
  const journalDir = join(harnessDir, 'memory', 'journal');
  if (!existsSync(journalDir)) return [];

  return readdirSync(journalDir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .sort()
    .reverse();
}
