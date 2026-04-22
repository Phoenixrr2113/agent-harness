import cron from 'node-cron';
import { existsSync } from 'fs';
import { join } from 'path';
import { loadDirectory, parseHarnessDocument } from '../primitives/loader.js';
import { loadConfig } from '../core/config.js';
import { createHarness } from '../core/harness.js';
import { delegateTo } from './delegate.js';
import { archiveOldFiles } from './sessions.js';
import { recordRun } from './metrics.js';
import { log } from '../core/logger.js';
import { recordSuccess, recordFailure } from './health.js';
import { synthesizeJournal, listUnjournaled } from './journal.js';
import { learnFromSessions } from './instinct-learner.js';
import type { HarnessConfig, HarnessDocument } from '../core/types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if the current time falls within quiet hours.
 * Quiet hours wrap around midnight (e.g. start: 23, end: 6 means 23:00–05:59).
 * Returns true if the agent should be quiet (no scheduled workflows).
 */
export function isQuietHours(
  config: HarnessConfig,
  now?: Date,
): boolean {
  const { start, end } = config.runtime.quiet_hours;
  const tz = config.runtime.timezone;

  // Get current hour in the configured timezone
  let hour: number;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: tz,
    });
    hour = parseInt(formatter.format(now ?? new Date()), 10);
  } catch {
    // Fallback to local time if timezone is invalid
    hour = (now ?? new Date()).getHours();
  }

  if (start === end) return false; // No quiet hours configured
  if (start < end) {
    // Simple range (e.g., start: 8, end: 17 means 8:00–16:59)
    return hour >= start && hour < end;
  }
  // Wraps midnight (e.g., start: 23, end: 6 means 23:00–05:59)
  return hour >= start || hour < end;
}

export interface ScheduledWorkflow {
  doc: HarnessDocument;
  cronExpression: string;
  task: ReturnType<typeof cron.schedule> | null;
}

export interface SchedulerOptions {
  harnessDir: string;
  apiKey?: string;
  /** Enable daily auto-archival of expired sessions/journals (default: true) */
  autoArchival?: boolean;
  /** Cron expression for auto-archival (default: "0 23 * * *" = daily at 23:00) */
  archivalCron?: string;
  /** Enable auto-journal synthesis (cron string or true for default "0 22 * * *") */
  autoJournal?: boolean | string;
  /** Enable auto-learn after journal synthesis (default: false) */
  autoLearn?: boolean;
  onRun?: (workflowId: string, result: string) => void;
  onError?: (workflowId: string, error: Error) => void;
  onSchedule?: (workflowId: string, cron: string) => void;
  onSkipQuietHours?: (workflowId: string) => void;
  onArchival?: (sessionsArchived: number, journalsArchived: number) => void;
  onRetry?: (workflowId: string, attempt: number, maxRetries: number, error: Error) => void;
  onJournal?: (date: string, sessionsCount: number) => void;
  onLearn?: (installed: number, skipped: number) => void;
}

export class Scheduler {
  private workflows: Map<string, ScheduledWorkflow> = new Map();
  private harnessDir: string;
  private apiKey?: string;
  private autoArchival: boolean;
  private archivalCron: string;
  private archivalTask: ReturnType<typeof cron.schedule> | null = null;
  private autoJournal: boolean | string;
  private autoLearn: boolean;
  private journalTask: ReturnType<typeof cron.schedule> | null = null;
  /** Tracks proactive executions: workflowId → timestamps of recent runs */
  private proactiveHistory: Map<string, number[]> = new Map();
  private onRun?: (workflowId: string, result: string) => void;
  private onError?: (workflowId: string, error: Error) => void;
  private onSchedule?: (workflowId: string, cron: string) => void;
  private onSkipQuietHours?: (workflowId: string) => void;
  private onArchival?: (sessionsArchived: number, journalsArchived: number) => void;
  private onRetry?: (workflowId: string, attempt: number, maxRetries: number, error: Error) => void;
  private onJournal?: (date: string, sessionsCount: number) => void;
  private onLearn?: (installed: number, skipped: number) => void;
  private running = false;

  constructor(options: SchedulerOptions) {
    this.harnessDir = options.harnessDir;
    this.apiKey = options.apiKey;
    this.autoArchival = options.autoArchival ?? true;
    this.archivalCron = options.archivalCron ?? '0 23 * * *';
    this.autoJournal = options.autoJournal ?? false;
    this.autoLearn = options.autoLearn ?? false;
    this.onRun = options.onRun;
    this.onError = options.onError;
    this.onSchedule = options.onSchedule;
    this.onSkipQuietHours = options.onSkipQuietHours;
    this.onArchival = options.onArchival;
    this.onRetry = options.onRetry;
    this.onJournal = options.onJournal;
    this.onLearn = options.onLearn;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // Schedule auto-archival
    if (this.autoArchival && cron.validate(this.archivalCron)) {
      this.archivalTask = cron.schedule(this.archivalCron, () => {
        this.runArchival();
      });
      log.debug(`Auto-archival scheduled: ${this.archivalCron}`);
    }

    // Schedule auto-journal synthesis
    if (this.autoJournal) {
      const journalCron = typeof this.autoJournal === 'string' ? this.autoJournal : '0 22 * * *';
      if (cron.validate(journalCron)) {
        this.journalTask = cron.schedule(journalCron, () => {
          void this.runJournalSynthesis();
        });
        log.debug(`Auto-journal scheduled: ${journalCron}${this.autoLearn ? ' (with auto-learn)' : ''}`);
      } else {
        log.warn(`Invalid auto_journal cron: ${journalCron}`);
      }
    }

    // Load all workflows
    const workflowDir = join(this.harnessDir, 'workflows');
    if (!existsSync(workflowDir)) return;

    const docs = loadDirectory(workflowDir);

    // Boot-time resume: drain any incomplete durable runs from a previous
    // process crash or sleep-expired suspension. Runs in parallel with cron
    // registration below so a slow resume doesn't hold up new schedules.
    void this.drainResumableRuns(docs);

    for (const doc of docs) {
      const cronExpr = doc.frontmatter.schedule;
      if (!cronExpr) continue;

      if (!cron.validate(cronExpr)) {
        try { this.onError?.(doc.frontmatter.id, new Error(`Invalid cron expression: ${cronExpr}`)); } catch (e) {
          log.warn(`onError hook failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }

      const task = cron.schedule(cronExpr, async () => {
        await this.executeWorkflow(doc);
      });

      this.workflows.set(doc.frontmatter.id, { doc, cronExpression: cronExpr, task });
      try { this.onSchedule?.(doc.frontmatter.id, cronExpr); } catch (e) {
        log.warn(`onSchedule hook failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private async drainResumableRuns(docs: HarnessDocument[]): Promise<void> {
    try {
      const { scanResumableRuns, durableRun } = await import('./durable-engine.js');
      const resumable = scanResumableRuns(this.harnessDir);
      if (resumable.length === 0) return;
      log.info(`Found ${resumable.length} resumable durable run(s)`);
      for (const summary of resumable) {
        const doc = docs.find((d) => d.frontmatter.id === summary.workflowId);
        if (!doc) {
          log.warn(`Resumable run ${summary.runId} references unknown workflow ${summary.workflowId} — skipping`);
          continue;
        }
        const prompt = `Execute this workflow:\n\n${doc.body}`;
        try {
          await durableRun({
            harnessDir: this.harnessDir,
            workflowId: summary.workflowId,
            prompt,
            resumeRunId: summary.runId,
            ...(this.apiKey ? { apiKey: this.apiKey } : {}),
          });
          log.info(`Resumed run ${summary.runId} (workflow ${summary.workflowId})`);
        } catch (err) {
          log.warn(`Failed to resume run ${summary.runId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      log.warn(`Boot-time resume scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.archivalTask) {
      this.archivalTask.stop();
      this.archivalTask = null;
    }

    if (this.journalTask) {
      this.journalTask.stop();
      this.journalTask = null;
    }

    for (const [, workflow] of this.workflows) {
      workflow.task?.stop();
    }
    this.workflows.clear();
    this.proactiveHistory.clear();
  }

  async executeWorkflow(doc: HarnessDocument): Promise<string> {
    const workflowId = doc.frontmatter.id;

    // Check quiet hours — skip scheduled workflows during quiet time
    const config = loadConfig(this.harnessDir);
    if (isQuietHours(config)) {
      log.debug(`Skipping workflow "${workflowId}" — quiet hours active`);
      try { this.onSkipQuietHours?.(workflowId); } catch (e) {
        log.warn(`onSkipQuietHours hook failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return '';
    }

    // Check proactive cooldown — if workflow has proactive: true in frontmatter
    const isProactive = (doc.frontmatter as Record<string, unknown>)['proactive'] === true;
    if (isProactive && !this.checkProactiveCooldown(workflowId, config)) {
      log.debug(`Skipping proactive workflow "${workflowId}" — rate limited or in cooldown`);
      return '';
    }

    const maxRetries = doc.frontmatter.max_retries ?? 0;
    const baseDelay = doc.frontmatter.retry_delay_ms ?? 1000;
    let lastError: Error | null = null;
    const startTime = Date.now();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // The workflow body IS the prompt — it describes what to do
        const prompt = `Execute this workflow:\n\n${doc.body}`;

        let resultText: string;
        let tokensUsed: number;

        const isDurable =
          doc.frontmatter.durable === true ||
          (config as unknown as { workflows?: { durable_default?: boolean } }).workflows?.durable_default === true;

        // If workflow has a `with:` field, delegate to that sub-agent
        const delegateAgentId = doc.frontmatter.with;
        if (delegateAgentId) {
          log.debug(`Workflow "${workflowId}" delegating to agent "${delegateAgentId}"`);
          const delegateResult = await delegateTo({
            harnessDir: this.harnessDir,
            agentId: delegateAgentId,
            prompt,
            apiKey: this.apiKey,
          });
          resultText = delegateResult.text;
          tokensUsed = delegateResult.usage.totalTokens;
        } else if (isDurable) {
          const { durableRun } = await import('./durable-engine.js');
          const durable = await durableRun({
            harnessDir: this.harnessDir,
            workflowId,
            prompt,
            ...(this.apiKey ? { apiKey: this.apiKey } : {}),
          });
          log.info(`→ Durable run: ${durable.runId} (${durable.resumed ? 'resumed' : 'new'})`);
          resultText = durable.text;
          tokensUsed = durable.usage.totalTokens;
        } else {
          const agent = createHarness({
            dir: this.harnessDir,
            apiKey: this.apiKey,
          });
          const result = await agent.run(prompt);
          await agent.shutdown();
          resultText = result.text;
          tokensUsed = result.usage.totalTokens;
        }

        // Record success in health metrics
        recordSuccess(this.harnessDir);

        // Record successful run
        const endTime = Date.now();
        recordRun(this.harnessDir, {
          workflow_id: workflowId,
          started: new Date(startTime).toISOString(),
          ended: new Date(endTime).toISOString(),
          duration_ms: endTime - startTime,
          success: true,
          tokens_used: tokensUsed,
          attempt: attempt + 1,
          max_retries: maxRetries,
        });

        try { this.onRun?.(workflowId, resultText); } catch (e) {
          log.warn(`onRun hook failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return resultText;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < maxRetries) {
          // Exponential backoff: baseDelay * 2^attempt
          const delay = baseDelay * Math.pow(2, attempt);
          log.debug(`Workflow "${workflowId}" failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms`);
          try { this.onRetry?.(workflowId, attempt + 1, maxRetries, lastError); } catch (e) {
            log.warn(`onRetry hook failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          await sleep(delay);
        }
      }
    }

    // Record failure in health metrics
    recordFailure(this.harnessDir, lastError?.message);

    // Record failed run
    const endTime = Date.now();
    recordRun(this.harnessDir, {
      workflow_id: workflowId,
      started: new Date(startTime).toISOString(),
      ended: new Date(endTime).toISOString(),
      duration_ms: endTime - startTime,
      success: false,
      error: lastError?.message,
      attempt: maxRetries + 1,
      max_retries: maxRetries,
    });

    // All attempts exhausted
    try { this.onError?.(workflowId, lastError!); } catch (e) {
      log.warn(`onError hook failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    throw lastError;
  }

  async runOnce(workflowId: string): Promise<string> {
    const workflowDir = join(this.harnessDir, 'workflows');
    const filePath = join(workflowDir, `${workflowId}.md`);

    if (!existsSync(filePath)) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    const doc = parseHarnessDocument(filePath);
    return this.executeWorkflow(doc);
  }

  listScheduled(): Array<{ id: string; cron: string; path: string }> {
    return Array.from(this.workflows.entries()).map(([id, w]) => ({
      id,
      cron: w.cronExpression,
      path: w.doc.path,
    }));
  }

  /** Run archival of expired sessions/journals based on config retention policy. */
  runArchival(): void {
    try {
      const config = loadConfig(this.harnessDir);
      const result = archiveOldFiles(
        this.harnessDir,
        config.memory.session_retention_days,
        config.memory.journal_retention_days,
      );
      const total = result.sessionsArchived + result.journalsArchived;
      if (total > 0) {
        log.info(`Archived ${result.sessionsArchived} session(s), ${result.journalsArchived} journal(s)`);
      }
      try { this.onArchival?.(result.sessionsArchived, result.journalsArchived); } catch (e) {
        log.warn(`onArchival hook failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error(`Archival failed: ${error.message}`);
      try { this.onError?.('__archival__', error); } catch (e) {
        log.warn(`onError hook failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * Synthesize today's journal from unjournaled sessions.
   * Optionally runs instinct learning after synthesis if auto_learn is enabled.
   */
  async runJournalSynthesis(): Promise<void> {
    try {
      const unjournaled = listUnjournaled(this.harnessDir);
      if (unjournaled.length === 0) {
        log.debug('Auto-journal: no unjournaled sessions, skipping');
        return;
      }

      // Synthesize today's journal
      const today = new Date().toISOString().slice(0, 10);
      log.info(`Auto-journal: synthesizing ${unjournaled.length} unjournaled date(s)`);
      const entry = await synthesizeJournal(this.harnessDir, today, this.apiKey);

      try { this.onJournal?.(today, entry.sessions.length); } catch (e) {
        log.warn(`onJournal hook failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Auto-learn if enabled
      if (this.autoLearn) {
        log.info('Auto-learn: running instinct learning after journal synthesis');
        const learnResult = await learnFromSessions(this.harnessDir, true, this.apiKey);
        try { this.onLearn?.(learnResult.installed.length, learnResult.skipped.length); } catch (e) {
          log.warn(`onLearn hook failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error(`Auto-journal failed: ${error.message}`);
      try { this.onError?.('__auto_journal__', error); } catch (e) {
        log.warn(`onError hook failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * Check if a proactive workflow is allowed to run based on rate limits and cooldown.
   * Returns true if the workflow should proceed, false if it should be skipped.
   */
  checkProactiveCooldown(workflowId: string, config: HarnessConfig): boolean {
    const proactive = config.proactive;
    if (!proactive?.enabled) return true; // proactive not enabled — no restrictions

    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
    const cooldownMs = (proactive.cooldown_minutes ?? 30) * 60_000;
    const maxPerHour = proactive.max_per_hour ?? 5;

    // Get or create history for this workflow
    let history = this.proactiveHistory.get(workflowId);
    if (!history) {
      history = [];
      this.proactiveHistory.set(workflowId, history);
    }

    // Prune entries older than 1 hour
    const recent = history.filter(ts => ts > oneHourAgo);
    this.proactiveHistory.set(workflowId, recent);

    // Check hourly rate limit
    if (recent.length >= maxPerHour) {
      log.debug(`Proactive cooldown: ${workflowId} hit max_per_hour (${maxPerHour})`);
      return false;
    }

    // Check cooldown since last run
    if (recent.length > 0) {
      const lastRun = recent[recent.length - 1];
      if (now - lastRun < cooldownMs) {
        log.debug(`Proactive cooldown: ${workflowId} within cooldown (${proactive.cooldown_minutes}min)`);
        return false;
      }
    }

    // Allowed — record this execution
    recent.push(now);
    return true;
  }

  isRunning(): boolean {
    return this.running;
  }
}
