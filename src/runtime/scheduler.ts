import cron from 'node-cron';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { loadDirectory, parseHarnessDocument } from '../primitives/loader.js';
import { loadConfig } from '../core/config.js';
import { createHarness } from '../core/harness.js';
import type { HarnessConfig, HarnessDocument } from '../core/types.js';

export interface ScheduledWorkflow {
  doc: HarnessDocument;
  cronExpression: string;
  task: ReturnType<typeof cron.schedule> | null;
}

export interface SchedulerOptions {
  harnessDir: string;
  apiKey?: string;
  onRun?: (workflowId: string, result: string) => void;
  onError?: (workflowId: string, error: Error) => void;
  onSchedule?: (workflowId: string, cron: string) => void;
}

export class Scheduler {
  private workflows: Map<string, ScheduledWorkflow> = new Map();
  private harnessDir: string;
  private apiKey?: string;
  private onRun?: (workflowId: string, result: string) => void;
  private onError?: (workflowId: string, error: Error) => void;
  private onSchedule?: (workflowId: string, cron: string) => void;
  private running = false;

  constructor(options: SchedulerOptions) {
    this.harnessDir = options.harnessDir;
    this.apiKey = options.apiKey;
    this.onRun = options.onRun;
    this.onError = options.onError;
    this.onSchedule = options.onSchedule;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

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

    for (const [id, workflow] of this.workflows) {
      workflow.task?.stop();
    }
    this.workflows.clear();
  }

  async executeWorkflow(doc: HarnessDocument): Promise<string> {
    const workflowId = doc.frontmatter.id;

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

  isRunning(): boolean {
    return this.running;
  }
}
