import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { getHealthStatus } from './health.js';
import { getSpending } from './cost-tracker.js';
import { getAllWorkflowStats, loadMetrics } from './metrics.js';
import { getSessionAnalytics } from './analytics.js';
import { validateMcpConfig } from './mcp.js';
import { loadState } from './state.js';
import { loadConfig } from '../core/config.js';
import type { HealthStatus } from './health.js';
import type { SpendingSummary } from './cost-tracker.js';
import type { WorkflowStats } from './metrics.js';
import type { AgentState, HarnessConfig } from '../core/types.js';

/** A point-in-time snapshot of all system telemetry. */
export interface TelemetrySnapshot {
  timestamp: string;
  agent: {
    name: string;
    version: string;
    mode: AgentState['mode'];
    lastInteraction: string;
  };
  health: HealthStatus;
  spending: {
    today: SpendingSummary;
    thisMonth: SpendingSummary;
    allTime: SpendingSummary;
  };
  sessions: {
    total: number;
    totalTokens: number;
    avgTokensPerSession: number;
    delegationCount: number;
  };
  workflows: {
    totalRuns: number;
    totalSuccesses: number;
    totalFailures: number;
    overallSuccessRate: number;
    stats: WorkflowStats[];
  };
  storage: {
    sessionCount: number;
    journalCount: number;
    weeklyCount: number;
    primitiveCount: number;
  };
  mcp: {
    serverCount: number;
    enabledCount: number;
    servers: Array<{ name: string; transport: string; enabled: boolean; valid: boolean; error?: string }>;
  };
}

/** Options for snapshot collection. */
export interface TelemetryOptions {
  /** Skip health checks (default: false) */
  skipHealth?: boolean;
  /** Skip session analytics parsing (default: false) */
  skipSessions?: boolean;
  /** Skip workflow metrics (default: false) */
  skipWorkflows?: boolean;
  /** Skip spending data (default: false) */
  skipSpending?: boolean;
}

/**
 * Count files in a directory matching a filter (non-recursive).
 */
function countFiles(dir: string, filter: (f: string) => boolean): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter(filter).length;
  } catch {
    return 0;
  }
}

const mdFilter = (f: string): boolean => f.endsWith('.md') && !f.startsWith('.') && !f.startsWith('_');

/**
 * Collect a full telemetry snapshot from all system modules.
 * Each section can be skipped via options for performance.
 */
export function collectSnapshot(
  harnessDir: string,
  options?: TelemetryOptions,
): TelemetrySnapshot {
  const now = new Date().toISOString();

  // Agent info
  let agentName = 'unknown';
  let agentVersion = '0.0.0';
  let config: HarnessConfig | undefined;
  try {
    config = loadConfig(harnessDir);
    agentName = config.agent.name;
    agentVersion = config.agent.version;
  } catch {
    // Config may not exist
  }

  let state: AgentState;
  try {
    state = loadState(harnessDir);
  } catch {
    state = {
      mode: 'idle',
      goals: [],
      active_workflows: [],
      unfinished_business: [],
      last_interaction: 'never',
    };
  }

  // Health
  const health: HealthStatus = options?.skipHealth
    ? { status: 'healthy', checks: [], metrics: { lastSuccessfulRun: null, lastFailedRun: null, lastError: null, consecutiveFailures: 0, totalRuns: 0, totalSuccesses: 0, totalFailures: 0, bootedAt: null, updatedAt: now }, costToday: 0, costThisMonth: 0 }
    : getHealthStatus(harnessDir);

  // Spending
  const today = now.split('T')[0];
  const monthStart = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`;
  const emptySummary: SpendingSummary = { total_cost_usd: 0, total_input_tokens: 0, total_output_tokens: 0, entries: 0, by_model: {}, by_provider: {} };

  let spendingToday: SpendingSummary = emptySummary;
  let spendingMonth: SpendingSummary = emptySummary;
  let spendingAll: SpendingSummary = emptySummary;

  if (!options?.skipSpending) {
    try {
      spendingToday = getSpending(harnessDir, today);
      spendingMonth = getSpending(harnessDir, monthStart);
      spendingAll = getSpending(harnessDir, '2000-01-01');
    } catch {
      // Cost data may not exist
    }
  }

  // Session analytics
  let totalSessions = 0;
  let totalTokens = 0;
  let avgTokensPerSession = 0;
  let delegationCount = 0;

  if (!options?.skipSessions) {
    try {
      const analytics = getSessionAnalytics(harnessDir);
      totalSessions = analytics.totalSessions;
      totalTokens = analytics.totalTokens;
      avgTokensPerSession = analytics.avgTokensPerSession;
      delegationCount = analytics.delegationCount;
    } catch {
      // Analytics may fail if no sessions
    }
  }

  // Workflow metrics
  let workflowStats: WorkflowStats[] = [];
  let wfTotalRuns = 0;
  let wfTotalSuccesses = 0;
  let wfTotalFailures = 0;

  if (!options?.skipWorkflows) {
    try {
      workflowStats = getAllWorkflowStats(harnessDir);
      const metricsStore = loadMetrics(harnessDir);
      wfTotalRuns = metricsStore.runs.length;
      wfTotalSuccesses = metricsStore.runs.filter((r) => r.success).length;
      wfTotalFailures = metricsStore.runs.filter((r) => !r.success).length;
    } catch {
      // Metrics may not exist
    }
  }

  // Storage counts
  const sessionCount = countFiles(join(harnessDir, 'memory', 'sessions'), mdFilter);
  const journalCount = countFiles(join(harnessDir, 'memory', 'journal'), mdFilter);
  const weeklyCount = countFiles(join(harnessDir, 'memory', 'journal', 'weekly'), mdFilter);

  // Count primitives across core dirs
  const primitiveDirs = ['rules', 'instincts', 'skills', 'playbooks', 'workflows', 'tools', 'agents'];
  let primitiveCount = 0;
  for (const dir of primitiveDirs) {
    primitiveCount += countFiles(join(harnessDir, dir), mdFilter);
  }

  // MCP server info
  const mcpServers = config?.mcp?.servers ?? {};
  const mcpEntries = Object.entries(mcpServers);
  const mcpValidationErrors = config ? validateMcpConfig(config) : [];
  const mcpErrorMap = new Map(mcpValidationErrors.map((e) => [e.server, e.error]));

  const mcpServerList = mcpEntries.map(([name, s]) => ({
    name,
    transport: s.transport,
    enabled: s.enabled !== false,
    valid: !mcpErrorMap.has(name),
    ...(mcpErrorMap.has(name) ? { error: mcpErrorMap.get(name) } : {}),
  }));

  return {
    timestamp: now,
    agent: {
      name: agentName,
      version: agentVersion,
      mode: state.mode,
      lastInteraction: state.last_interaction,
    },
    health,
    spending: {
      today: spendingToday,
      thisMonth: spendingMonth,
      allTime: spendingAll,
    },
    sessions: {
      total: totalSessions,
      totalTokens,
      avgTokensPerSession,
      delegationCount,
    },
    workflows: {
      totalRuns: wfTotalRuns,
      totalSuccesses: wfTotalSuccesses,
      totalFailures: wfTotalFailures,
      overallSuccessRate: wfTotalRuns > 0 ? wfTotalSuccesses / wfTotalRuns : 0,
      stats: workflowStats,
    },
    storage: {
      sessionCount,
      journalCount,
      weeklyCount,
      primitiveCount,
    },
    mcp: {
      serverCount: mcpEntries.length,
      enabledCount: mcpServerList.filter((s) => s.enabled).length,
      servers: mcpServerList,
    },
  };
}

/**
 * Format a telemetry snapshot as a human-readable dashboard string.
 */
export function formatDashboard(snapshot: TelemetrySnapshot): string {
  const lines: string[] = [];

  // Header
  const statusIcon = snapshot.health.status === 'healthy' ? 'OK' : snapshot.health.status === 'degraded' ? 'WARN' : 'FAIL';
  lines.push(`  ${snapshot.agent.name} v${snapshot.agent.version} | ${statusIcon} | mode: ${snapshot.agent.mode}`);
  lines.push(`  Last interaction: ${snapshot.agent.lastInteraction}`);
  lines.push('');

  // Health checks
  lines.push('  Health Checks');
  for (const check of snapshot.health.checks) {
    const icon = check.status === 'pass' ? '+' : check.status === 'warn' ? '!' : 'x';
    lines.push(`    [${icon}] ${check.name}: ${check.message}`);
  }
  lines.push('');

  // Spending
  const todayCost = snapshot.spending.today.total_cost_usd;
  const monthCost = snapshot.spending.thisMonth.total_cost_usd;
  const allTimeCost = snapshot.spending.allTime.total_cost_usd;
  lines.push('  Spending');
  lines.push(`    Today:    $${todayCost.toFixed(6)} (${snapshot.spending.today.entries} calls)`);
  lines.push(`    Month:    $${monthCost.toFixed(6)} (${snapshot.spending.thisMonth.entries} calls)`);
  lines.push(`    All time: $${allTimeCost.toFixed(6)} (${snapshot.spending.allTime.entries} calls)`);

  // Model breakdown (today)
  const todayModels = Object.entries(snapshot.spending.today.by_model);
  if (todayModels.length > 0) {
    lines.push('    By model (today):');
    for (const [model, data] of todayModels.sort((a, b) => b[1].cost_usd - a[1].cost_usd)) {
      lines.push(`      ${model}: $${data.cost_usd.toFixed(6)} (${data.count}x)`);
    }
  }
  lines.push('');

  // Sessions
  lines.push('  Sessions');
  lines.push(`    Total: ${snapshot.sessions.total} | Tokens: ${snapshot.sessions.totalTokens.toLocaleString()} | Avg: ${snapshot.sessions.avgTokensPerSession.toLocaleString()}/session`);
  if (snapshot.sessions.delegationCount > 0) {
    lines.push(`    Delegations: ${snapshot.sessions.delegationCount}`);
  }
  lines.push('');

  // Workflows
  if (snapshot.workflows.totalRuns > 0 || snapshot.workflows.stats.length > 0) {
    const successRate = (snapshot.workflows.overallSuccessRate * 100).toFixed(0);
    lines.push('  Workflows');
    lines.push(`    Runs: ${snapshot.workflows.totalRuns} (${successRate}% success) | ${snapshot.workflows.totalSuccesses} ok, ${snapshot.workflows.totalFailures} failed`);
    for (const s of snapshot.workflows.stats.slice(0, 5)) {
      const rate = (s.success_rate * 100).toFixed(0);
      lines.push(`    ${s.workflow_id}: ${s.total_runs} runs (${rate}%) | last: ${s.last_run}`);
    }
    if (snapshot.workflows.stats.length > 5) {
      lines.push(`    ... and ${snapshot.workflows.stats.length - 5} more`);
    }
    lines.push('');
  }

  // MCP
  if (snapshot.mcp.serverCount > 0) {
    lines.push('  MCP Servers');
    lines.push(`    Configured: ${snapshot.mcp.serverCount} | Enabled: ${snapshot.mcp.enabledCount}`);
    for (const server of snapshot.mcp.servers) {
      const status = !server.enabled ? '-' : server.valid ? '+' : '!';
      const error = server.error ? ` (${server.error})` : '';
      lines.push(`    [${status}] ${server.name} (${server.transport})${error}`);
    }
    lines.push('');
  }

  // Storage
  lines.push('  Storage');
  lines.push(`    Sessions: ${snapshot.storage.sessionCount} | Journals: ${snapshot.storage.journalCount} | Weekly: ${snapshot.storage.weeklyCount} | Primitives: ${snapshot.storage.primitiveCount}`);
  lines.push('');

  // Run health
  const m = snapshot.health.metrics;
  lines.push('  Run Health');
  lines.push(`    Total: ${m.totalRuns} | Success: ${m.totalSuccesses} | Fail: ${m.totalFailures} | Consecutive failures: ${m.consecutiveFailures}`);
  if (m.bootedAt) lines.push(`    Booted: ${m.bootedAt}`);
  if (m.lastSuccessfulRun) lines.push(`    Last success: ${m.lastSuccessfulRun}`);
  if (m.lastFailedRun) lines.push(`    Last failure: ${m.lastFailedRun}`);
  if (m.lastError) {
    const isStale = m.lastSuccessfulRun && m.lastFailedRun
      && new Date(m.lastSuccessfulRun) > new Date(m.lastFailedRun);
    const marker = isStale ? ' (stale — succeeded since)' : '';
    lines.push(`    Last error: ${m.lastError.slice(0, 120)}${marker}`);
  }

  return lines.join('\n');
}
