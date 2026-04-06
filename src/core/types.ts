import { z } from 'zod';

// --- Frontmatter ---
export const FrontmatterSchema = z.object({
  id: z.string(),
  tags: z.array(z.string()).default([]),
  created: z.string().optional(),
  updated: z.string().optional(),
  author: z.enum(['human', 'agent', 'infrastructure']).default('human'),
  status: z.enum(['active', 'archived', 'deprecated', 'draft']).default('active'),
  related: z.array(z.string()).default([]),
  schedule: z.string().optional(),
  with: z.string().optional(),
  channel: z.string().optional(),
  duration_minutes: z.number().optional(),
});

export type Frontmatter = z.infer<typeof FrontmatterSchema>;

// --- Primitive Document ---
export interface HarnessDocument {
  path: string;
  frontmatter: Frontmatter;
  l0: string;
  l1: string;
  body: string;
  raw: string;
}

// --- Primitive Types ---
export type PrimitiveType =
  | 'rule'
  | 'instinct'
  | 'skill'
  | 'playbook'
  | 'workflow'
  | 'tool'
  | 'agent'
  | 'session'
  | 'journal';

export interface Primitive {
  type: PrimitiveType;
  doc: HarnessDocument;
}

// --- Config ---
export const HarnessConfigSchema = z.object({
  agent: z.object({
    name: z.string().min(1),
    version: z.string().default('0.1.0'),
  }).passthrough(),
  model: z.object({
    provider: z.string().default('openrouter'),
    id: z.string().min(1),
    max_tokens: z.number().int().positive().default(200000),
  }).passthrough(),
  runtime: z.object({
    scratchpad_budget: z.number().int().nonnegative().default(10000),
    heartbeat: z.string().optional(),
    daily_summary: z.string().optional(),
    quiet_hours: z.object({
      start: z.number().int().min(0).max(23).default(23),
      end: z.number().int().min(0).max(23).default(6),
    }).passthrough().default({ start: 23, end: 6 }),
    timezone: z.string().default('America/New_York'),
  }).passthrough(),
  memory: z.object({
    session_retention_days: z.number().int().positive().default(7),
    journal_retention_days: z.number().int().positive().default(365),
  }).passthrough(),
  channels: z.object({
    primary: z.string().default('cli'),
  }).passthrough(),
}).passthrough();

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

export const CONFIG_DEFAULTS: HarnessConfig = {
  agent: { name: 'agent', version: '0.1.0' },
  model: { provider: 'openrouter', id: 'anthropic/claude-sonnet-4', max_tokens: 200000 },
  runtime: {
    scratchpad_budget: 10000,
    quiet_hours: { start: 23, end: 6 },
    timezone: 'America/New_York',
  },
  memory: { session_retention_days: 7, journal_retention_days: 365 },
  channels: { primary: 'cli' },
};

// --- Agent State ---
export interface AgentState {
  mode: string;
  goals: string[];
  active_workflows: string[];
  last_interaction: string;
  unfinished_business: string[];
}

// --- Context Budget ---
export interface ContextBudget {
  max_tokens: number;
  used_tokens: number;
  remaining: number;
  loaded_files: string[];
}

// --- Agent Options (programmatic API) ---
export interface CreateHarnessOptions {
  dir: string;
  /** Model ID override (e.g., "claude-sonnet-4-20250514" or "gpt-4o") */
  model?: string;
  /** Provider override (e.g., "anthropic", "openai", "openrouter") */
  provider?: string;
  apiKey?: string;
  config?: Partial<HarnessConfig>;
}

// --- Agent Interface ---
export interface AgentRunResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  session_id: string;
  steps: number;
}

export interface HarnessAgent {
  name: string;
  config: HarnessConfig;
  boot(): Promise<void>;
  run(prompt: string): Promise<AgentRunResult>;
  stream(prompt: string): AsyncIterable<string>;
  shutdown(): Promise<void>;
  getSystemPrompt(): string;
  getState(): AgentState;
}

// --- Index Entry ---
export interface IndexEntry {
  id: string;
  path: string;
  tags: string[];
  l0: string;
  created: string;
  status: string;
}
