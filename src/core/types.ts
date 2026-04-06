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
export interface HarnessConfig {
  agent: {
    name: string;
    version: string;
  };
  model: {
    provider: string;
    id: string;
    max_tokens: number;
  };
  runtime: {
    scratchpad_budget: number;
    heartbeat?: string;
    daily_summary?: string;
    quiet_hours: {
      start: number;
      end: number;
    };
    timezone: string;
  };
  memory: {
    session_retention_days: number;
    journal_retention_days: number;
  };
  channels: {
    primary: string;
  };
}

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
  model?: string;
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
