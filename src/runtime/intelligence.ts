import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { loadDirectoryWithErrors, loadDirectory } from '../primitives/loader.js';
import { buildDependencyGraph } from './graph.js';
import { getPrimitiveDirs } from '../core/types.js';
import type { HarnessConfig, HarnessDocument } from '../core/types.js';
import { loadConfig } from '../core/config.js';
import type { InstinctCandidate } from './instinct-learner.js';
import { installInstinct } from './instinct-learner.js';
import { log } from '../core/logger.js';
import { checkRateLimit } from './rate-limiter.js';
import { buildRateLimits } from './guardrails.js';
import { checkBudget } from './cost-tracker.js';
import { validateHarness } from './validator.js';

// --- Auto-Promote Instincts ---

export interface PatternOccurrence {
  behavior: string;
  journalDates: string[];
  count: number;
}

export interface AutoPromoteResult {
  patterns: PatternOccurrence[];
  promoted: string[];
  skipped: string[];
  journalsScanned: number;
}

/**
 * Scan all journals for instinct candidates that appear 3+ times.
 * These repeated patterns suggest strong behavioral signals worth auto-promoting.
 *
 * The function:
 * 1. Reads all journal files
 * 2. Extracts "## Instinct Candidates" sections
 * 3. Normalizes behavior text for fuzzy matching
 * 4. Groups by similar behavior (normalized string comparison)
 * 5. Returns patterns with 3+ occurrences across different journal dates
 * 6. Optionally auto-installs promoted instincts
 */
export function autoPromoteInstincts(
  harnessDir: string,
  options?: { threshold?: number; install?: boolean },
): AutoPromoteResult {
  const threshold = options?.threshold ?? 3;
  const journalDir = join(harnessDir, 'memory', 'journal');

  if (!existsSync(journalDir)) {
    return { patterns: [], promoted: [], skipped: [], journalsScanned: 0 };
  }

  const files = readdirSync(journalDir)
    .filter((f) => f.endsWith('.md') && /^\d{4}-\d{2}-\d{2}/.test(f))
    .sort();

  // Collect all instinct candidate behaviors with their journal dates
  const behaviorMap = new Map<string, { original: string; dates: Set<string> }>();

  for (const file of files) {
    const content = readFileSync(join(journalDir, file), 'utf-8');
    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;
    const journalDate = dateMatch[1];

    // Extract instinct candidates section
    const sectionMatch = content.match(/## Instinct Candidates\n([\s\S]*?)(?=\n## |\n*$)/);
    if (!sectionMatch) continue;

    const lines = sectionMatch[1]
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).trim().replace(/^INSTINCT:\s*/i, ''));

    for (const line of lines) {
      if (!line) continue;
      const normalized = normalizeBehavior(line);
      if (!normalized) continue;

      const existing = behaviorMap.get(normalized);
      if (existing) {
        existing.dates.add(journalDate);
      } else {
        behaviorMap.set(normalized, { original: line, dates: new Set([journalDate]) });
      }
    }
  }

  // Filter to patterns with threshold+ occurrences across different dates
  const patterns: PatternOccurrence[] = [];
  for (const [, value] of behaviorMap) {
    if (value.dates.size >= threshold) {
      patterns.push({
        behavior: value.original,
        journalDates: [...value.dates].sort(),
        count: value.dates.size,
      });
    }
  }

  // Sort by count descending
  patterns.sort((a, b) => b.count - a.count);

  // Deduplicate against existing instincts
  const existingIds = new Set<string>();
  const existingBehaviors = new Set<string>();
  const instinctsDir = join(harnessDir, 'instincts');
  if (existsSync(instinctsDir)) {
    const docs = loadDirectory(instinctsDir);
    for (const doc of docs) {
      existingIds.add(doc.id);
      if (doc.description) existingBehaviors.add(normalizeBehavior(doc.description));
    }
  }

  const promoted: string[] = [];
  const skipped: string[] = [];

  for (const pattern of patterns) {
    const normalized = normalizeBehavior(pattern.behavior);
    const id = behaviorToId(pattern.behavior);

    if (existingIds.has(id) || existingBehaviors.has(normalized)) {
      skipped.push(id);
      continue;
    }

    if (options?.install) {
      const candidate: InstinctCandidate = {
        id,
        behavior: pattern.behavior,
        provenance: `auto-promote:${pattern.journalDates.length}x across ${pattern.journalDates[0]} to ${pattern.journalDates[pattern.journalDates.length - 1]}`,
        confidence: Math.min(0.9, 0.5 + pattern.count * 0.1),
      };

      const path = installInstinct(harnessDir, candidate);
      if (path) {
        promoted.push(id);
      } else {
        skipped.push(id);
      }
    }
  }

  return { patterns, promoted, skipped, journalsScanned: files.length };
}

/**
 * Normalize behavior text for fuzzy matching.
 * Lowercases, strips punctuation, collapses whitespace.
 */
function normalizeBehavior(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Convert a behavior string to a kebab-case ID.
 */
function behaviorToId(behavior: string): string {
  return behavior
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 50)
    .replace(/-+$/, '');
}

// --- Dead Primitive Detection ---

export interface DeadPrimitive {
  id: string;
  path: string;
  directory: string;
  lastModified: string;
  daysSinceModified: number;
  reason: string;
}

export interface DeadPrimitiveResult {
  dead: DeadPrimitive[];
  totalScanned: number;
  thresholdDays: number;
}

/**
 * Detect "dead" primitives — files that are:
 * 1. Orphaned (no incoming or outgoing references via related:/with:)
 * 2. Not modified in the last N days (default 30)
 *
 * Excludes session and journal directories (memory files).
 * Does NOT flag recently created primitives even if orphaned.
 */
export function detectDeadPrimitives(
  harnessDir: string,
  config?: HarnessConfig,
  options?: { thresholdDays?: number },
): DeadPrimitiveResult {
  const thresholdDays = options?.thresholdDays ?? 30;
  const now = Date.now();

  // Build dependency graph to find orphans
  const graph = buildDependencyGraph(harnessDir, config);
  const orphanIds = new Set(graph.orphans);

  // Also find nodes with only broken refs (effectively orphaned)
  const connectedIds = new Set<string>();
  for (const edge of graph.edges) {
    connectedIds.add(edge.from);
    connectedIds.add(edge.to);
  }

  const dead: DeadPrimitive[] = [];
  let totalScanned = 0;

  for (const node of graph.nodes) {
    totalScanned++;

    // Skip non-orphans
    if (!orphanIds.has(node.id)) continue;

    // Check file modification time
    const absPath = join(harnessDir, node.path);
    if (!existsSync(absPath)) continue;

    try {
      const stat = statSync(absPath);
      const mtime = stat.mtime.getTime();
      const daysSince = Math.floor((now - mtime) / (24 * 60 * 60 * 1000));

      if (daysSince >= thresholdDays) {
        dead.push({
          id: node.id,
          path: node.path,
          directory: node.directory,
          lastModified: stat.mtime.toISOString().split('T')[0],
          daysSinceModified: daysSince,
          reason: `Orphaned (no references) and not modified in ${daysSince} days`,
        });
      }
    } catch (err) {
      log.warn(`Failed to stat ${absPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Sort by days since modified (most stale first)
  dead.sort((a, b) => b.daysSinceModified - a.daysSinceModified);

  return { dead, totalScanned, thresholdDays };
}

// --- Contradiction Detection ---

export interface Contradiction {
  primitiveA: { id: string; path: string; type: string; text: string };
  primitiveB: { id: string; path: string; type: string; text: string };
  reason: string;
  severity: 'low' | 'medium' | 'high';
}

export interface ContradictionResult {
  contradictions: Contradiction[];
  rulesChecked: number;
  instinctsChecked: number;
}

/**
 * Detect contradictions between rules and instincts.
 *
 * Checks for:
 * 1. Direct negation patterns ("always X" vs "never X", "do X" vs "don't X")
 * 2. Conflicting tag overlap with opposing behavioral signals
 * 3. Same topic with contradictory directives
 *
 * This is a heuristic-based detector (no LLM needed).
 * Returns candidate contradictions for human review.
 */
export function detectContradictions(
  harnessDir: string,
): ContradictionResult {
  const rulesDir = join(harnessDir, 'rules');
  const instinctsDir = join(harnessDir, 'instincts');

  const rules: HarnessDocument[] = existsSync(rulesDir) ? loadDirectory(rulesDir) : [];
  const instincts: HarnessDocument[] = existsSync(instinctsDir) ? loadDirectory(instinctsDir) : [];

  const contradictions: Contradiction[] = [];

  // Build a lookup of behavioral directives from each document
  const ruleDirectives = rules.map((doc) => ({
    doc,
    directives: extractDirectives(doc),
    topics: extractTopics(doc),
  }));

  const instinctDirectives = instincts.map((doc) => ({
    doc,
    directives: extractDirectives(doc),
    topics: extractTopics(doc),
  }));

  // Cross-check rules vs instincts
  for (const rule of ruleDirectives) {
    for (const instinct of instinctDirectives) {
      // Check directive negation patterns
      for (const rd of rule.directives) {
        for (const id of instinct.directives) {
          const negation = checkNegation(rd, id);
          if (negation) {
            contradictions.push({
              primitiveA: {
                id: rule.doc.id,
                path: relative(harnessDir, rule.doc.path),
                type: 'rule',
                text: rd.raw,
              },
              primitiveB: {
                id: instinct.doc.id,
                path: relative(harnessDir, instinct.doc.path),
                type: 'instinct',
                text: id.raw,
              },
              reason: negation,
              severity: 'high',
            });
          }
        }
      }

      // Check topic conflicts (same topic, opposing signals)
      const sharedTopics = rule.topics.filter((t) => instinct.topics.includes(t));
      if (sharedTopics.length > 0) {
        // Check if one says "always" and other says "never" about shared topic
        const ruleText = ((rule.doc.description ?? '') + ' ' + rule.doc.body).toLowerCase();
        const instinctText = ((instinct.doc.description ?? '') + ' ' + instinct.doc.body).toLowerCase();

        for (const topic of sharedTopics) {
          const ruleHasAlways = hasPositiveDirective(ruleText, topic);
          const instinctHasNever = hasNegativeDirective(instinctText, topic);
          const ruleHasNever = hasNegativeDirective(ruleText, topic);
          const instinctHasAlways = hasPositiveDirective(instinctText, topic);

          if ((ruleHasAlways && instinctHasNever) || (ruleHasNever && instinctHasAlways)) {
            // Avoid duplicate if already caught by directive check
            const alreadyCaught = contradictions.some(
              (c) =>
                c.primitiveA.id === rule.doc.id &&
                c.primitiveB.id === instinct.doc.id,
            );
            if (!alreadyCaught) {
              contradictions.push({
                primitiveA: {
                  id: rule.doc.id,
                  path: relative(harnessDir, rule.doc.path),
                  type: 'rule',
                  text: rule.doc.description ?? rule.doc.id,
                },
                primitiveB: {
                  id: instinct.doc.id,
                  path: relative(harnessDir, instinct.doc.path),
                  type: 'instinct',
                  text: instinct.doc.description ?? instinct.doc.id,
                },
                reason: `Conflicting directives about "${topic}"`,
                severity: 'medium',
              });
            }
          }
        }
      }
    }
  }

  // Also check rules vs rules and instincts vs instincts
  checkIntraGroupContradictions(ruleDirectives, 'rule', harnessDir, contradictions);
  checkIntraGroupContradictions(instinctDirectives, 'instinct', harnessDir, contradictions);

  return {
    contradictions,
    rulesChecked: rules.length,
    instinctsChecked: instincts.length,
  };
}

interface Directive {
  action: 'positive' | 'negative';
  verb: string;
  subject: string;
  raw: string;
}

/**
 * Extract behavioral directives from a document.
 * Looks for patterns like "always X", "never Y", "do X", "don't Y", "avoid X", "prefer Y".
 */
function extractDirectives(doc: HarnessDocument): Directive[] {
  const directives: Directive[] = [];
  const text = ((doc.description ?? '') + '\n' + doc.body).trim();

  // Process line by line
  for (const line of text.split('\n')) {
    const trimmed = line.trim().toLowerCase();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Strip list markers
    const cleaned = trimmed.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '');

    // Positive patterns
    const positiveMatch = cleaned.match(
      /^(always|must|should|prefer|ensure|require|use)\s+(.+)/,
    );
    if (positiveMatch) {
      directives.push({
        action: 'positive',
        verb: positiveMatch[1],
        subject: positiveMatch[2].replace(/[.!]$/, ''),
        raw: cleaned,
      });
      continue;
    }

    // Negative patterns
    const negativeMatch = cleaned.match(
      /^(never|don'?t|avoid|do not|must not|should not|shouldn'?t)\s+(.+)/,
    );
    if (negativeMatch) {
      directives.push({
        action: 'negative',
        verb: negativeMatch[1],
        subject: negativeMatch[2].replace(/[.!]$/, ''),
        raw: cleaned,
      });
    }
  }

  return directives;
}

/**
 * Extract topic keywords from a document (from tags, ID, and L0).
 */
function extractTopics(doc: HarnessDocument): string[] {
  const topics: string[] = [];

  // Tags as topics
  for (const tag of doc.tags) {
    topics.push(tag.toLowerCase());
  }

  // ID words as topics
  const idParts = doc.id.split('-').filter((p) => p.length > 2);
  topics.push(...idParts.map((p) => p.toLowerCase()));

  return [...new Set(topics)];
}

/**
 * Check if two directives are negations of each other.
 */
function checkNegation(a: Directive, b: Directive): string | null {
  // One positive, one negative
  if (a.action === b.action) return null;

  // Normalize subjects for comparison
  const subA = a.subject.toLowerCase().replace(/\s+/g, ' ').trim();
  const subB = b.subject.toLowerCase().replace(/\s+/g, ' ').trim();

  // Direct subject match
  if (subA === subB) {
    return `Direct contradiction: "${a.raw}" vs "${b.raw}"`;
  }

  // Fuzzy match: check if one subject is a substring of the other (with word boundaries)
  const wordsA = subA.split(' ').filter((w) => w.length > 3);
  const wordsB = subB.split(' ').filter((w) => w.length > 3);
  const overlap = wordsA.filter((w) => wordsB.includes(w));

  if (overlap.length >= 2 && overlap.length >= Math.min(wordsA.length, wordsB.length) * 0.6) {
    return `Likely contradiction (shared terms: ${overlap.join(', ')}): "${a.raw}" vs "${b.raw}"`;
  }

  return null;
}

function hasPositiveDirective(text: string, topic: string): boolean {
  const patterns = [
    new RegExp(`always\\s+\\w*${topic}`, 'i'),
    new RegExp(`must\\s+\\w*${topic}`, 'i'),
    new RegExp(`should\\s+\\w*${topic}`, 'i'),
    new RegExp(`prefer\\s+\\w*${topic}`, 'i'),
    new RegExp(`use\\s+\\w*${topic}`, 'i'),
  ];
  return patterns.some((p) => p.test(text));
}

function hasNegativeDirective(text: string, topic: string): boolean {
  const patterns = [
    new RegExp(`never\\s+\\w*${topic}`, 'i'),
    new RegExp(`avoid\\s+\\w*${topic}`, 'i'),
    new RegExp(`don'?t\\s+\\w*${topic}`, 'i'),
    new RegExp(`do not\\s+\\w*${topic}`, 'i'),
  ];
  return patterns.some((p) => p.test(text));
}

function checkIntraGroupContradictions(
  group: Array<{ doc: HarnessDocument; directives: Directive[]; topics: string[] }>,
  type: string,
  harnessDir: string,
  contradictions: Contradiction[],
): void {
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const a = group[i];
      const b = group[j];

      for (const da of a.directives) {
        for (const db of b.directives) {
          const negation = checkNegation(da, db);
          if (negation) {
            contradictions.push({
              primitiveA: {
                id: a.doc.id,
                path: relative(harnessDir, a.doc.path),
                type,
                text: da.raw,
              },
              primitiveB: {
                id: b.doc.id,
                path: relative(harnessDir, b.doc.path),
                type,
                text: db.raw,
              },
              reason: negation,
              severity: 'medium',
            });
          }
        }
      }
    }
  }
}

// --- Session Enrichment ---

export interface SessionEnrichment {
  sessionId: string;
  topics: string[];
  tokenCount: number;
  stepCount: number;
  model: string;
  toolsUsed: string[];
  primitivesReferenced: string[];
  duration: string;
}

export interface EnrichmentResult {
  enriched: SessionEnrichment[];
  sessionsScanned: number;
}

/**
 * Enrich sessions with extracted metadata.
 *
 * Scans session files and extracts:
 * - Topics (from prompt text, frequent nouns, matched primitive IDs)
 * - Token/step counts (from frontmatter or markdown body)
 * - Model used
 * - Tools used (from tool call sections)
 * - Referenced primitives (IDs mentioned in session text)
 * - Duration
 */
export function enrichSessions(
  harnessDir: string,
  config?: HarnessConfig,
  options?: { from?: string; to?: string },
): EnrichmentResult {
  const sessionsDir = join(harnessDir, 'memory', 'sessions');
  if (!existsSync(sessionsDir)) {
    return { enriched: [], sessionsScanned: 0 };
  }

  // Load all primitive IDs for cross-reference
  const primitiveIds = new Set<string>();
  const dirs = getPrimitiveDirs(config);
  for (const dir of dirs) {
    const fullPath = join(harnessDir, dir);
    if (!existsSync(fullPath)) continue;
    const { docs } = loadDirectoryWithErrors(fullPath);
    for (const doc of docs) {
      primitiveIds.add(doc.id);
    }
  }

  const files = readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.') && !f.startsWith('_'))
    .sort();

  // Filter by date range
  const filtered = files.filter((f) => {
    if (!options?.from && !options?.to) return true;
    const dateMatch = f.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) return false;
    const d = dateMatch[1];
    if (options?.from && d < options.from) return false;
    if (options?.to && d > options.to) return false;
    return true;
  });

  const enriched: SessionEnrichment[] = [];

  for (const file of filtered) {
    const content = readFileSync(join(sessionsDir, file), 'utf-8');
    const sessionId = file.replace(/\.md$/, '');

    const enrichment = enrichSession(content, sessionId, primitiveIds);
    enriched.push(enrichment);
  }

  return { enriched, sessionsScanned: filtered.length };
}

function enrichSession(
  content: string,
  sessionId: string,
  primitiveIds: Set<string>,
): SessionEnrichment {
  // Extract metadata from frontmatter/body
  const tokensMatch = content.match(/[Tt]okens?[:\s]+(\d[\d,]*)/);
  const tokenCount = tokensMatch ? parseInt(tokensMatch[1].replace(/,/g, ''), 10) : 0;

  const stepsMatch = content.match(/[Ss]teps?[:\s]+(\d+)/);
  const stepCount = stepsMatch ? parseInt(stepsMatch[1], 10) : 0;

  const modelMatch = content.match(/[Mm]odel[:\s]+([^\n]+)/);
  const model = modelMatch ? modelMatch[1].trim() : 'unknown';

  const durationMatch = content.match(/[Dd]uration[:\s]+([^\n]+)/);
  const duration = durationMatch ? durationMatch[1].trim() : '';

  // Extract tools used from tool call sections
  const toolsUsed: string[] = [];
  const toolMatches = content.matchAll(/### Tool(?:\s+Call)?:\s*(\S+)/g);
  for (const match of toolMatches) {
    const toolName = match[1];
    if (!toolsUsed.includes(toolName)) {
      toolsUsed.push(toolName);
    }
  }

  // Also check for tool_calls in frontmatter-style sections
  const toolCallMatches = content.matchAll(/toolName[:\s]+["']?(\S+)["']?/g);
  for (const match of toolCallMatches) {
    const toolName = match[1];
    if (!toolsUsed.includes(toolName)) {
      toolsUsed.push(toolName);
    }
  }

  // Find referenced primitives (any primitive ID that appears in text)
  const primitivesReferenced: string[] = [];
  for (const id of primitiveIds) {
    if (id.length < 3) continue; // Skip very short IDs to avoid false positives
    if (content.includes(id)) {
      primitivesReferenced.push(id);
    }
  }

  // Extract topics from prompt section
  const topics = extractSessionTopics(content);

  return {
    sessionId,
    topics,
    tokenCount,
    stepCount,
    model,
    toolsUsed,
    primitivesReferenced,
    duration,
  };
}

/**
 * Extract topic keywords from session content.
 * Uses a simple frequency-based approach on meaningful words.
 */
function extractSessionTopics(content: string): string[] {
  // Extract prompt section specifically
  const promptMatch = content.match(/## Prompt\n([\s\S]*?)(?=\n## |$)/);
  const promptText = promptMatch ? promptMatch[1] : '';

  // Also include summary
  const summaryMatch = content.match(/## Summary\n([\s\S]*?)(?=\n## |$)/);
  const summaryText = summaryMatch ? summaryMatch[1] : '';

  const text = (promptText + ' ' + summaryText).toLowerCase();

  // Common stop words to filter out
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'must', 'to', 'of',
    'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about',
    'like', 'through', 'after', 'before', 'between', 'under', 'during',
    'and', 'or', 'but', 'not', 'no', 'nor', 'so', 'yet', 'both', 'either',
    'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most', 'other',
    'some', 'such', 'than', 'too', 'very', 'just', 'also', 'this', 'that',
    'these', 'those', 'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you',
    'your', 'he', 'she', 'they', 'them', 'their', 'what', 'which', 'who',
    'when', 'where', 'how', 'why', 'if', 'then', 'else', 'while', 'up',
    'out', 'off', 'over', 'only', 'own', 'same', 'get', 'got', 'make',
    'made', 'use', 'used', 'using', 'one', 'two', 'new',
  ]);

  // Count word frequencies
  const words = text
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stopWords.has(w));

  const freq = new Map<string, number>();
  for (const word of words) {
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }

  // Return top 5 most frequent meaningful words
  return Array.from(freq.entries())
    .filter(([, count]) => count >= 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);
}

// --- Capability Suggestions ---

export interface CapabilitySuggestion {
  topic: string;
  frequency: number;
  sessionDates: string[];
  suggestion: string;
  suggestedType: 'skill' | 'playbook';
}

export interface CapabilitySuggestionResult {
  suggestions: CapabilitySuggestion[];
  topicsAnalyzed: number;
  sessionsScanned: number;
}

/**
 * Suggest capabilities (skills/playbooks) for frequent session topics
 * that don't have existing coverage.
 *
 * Scans sessions for recurring topics, cross-references against existing
 * skills/playbooks, and suggests new ones for uncovered topics.
 */
export function suggestCapabilities(
  harnessDir: string,
  config?: HarnessConfig,
  options?: { minFrequency?: number },
): CapabilitySuggestionResult {
  const minFrequency = options?.minFrequency ?? 3;

  // Enrich sessions to get topics
  const { enriched, sessionsScanned } = enrichSessions(harnessDir, config);

  // Collect topic frequency across sessions
  const topicOccurrences = new Map<string, Set<string>>();
  for (const session of enriched) {
    const dateMatch = session.sessionId.match(/^(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch ? dateMatch[1] : session.sessionId;

    for (const topic of session.topics) {
      if (!topicOccurrences.has(topic)) {
        topicOccurrences.set(topic, new Set());
      }
      topicOccurrences.get(topic)!.add(date);
    }
  }

  // Load existing skills and playbooks
  const coveredTopics = new Set<string>();
  const skillsDir = join(harnessDir, 'skills');
  const playbooksDir = join(harnessDir, 'playbooks');

  for (const dir of [skillsDir, playbooksDir]) {
    if (!existsSync(dir)) continue;
    const docs = loadDirectory(dir);
    for (const doc of docs) {
      // Add ID parts as covered topics
      for (const part of doc.id.split('-')) {
        if (part.length > 2) coveredTopics.add(part.toLowerCase());
      }
      // Add tags as covered topics
      for (const tag of doc.tags) {
        coveredTopics.add(tag.toLowerCase());
      }
    }
  }

  // Find frequent uncovered topics
  const suggestions: CapabilitySuggestion[] = [];

  for (const [topic, dates] of topicOccurrences) {
    if (dates.size < minFrequency) continue;
    if (coveredTopics.has(topic)) continue;

    const suggestedType = dates.size >= 5 ? 'playbook' : 'skill';
    suggestions.push({
      topic,
      frequency: dates.size,
      sessionDates: [...dates].sort(),
      suggestion: `Create a ${suggestedType} for "${topic}" — appeared in ${dates.size} session(s)`,
      suggestedType,
    });
  }

  // Sort by frequency
  suggestions.sort((a, b) => b.frequency - a.frequency);

  return {
    suggestions,
    topicsAnalyzed: topicOccurrences.size,
    sessionsScanned,
  };
}

// --- Failure Taxonomy ---

/**
 * Named failure modes with recovery strategies.
 * Based on common agent failure patterns (context overflow, tool errors,
 * budget exhaustion, hallucination, stale primitives, circular delegation).
 */
export type FailureMode =
  | 'context_overflow'
  | 'tool_execution_error'
  | 'budget_exhausted'
  | 'rate_limited'
  | 'llm_timeout'
  | 'llm_error'
  | 'hallucination_detected'
  | 'stale_primitive'
  | 'circular_delegation'
  | 'missing_dependency'
  | 'parse_error'
  | 'config_invalid'
  | 'mcp_connection_failed'
  | 'state_corruption'
  | 'unknown';

export interface FailureRecord {
  mode: FailureMode;
  timestamp: string;
  sessionId?: string;
  message: string;
  context?: Record<string, unknown>;
  recoveryAttempted?: string;
  recovered: boolean;
}

export interface FailureTaxonomy {
  modes: Record<FailureMode, {
    description: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    recoveryStrategies: string[];
    autoRecoverable: boolean;
  }>;
}

/**
 * The canonical failure taxonomy for agent-harness.
 * Each mode has a description, severity level, recovery strategies,
 * and whether automatic recovery is possible.
 */
export const FAILURE_TAXONOMY: FailureTaxonomy = {
  modes: {
    context_overflow: {
      description: 'System prompt + conversation exceeds model context window',
      severity: 'high',
      recoveryStrategies: [
        'Trim oldest messages from conversation history',
        'Reduce primitive loading level (L2 → L1 → L0)',
        'Archive old sessions to free memory budget',
        'Split into sub-conversations with summarized context',
      ],
      autoRecoverable: true,
    },
    tool_execution_error: {
      description: 'An MCP or HTTP tool call failed during execution',
      severity: 'medium',
      recoveryStrategies: [
        'Retry with exponential backoff',
        'Fall back to alternative tool if available',
        'Report error to LLM and ask for alternative approach',
        'Skip tool and proceed with available context',
      ],
      autoRecoverable: true,
    },
    budget_exhausted: {
      description: 'Daily or monthly spending limit has been reached',
      severity: 'critical',
      recoveryStrategies: [
        'Wait until next budget period',
        'Switch to cheaper model (fast_model or summary_model)',
        'Queue non-urgent tasks for later execution',
        'Alert operator to increase budget',
      ],
      autoRecoverable: false,
    },
    rate_limited: {
      description: 'LLM API rate limit hit (per-minute/hour/day)',
      severity: 'medium',
      recoveryStrategies: [
        'Wait for retryAfterMs from rate limiter',
        'Reduce request frequency',
        'Queue and batch requests',
      ],
      autoRecoverable: true,
    },
    llm_timeout: {
      description: 'LLM API call timed out without response',
      severity: 'medium',
      recoveryStrategies: [
        'Retry with same prompt',
        'Retry with shorter prompt (reduce context)',
        'Switch to faster model',
        'Increase timeout_ms in config',
      ],
      autoRecoverable: true,
    },
    llm_error: {
      description: 'LLM API returned an error response (4xx/5xx)',
      severity: 'high',
      recoveryStrategies: [
        'Retry with exponential backoff (max_retries in config)',
        'Switch to fallback model',
        'Check API key validity',
        'Log error details for debugging',
      ],
      autoRecoverable: true,
    },
    hallucination_detected: {
      description: 'LLM output contains fabricated facts or references to non-existent primitives',
      severity: 'medium',
      recoveryStrategies: [
        'Re-prompt with explicit grounding: "Only reference primitives that exist"',
        'Validate output against known primitive IDs',
        'Add validation step before acting on LLM output',
        'Record in journal for future training',
      ],
      autoRecoverable: false,
    },
    stale_primitive: {
      description: 'A referenced primitive is outdated, deprecated, or orphaned',
      severity: 'low',
      recoveryStrategies: [
        'Run detectDeadPrimitives() to identify stale files',
        'Archive deprecated primitives',
        'Update references to point to current versions',
        'Auto-flag via validator',
      ],
      autoRecoverable: true,
    },
    circular_delegation: {
      description: 'Agent delegation loop detected (A delegates to B delegates to A)',
      severity: 'high',
      recoveryStrategies: [
        'Track delegation chain and break on cycle detection',
        'Set max delegation depth (default: 3)',
        'Return partial result from last agent in chain',
        'Log delegation graph for debugging',
      ],
      autoRecoverable: true,
    },
    missing_dependency: {
      description: 'A required dependency (primitive, MCP server, API key) is missing',
      severity: 'high',
      recoveryStrategies: [
        'Run doctorHarness() to auto-fix missing files',
        'Check .env for required API keys',
        'Install missing MCP servers',
        'Prompt user to install missing bundle',
      ],
      autoRecoverable: false,
    },
    parse_error: {
      description: 'A primitive file has invalid YAML frontmatter or malformed content',
      severity: 'medium',
      recoveryStrategies: [
        'Run fixCapability() to auto-repair frontmatter',
        'Skip the malformed file and log a warning',
        'Use default frontmatter values',
        'Report to user for manual fix',
      ],
      autoRecoverable: true,
    },
    config_invalid: {
      description: 'config.yaml fails schema validation',
      severity: 'critical',
      recoveryStrategies: [
        'Fall back to CONFIG_DEFAULTS',
        'Report specific validation errors to user',
        'Run harness doctor to attempt repair',
      ],
      autoRecoverable: false,
    },
    mcp_connection_failed: {
      description: 'Failed to connect to an MCP server (process spawn or HTTP)',
      severity: 'medium',
      recoveryStrategies: [
        'Retry connection with backoff',
        'Disable the server and continue without its tools',
        'Check command/URL/env configuration',
        'Fall back to built-in tools only',
      ],
      autoRecoverable: true,
    },
    state_corruption: {
      description: 'state.md is unreadable or contains invalid data',
      severity: 'high',
      recoveryStrategies: [
        'Fall back to DEFAULT_STATE',
        'Rebuild state from session history',
        'Reset state.md and log the event',
      ],
      autoRecoverable: true,
    },
    unknown: {
      description: 'An unclassified error occurred',
      severity: 'high',
      recoveryStrategies: [
        'Log full error with stack trace',
        'Record in health.json failure counter',
        'Alert operator',
        'Graceful shutdown if critical path',
      ],
      autoRecoverable: false,
    },
  },
};

export interface FailureAnalysis {
  recentFailures: FailureRecord[];
  modeFrequency: Record<string, number>;
  mostCommonMode: FailureMode | null;
  suggestedRecovery: string[];
  healthImplication: 'healthy' | 'degraded' | 'unhealthy';
}

/**
 * Classify an error into a failure mode.
 */
export function classifyFailure(error: Error | string, context?: Record<string, unknown>): FailureMode {
  const msg = typeof error === 'string' ? error.toLowerCase() : error.message.toLowerCase();

  if (msg.includes('context') && (msg.includes('overflow') || msg.includes('too long') || msg.includes('exceed'))) {
    return 'context_overflow';
  }
  if (msg.includes('tool') && (msg.includes('fail') || msg.includes('error') || msg.includes('timeout'))) {
    return 'tool_execution_error';
  }
  if (msg.includes('budget') || msg.includes('spending') || msg.includes('limit exceeded')) {
    return 'budget_exhausted';
  }
  if (msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests')) {
    return 'rate_limited';
  }
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('ETIMEDOUT')) {
    return 'llm_timeout';
  }
  if (msg.includes('mcp') && (msg.includes('connect') || msg.includes('spawn') || msg.includes('failed'))) {
    return 'mcp_connection_failed';
  }
  if (msg.includes('parse') || msg.includes('yaml') || msg.includes('frontmatter') || msg.includes('malformed')) {
    return 'parse_error';
  }
  if (msg.includes('config') && (msg.includes('invalid') || msg.includes('validation'))) {
    return 'config_invalid';
  }
  if (msg.includes('state') && (msg.includes('corrupt') || msg.includes('invalid') || msg.includes('unreadable'))) {
    return 'state_corruption';
  }
  if (msg.includes('circular') || msg.includes('delegation loop') || msg.includes('cycle')) {
    return 'circular_delegation';
  }
  if (msg.includes('missing') || msg.includes('not found') || msg.includes('dependency')) {
    return 'missing_dependency';
  }
  if (msg.includes('401') || msg.includes('403') || msg.includes('500') || msg.includes('502') || msg.includes('503')) {
    return 'llm_error';
  }

  return 'unknown';
}

/**
 * Get recovery strategies for a failure mode.
 */
export function getRecoveryStrategies(mode: FailureMode): string[] {
  return FAILURE_TAXONOMY.modes[mode]?.recoveryStrategies ?? ['Log error and alert operator'];
}

/**
 * Analyze failure patterns from session history and health data.
 * Returns frequency analysis and recovery suggestions.
 */
export function analyzeFailures(
  harnessDir: string,
  options?: { days?: number },
): FailureAnalysis {
  const days = options?.days ?? 7;
  const now = Date.now();
  const cutoffMs = days * 24 * 60 * 60 * 1000;

  const recentFailures: FailureRecord[] = [];

  // Scan health.json for failures
  const healthPath = join(harnessDir, 'memory', 'health.json');
  if (existsSync(healthPath)) {
    try {
      const health = JSON.parse(readFileSync(healthPath, 'utf-8'));
      if (health.lastError) {
        const mode = classifyFailure(health.lastError);
        recentFailures.push({
          mode,
          timestamp: health.lastFailure || new Date().toISOString(),
          message: health.lastError,
          recovered: health.consecutiveFailures === 0,
        });
      }
    } catch {
      // Malformed health.json
    }
  }

  // Scan sessions for error indicators
  const sessionsDir = join(harnessDir, 'memory', 'sessions');
  if (existsSync(sessionsDir)) {
    const files = readdirSync(sessionsDir)
      .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
      .sort()
      .reverse();

    for (const file of files) {
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        const fileDate = new Date(dateMatch[1]).getTime();
        if (now - fileDate > cutoffMs) break;
      }

      try {
        const content = readFileSync(join(sessionsDir, file), 'utf-8');
        // Look for error patterns in session content
        const errorLines = content.split('\n').filter((l) =>
          l.toLowerCase().includes('error') ||
          l.toLowerCase().includes('failed') ||
          l.toLowerCase().includes('timeout'),
        );

        for (const line of errorLines.slice(0, 3)) {
          const mode = classifyFailure(line);
          if (mode !== 'unknown') {
            recentFailures.push({
              mode,
              timestamp: dateMatch?.[1] ?? 'unknown',
              sessionId: file.replace('.md', ''),
              message: line.trim().slice(0, 200),
              recovered: true,
            });
          }
        }
      } catch {
        // Skip unreadable sessions
      }
    }
  }

  // Calculate frequency
  const modeFrequency: Record<string, number> = {};
  for (const f of recentFailures) {
    modeFrequency[f.mode] = (modeFrequency[f.mode] ?? 0) + 1;
  }

  // Find most common mode
  let mostCommonMode: FailureMode | null = null;
  let maxFreq = 0;
  for (const [mode, count] of Object.entries(modeFrequency)) {
    if (count > maxFreq) {
      maxFreq = count;
      mostCommonMode = mode as FailureMode;
    }
  }

  // Suggest recovery
  const suggestedRecovery = mostCommonMode
    ? getRecoveryStrategies(mostCommonMode)
    : [];

  // Determine health implication
  let healthImplication: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
  if (recentFailures.length > 5) {
    healthImplication = 'unhealthy';
  } else if (recentFailures.length > 0) {
    healthImplication = 'degraded';
  }

  return {
    recentFailures: recentFailures.slice(0, 20),
    modeFrequency,
    mostCommonMode,
    suggestedRecovery,
    healthImplication,
  };
}

// --- Verification Gates ---

export type GateStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface GateCheck {
  name: string;
  description: string;
  status: GateStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface VerificationGateResult {
  gateName: string;
  passed: boolean;
  checks: GateCheck[];
  summary: string;
}

export type GateDefinition = {
  name: string;
  description: string;
  check: (harnessDir: string, config?: HarnessConfig) => GateCheck[];
};

/**
 * Built-in verification gates for the harness.
 * Each gate is a set of checks that must pass at a specific stage.
 */
export const BUILTIN_GATES: GateDefinition[] = [
  {
    name: 'pre-boot',
    description: 'Checks before agent boot: config valid, IDENTITY.md exists, API key available',
    check: (harnessDir: string) => {
      const checks: GateCheck[] = [];

      // IDENTITY.md exists (falls back to legacy CORE.md)
      const hasIdentity = existsSync(join(harnessDir, 'IDENTITY.md')) || existsSync(join(harnessDir, 'CORE.md'));
      checks.push(hasIdentity
        ? { name: 'core-md', description: 'IDENTITY.md exists', status: 'pass', message: 'IDENTITY.md present' }
        : { name: 'core-md', description: 'IDENTITY.md exists', status: 'fail', message: 'Missing IDENTITY.md — required for agent identity' });

      // Config valid
      try {
        loadConfig(harnessDir);
        checks.push({ name: 'config-valid', description: 'config.yaml valid', status: 'pass', message: 'Config parsed successfully' });
      } catch (err) {
        checks.push({ name: 'config-valid', description: 'config.yaml valid', status: 'fail', message: `Config error: ${err instanceof Error ? err.message : String(err)}` });
      }

      // API key available
      const hasKey = !!(process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);
      checks.push(hasKey
        ? { name: 'api-key', description: 'API key available', status: 'pass', message: 'API key found in environment' }
        : { name: 'api-key', description: 'API key available', status: 'warn', message: 'No API key in environment — will need --api-key flag' });

      // Memory directory
      const memDir = join(harnessDir, 'memory');
      checks.push(existsSync(memDir)
        ? { name: 'memory-dir', description: 'Memory directory exists', status: 'pass', message: 'memory/ directory present' }
        : { name: 'memory-dir', description: 'Memory directory exists', status: 'warn', message: 'memory/ directory missing — will be created on first run' });

      return checks;
    },
  },
  {
    name: 'pre-run',
    description: 'Checks before each LLM call: budget, rate limits, context budget',
    check: (harnessDir: string) => {
      const checks: GateCheck[] = [];

      let config: HarnessConfig;
      try {
        config = loadConfig(harnessDir);
      } catch {
        checks.push({ name: 'config-load', description: 'Config loadable', status: 'fail', message: 'Cannot load config' });
        return checks;
      }

      // Budget check
      try {
        const budgetStatus = checkBudget(harnessDir, config.budget);
        const exceeded = (budgetStatus.daily_remaining_usd !== null && budgetStatus.daily_remaining_usd <= 0) ||
          (budgetStatus.monthly_remaining_usd !== null && budgetStatus.monthly_remaining_usd <= 0);
        if (exceeded) {
          checks.push({ name: 'budget', description: 'Budget not exceeded', status: 'fail', message: 'Budget limit exceeded', details: { ...budgetStatus } });
        } else {
          checks.push({ name: 'budget', description: 'Budget not exceeded', status: 'pass', message: 'Within budget' });
        }
      } catch (err) {
        checks.push({ name: 'budget', description: 'Budget not exceeded', status: 'skip', message: `Budget check unavailable: ${err instanceof Error ? err.message : String(err)}` });
      }

      // Rate limit check
      try {
        const limits = buildRateLimits(config);
        if (limits.length === 0) {
          checks.push({ name: 'rate-limit', description: 'Rate limit not hit', status: 'pass', message: 'No rate limits configured' });
        } else {
          let blocked = false;
          for (const limit of limits) {
            const rateCheck = checkRateLimit(harnessDir, limit);
            if (!rateCheck.allowed) {
              const windowLabel = limit.window_ms <= 60_000 ? 'minute' : limit.window_ms <= 3_600_000 ? 'hour' : 'day';
              checks.push({ name: 'rate-limit', description: 'Rate limit not hit', status: 'fail', message: `Rate limited (${windowLabel}): ${rateCheck.current}/${rateCheck.max}. Retry after ${Math.ceil(rateCheck.retry_after_ms / 1000)}s` });
              blocked = true;
              break;
            }
          }
          if (!blocked) {
            checks.push({ name: 'rate-limit', description: 'Rate limit not hit', status: 'pass', message: 'Within rate limits' });
          }
        }
      } catch (err) {
        checks.push({ name: 'rate-limit', description: 'Rate limit not hit', status: 'skip', message: `Rate limit check unavailable: ${err instanceof Error ? err.message : String(err)}` });
      }

      // Health check
      const healthPath = join(harnessDir, 'memory', 'health.json');
      if (existsSync(healthPath)) {
        try {
          const health = JSON.parse(readFileSync(healthPath, 'utf-8'));
          if (health.consecutiveFailures >= 3) {
            checks.push({ name: 'health', description: 'Agent healthy', status: 'warn', message: `${health.consecutiveFailures} consecutive failures detected` });
          } else {
            checks.push({ name: 'health', description: 'Agent healthy', status: 'pass', message: 'No recent failure pattern' });
          }
        } catch {
          checks.push({ name: 'health', description: 'Agent healthy', status: 'skip', message: 'Health data unavailable' });
        }
      }

      return checks;
    },
  },
  {
    name: 'post-session',
    description: 'Checks after a session: session recorded, no parse errors, primitives intact',
    check: (harnessDir: string) => {
      const checks: GateCheck[] = [];

      // Sessions directory exists and has files
      const sessionsDir = join(harnessDir, 'memory', 'sessions');
      if (existsSync(sessionsDir)) {
        const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.md') && !f.startsWith('.'));
        checks.push({
          name: 'sessions-recorded',
          description: 'Sessions being recorded',
          status: files.length > 0 ? 'pass' : 'warn',
          message: `${files.length} session file(s) in memory`,
        });
      } else {
        checks.push({ name: 'sessions-recorded', description: 'Sessions being recorded', status: 'warn', message: 'No sessions directory' });
      }

      // Check for parse errors in primitives
      const dirs = getPrimitiveDirs();
      let totalParseErrors = 0;
      for (const dir of dirs) {
        const fullPath = join(harnessDir, dir);
        if (!existsSync(fullPath)) continue;
        const { errors } = loadDirectoryWithErrors(fullPath);
        totalParseErrors += errors.length;
      }

      checks.push(totalParseErrors === 0
        ? { name: 'parse-errors', description: 'No primitive parse errors', status: 'pass', message: 'All primitives parse cleanly' }
        : { name: 'parse-errors', description: 'No primitive parse errors', status: 'warn', message: `${totalParseErrors} parse error(s) in primitives` });

      return checks;
    },
  },
  {
    name: 'pre-deploy',
    description: 'Checks before deployment: validator passes, no dead primitives, no contradictions',
    check: (harnessDir: string, config?: HarnessConfig) => {
      const checks: GateCheck[] = [];

      // Run validator
      try {
        const validation = validateHarness(harnessDir);
        if (validation.errors.length > 0) {
          checks.push({ name: 'validator', description: 'Validator passes', status: 'fail', message: `${validation.errors.length} error(s)`, details: { errors: validation.errors } });
        } else if (validation.warnings.length > 0) {
          checks.push({ name: 'validator', description: 'Validator passes', status: 'warn', message: `${validation.warnings.length} warning(s)` });
        } else {
          checks.push({ name: 'validator', description: 'Validator passes', status: 'pass', message: 'Validation clean' });
        }
      } catch (err) {
        checks.push({ name: 'validator', description: 'Validator passes', status: 'fail', message: `Validator error: ${err instanceof Error ? err.message : String(err)}` });
      }

      // Check for dead primitives
      const deadResult = detectDeadPrimitives(harnessDir, config);
      checks.push(deadResult.dead.length === 0
        ? { name: 'dead-primitives', description: 'No dead primitives', status: 'pass', message: 'All primitives referenced or recently modified' }
        : { name: 'dead-primitives', description: 'No dead primitives', status: 'warn', message: `${deadResult.dead.length} dead primitive(s) found`, details: { dead: deadResult.dead.map((d) => d.id) } });

      // Check for contradictions
      const contradictionResult = detectContradictions(harnessDir);
      checks.push(contradictionResult.contradictions.length === 0
        ? { name: 'contradictions', description: 'No contradictions', status: 'pass', message: 'No conflicting rules/instincts' }
        : { name: 'contradictions', description: 'No contradictions', status: 'warn', message: `${contradictionResult.contradictions.length} potential contradiction(s)` });

      return checks;
    },
  },
];

/**
 * Run a verification gate by name.
 * Returns all check results and an overall pass/fail status.
 */
export function runGate(
  gateName: string,
  harnessDir: string,
  config?: HarnessConfig,
): VerificationGateResult {
  const gate = BUILTIN_GATES.find((g) => g.name === gateName);
  if (!gate) {
    return {
      gateName,
      passed: false,
      checks: [{ name: 'gate-not-found', description: 'Gate exists', status: 'fail', message: `Unknown gate: ${gateName}` }],
      summary: `Gate "${gateName}" not found. Available: ${BUILTIN_GATES.map((g) => g.name).join(', ')}`,
    };
  }

  const checks = gate.check(harnessDir, config);
  const hasFails = checks.some((c) => c.status === 'fail');

  const passed = !hasFails;
  const passCount = checks.filter((c) => c.status === 'pass').length;
  const failCount = checks.filter((c) => c.status === 'fail').length;
  const warnCount = checks.filter((c) => c.status === 'warn').length;

  let summary = `${gate.name}: ${passCount} passed`;
  if (failCount > 0) summary += `, ${failCount} failed`;
  if (warnCount > 0) summary += `, ${warnCount} warnings`;

  return { gateName, passed, checks, summary };
}

/**
 * Run all built-in verification gates.
 */
export function runAllGates(
  harnessDir: string,
  config?: HarnessConfig,
): VerificationGateResult[] {
  return BUILTIN_GATES.map((gate) => runGate(gate.name, harnessDir, config));
}

/**
 * List available gate names and descriptions.
 */
export function listGates(): Array<{ name: string; description: string }> {
  return BUILTIN_GATES.map((g) => ({ name: g.name, description: g.description }));
}
