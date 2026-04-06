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
  max_retries: z.number().int().nonnegative().optional(),
  retry_delay_ms: z.number().int().positive().optional(),
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
    max_retries: z.number().int().nonnegative().default(2),
    timeout_ms: z.number().int().positive().optional(),
    /** Cheap model for auto-generating summaries, tags, frontmatter (e.g. 'google/gemini-flash-1.5') */
    summary_model: z.string().optional(),
    /** Fast model for validation, checks, and quick decisions (e.g. 'google/gemini-flash-1.5') */
    fast_model: z.string().optional(),
  }).passthrough(),
  runtime: z.object({
    scratchpad_budget: z.number().int().nonnegative().default(10000),
    /** Reserved: cron expression for periodic heartbeat check (not yet implemented) */
    heartbeat: z.string().optional(),
    /** Reserved: cron expression for daily summary generation (not yet implemented) */
    daily_summary: z.string().optional(),
    /** Auto-process primitives on save: generate frontmatter, L0/L1 summaries (default: true) */
    auto_process: z.boolean().default(true),
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
  extensions: z.object({
    directories: z.array(z.string()).default([]),
  }).passthrough().default({ directories: [] }),
  rate_limits: z.object({
    /** Max LLM calls per minute (default: unlimited) */
    per_minute: z.number().int().positive().optional(),
    /** Max LLM calls per hour (default: unlimited) */
    per_hour: z.number().int().positive().optional(),
    /** Max LLM calls per day (default: unlimited) */
    per_day: z.number().int().positive().optional(),
  }).passthrough().default({}),
  budget: z.object({
    /** Max daily spend in USD (default: unlimited) */
    daily_limit_usd: z.number().positive().optional(),
    /** Max monthly spend in USD (default: unlimited) */
    monthly_limit_usd: z.number().positive().optional(),
    /** Block runs when budget exceeded (default: true) */
    enforce: z.boolean().default(true),
  }).passthrough().default({ enforce: true }),
  mcp: z.object({
    /** MCP server definitions keyed by server name */
    servers: z.record(z.string(), z.object({
      /** Transport type: 'stdio' for local processes, 'http' for remote, 'sse' for SSE */
      transport: z.enum(['stdio', 'http', 'sse']),
      /** Command to spawn (stdio transport only) */
      command: z.string().optional(),
      /** Command arguments (stdio transport only) */
      args: z.array(z.string()).optional(),
      /** Environment variables for the spawned process (stdio transport only) */
      env: z.record(z.string(), z.string()).optional(),
      /** Working directory for the spawned process (stdio transport only) */
      cwd: z.string().optional(),
      /** URL endpoint (http/sse transport only) */
      url: z.string().optional(),
      /** Additional HTTP headers (http/sse transport only) */
      headers: z.record(z.string(), z.string()).optional(),
      /** Whether this server is enabled (default: true) */
      enabled: z.boolean().default(true),
    }).passthrough()).default({}),
  }).passthrough().default({ servers: {} }),
  /** Intelligence & continuous learning config */
  intelligence: z.object({
    /** Auto-run journal synthesis on a cron schedule (default: off). Set to cron string e.g. "0 22 * * *" or true for default "0 22 * * *". */
    auto_journal: z.union([z.boolean(), z.string()]).default(false),
    /** Auto-run instinct learning after journal synthesis (default: off) */
    auto_learn: z.boolean().default(false),
  }).passthrough().default({ auto_journal: false, auto_learn: false }),
  /** Proactive execution config (scheduler rate-limiting) */
  proactive: z.object({
    /** Enable proactive scheduled workflows (default: false) */
    enabled: z.boolean().default(false),
    /** Max proactive workflow executions per hour (default: 5) */
    max_per_hour: z.number().int().positive().default(5),
    /** Cooldown in minutes between proactive runs of the same workflow (default: 30) */
    cooldown_minutes: z.number().int().nonnegative().default(30),
    /** Override quiet hours for proactive execution (start/end hours, inherits runtime.quiet_hours if not set) */
    quiet_hours: z.object({
      start: z.number().int().min(0).max(23).optional(),
      end: z.number().int().min(0).max(23).optional(),
    }).passthrough().optional(),
  }).passthrough().default({ enabled: false, max_per_hour: 5, cooldown_minutes: 30 }),
  /** Primitive bundle registries for search/install */
  registries: z.array(z.object({
    /** Registry URL (HTTPS endpoint) */
    url: z.string().url(),
    /** Optional display name */
    name: z.string().optional(),
    /** Optional auth token for private registries */
    token: z.string().optional(),
  }).passthrough()).default([]),
}).passthrough();

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

export const CONFIG_DEFAULTS: HarnessConfig = {
  agent: { name: 'agent', version: '0.1.0' },
  model: { provider: 'openrouter', id: 'anthropic/claude-sonnet-4', max_tokens: 200000, max_retries: 2 },
  runtime: {
    scratchpad_budget: 10000,
    auto_process: true,
    quiet_hours: { start: 23, end: 6 },
    timezone: 'America/New_York',
  },
  memory: { session_retention_days: 7, journal_retention_days: 365 },
  channels: { primary: 'cli' },
  extensions: { directories: [] },
  rate_limits: {},
  budget: { enforce: true },
  intelligence: { auto_journal: false, auto_learn: false },
  proactive: { enabled: false, max_per_hour: 5, cooldown_minutes: 30 },
  mcp: { servers: {} },
  registries: [],
};

export const CORE_PRIMITIVE_DIRS = ['rules', 'instincts', 'skills', 'playbooks', 'workflows', 'tools', 'agents'] as const;

export function getPrimitiveDirs(config?: HarnessConfig): string[] {
  const dirs: string[] = [...CORE_PRIMITIVE_DIRS];
  if (config?.extensions?.directories) {
    for (const dir of config.extensions.directories) {
      if (!dirs.includes(dir)) {
        dirs.push(dir);
      }
    }
  }
  return dirs;
}

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

// --- Utility Types ---
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

// --- Lifecycle Hooks ---
export interface HarnessHooks {
  /** Called after boot completes (context loaded, state ready) */
  onBoot?: (context: { agent: HarnessAgent; config: HarnessConfig; state: AgentState }) => void | Promise<void>;
  /** Called after each session completes (run or stream) */
  onSessionEnd?: (context: { agent: HarnessAgent; sessionId: string; prompt: string; result: AgentRunResult }) => void | Promise<void>;
  /** Called when an error occurs during run/stream */
  onError?: (context: { agent: HarnessAgent; error: Error; prompt?: string }) => void | Promise<void>;
  /** Called when agent state changes (boot, shutdown, after run) */
  onStateChange?: (context: { agent: HarnessAgent; previous: string; current: string }) => void | Promise<void>;
  /** Called before shutdown completes */
  onShutdown?: (context: { agent: HarnessAgent; state: AgentState }) => void | Promise<void>;
}

// --- Tool Executor Config (inline to avoid circular deps) ---
export interface ToolExecutorOptions {
  /** Maximum tool calls per run (default: 5) */
  maxToolCalls?: number;
  /** Timeout per tool call in ms (default: 30000) */
  toolTimeoutMs?: number;
  /** Whether to allow HTTP tool execution (default: true) */
  allowHttpExecution?: boolean;
}

// --- Agent Options (programmatic API) ---
export interface CreateHarnessOptions {
  dir: string;
  /** Model ID override (e.g., "claude-sonnet-4-20250514" or "gpt-4o") */
  model?: string;
  /** Provider override (e.g., "anthropic", "openai", "openrouter") */
  provider?: string;
  apiKey?: string;
  config?: DeepPartial<HarnessConfig>;
  /** Lifecycle hooks for agent events */
  hooks?: HarnessHooks;
  /** Tool execution configuration */
  toolExecutor?: ToolExecutorOptions;
}

/** Record of a single tool call made during a run */
export interface ToolCallInfo {
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
}

// --- Agent Interface ---
export interface AgentRunResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  session_id: string;
  steps: number;
  /** Tool calls made during the run (empty array if none) */
  toolCalls: ToolCallInfo[];
}

export interface AgentStreamResult {
  /** Async iterable of text chunks — consume with for-await */
  textStream: AsyncIterable<string>;
  /** Resolves after the stream is fully consumed with session metadata */
  result: Promise<AgentRunResult>;
}

export interface HarnessAgent {
  name: string;
  config: HarnessConfig;
  boot(): Promise<void>;
  run(prompt: string): Promise<AgentRunResult>;
  stream(prompt: string): AgentStreamResult;
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
