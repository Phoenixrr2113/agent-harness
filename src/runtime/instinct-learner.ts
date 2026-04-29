import { writeFileSync, readdirSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getModel, generate } from '../llm/provider.js';
import { loadConfig } from '../core/config.js';
import { loadDirectory } from '../primitives/loader.js';

export interface InstinctCandidate {
  id: string;
  behavior: string;
  provenance: string;
  confidence: number;
}

export interface LearnResult {
  candidates: InstinctCandidate[];
  installed: string[];
  skipped: string[];
}

export async function proposeInstincts(
  harnessDir: string,
  fromJournalDate?: string,
  apiKey?: string,
): Promise<InstinctCandidate[]> {
  const config = loadConfig(harnessDir);
  const model = getModel(config, apiKey);

  // Load existing instincts to avoid duplicates
  const existingInstincts = loadDirectory(join(harnessDir, 'instincts'));
  const existingBehaviors = existingInstincts.map((d) => d.description ?? d.id).join('\n- ');

  // Load recent sessions or journal
  let recentContext = '';
  if (fromJournalDate) {
    const journalPath = join(harnessDir, 'memory', 'journal', `${fromJournalDate}.md`);
    if (existsSync(journalPath)) {
      recentContext = readFileSync(journalPath, 'utf-8');
    }
  }

  if (!recentContext) {
    // Fall back to recent sessions
    const sessionsDir = join(harnessDir, 'memory', 'sessions');
    if (existsSync(sessionsDir)) {
      const files = readdirSync(sessionsDir)
        .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
        .sort()
        .reverse()
        .slice(0, 10);

      recentContext = files
        .map((f) => readFileSync(join(sessionsDir, f), 'utf-8'))
        .join('\n\n---\n\n');
    }
  }

  if (!recentContext) {
    return [];
  }

  const prompt = `Analyze these recent agent interactions and identify potential instincts — reflexive behaviors that should become automatic.

Existing instincts (DO NOT duplicate):
- ${existingBehaviors || 'none yet'}

Recent context:
${recentContext.slice(0, 4000)}

For each candidate instinct, respond with EXACTLY this JSON format (one per line):
{"id": "kebab-case-id", "behavior": "One sentence describing the behavior", "provenance": "Where this was learned from", "confidence": 0.8}

Only propose instincts with confidence >= 0.7. Only propose genuinely useful behaviors, not obvious ones.
If there are no good candidates, respond with: NONE`;

  const result = await generate({
    model,
    system: 'You are an instinct analyzer. Extract behavioral patterns. Be selective — only propose high-value instincts.',
    prompt,
  });

  const candidates: InstinctCandidate[] = [];

  for (const line of result.text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === 'NONE') break;
    if (!trimmed.startsWith('{')) continue;

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.id && parsed.behavior && parsed.confidence >= 0.7) {
        candidates.push({
          id: parsed.id,
          behavior: parsed.behavior,
          provenance: parsed.provenance || 'auto-detected',
          confidence: parsed.confidence,
        });
      }
    } catch {
      // Skip malformed lines
    }
  }

  return candidates;
}

export function installInstinct(harnessDir: string, candidate: InstinctCandidate): string {
  const instinctsDir = join(harnessDir, 'instincts');
  if (!existsSync(instinctsDir)) {
    mkdirSync(instinctsDir, { recursive: true });
  }

  const today = new Date().toISOString().split('T')[0];
  const filePath = join(instinctsDir, `${candidate.id}.md`);

  // Don't overwrite existing
  if (existsSync(filePath)) {
    return '';
  }

  const content = `---
id: ${candidate.id}
tags: [instinct, auto-learned]
created: ${today}
updated: ${today}
author: agent
status: active
source: auto-detected
---

<!-- L0: ${candidate.behavior} -->
<!-- L1: ${candidate.behavior} Learned from: ${candidate.provenance}. Confidence: ${candidate.confidence}. -->

# Instinct: ${candidate.id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}

${candidate.behavior}

**Provenance:** ${candidate.provenance}
**Confidence:** ${candidate.confidence}
**Auto-learned:** ${today}
`;

  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

export async function learnFromSessions(
  harnessDir: string,
  autoInstall: boolean = false,
  apiKey?: string,
): Promise<LearnResult> {
  // D13: prefer the journal's already-extracted instinct candidates over a
  // fresh LLM pass. `harness journal` synthesizes a structured markdown with
  // a `## Instinct Candidates` section — the user has already seen those
  // candidates and re-running the LLM here is wasted inference (and
  // non-deterministic; small models often return "NONE" while the journal
  // has 3+ candidates).
  let candidates = harvestInstincts(harnessDir, {}).candidates;

  // Fall back to fresh LLM proposal if the journal didn't surface any
  // (no journal yet, or the synthesizer left the section empty).
  if (candidates.length === 0) {
    candidates = await proposeInstincts(harnessDir, undefined, apiKey);
  }

  // Persist candidates so `harness rules promote <id>` can look them up later
  const candidatesPath = join(harnessDir, 'memory', 'instinct-candidates.json');
  const candidatesDir = join(harnessDir, 'memory');
  if (!existsSync(candidatesDir)) {
    mkdirSync(candidatesDir, { recursive: true });
  }
  writeFileSync(candidatesPath, JSON.stringify({ candidates }, null, 2), 'utf-8');

  const installed: string[] = [];
  const skipped: string[] = [];

  if (autoInstall) {
    for (const candidate of candidates) {
      const path = installInstinct(harnessDir, candidate);
      if (path) {
        installed.push(candidate.id);
      } else {
        skipped.push(candidate.id);
      }
    }
  }

  return { candidates, installed, skipped };
}

export interface HarvestResult {
  candidates: InstinctCandidate[];
  installed: string[];
  skipped: string[];
  journalsScanned: number;
}

/**
 * Harvest instinct candidates from journal entries.
 * Scans all journals (or journals within a date range) for instinct candidate
 * sections, deduplicates against existing instincts, and optionally installs them.
 *
 * Unlike learnFromSessions which uses LLM calls, harvestInstincts is pure file-based —
 * it extracts already-identified candidates from journal synthesis output.
 */
export function harvestInstincts(
  harnessDir: string,
  options?: { from?: string; to?: string; install?: boolean },
): HarvestResult {
  const journalDir = join(harnessDir, 'memory', 'journal');
  if (!existsSync(journalDir)) {
    return { candidates: [], installed: [], skipped: [], journalsScanned: 0 };
  }

  const files = readdirSync(journalDir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.') && !f.startsWith('_'))
    .sort();

  // Filter by date range
  const from = options?.from;
  const to = options?.to;
  const filtered = files.filter((f) => {
    const dateMatch = f.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) return false;
    const d = dateMatch[1];
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });

  // Load existing instinct IDs to deduplicate
  const instinctsDir = join(harnessDir, 'instincts');
  const existingIds = new Set<string>();
  const existingBehaviors = new Set<string>();
  if (existsSync(instinctsDir)) {
    const docs = loadDirectory(instinctsDir);
    for (const doc of docs) {
      existingIds.add(doc.id);
      if (doc.description) existingBehaviors.add(doc.description.toLowerCase());
    }
  }

  const candidates: InstinctCandidate[] = [];
  const seenIds = new Set<string>();

  for (const file of filtered) {
    const content = readFileSync(join(journalDir, file), 'utf-8');

    // Extract instinct candidates section
    const sectionMatch = content.match(/## Instinct Candidates\n([\s\S]*?)(?=\n## |\n*$)/);
    if (!sectionMatch) continue;

    // D14+D15: tolerate malformed bullets the synthesis LLM sometimes emits.
    // The intended format is `- INSTINCT: <behavior>` but qwen3-class models
    // produce `- - INSTINCT: ...` (double-dash) often enough to break harvest.
    // Strip any sequence of leading "- " bullets, then require INSTINCT: prefix.
    const lines = sectionMatch[1]
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.replace(/^(?:-\s+)+/, '').trim()) // collapse "- - INSTINCT" → "INSTINCT"
      .map((l) => l.replace(/^INSTINCT:\s*/i, ''))
      .filter((l) => l.length > 0);

    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
    const journalDate = dateMatch ? dateMatch[1] : 'unknown';

    for (const line of lines) {
      if (!line) continue;

      // Generate a kebab-case id from the behavior text
      const id = line
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .slice(0, 50)
        .replace(/-+$/, '');

      if (!id) continue;
      if (seenIds.has(id)) continue;
      if (existingIds.has(id)) continue;

      // Fuzzy dedup: skip if behavior text closely matches existing instinct L0
      const behaviorLower = line.toLowerCase();
      if (existingBehaviors.has(behaviorLower)) continue;

      seenIds.add(id);
      candidates.push({
        id,
        behavior: line,
        provenance: `journal:${journalDate}`,
        confidence: 0.75,
      });
    }
  }

  const installed: string[] = [];
  const skipped: string[] = [];

  if (options?.install) {
    for (const candidate of candidates) {
      const path = installInstinct(harnessDir, candidate);
      if (path) {
        installed.push(candidate.id);
      } else {
        skipped.push(candidate.id);
      }
    }
  }

  return { candidates, installed, skipped, journalsScanned: filtered.length };
}

export function loadCandidateById(harnessDir: string, id: string): InstinctCandidate | null {
  const candidatesPath = join(harnessDir, 'memory', 'instinct-candidates.json');
  if (!existsSync(candidatesPath)) return null;
  const raw = readFileSync(candidatesPath, 'utf-8');
  let parsed: { candidates?: InstinctCandidate[] };
  try { parsed = JSON.parse(raw); } catch { return null; }
  return parsed.candidates?.find((c) => c.id === id) ?? null;
}
