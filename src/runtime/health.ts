import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getSpending } from './cost-tracker.js';

/** Individual health check result */
export interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
}

/** Persisted health metrics */
export interface HealthMetrics {
  lastSuccessfulRun: string | null;
  lastFailedRun: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  totalRuns: number;
  totalSuccesses: number;
  totalFailures: number;
  bootedAt: string | null;
  updatedAt: string;
}

/** Overall health status */
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: HealthCheck[];
  metrics: HealthMetrics;
  costToday: number;
  costThisMonth: number;
}

const HEALTH_FILE = 'health.json';

function getHealthPath(harnessDir: string): string {
  return join(harnessDir, 'memory', HEALTH_FILE);
}

function defaultMetrics(): HealthMetrics {
  return {
    lastSuccessfulRun: null,
    lastFailedRun: null,
    lastError: null,
    consecutiveFailures: 0,
    totalRuns: 0,
    totalSuccesses: 0,
    totalFailures: 0,
    bootedAt: null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Load health metrics from disk.
 */
export function loadHealth(harnessDir: string): HealthMetrics {
  const healthPath = getHealthPath(harnessDir);
  if (!existsSync(healthPath)) {
    return defaultMetrics();
  }

  try {
    const content = readFileSync(healthPath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'totalRuns' in parsed
    ) {
      return parsed as HealthMetrics;
    }
    return defaultMetrics();
  } catch {
    return defaultMetrics();
  }
}

/**
 * Save health metrics to disk.
 */
export function saveHealth(harnessDir: string, metrics: HealthMetrics): void {
  const memoryDir = join(harnessDir, 'memory');
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }

  metrics.updatedAt = new Date().toISOString();
  writeFileSync(getHealthPath(harnessDir), JSON.stringify(metrics, null, 2), 'utf-8');
}

/**
 * Record a successful run.
 */
export function recordSuccess(harnessDir: string): void {
  const metrics = loadHealth(harnessDir);
  metrics.totalRuns++;
  metrics.totalSuccesses++;
  metrics.consecutiveFailures = 0;
  metrics.lastSuccessfulRun = new Date().toISOString();
  saveHealth(harnessDir, metrics);
}

/**
 * Record a failed run.
 */
export function recordFailure(harnessDir: string, error?: string): void {
  const metrics = loadHealth(harnessDir);
  metrics.totalRuns++;
  metrics.totalFailures++;
  metrics.consecutiveFailures++;
  metrics.lastFailedRun = new Date().toISOString();
  metrics.lastError = error ?? null;
  saveHealth(harnessDir, metrics);
}

/**
 * Record boot time.
 */
export function recordBoot(harnessDir: string): void {
  const metrics = loadHealth(harnessDir);
  metrics.bootedAt = new Date().toISOString();
  saveHealth(harnessDir, metrics);
}

/**
 * Run all health checks and return overall status.
 */
export function getHealthStatus(harnessDir: string): HealthStatus {
  const metrics = loadHealth(harnessDir);
  const checks: HealthCheck[] = [];

  // Check 1: Required files exist
  const requiredFiles = ['CORE.md', 'config.yaml', 'state.md'];
  const missingFiles = requiredFiles.filter((f) => !existsSync(join(harnessDir, f)));
  if (missingFiles.length === 0) {
    checks.push({ name: 'core-files', status: 'pass', message: 'All core files present' });
  } else {
    checks.push({ name: 'core-files', status: 'fail', message: `Missing: ${missingFiles.join(', ')}` });
  }

  // Check 2: Memory directory exists
  const memoryDir = join(harnessDir, 'memory');
  if (existsSync(memoryDir)) {
    checks.push({ name: 'memory-dir', status: 'pass', message: 'Memory directory exists' });
  } else {
    checks.push({ name: 'memory-dir', status: 'fail', message: 'Memory directory missing' });
  }

  // Check 3: API key availability. Skip the warning when the configured
  // provider is a local-only one (ollama, localhost OpenAI-compat) or a
  // pre-keyed service (agntk-free).
  const apiKeys: Array<{ name: string; envVar: string }> = [
    { name: 'OpenRouter', envVar: 'OPENROUTER_API_KEY' },
    { name: 'Anthropic', envVar: 'ANTHROPIC_API_KEY' },
    { name: 'OpenAI', envVar: 'OPENAI_API_KEY' },
    { name: 'Cerebras', envVar: 'CEREBRAS_API_KEY' },
  ];
  const presentKeys = apiKeys.filter((k) => process.env[k.envVar]);
  const providerNeedsKey = detectProviderNeedsKey(harnessDir);
  if (presentKeys.length > 0) {
    checks.push({
      name: 'api-keys',
      status: 'pass',
      message: `API keys: ${presentKeys.map((k) => k.name).join(', ')}`,
    });
  } else if (!providerNeedsKey) {
    checks.push({
      name: 'api-keys',
      status: 'pass',
      message: 'Local/pre-keyed provider — no API key required',
    });
  } else {
    checks.push({ name: 'api-keys', status: 'warn', message: 'No API keys found in environment' });
  }

  // Check 4: Consecutive failures
  if (metrics.consecutiveFailures === 0) {
    checks.push({ name: 'run-health', status: 'pass', message: 'No consecutive failures' });
  } else if (metrics.consecutiveFailures < 3) {
    checks.push({
      name: 'run-health',
      status: 'warn',
      message: `${metrics.consecutiveFailures} consecutive failure(s)`,
    });
  } else {
    checks.push({
      name: 'run-health',
      status: 'fail',
      message: `${metrics.consecutiveFailures} consecutive failures — last error: ${metrics.lastError ?? 'unknown'}`,
    });
  }

  // Check 5: Last run recency (warn if no successful run in 24h when there have been runs)
  if (metrics.lastSuccessfulRun) {
    const hoursSinceSuccess = (Date.now() - new Date(metrics.lastSuccessfulRun).getTime()) / 3600000;
    if (hoursSinceSuccess < 24) {
      checks.push({ name: 'last-success', status: 'pass', message: `Last success: ${metrics.lastSuccessfulRun}` });
    } else {
      checks.push({
        name: 'last-success',
        status: 'warn',
        message: `Last success was ${Math.round(hoursSinceSuccess)}h ago`,
      });
    }
  } else if (metrics.totalRuns > 0) {
    checks.push({ name: 'last-success', status: 'warn', message: 'No successful runs recorded' });
  }

  // Cost checks
  let costToday = 0;
  let costThisMonth = 0;

  try {
    const today = new Date().toISOString().split('T')[0];
    const monthStart = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`;
    costToday = getSpending(harnessDir, today).total_cost_usd;
    costThisMonth = getSpending(harnessDir, monthStart).total_cost_usd;
  } catch {
    // Cost data may not exist
  }

  // Determine overall status
  const failCount = checks.filter((c) => c.status === 'fail').length;
  const warnCount = checks.filter((c) => c.status === 'warn').length;

  let status: HealthStatus['status'];
  if (failCount > 0) {
    status = 'unhealthy';
  } else if (warnCount > 0) {
    status = 'degraded';
  } else {
    status = 'healthy';
  }

  return { status, checks, metrics, costToday, costThisMonth };
}

/**
 * Reset health metrics (for testing or fresh start).
 */
export function resetHealth(harnessDir: string): void {
  saveHealth(harnessDir, defaultMetrics());
}

/**
 * Returns true when the configured provider requires an API key in the
 * environment. Returns false for local-only providers (ollama, openai with
 * a localhost base_url) and for agntk-free which ships with an embedded key.
 * Best-effort — falls back to "yes, needs a key" if the config cannot be read.
 */
function detectProviderNeedsKey(harnessDir: string): boolean {
  try {
    const configPath = join(harnessDir, 'config.yaml');
    const altConfigPath = join(harnessDir, 'config.yml');
    const path = existsSync(configPath) ? configPath : existsSync(altConfigPath) ? altConfigPath : null;
    if (!path) return true;
    const raw = readFileSync(path, 'utf-8');
    const providerMatch = raw.match(/^\s*provider:\s*([^\s#]+)/m);
    const baseUrlMatch = raw.match(/^\s*base_url:\s*([^\s#]+)/m);
    const provider = providerMatch?.[1]?.toLowerCase();
    const baseUrl = baseUrlMatch?.[1];
    if (provider === 'ollama' || provider === 'agntk-free') return false;
    if (provider === 'openai' && baseUrl && /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(baseUrl)) {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}
