import { z } from 'zod';

// --- Frontmatter ---
/**
 * Which config.yaml model a sub-agent's LLM call should use when invoked
 * via `harness delegate`. Only meaningful on agent primitives.
 *
 * - 'primary' (default): config.model.id — same as `harness run`
 * - 'summary': config.model.summary_model (falls back to primary if unset)
 * - 'fast':    config.model.fast_model (falls back to summary → primary)
 *
 * All three use the SAME provider as the primary config. Multi-provider
 * sub-agents are explicitly not supported in this field — model ids are
 * provider-specific and a portable tier abstraction leaks. If you need a
 * different provider, that's a separate feature (backlog).
 */
export type AgentModelTier = 'primary' | 'summary' | 'fast';

/**
 * Slugify an Agent Skills `name` field (lowercase-hyphen) into a valid id.
 * "My Cool Skill" → "my-cool-skill". Used when a primitive file uses the
 * Agent Skills spec's `name` field and omits the legacy `id`.
 */
function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const FrontmatterInnerSchema = z.object({
  id: z.string(),
  /**
   * Agent Skills spec primary identifier (https://agentskills.io). When set
   * without an `id`, the loader derives `id = slugify(name)`. This field is
   * preserved in the parsed frontmatter so downstream code that wants the
   * original (e.g. for display) can access it.
   */
  name: z.string().optional(),
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
  /** Sub-agent only: which config model tier to use. See AgentModelTier above. */
  model: z.enum(['primary', 'summary', 'fast']).optional(),
  /**
   * Sub-agent only: whitelist of tool names this agent may call. When set,
   * narrows the inherited tool set to just these. Unknown names are silently
   * ignored by the AI SDK. See activeTools on generateText/streamText.
   */
  active_tools: z.array(z.string()).optional(),
  /**
   * Agent Skills spec summary + sub-agent tool description. Primitive loaders
   * use it for L1 fallback; sub-agent exposure uses it as the tool description.
   */
  description: z.string().optional(),
  /**
   * Workflow only: opt this workflow into durable execution (filesystem-backed
   * event log + step-result cache). When true, `scheduler.executeWorkflow`
   * routes the run through `durableRun()` instead of `agent.run()`.
   */
  durable: z.boolean().optional(),
  // --- Agent Skills spec optional fields (https://agentskills.io/specification) ---
  /** License string (SPDX id or free-form), e.g. "MIT". */
  license: z.string().optional(),
  /** Free-form compatibility hint, e.g. "claude-code >= 2.1". */
  compatibility: z.string().optional(),
  /** Opaque metadata bag for tool-specific extensions. */
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** Agent Skills spec: whitelist of tools this primitive may call. */
  'allowed-tools': z.array(z.string()).optional(),
});

/**
 * Frontmatter schema with Agent Skills dual-schema support: if a primitive
 * file omits `id` but provides `name` (the Agent Skills convention), the
 * loader auto-derives `id = slugify(name)` before validation. Legacy files
 * using `id` directly keep working unchanged.
 */
export const FrontmatterSchema = z.preprocess((input) => {
  if (typeof input !== 'object' || input === null) return input;
  const data = { ...(input as Record<string, unknown>) };
  if (!data.id && typeof data.name === 'string' && data.name.trim().length > 0) {
    data.id = slugifyName(data.name);
  }
  return data;
}, FrontmatterInnerSchema);

export type Frontmatter = z.infer<typeof FrontmatterSchema>;

// --- Primitive Document ---
export interface HarnessDocument {
  path: string;
  frontmatter: Frontmatter;
  l0: string;
  l1: string;
  body: string;
  raw: string;
  /**
   * Absolute path to the primitive's bundle directory, if this doc is the
   * entry-point of a multi-file bundle (e.g. `skills/my-skill/SKILL.md`).
   * Undefined for flat single-file primitives. Consumers can list/read other
   * files in this directory on demand — they are NOT auto-loaded into context.
   */
  bundleDir?: string;
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
    /**
     * Base URL override for the `openai` provider. Lets you point agent-harness
     * at any OpenAI-compatible endpoint: Cerebras Cloud, Groq, Together AI,
     * Fireworks, DeepInfra, a local vLLM, etc. Must include the API version
     * path segment (typically /v1).
     *
     * Examples:
     *   base_url: https://api.cerebras.ai/v1     (Cerebras, free dev tier)
     *   base_url: https://api.groq.com/openai/v1 (Groq)
     *   base_url: https://api.together.xyz/v1    (Together AI)
     *
     * The OpenAI provider uses this via createOpenAI({ baseURL }) and forces
     * the .chat() code path since not all OpenAI-compat providers implement
     * the Responses API. Ignored by other providers.
     */
    base_url: z.string().url().optional(),
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
    workflow_retention_days: z.number().int().positive().default(30),
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
  approval: z.object({
    /**
     * Whether tool approval is active. When true, tools listed in `tools`
     * pause for user confirmation before executing. Default true so new
     * scaffolds get safety out of the box; existing configs without an
     * `approval` section remain unchanged (zod defaults apply only when
     * the object is present).
     */
    enabled: z.boolean().default(true),
    /**
     * How to handle an approval request.
     *
     * - auto (default): prompt interactively if stdout is a TTY, else deny.
     * - interactive: always prompt (errors on non-TTY).
     * - deny: auto-deny every listed tool (useful for dry-run).
     * - allow: auto-approve every listed tool (bypasses the prompt,
     *   effectively disables approval — prefer `enabled: false`).
     */
    mode: z.enum(['auto', 'interactive', 'deny', 'allow']).default('auto'),
    /**
     * Tool names that require approval. Exact match against the tool's
     * registered name (MCP tools use their server-provided name, e.g.
     * `execute`, `write_file`, `edit_file`). Empty list = no tools
     * require approval even with enabled=true.
     */
    tools: z.array(z.string()).default([
      'execute',
      'write_file',
      'edit_file',
      'create_directory',
      'move_file',
    ]),
  }).passthrough().default({
    enabled: true,
    mode: 'auto',
    tools: ['execute', 'write_file', 'edit_file', 'create_directory', 'move_file'],
  }),
  reflection: z.object({
    /**
     * Reflection strategy — injects a self-critique directive into the
     * system prompt between steps.
     *
     * - none (default): no reflection injected; AI SDK behavior unchanged.
     * - every-step: every step AFTER the first gets the reflection directive.
     * - periodic: every `frequency` steps (default 3) get the directive,
     *   skipping step 0.
     *
     * Reflection costs tokens per step it fires on. On long runs, `periodic`
     * with frequency=3-5 is usually the right tradeoff.
     */
    strategy: z.enum(['none', 'every-step', 'periodic']).default('none'),
    /** How often to reflect in `periodic` strategy (default: 3). Ignored otherwise. */
    frequency: z.number().int().positive().optional(),
    /** Custom reflection directive — overrides the built-in template for the active strategy. */
    prompt_template: z.string().optional(),
  }).passthrough().default({ strategy: 'none' }),
  workflows: z.object({
    /**
     * Apply durable execution to every markdown workflow, even those without
     * `durable: true` in frontmatter. Default false — durability is opt-in.
     */
    durable_default: z.boolean().default(false),
  }).passthrough().default({ durable_default: false }),
  content_filters: z.object({
    /**
     * Apply output content filters to model text before returning to the caller.
     * Off by default — opt-in because filters cost a pass over the output and
     * can alter text in surprising ways if misconfigured.
     */
    enabled: z.boolean().default(false),
    /**
     * What to do when any filter fails.
     *
     * - filter (default): return the chained `filtered` text; continue silently.
     * - throw: raise ContentFilterBlockedError carrying the failure details.
     */
    on_block: z.enum(['filter', 'throw']).default('filter'),
    /**
     * Ordered list of filters to run. Each filter's `type` picks a built-in:
     *
     * - pii:    redacts SSN / credit card / email / phone (optional extra
     *           regex patterns via `patterns`). `redact: false` for detect-only.
     * - topic:  blocks text containing any supplied topic string (no redaction).
     * - length: caps `max_chars` (truncates) or `max_words` (fails without trunc).
     *
     * Filters run in order and later filters see earlier `filtered` output,
     * so PII redaction can feed a length cap.
     */
    filters: z.array(z.union([
      z.object({
        type: z.literal('pii'),
        redact: z.boolean().optional(),
        patterns: z.array(z.object({
          name: z.string(),
          pattern: z.string(),
          flags: z.string().optional(),
          replacement: z.string(),
        })).optional(),
      }).passthrough(),
      z.object({
        type: z.literal('topic'),
        blocked: z.array(z.string()).default([]),
      }).passthrough(),
      z.object({
        type: z.literal('length'),
        max_chars: z.number().int().positive().optional(),
        max_words: z.number().int().positive().optional(),
      }).passthrough(),
    ])).default([]),
  }).passthrough().default({ enabled: false, on_block: 'filter', filters: [] }),
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
      /**
       * Filter which tools from this server the agent sees. Useful for
       * keeping the total tool count small on agents that connect to many
       * MCP servers — model tool-selection accuracy degrades past ~20 tools.
       *
       * - `include`: allow-list. Only tools matching these names are kept.
       * - `exclude`: block-list. Named tools are removed (applied after include).
       *
       * Both fields match by exact tool name. Unknown names produce a warn-level
       * log so typos surface. When both fields are unset or empty, no filtering
       * is applied (current behavior).
       *
       * Example:
       *   tools:
       *     include: [read_text_file, write_file, edit_file, search_files]
       */
      tools: z.object({
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
      }).optional(),
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
  /**
   * License policy for `harness install <url>`. Controls how the universal
   * installer reacts to the license detected on a fetched primitive (Level 3
   * of task 12.14). Detection itself runs unconditionally — this only governs
   * what happens after the license is determined.
   */
  install: z.object({
    /**
     * SPDX ids the installer accepts without warning. Permissive defaults
     * cover the OSI-approved ecosystem most users care about. Add or remove
     * here to tighten or loosen the policy.
     */
    allowed_licenses: z.array(z.string()).default([
      'MIT',
      'Apache-2.0',
      'BSD-2-Clause',
      'BSD-3-Clause',
      'ISC',
      'MPL-2.0',
      'CC-BY-4.0',
      'CC0-1.0',
      'Unlicense',
    ]),
    /**
     * What to do when the detected license is not in `allowed_licenses` and
     * is not classified as PROPRIETARY. Includes the UNKNOWN case (no LICENSE
     * file found anywhere) and any non-permissive SPDX id like GPL-3.0.
     *
     * - allow:  install silently (legacy v0.1.3 behavior — safest for migration)
     * - warn:   install with a stderr warning naming the license_source
     * - prompt: ask Y/n on TTY; treats non-TTY as `block`
     * - block:  refuse the install with an error showing the override flag
     */
    on_unknown_license: z.enum(['allow', 'warn', 'prompt', 'block']).default('warn'),
    /**
     * What to do when the detected license is PROPRIETARY (text contains
     * "all rights reserved" or no permission grant). Defaults to `block`
     * because shipping proprietary content was the v0.1.0 yank cause.
     */
    on_proprietary: z.enum(['allow', 'warn', 'prompt', 'block']).default('block'),
  }).passthrough().default({
    allowed_licenses: [
      'MIT',
      'Apache-2.0',
      'BSD-2-Clause',
      'BSD-3-Clause',
      'ISC',
      'MPL-2.0',
      'CC-BY-4.0',
      'CC0-1.0',
      'Unlicense',
    ],
    on_unknown_license: 'warn',
    on_proprietary: 'block',
  }),
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
  memory: { session_retention_days: 7, journal_retention_days: 365, workflow_retention_days: 30 },
  channels: { primary: 'cli' },
  extensions: { directories: [] },
  rate_limits: {},
  budget: { enforce: true },
  approval: {
    enabled: true,
    mode: 'auto',
    tools: ['execute', 'write_file', 'edit_file', 'create_directory', 'move_file'],
  },
  reflection: { strategy: 'none' },
  workflows: { durable_default: false },
  content_filters: { enabled: false, on_block: 'filter', filters: [] },
  intelligence: { auto_journal: false, auto_learn: false },
  proactive: { enabled: false, max_per_hour: 5, cooldown_minutes: 30 },
  mcp: { servers: {} },
  registries: [],
  install: {
    allowed_licenses: [
      'MIT',
      'Apache-2.0',
      'BSD-2-Clause',
      'BSD-3-Clause',
      'ISC',
      'MPL-2.0',
      'CC-BY-4.0',
      'CC0-1.0',
      'Unlicense',
    ],
    on_unknown_license: 'warn',
    on_proprietary: 'block',
  },
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
  /**
   * Whitelist of tool names the model may call during this harness's runs.
   * Narrows the loaded tool set without unloading. Applies to both `run()` and
   * `stream()`; ignored when no tools are configured.
   */
  activeTools?: string[];
  /**
   * When true, disables the per-tool approval wrapper for this harness even
   * if config.approval.enabled is true. Used by CLI `--approve-all` and by
   * non-interactive contexts (e.g. scripted pipelines). Default false.
   */
  bypassApproval?: boolean;
  /**
   * Transform the tool set after all built-in wrapping (MCP + approval) is
   * applied but before the agent accepts prompts. Used by the durable-execution
   * engine to wrap each tool's execute with cache-check logic. Receives the
   * currently-wrapped tool set and must return a tool set of the same shape.
   */
  wrapToolSet?: (tools: Record<string, unknown>) => Record<string, unknown>;
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
