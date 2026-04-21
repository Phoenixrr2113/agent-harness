import { log } from '../core/logger.js';
import type { HarnessConfig } from '../core/types.js';

/**
 * Result of running a single content filter against a text output.
 * - `passed: true` — the text cleared the filter.
 * - `passed: false` + `filtered` set — the filter redacted something and produced
 *   a safer string. Runners in `filter` mode should continue with `filtered`.
 * - `passed: false` + `filtered` unset — the filter rejected without a safe
 *   replacement. In `throw` mode this surfaces as ContentFilterBlockedError.
 */
export interface ContentFilterResult {
  passed: boolean;
  name: string;
  message?: string;
  filtered?: string;
}

/**
 * A named text check. Implementations are synchronous or async and must not
 * mutate their input. The returned `filtered` field, if present, is the
 * redacted version of the input (never the original).
 */
export interface ContentFilter {
  name: string;
  check: (text: string) => ContentFilterResult | Promise<ContentFilterResult>;
}

/** Action taken when one or more output filters fail on a run. */
export type ContentFilterOnBlock = 'filter' | 'throw';

/**
 * Config-side spec for a single filter. The `type` discriminator picks one
 * of the built-ins and the remaining fields configure it. Unknown types are
 * warned about at build time and skipped.
 */
export type ContentFilterSpec =
  | {
      type: 'pii';
      redact?: boolean;
      patterns?: Array<{ name: string; pattern: string; flags?: string; replacement: string }>;
    }
  | { type: 'topic'; blocked: string[] }
  | { type: 'length'; max_chars?: number; max_words?: number };

/** Config section consumed by `applyContentFilters`. */
export interface ContentFiltersConfig {
  enabled: boolean;
  on_block: ContentFilterOnBlock;
  filters: ContentFilterSpec[];
}

/**
 * Raised when any output filter fails and `on_block: 'throw'` is configured.
 * Carries the underlying per-filter results so callers can introspect.
 */
export class ContentFilterBlockedError extends Error {
  public readonly results: ContentFilterResult[];
  constructor(results: ContentFilterResult[]) {
    const failed = results.filter((r) => !r.passed);
    const names = failed.map((r) => r.name).join(', ');
    const messages = failed
      .map((r) => r.message)
      .filter(Boolean)
      .join('; ');
    super(`Content filter blocked output: [${names}] ${messages}`);
    this.name = 'ContentFilterBlockedError';
    this.results = results;
  }
}

const DEFAULT_PII_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  { name: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[SSN REDACTED]' },
  {
    name: 'credit_card',
    pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    replacement: '[CC REDACTED]',
  },
  {
    name: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: '[EMAIL REDACTED]',
  },
  {
    name: 'phone',
    pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    replacement: '[PHONE REDACTED]',
  },
];

/**
 * Built-in PII filter. Redacts SSN, credit card, email, and phone patterns
 * by default. Pass `redact: false` for detect-only (returns failure without
 * a `filtered` string). Extra patterns appended via `patterns` are compiled
 * from their string source + optional flags.
 */
export function piiFilter(options: {
  redact?: boolean;
  patterns?: Array<{ name: string; pattern: string; flags?: string; replacement: string }>;
} = {}): ContentFilter {
  const { redact = true, patterns: extra = [] } = options;
  const compiledExtra = extra.map((p) => ({
    name: p.name,
    pattern: new RegExp(p.pattern, p.flags ?? 'g'),
    replacement: p.replacement,
  }));
  const allPatterns = [...DEFAULT_PII_PATTERNS, ...compiledExtra];

  return {
    name: 'pii',
    check: (text) => {
      const found: string[] = [];
      let filtered = text;

      for (const { name, pattern, replacement } of allPatterns) {
        pattern.lastIndex = 0;
        if (pattern.test(text)) {
          found.push(name);
          if (redact) {
            pattern.lastIndex = 0;
            filtered = filtered.replace(pattern, replacement);
          }
        }
      }

      if (found.length === 0) {
        return { passed: true, name: 'pii' };
      }

      return {
        passed: false,
        name: 'pii',
        message: `PII detected: ${found.join(', ')}`,
        ...(redact ? { filtered } : {}),
      };
    },
  };
}

/**
 * Blocks text containing any of the supplied topic strings (case-insensitive
 * word-boundary match). Does not redact — pair with a `throw` or manual
 * downstream handling.
 */
export function topicFilter(blocked: string[]): ContentFilter {
  const matchers = blocked.map((t) => ({
    source: t,
    regex: new RegExp(`\\b${escapeRegex(t)}\\b`, 'i'),
  }));
  return {
    name: 'topic',
    check: (text) => {
      const lower = text.toLowerCase();
      const matched: string[] = [];
      for (const m of matchers) {
        if (m.regex.test(text) || lower.includes(m.source.toLowerCase())) {
          matched.push(m.source);
        }
      }
      if (matched.length === 0) return { passed: true, name: 'topic' };
      return {
        passed: false,
        name: 'topic',
        message: `Blocked topics: ${matched.join(', ')}`,
      };
    },
  };
}

/**
 * Caps output by character or word count. When `max_chars` is exceeded the
 * text is truncated as `filtered`; when `max_words` is exceeded the filter
 * fails without a truncation (word-safe truncation is caller's choice).
 */
export function lengthLimit(options: { max_chars?: number; max_words?: number }): ContentFilter {
  const { max_chars, max_words } = options;
  return {
    name: 'length',
    check: (text) => {
      if (max_chars !== undefined && text.length > max_chars) {
        return {
          passed: false,
          name: 'length',
          message: `Exceeds ${max_chars} chars (got ${text.length})`,
          filtered: text.slice(0, max_chars),
        };
      }
      if (max_words !== undefined) {
        const words = text.split(/\s+/).filter(Boolean).length;
        if (words > max_words) {
          return {
            passed: false,
            name: 'length',
            message: `Exceeds ${max_words} words (got ${words})`,
          };
        }
      }
      return { passed: true, name: 'length' };
    },
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Translate the user's config.content_filters.filters list into runtime
 * ContentFilter instances. Unknown `type` entries are logged and skipped so
 * a bad config line doesn't break the whole run.
 */
export function buildContentFiltersFromConfig(specs: ContentFilterSpec[]): ContentFilter[] {
  const out: ContentFilter[] = [];
  for (const spec of specs) {
    switch (spec.type) {
      case 'pii':
        out.push(piiFilter({ redact: spec.redact, patterns: spec.patterns }));
        break;
      case 'topic':
        out.push(topicFilter(spec.blocked));
        break;
      case 'length':
        out.push(lengthLimit({ max_chars: spec.max_chars, max_words: spec.max_words }));
        break;
      default: {
        const unknown = spec as { type?: string };
        log.warn(`Unknown content_filter type: ${unknown.type ?? '(missing)'} — skipped.`);
      }
    }
  }
  return out;
}

/**
 * Run a list of filters against `text` in order. Each filter sees the output
 * of prior filters' `filtered` replacement (chained redaction), so e.g. a PII
 * redaction is visible to a later length-limit filter.
 */
export async function runContentFilters(
  filters: ContentFilter[],
  text: string,
): Promise<{ results: ContentFilterResult[]; filteredText: string }> {
  if (filters.length === 0) return { results: [], filteredText: text };

  const results: ContentFilterResult[] = [];
  let current = text;

  for (const filter of filters) {
    try {
      const res = await filter.check(current);
      results.push(res);
      if (!res.passed && res.filtered !== undefined) {
        current = res.filtered;
      }
    } catch (err) {
      log.warn(`Content filter "${filter.name}" threw: ${err instanceof Error ? err.message : String(err)}`);
      results.push({
        passed: false,
        name: filter.name,
        message: `Filter error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { results, filteredText: current };
}

/**
 * Apply output content filters given a harness config and a raw model output
 * string. Returns the (possibly redacted) text to use, whether any filter
 * failed, and the raw per-filter results for observability.
 *
 * When config.content_filters is disabled or missing, this is a no-op that
 * returns the input unchanged.
 *
 * In `throw` mode, a failed filter raises ContentFilterBlockedError. In
 * `filter` mode (the default), the chained `filteredText` is returned.
 */
export async function applyContentFilters(
  config: HarnessConfig,
  text: string,
): Promise<{ text: string; blocked: boolean; results: ContentFilterResult[] }> {
  const cfg = (config as HarnessConfig & { content_filters?: ContentFiltersConfig }).content_filters;
  if (!cfg || !cfg.enabled || !cfg.filters || cfg.filters.length === 0) {
    return { text, blocked: false, results: [] };
  }

  const filters = buildContentFiltersFromConfig(cfg.filters);
  const { results, filteredText } = await runContentFilters(filters, text);
  const blocked = results.some((r) => !r.passed);

  if (!blocked) {
    return { text, blocked: false, results };
  }

  if (cfg.on_block === 'throw') {
    throw new ContentFilterBlockedError(results);
  }

  return { text: filteredText, blocked: true, results };
}
