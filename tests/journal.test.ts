import { describe, it, expect } from 'vitest';
import { parseJournalSynthesis } from '../src/runtime/journal.js';

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
