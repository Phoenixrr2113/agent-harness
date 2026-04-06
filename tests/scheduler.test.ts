import { describe, it, expect } from 'vitest';
import { isQuietHours } from '../src/runtime/scheduler.js';
import type { HarnessConfig } from '../src/core/types.js';

function makeConfig(start: number, end: number, timezone = 'America/New_York'): HarnessConfig {
  return {
    agent: { name: 'test', version: '0.1.0' },
    model: { provider: 'openrouter', id: 'test', max_tokens: 200000, max_retries: 2 },
    runtime: {
      scratchpad_budget: 10000,
      quiet_hours: { start, end },
      timezone,
    },
    memory: { session_retention_days: 7, journal_retention_days: 365 },
    channels: { primary: 'cli' },
    extensions: { directories: [] },
  };
}

describe('isQuietHours', () => {
  it('should return true during quiet hours (wraps midnight)', () => {
    const config = makeConfig(23, 6, 'UTC');
    // 23:30 UTC is within quiet hours (23:00–05:59)
    const lateNight = new Date('2026-04-06T23:30:00Z');
    expect(isQuietHours(config, lateNight)).toBe(true);
  });

  it('should return true during early morning quiet hours', () => {
    const config = makeConfig(23, 6, 'UTC');
    // 3:00 UTC is within quiet hours (23:00–05:59)
    const earlyMorning = new Date('2026-04-06T03:00:00Z');
    expect(isQuietHours(config, earlyMorning)).toBe(true);
  });

  it('should return false outside quiet hours', () => {
    const config = makeConfig(23, 6, 'UTC');
    // 12:00 UTC is outside quiet hours
    const midday = new Date('2026-04-06T12:00:00Z');
    expect(isQuietHours(config, midday)).toBe(false);
  });

  it('should return false at the exact end hour (end is exclusive)', () => {
    const config = makeConfig(23, 6, 'UTC');
    // 6:00 UTC — the end hour is exclusive, so 6:xx should NOT be quiet
    const exactEnd = new Date('2026-04-06T06:30:00Z');
    expect(isQuietHours(config, exactEnd)).toBe(false);
  });

  it('should handle non-wrapping range (e.g. 8–17)', () => {
    const config = makeConfig(8, 17, 'UTC');
    // 10:00 UTC is within 8:00–16:59
    const morning = new Date('2026-04-06T10:00:00Z');
    expect(isQuietHours(config, morning)).toBe(true);

    // 18:00 UTC is outside
    const evening = new Date('2026-04-06T18:00:00Z');
    expect(isQuietHours(config, evening)).toBe(false);
  });

  it('should return false when start equals end (no quiet hours)', () => {
    const config = makeConfig(0, 0, 'UTC');
    const anytime = new Date('2026-04-06T15:00:00Z');
    expect(isQuietHours(config, anytime)).toBe(false);
  });

  it('should handle timezone conversion', () => {
    // April 6 is in EDT (UTC-4). Quiet hours 23–6 in America/New_York.
    const config = makeConfig(23, 6, 'America/New_York');

    // 3:00 UTC = 23:00 EDT — within quiet hours (>= 23)
    const utc3am = new Date('2026-04-06T03:00:00Z');
    expect(isQuietHours(config, utc3am)).toBe(true);

    // 10:00 UTC = 6:00 EDT — end hour is exclusive, so NOT quiet
    const utc10am = new Date('2026-04-06T10:00:00Z');
    expect(isQuietHours(config, utc10am)).toBe(false);

    // 16:00 UTC = 12:00 EDT — clearly outside quiet hours
    const utc4pm = new Date('2026-04-06T16:00:00Z');
    expect(isQuietHours(config, utc4pm)).toBe(false);
  });

  it('should fallback to local time for invalid timezone', () => {
    const config = makeConfig(23, 6, 'Invalid/Timezone');
    // Should not throw, falls back to local time
    expect(() => isQuietHours(config)).not.toThrow();
  });
});
