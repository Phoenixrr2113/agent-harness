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
  onRun?: (workflowId: string, result: string) => void;
  onError?: (workflowId: string, error: Error) => void;
  onSchedule?: (workflowId: string, cron: string) => void;
  onSkipQuietHours?: (workflowId: string) => void;
  onArchival?: (sessionsArchived: number, journalsArchived: number) => void;
  onRetry?: (workflowId: string, attempt: number, maxRetries: number, error: Error) => void;
}

export class Scheduler {
  private workflows: Map<string, ScheduledWorkflow> = new Map();
  private harnessDir: string;
  private apiKey?: string;
  private autoArchival: boolean;
  private archivalCron: string;
  private archivalTask: ReturnType<typeof cron.schedule> | null = null;
  private onRun?: (workflowId: string, result: string) => void;
  private onError?: (workflowId: string, error: Error) => void;
  private onSchedule?: (workflowId: string, cron: string) => void;
  private onSkipQuietHours?: (workflowId: string) => void;
  private onArchival?: (sessionsArchived: number, journalsArchived: number) => void;
  private onRetry?: (workflowId: string, attempt: number, maxRetries: number, error: Error) => void;
  private running = false;

  constructor(options: SchedulerOptions) {
    this.harnessDir = options.harnessDir;
    this.apiKey = options.apiKey;
    this.autoArchival = options.autoArchival ?? true;
    this.archivalCron = options.archivalCron ?? '0 23 * * *';
    this.onRun = options.onRun;
    this.onError = options.onError;
    this.onSchedule = options.onSchedule;
    this.onSkipQuietHours = options.onSkipQuietHours;
    this.onArchival = options.onArchival;
    this.onRetry = options.onRetry;
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

    // Load all workflows
    const workflowDir = join(this.harnessDir, 'workflows');
    if (!existsSync(workflowDir)) return;

    const docs = loadDirectory(workflowDir);

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

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.archivalTask) {
      this.archivalTask.stop();
      this.archivalTask = null;
    }

    for (const [, workflow] of this.workflows) {
      workflow.task?.stop();
    }
    this.workflows.clear();
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

  isRunning(): boolean {
    return this.running;
  }
}
