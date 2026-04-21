import { describe, it, expect } from 'vitest';
import {
  piiFilter,
  topicFilter,
  lengthLimit,
  buildContentFiltersFromConfig,
  runContentFilters,
  applyContentFilters,
  ContentFilterBlockedError,
  type ContentFilterSpec,
} from '../src/runtime/content-filters.js';
import type { HarnessConfig } from '../src/core/types.js';
import { CONFIG_DEFAULTS } from '../src/core/types.js';

function buildConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return { ...CONFIG_DEFAULTS, ...overrides } as HarnessConfig;
}

describe('piiFilter', () => {
  it('passes clean text', async () => {
    const res = await piiFilter().check('hello world, nothing sensitive here');
    expect(res.passed).toBe(true);
    expect(res.name).toBe('pii');
  });

  it('redacts SSN, credit card, email, phone', async () => {
    const input = 'SSN 123-45-6789 card 4111 1111 1111 1111 mail foo@bar.com phone 555-123-4567';
    const res = await piiFilter().check(input);
    expect(res.passed).toBe(false);
    expect(res.filtered).toContain('[SSN REDACTED]');
    expect(res.filtered).toContain('[CC REDACTED]');
    expect(res.filtered).toContain('[EMAIL REDACTED]');
    expect(res.filtered).toContain('[PHONE REDACTED]');
    expect(res.message).toMatch(/ssn|credit_card|email|phone/);
  });

  it('reports detection without a filtered string when redact=false', async () => {
    const res = await piiFilter({ redact: false }).check('my email is foo@bar.com');
    expect(res.passed).toBe(false);
    expect(res.filtered).toBeUndefined();
  });

  it('honors extra regex patterns from config', async () => {
    const res = await piiFilter({
      patterns: [{ name: 'api_key', pattern: 'sk-[A-Za-z0-9]{10,}', replacement: '[KEY REDACTED]' }],
    }).check('token is sk-abcdef1234567890');
    expect(res.passed).toBe(false);
    expect(res.filtered).toContain('[KEY REDACTED]');
  });
});

describe('topicFilter', () => {
  it('passes text that does not mention blocked topics', async () => {
    const res = await topicFilter(['secret']).check('nothing to see');
    expect(res.passed).toBe(true);
  });

  it('blocks text that mentions a blocked topic (case-insensitive)', async () => {
    const res = await topicFilter(['secret']).check('this SECRET is leaking');
    expect(res.passed).toBe(false);
    expect(res.message).toContain('secret');
  });

  it('does not redact — no filtered string on failure', async () => {
    const res = await topicFilter(['banned']).check('banned content here');
    expect(res.filtered).toBeUndefined();
  });
});

describe('lengthLimit', () => {
  it('passes short text under both caps', async () => {
    const res = await lengthLimit({ max_chars: 100, max_words: 100 }).check('short text');
    expect(res.passed).toBe(true);
  });

  it('truncates when max_chars exceeded', async () => {
    const res = await lengthLimit({ max_chars: 5 }).check('123456789');
    expect(res.passed).toBe(false);
    expect(res.filtered).toBe('12345');
  });

  it('fails without truncation when max_words exceeded', async () => {
    const res = await lengthLimit({ max_words: 2 }).check('one two three four');
    expect(res.passed).toBe(false);
    expect(res.filtered).toBeUndefined();
  });
});

describe('buildContentFiltersFromConfig', () => {
  it('builds filters for known types', () => {
    const specs: ContentFilterSpec[] = [
      { type: 'pii' },
      { type: 'topic', blocked: ['x'] },
      { type: 'length', max_chars: 10 },
    ];
    const filters = buildContentFiltersFromConfig(specs);
    expect(filters.map((f) => f.name)).toEqual(['pii', 'topic', 'length']);
  });

  it('skips and warns on unknown types', () => {
    const specs = [{ type: 'unknown-type' }] as unknown as ContentFilterSpec[];
    const filters = buildContentFiltersFromConfig(specs);
    expect(filters).toHaveLength(0);
  });
});

describe('runContentFilters chaining', () => {
  it('later filters see earlier filtered output', async () => {
    const filters = [piiFilter(), lengthLimit({ max_chars: 30 })];
    const { results, filteredText } = await runContentFilters(
      filters,
      'email is foo@bar.com and some more trailing content that should be truncated',
    );
    expect(filteredText.length).toBe(30);
    expect(filteredText).toContain('[EMAIL REDACTED]');
    expect(results[0].passed).toBe(false);
    expect(results[1].passed).toBe(false);
  });

  it('returns input unchanged when no filters given', async () => {
    const { results, filteredText } = await runContentFilters([], 'hello');
    expect(results).toHaveLength(0);
    expect(filteredText).toBe('hello');
  });
});

describe('applyContentFilters — config integration', () => {
  it('is a no-op when content_filters is disabled', async () => {
    const cfg = buildConfig();
    const out = await applyContentFilters(cfg, 'email: foo@bar.com');
    expect(out.blocked).toBe(false);
    expect(out.text).toBe('email: foo@bar.com');
  });

  it('returns filtered text in filter mode', async () => {
    const cfg = buildConfig({
      content_filters: {
        enabled: true,
        on_block: 'filter',
        filters: [{ type: 'pii' }],
      },
    } as Partial<HarnessConfig>);
    const out = await applyContentFilters(cfg, 'ping me at foo@bar.com today');
    expect(out.blocked).toBe(true);
    expect(out.text).toContain('[EMAIL REDACTED]');
  });

  it('throws ContentFilterBlockedError in throw mode on failure', async () => {
    const cfg = buildConfig({
      content_filters: {
        enabled: true,
        on_block: 'throw',
        filters: [{ type: 'topic', blocked: ['forbidden'] }],
      },
    } as Partial<HarnessConfig>);
    await expect(applyContentFilters(cfg, 'forbidden content')).rejects.toBeInstanceOf(
      ContentFilterBlockedError,
    );
  });

  it('does not throw when all filters pass in throw mode', async () => {
    const cfg = buildConfig({
      content_filters: {
        enabled: true,
        on_block: 'throw',
        filters: [{ type: 'topic', blocked: ['forbidden'] }],
      },
    } as Partial<HarnessConfig>);
    const out = await applyContentFilters(cfg, 'clean output');
    expect(out.blocked).toBe(false);
    expect(out.text).toBe('clean output');
  });
});
