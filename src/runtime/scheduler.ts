import cron from 'node-cron';
import { existsSync } from 'fs';
import { join } from 'path';
import { loadDirectory, parseHarnessDocument } from '../primitives/loader.js';
import { loadConfig } from '../core/config.js';
import { createHarness } from '../core/harness.js';
import { archiveOldFiles } from './sessions.js';
import { log } from '../core/logger.js';
import type { HarnessConfig, HarnessDocument } from '../core/types.js';

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
        this.onError?.(doc.frontmatter.id, new Error(`Invalid cron expression: ${cronExpr}`));
        continue;
      }

      const task = cron.schedule(cronExpr, async () => {
        await this.executeWorkflow(doc);
      });

      this.workflows.set(doc.frontmatter.id, { doc, cronExpression: cronExpr, task });
      this.onSchedule?.(doc.frontmatter.id, cronExpr);
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
      this.onSkipQuietHours?.(workflowId);
      return '';
    }

    try {
      // Create a harness instance for this workflow execution
      const agent = createHarness({
        dir: this.harnessDir,
        apiKey: this.apiKey,
      });

      // The workflow body IS the prompt — it describes what to do
      const prompt = `Execute this workflow:\n\n${doc.body}`;
      const result = await agent.run(prompt);
      await agent.shutdown();

      this.onRun?.(workflowId, result.text);
      return result.text;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.onError?.(workflowId, error);
      throw error;
    }
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
      this.onArchival?.(result.sessionsArchived, result.journalsArchived);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error(`Archival failed: ${error.message}`);
      this.onError?.('__archival__', error);
    }
  }

  isRunning(): boolean {
    return this.running;
  }
}
