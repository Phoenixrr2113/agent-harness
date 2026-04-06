import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

/** Cost per 1M tokens for a model (input and output separately) */
export interface ModelPricing {
  model_pattern: string;
  input_per_million: number;
  output_per_million: number;
}

/** A recorded cost event */
export interface CostEntry {
  timestamp: string;
  model_id: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  source: string;
}

/** Budget configuration */
export interface BudgetConfig {
  daily_limit_usd?: number;
  monthly_limit_usd?: number;
  alert_threshold_pct?: number;
}

/** Budget status check result */
export interface BudgetStatus {
  daily_spent_usd: number;
  daily_limit_usd: number | null;
  daily_remaining_usd: number | null;
  daily_pct: number | null;
  monthly_spent_usd: number;
  monthly_limit_usd: number | null;
  monthly_remaining_usd: number | null;
  monthly_pct: number | null;
  alerts: string[];
}

/** Spending summary for a time period */
export interface SpendingSummary {
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  entries: number;
  by_model: Record<string, { cost_usd: number; input_tokens: number; output_tokens: number; count: number }>;
  by_provider: Record<string, { cost_usd: number; count: number }>;
}

/** Persisted cost store */
export interface CostStore {
  entries: CostEntry[];
  updated: string;
}

const COST_FILE = 'costs.json';
const MAX_ENTRIES = 5000;

/** Default pricing for common models (per 1M tokens) */
const DEFAULT_PRICING: ModelPricing[] = [
  // Anthropic via OpenRouter
  { model_pattern: 'anthropic/claude-sonnet-4', input_per_million: 3.0, output_per_million: 15.0 },
  { model_pattern: 'anthropic/claude-opus-4', input_per_million: 15.0, output_per_million: 75.0 },
  { model_pattern: 'anthropic/claude-haiku-3.5', input_per_million: 0.8, output_per_million: 4.0 },
  // Direct Anthropic
  { model_pattern: 'claude-sonnet-4', input_per_million: 3.0, output_per_million: 15.0 },
  { model_pattern: 'claude-opus-4', input_per_million: 15.0, output_per_million: 75.0 },
  { model_pattern: 'claude-haiku-3.5', input_per_million: 0.8, output_per_million: 4.0 },
  // OpenAI
  { model_pattern: 'openai/gpt-4o', input_per_million: 2.5, output_per_million: 10.0 },
  { model_pattern: 'gpt-4o', input_per_million: 2.5, output_per_million: 10.0 },
  { model_pattern: 'openai/gpt-4o-mini', input_per_million: 0.15, output_per_million: 0.6 },
  { model_pattern: 'gpt-4o-mini', input_per_million: 0.15, output_per_million: 0.6 },
  // Local models
  { model_pattern: 'local/', input_per_million: 0, output_per_million: 0 },
];

function getStorePath(harnessDir: string): string {
  return join(harnessDir, 'memory', COST_FILE);
}

/**
 * Load cost entries from disk.
 */
export function loadCosts(harnessDir: string): CostStore {
  const storePath = getStorePath(harnessDir);
  if (!existsSync(storePath)) {
    return { entries: [], updated: new Date().toISOString() };
  }

  try {
    const content = readFileSync(storePath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'entries' in parsed &&
      Array.isArray((parsed as CostStore).entries)
    ) {
      return parsed as CostStore;
    }
    return { entries: [], updated: new Date().toISOString() };
  } catch {
    return { entries: [], updated: new Date().toISOString() };
  }
}

/**
 * Save cost entries to disk. Trims to MAX_ENTRIES.
 */
export function saveCosts(harnessDir: string, store: CostStore): void {
  const memoryDir = join(harnessDir, 'memory');
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }

  if (store.entries.length > MAX_ENTRIES) {
    store.entries = store.entries.slice(store.entries.length - MAX_ENTRIES);
  }

  store.updated = new Date().toISOString();
  writeFileSync(getStorePath(harnessDir), JSON.stringify(store, null, 2), 'utf-8');
}

/**
 * Find pricing for a model ID. Uses prefix matching against DEFAULT_PRICING.
 * Custom pricing can be passed to override defaults.
 */
export function findPricing(
  modelId: string,
  customPricing?: ModelPricing[],
): ModelPricing | null {
  const allPricing = [...(customPricing ?? []), ...DEFAULT_PRICING];

  for (const pricing of allPricing) {
    if (modelId === pricing.model_pattern || modelId.startsWith(pricing.model_pattern)) {
      return pricing;
    }
  }

  return null;
}

/**
 * Calculate cost in USD for a given usage.
 */
export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  customPricing?: ModelPricing[],
): number {
  const pricing = findPricing(modelId, customPricing);
  if (!pricing) return 0;

  const inputCost = (inputTokens / 1_000_000) * pricing.input_per_million;
  const outputCost = (outputTokens / 1_000_000) * pricing.output_per_million;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

/**
 * Record a cost entry.
 */
export function recordCost(
  harnessDir: string,
  entry: Omit<CostEntry, 'timestamp' | 'cost_usd'> & { cost_usd?: number },
  customPricing?: ModelPricing[],
): CostEntry {
  const store = loadCosts(harnessDir);

  const costUsd = entry.cost_usd ?? calculateCost(
    entry.model_id,
    entry.input_tokens,
    entry.output_tokens,
    customPricing,
  );

  const fullEntry: CostEntry = {
    timestamp: new Date().toISOString(),
    model_id: entry.model_id,
    provider: entry.provider,
    input_tokens: entry.input_tokens,
    output_tokens: entry.output_tokens,
    cost_usd: costUsd,
    source: entry.source,
  };

  store.entries.push(fullEntry);
  saveCosts(harnessDir, store);

  return fullEntry;
}

/**
 * Get spending summary for a date range.
 * Defaults to today if no range specified.
 */
export function getSpending(
  harnessDir: string,
  from?: string,
  to?: string,
): SpendingSummary {
  const store = loadCosts(harnessDir);

  const fromDate = from ?? new Date().toISOString().split('T')[0];
  const toDate = to ?? new Date(Date.now() + 86400000).toISOString().split('T')[0];

  const filtered = store.entries.filter(
    (e) => e.timestamp >= fromDate && e.timestamp < toDate + 'T99',
  );

  const byModel: SpendingSummary['by_model'] = {};
  const byProvider: SpendingSummary['by_provider'] = {};

  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;

  for (const entry of filtered) {
    totalCost += entry.cost_usd;
    totalInput += entry.input_tokens;
    totalOutput += entry.output_tokens;

    if (!byModel[entry.model_id]) {
      byModel[entry.model_id] = { cost_usd: 0, input_tokens: 0, output_tokens: 0, count: 0 };
    }
    byModel[entry.model_id].cost_usd += entry.cost_usd;
    byModel[entry.model_id].input_tokens += entry.input_tokens;
    byModel[entry.model_id].output_tokens += entry.output_tokens;
    byModel[entry.model_id].count += 1;

    if (!byProvider[entry.provider]) {
      byProvider[entry.provider] = { cost_usd: 0, count: 0 };
    }
    byProvider[entry.provider].cost_usd += entry.cost_usd;
    byProvider[entry.provider].count += 1;
  }

  return {
    total_cost_usd: Math.round(totalCost * 1_000_000) / 1_000_000,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    entries: filtered.length,
    by_model: byModel,
    by_provider: byProvider,
  };
}

/**
 * Check budget status against configured limits.
 */
export function checkBudget(
  harnessDir: string,
  budget: BudgetConfig,
): BudgetStatus {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  const dailySpending = getSpending(harnessDir, today);
  const monthlySpending = getSpending(harnessDir, monthStart);

  const alerts: string[] = [];
  const alertPct = budget.alert_threshold_pct ?? 80;

  const dailyLimit = budget.daily_limit_usd ?? null;
  const monthlyLimit = budget.monthly_limit_usd ?? null;

  let dailyPct: number | null = null;
  let dailyRemaining: number | null = null;

  if (dailyLimit !== null) {
    dailyPct = dailyLimit > 0 ? (dailySpending.total_cost_usd / dailyLimit) * 100 : 0;
    dailyRemaining = Math.max(0, dailyLimit - dailySpending.total_cost_usd);

    if (dailySpending.total_cost_usd >= dailyLimit) {
      alerts.push(`Daily budget exceeded: $${dailySpending.total_cost_usd.toFixed(4)} / $${dailyLimit.toFixed(2)}`);
    } else if (dailyPct >= alertPct) {
      alerts.push(`Daily budget at ${dailyPct.toFixed(0)}%: $${dailySpending.total_cost_usd.toFixed(4)} / $${dailyLimit.toFixed(2)}`);
    }
  }

  let monthlyPct: number | null = null;
  let monthlyRemaining: number | null = null;

  if (monthlyLimit !== null) {
    monthlyPct = monthlyLimit > 0 ? (monthlySpending.total_cost_usd / monthlyLimit) * 100 : 0;
    monthlyRemaining = Math.max(0, monthlyLimit - monthlySpending.total_cost_usd);

    if (monthlySpending.total_cost_usd >= monthlyLimit) {
      alerts.push(`Monthly budget exceeded: $${monthlySpending.total_cost_usd.toFixed(4)} / $${monthlyLimit.toFixed(2)}`);
    } else if (monthlyPct >= alertPct) {
      alerts.push(`Monthly budget at ${monthlyPct.toFixed(0)}%: $${monthlySpending.total_cost_usd.toFixed(4)} / $${monthlyLimit.toFixed(2)}`);
    }
  }

  return {
    daily_spent_usd: dailySpending.total_cost_usd,
    daily_limit_usd: dailyLimit,
    daily_remaining_usd: dailyRemaining,
    daily_pct: dailyPct,
    monthly_spent_usd: monthlySpending.total_cost_usd,
    monthly_limit_usd: monthlyLimit,
    monthly_remaining_usd: monthlyRemaining,
    monthly_pct: monthlyPct,
    alerts,
  };
}

/**
 * Clear all cost entries, or entries for a specific model.
 */
export function clearCosts(harnessDir: string, modelId?: string): number {
  const store = loadCosts(harnessDir);
  const before = store.entries.length;

  if (modelId) {
    store.entries = store.entries.filter((e) => e.model_id !== modelId);
  } else {
    store.entries = [];
  }

  saveCosts(harnessDir, store);
  return before - store.entries.length;
}
