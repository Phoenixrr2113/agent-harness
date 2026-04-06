import { recordEvent, checkRateLimit } from './rate-limiter.js';
import { checkBudget } from './cost-tracker.js';
import type { HarnessConfig } from '../core/types.js';
import type { RateLimit, RateLimitCheck } from './rate-limiter.js';
import type { BudgetStatus } from './cost-tracker.js';

/** Result of a guardrail check before an LLM call. */
export interface GuardrailResult {
  allowed: boolean;
  reason: string | null;
  rateLimitCheck: RateLimitCheck | null;
  budgetStatus: BudgetStatus | null;
  /** Suggested wait time in ms if rate-limited (0 otherwise) */
  retryAfterMs: number;
}

const RATE_KEY = 'llm-calls';

/**
 * Build rate limit rules from config.
 * Returns an array of limits to check (per-minute, per-hour, per-day).
 */
export function buildRateLimits(config: HarnessConfig): RateLimit[] {
  const limits: RateLimit[] = [];
  const rl = config.rate_limits;

  if (rl?.per_minute) {
    limits.push({ key: `${RATE_KEY}:minute`, max_requests: rl.per_minute, window_ms: 60_000 });
  }
  if (rl?.per_hour) {
    limits.push({ key: `${RATE_KEY}:hour`, max_requests: rl.per_hour, window_ms: 3_600_000 });
  }
  if (rl?.per_day) {
    limits.push({ key: `${RATE_KEY}:day`, max_requests: rl.per_day, window_ms: 86_400_000 });
  }

  return limits;
}

/**
 * Check all guardrails (rate limits + budget) before an LLM call.
 *
 * Rate limits: Checks all configured limits. If any limit is exceeded,
 * the call is blocked with `retry_after_ms` from the first violated limit.
 *
 * Budget: Checks daily and monthly spending limits. If `budget.enforce` is true
 * and any limit is exceeded, the call is blocked.
 *
 * Returns { allowed: true } if all checks pass.
 */
export function checkGuardrails(
  harnessDir: string,
  config: HarnessConfig,
): GuardrailResult {
  // Check rate limits
  const limits = buildRateLimits(config);
  for (const limit of limits) {
    const check = checkRateLimit(harnessDir, limit);
    if (!check.allowed) {
      const windowLabel = limit.window_ms <= 60_000 ? 'minute' : limit.window_ms <= 3_600_000 ? 'hour' : 'day';
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${check.current}/${check.max} calls per ${windowLabel}. Retry after ${Math.ceil(check.retry_after_ms / 1000)}s.`,
        rateLimitCheck: check,
        budgetStatus: null,
        retryAfterMs: check.retry_after_ms,
      };
    }
  }

  // Check budget
  const budgetConfig = config.budget;
  if (budgetConfig?.enforce !== false && (budgetConfig?.daily_limit_usd || budgetConfig?.monthly_limit_usd)) {
    const status = checkBudget(harnessDir, {
      daily_limit_usd: budgetConfig.daily_limit_usd,
      monthly_limit_usd: budgetConfig.monthly_limit_usd,
    });

    const exceeded = status.alerts.some((a) => a.includes('exceeded'));
    if (exceeded) {
      return {
        allowed: false,
        reason: status.alerts.filter((a) => a.includes('exceeded')).join('; '),
        rateLimitCheck: null,
        budgetStatus: status,
        retryAfterMs: 0,
      };
    }
  }

  // All checks pass — record rate limit events for all configured limits
  const now = Date.now();
  for (const limit of limits) {
    recordEvent(harnessDir, limit.key, now);
  }

  return {
    allowed: true,
    reason: null,
    rateLimitCheck: null,
    budgetStatus: null,
    retryAfterMs: 0,
  };
}
