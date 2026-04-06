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
  const existingBehaviors = existingInstincts.map((d) => d.l0 || d.frontmatter.id).join('\n- ');

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
  const candidates = await proposeInstincts(harnessDir, undefined, apiKey);
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
