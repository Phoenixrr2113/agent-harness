import { createInterface } from 'node:readline';
import type { Tool } from 'ai';
import { log } from '../core/logger.js';
import type { AIToolSet } from './tool-executor.js';

export type ApprovalMode = 'auto' | 'interactive' | 'deny' | 'allow';

export type ApprovalDecision = 'approve-once' | 'approve-session' | 'deny-once' | 'abort';

export interface ApprovalConfig {
  enabled: boolean;
  mode: ApprovalMode;
  tools: string[];
}

export interface ApprovalPromptRequest {
  toolName: string;
  input: unknown;
}

export type ApprovalHandler = (req: ApprovalPromptRequest) => Promise<ApprovalDecision>;

export interface ApprovalSessionState {
  alwaysApprove: Set<string>;
  aborted: boolean;
}

export function createApprovalSessionState(): ApprovalSessionState {
  return { alwaysApprove: new Set(), aborted: false };
}

/**
 * Resolve the effective approval mode based on config + TTY availability.
 * `auto` downgrades to `deny` when stdout is not a TTY (e.g. piped, CI).
 */
export function resolveApprovalMode(mode: ApprovalMode): Exclude<ApprovalMode, 'auto'> {
  if (mode !== 'auto') return mode;
  return process.stdout.isTTY ? 'interactive' : 'deny';
}

/**
 * Prompt the user for approval on stdout and read a single-letter response
 * from stdin. Returns a structured decision covering the four supported
 * options: approve once, approve-all-for-session, deny once, or abort.
 */
export const defaultApprovalHandler: ApprovalHandler = async (req) => {
  const preview = JSON.stringify(req.input).slice(0, 500);
  process.stdout.write(`\n⚠ Approval required: ${req.toolName}\n`);
  process.stdout.write(`  args: ${preview}${preview.length >= 500 ? '…' : ''}\n`);
  process.stdout.write(`  [y] yes  [n] no  [a] yes-to-all-for-this-tool  [q] quit\n> `);

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const answer = await new Promise<string>((resolve) => {
    rl.question('', (input) => {
      rl.close();
      resolve(input.trim().toLowerCase());
    });
  });

  switch (answer) {
    case 'y':
    case 'yes':
      return 'approve-once';
    case 'a':
    case 'all':
      return 'approve-session';
    case 'q':
    case 'quit':
    case 'abort':
      return 'abort';
    default:
      return 'deny-once';
  }
};

/**
 * Wrap a single tool so that its execute function checks approval before
 * running. Returns the original tool unchanged when the tool name is not
 * in the approval list, or when approval is disabled, or when mode=allow.
 *
 * Denied calls return a structured error result `{ approvalDenied, toolName,
 * reason }` — the AI SDK surfaces this to the model as a tool result, so
 * the model can react rather than aborting the whole run.
 */
export function wrapToolWithApproval(
  toolName: string,
  tool: Tool,
  config: ApprovalConfig,
  session: ApprovalSessionState,
  handler: ApprovalHandler = defaultApprovalHandler,
): Tool {
  if (!config.enabled) return tool;
  if (!config.tools.includes(toolName)) return tool;

  const mode = resolveApprovalMode(config.mode);
  if (mode === 'allow') return tool;

  const originalExecute = tool.execute;
  if (!originalExecute) return tool;

  return {
    ...tool,
    execute: async (input: unknown, opts: unknown) => {
      if (session.aborted) {
        return {
          approvalDenied: true,
          toolName,
          reason: 'Session aborted by user in a prior approval prompt.',
        };
      }
      if (session.alwaysApprove.has(toolName)) {
        return originalExecute(input as never, opts as never);
      }
      if (mode === 'deny') {
        log.warn(`approval: denying "${toolName}" (mode=deny, no TTY or configured deny-all)`);
        return {
          approvalDenied: true,
          toolName,
          reason: 'No TTY available for approval prompt. Set approval.mode to allow/interactive or use --approve-all.',
        };
      }

      const decision = await handler({ toolName, input });
      switch (decision) {
        case 'approve-once':
          return originalExecute(input as never, opts as never);
        case 'approve-session':
          session.alwaysApprove.add(toolName);
          return originalExecute(input as never, opts as never);
        case 'abort':
          session.aborted = true;
          return {
            approvalDenied: true,
            toolName,
            reason: 'User aborted the run during approval prompt.',
          };
        case 'deny-once':
        default:
          return {
            approvalDenied: true,
            toolName,
            reason: 'User declined the approval prompt.',
          };
      }
    },
  };
}

/**
 * Apply approval wrapping to every tool in a ToolSet whose name is in
 * `config.tools`. Returns a new ToolSet; the original is not mutated. Uses
 * a fresh session state so approval-all-for-this-tool decisions are scoped
 * to one agent run.
 */
export function wrapToolSetWithApproval(
  tools: AIToolSet,
  config: ApprovalConfig,
  sessionState?: ApprovalSessionState,
  handler?: ApprovalHandler,
): AIToolSet {
  if (!config.enabled) return tools;
  if (!config.tools.length) return tools;

  const session = sessionState ?? createApprovalSessionState();
  const out: AIToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    out[name] = wrapToolWithApproval(name, tool as Tool, config, session, handler) as typeof tool;
  }
  return out;
}
