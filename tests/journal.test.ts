import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseJournalSynthesis, compressJournals } from '../src/runtime/journal.js';
import { harvestInstincts } from '../src/runtime/instinct-learner.js';

describe('parseJournalSynthesis', () => {
  it('should parse a well-formed synthesis response', () => {
    const text = `## Summary
Today the agent focused on code review and testing improvements.

## Insights
- Code review patterns emerging around error handling
- Testing coverage is increasing consistently

## Instinct Candidates
- INSTINCT: Always check error types before logging
- INSTINCT: Run tests before committing changes

## Knowledge Updates
- The project uses vitest, not jest
- Config schema requires max_retries field`;

    const result = parseJournalSynthesis(text);

    expect(result.summary).toContain('code review and testing improvements');
    expect(result.insights).toHaveLength(2);
    expect(result.insights[0]).toContain('error handling');
    expect(result.instinct_candidates).toHaveLength(2);
    expect(result.instinct_candidates[0]).toBe('Always check error types before logging');
    expect(result.instinct_candidates[1]).toBe('Run tests before committing changes');
    expect(result.knowledge_updates).toHaveLength(2);
    expect(result.knowledge_updates[0]).toContain('vitest');
  });

  it('should handle missing sections gracefully', () => {
    const text = `## Summary
Just a summary, no other sections.`;

    const result = parseJournalSynthesis(text);

    expect(result.summary).toContain('Just a summary');
    expect(result.insights).toEqual([]);
    expect(result.instinct_candidates).toEqual([]);
    expect(result.knowledge_updates).toEqual([]);
  });

  it('should handle completely empty text', () => {
    const result = parseJournalSynthesis('');

    expect(result.summary).toBe('');
    expect(result.insights).toEqual([]);
    expect(result.instinct_candidates).toEqual([]);
    expect(result.knowledge_updates).toEqual([]);
  });

  it('should strip INSTINCT: prefix from candidates', () => {
    const text = `## Instinct Candidates
- INSTINCT: Do thing one
- INSTINCT:  Do thing two with extra space
- Not an instinct, just a bullet`;

    const result = parseJournalSynthesis(text);

    expect(result.instinct_candidates).toHaveLength(3);
    expect(result.instinct_candidates[0]).toBe('Do thing one');
    expect(result.instinct_candidates[1]).toBe('Do thing two with extra space');
    expect(result.instinct_candidates[2]).toBe('Not an instinct, just a bullet');
  });

  it('should accept legacy "Patterns" section as insights', () => {
    const text = `## Summary
Summary text.

## Patterns
- Pattern one
- Pattern two`;

    const result = parseJournalSynthesis(text);

    expect(result.insights).toHaveLength(2);
    expect(result.insights[0]).toBe('Pattern one');
    expect(result.insights[1]).toBe('Pattern two');
  });

  it('should prefer Insights over Patterns if both exist', () => {
    const text = `## Summary
Summary.

## Insights
- Insight one

## Patterns
- Pattern one`;

    const result = parseJournalSynthesis(text);

    expect(result.insights).toHaveLength(1);
    expect(result.insights[0]).toBe('Insight one');
  });

  it('should ignore non-bullet lines in sections', () => {
    const text = `## Summary
This is the summary.

## Knowledge Updates
Some introductory text
- Actual bullet one
More text between
- Actual bullet two`;

    const result = parseJournalSynthesis(text);

    expect(result.knowledge_updates).toHaveLength(2);
    expect(result.knowledge_updates[0]).toBe('Actual bullet one');
  });
});

// --- compressJournals tests ---
const JOURNAL_TEST_DIR = join(__dirname, '__test_journal_compress__');

function writeJournal(date: string, content: string): void {
  const journalDir = join(JOURNAL_TEST_DIR, 'memory', 'journal');
  mkdirSync(journalDir, { recursive: true });
  writeFileSync(join(journalDir, `${date}.md`), content, 'utf-8');
}

function makeJournalContent(date: string, summary: string, insights: string[], instincts: string[]): string {
  const insightLines = insights.map((i) => `- ${i}`).join('\n');
  const instinctLines = instincts.map((i) => `- INSTINCT: ${i}`).join('\n');
  return `---\nid: journal-${date}\ntags: [journal, daily]\ncreated: ${date}\nauthor: infrastructure\nstatus: active\n---\n\n# Journal: ${date}\n\n## Summary\n${summary}\n\n## Insights\n${insightLines}\n\n## Instinct Candidates\n${instinctLines}\n\n## Knowledge Updates\n- Learned something on ${date}\n`;
}

describe('compressJournals', () => {
  beforeEach(() => {
    mkdirSync(JOURNAL_TEST_DIR, { recursive: true });
    writeFileSync(join(JOURNAL_TEST_DIR, 'CORE.md'), '# Core', 'utf-8');
    writeFileSync(
      join(JOURNAL_TEST_DIR, 'config.yaml'),
      `agent:\n  name: test\n  version: "0.1.0"\nmodel:\n  provider: openrouter\n  id: test-model\n  max_tokens: 200000\n`,
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(JOURNAL_TEST_DIR, { recursive: true, force: true });
  });

  it('should compress a complete past week into a weekly summary', () => {
    // Use a week well in the past: 2026-03-23 (Mon) to 2026-03-29 (Sun)
    writeJournal('2026-03-23', makeJournalContent('2026-03-23', 'Monday work', ['Insight A'], ['Be thorough']));
    writeJournal('2026-03-24', makeJournalContent('2026-03-24', 'Tuesday work', ['Insight B'], ['Check twice']));
    writeJournal('2026-03-25', makeJournalContent('2026-03-25', 'Wednesday work', ['Insight A'], ['Be thorough']));

    const results = compressJournals(JOURNAL_TEST_DIR);

    expect(results).toHaveLength(1);
    expect(results[0].weekStart).toBe('2026-03-23');
    expect(results[0].journalDates).toEqual(['2026-03-23', '2026-03-24', '2026-03-25']);
    // Deduplication: "Insight A" and "Be thorough" appear twice but should be unique
    expect(results[0].allInsights).toContain('Insight A');
    expect(results[0].allInsights).toContain('Insight B');
    expect(results[0].allInsights).toHaveLength(2);
    expect(results[0].allInstinctCandidates).toContain('Be thorough');
    expect(results[0].allInstinctCandidates).toContain('Check twice');
    expect(results[0].allInstinctCandidates).toHaveLength(2);

    // File should exist
    const weeklyDir = join(JOURNAL_TEST_DIR, 'memory', 'journal', 'weekly');
    expect(existsSync(join(weeklyDir, '2026-03-23.md'))).toBe(true);
  });

  it('should skip existing weekly summaries unless force=true', () => {
    writeJournal('2026-03-23', makeJournalContent('2026-03-23', 'Monday', [], []));

    const first = compressJournals(JOURNAL_TEST_DIR);
    expect(first).toHaveLength(1);

    const second = compressJournals(JOURNAL_TEST_DIR);
    expect(second).toHaveLength(0);

    const forced = compressJournals(JOURNAL_TEST_DIR, { force: true });
    expect(forced).toHaveLength(1);
  });

  it('should not compress the current week', () => {
    // Write a journal for today — should be skipped
    const today = new Date().toISOString().split('T')[0];
    writeJournal(today, makeJournalContent(today, 'Today', [], []));

    const results = compressJournals(JOURNAL_TEST_DIR);
    expect(results).toHaveLength(0);
  });

  it('should return empty when no journals exist', () => {
    const results = compressJournals(JOURNAL_TEST_DIR);
    expect(results).toHaveLength(0);
  });

  it('should handle multiple weeks', () => {
    // Week 1: 2026-03-16 to 2026-03-22
    writeJournal('2026-03-16', makeJournalContent('2026-03-16', 'Week 1', ['W1 insight'], []));
    // Week 2: 2026-03-23 to 2026-03-29
    writeJournal('2026-03-23', makeJournalContent('2026-03-23', 'Week 2', ['W2 insight'], []));

    const results = compressJournals(JOURNAL_TEST_DIR);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.weekStart).sort()).toEqual(['2026-03-16', '2026-03-23']);
  });
});

// --- harvestInstincts tests ---
const HARVEST_TEST_DIR = join(__dirname, '__test_harvest__');

describe('harvestInstincts', () => {
  beforeEach(() => {
    mkdirSync(HARVEST_TEST_DIR, { recursive: true });
    writeFileSync(join(HARVEST_TEST_DIR, 'CORE.md'), '# Core', 'utf-8');
    writeFileSync(
      join(HARVEST_TEST_DIR, 'config.yaml'),
      `agent:\n  name: test\n  version: "0.1.0"\nmodel:\n  provider: openrouter\n  id: test-model\n  max_tokens: 200000\n`,
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(HARVEST_TEST_DIR, { recursive: true, force: true });
  });

  it('should extract instinct candidates from journal files', () => {
    const journalDir = join(HARVEST_TEST_DIR, 'memory', 'journal');
    mkdirSync(journalDir, { recursive: true });
    writeFileSync(
      join(journalDir, '2026-03-20.md'),
      makeJournalContent('2026-03-20', 'Test day', [], ['Always validate input', 'Check types before casting']),
      'utf-8',
    );

    const result = harvestInstincts(HARVEST_TEST_DIR);
    expect(result.journalsScanned).toBe(1);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0].behavior).toBe('Always validate input');
    expect(result.candidates[1].behavior).toBe('Check types before casting');
    expect(result.candidates[0].provenance).toBe('journal:2026-03-20');
  });

  it('should deduplicate against existing instincts', () => {
    const journalDir = join(HARVEST_TEST_DIR, 'memory', 'journal');
    mkdirSync(journalDir, { recursive: true });
    writeFileSync(
      join(journalDir, '2026-03-20.md'),
      makeJournalContent('2026-03-20', 'Test', [], ['Always validate input', 'New behavior']),
      'utf-8',
    );

    // Create an existing instinct with the same id
    const instinctsDir = join(HARVEST_TEST_DIR, 'instincts');
    mkdirSync(instinctsDir, { recursive: true });
    writeFileSync(
      join(instinctsDir, 'always-validate-input.md'),
      `---\nid: always-validate-input\ntags: [instinct]\nstatus: active\n---\n<!-- L0: Always validate input -->\n# Instinct: Always Validate Input\n\nAlways validate input at boundaries.`,
      'utf-8',
    );

    const result = harvestInstincts(HARVEST_TEST_DIR);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].behavior).toBe('New behavior');
  });

  it('should filter by date range', () => {
    const journalDir = join(HARVEST_TEST_DIR, 'memory', 'journal');
    mkdirSync(journalDir, { recursive: true });
    writeFileSync(
      join(journalDir, '2026-03-15.md'),
      makeJournalContent('2026-03-15', 'Old', [], ['Old instinct']),
      'utf-8',
    );
    writeFileSync(
      join(journalDir, '2026-03-25.md'),
      makeJournalContent('2026-03-25', 'New', [], ['New instinct']),
      'utf-8',
    );

    const result = harvestInstincts(HARVEST_TEST_DIR, { from: '2026-03-20' });
    expect(result.journalsScanned).toBe(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].behavior).toBe('New instinct');
  });

  it('should install candidates when install=true', () => {
    const journalDir = join(HARVEST_TEST_DIR, 'memory', 'journal');
    mkdirSync(journalDir, { recursive: true });
    writeFileSync(
      join(journalDir, '2026-03-20.md'),
      makeJournalContent('2026-03-20', 'Test', [], ['Run tests first']),
      'utf-8',
    );

    const result = harvestInstincts(HARVEST_TEST_DIR, { install: true });
    expect(result.candidates).toHaveLength(1);
    expect(result.installed).toHaveLength(1);
    expect(result.installed[0]).toBe('run-tests-first');

    // Verify file was created
    expect(existsSync(join(HARVEST_TEST_DIR, 'instincts', 'run-tests-first.md'))).toBe(true);
  });

  it('should return empty when no journals exist', () => {
    const result = harvestInstincts(HARVEST_TEST_DIR);
    expect(result.journalsScanned).toBe(0);
    expect(result.candidates).toHaveLength(0);
  });

  it('should deduplicate across multiple journals', () => {
    const journalDir = join(HARVEST_TEST_DIR, 'memory', 'journal');
    mkdirSync(journalDir, { recursive: true });
    writeFileSync(
      join(journalDir, '2026-03-20.md'),
      makeJournalContent('2026-03-20', 'Day 1', [], ['Shared instinct']),
      'utf-8',
    );
    writeFileSync(
      join(journalDir, '2026-03-21.md'),
      makeJournalContent('2026-03-21', 'Day 2', [], ['Shared instinct']),
      'utf-8',
    );

    const result = harvestInstincts(HARVEST_TEST_DIR);
    expect(result.journalsScanned).toBe(2);
    // Same text should be deduped to one candidate
    expect(result.candidates).toHaveLength(1);
  });
});
