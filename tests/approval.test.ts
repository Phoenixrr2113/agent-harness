import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import {
  createApprovalSessionState,
  resolveApprovalMode,
  wrapToolWithApproval,
  wrapToolSetWithApproval,
  type ApprovalConfig,
  type ApprovalHandler,
} from '../src/runtime/approval.js';
import type { AIToolSet } from '../src/runtime/tool-executor.js';

function makeTool(execute: (input: unknown) => unknown) {
  return tool({
    description: 'test tool',
    inputSchema: z.object({ value: z.string() }),
    execute: async (input: unknown) => execute(input),
  });
}

function config(overrides: Partial<ApprovalConfig> = {}): ApprovalConfig {
  return { enabled: true, mode: 'interactive', tools: ['danger'], ...overrides };
}

describe('resolveApprovalMode', () => {
  it('returns modes other than auto unchanged', () => {
    expect(resolveApprovalMode('interactive')).toBe('interactive');
    expect(resolveApprovalMode('allow')).toBe('allow');
    expect(resolveApprovalMode('deny')).toBe('deny');
  });

  it('auto downgrades to deny when stdout is not a TTY', () => {
    const original = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    expect(resolveApprovalMode('auto')).toBe('deny');
    Object.defineProperty(process.stdout, 'isTTY', { value: original, configurable: true });
  });
});

describe('wrapToolWithApproval', () => {
  let executed: number;
  let session = createApprovalSessionState();

  beforeEach(() => {
    executed = 0;
    session = createApprovalSessionState();
  });

  it('returns original tool unchanged when enabled=false', async () => {
    const t = makeTool(() => { executed++; return 'ok'; });
    const wrapped = wrapToolWithApproval('danger', t, config({ enabled: false }), session);
    expect(wrapped).toBe(t);
  });

  it('returns original tool unchanged when tool not in approval list', async () => {
    const t = makeTool(() => { executed++; return 'ok'; });
    const wrapped = wrapToolWithApproval('safe', t, config({ tools: ['danger'] }), session);
    expect(wrapped).toBe(t);
  });

  it('returns original tool unchanged when mode=allow', async () => {
    const t = makeTool(() => { executed++; return 'ok'; });
    const wrapped = wrapToolWithApproval('danger', t, config({ mode: 'allow' }), session);
    expect(wrapped).toBe(t);
  });

  it('denies without prompting when mode=deny', async () => {
    const t = makeTool(() => { executed++; return 'ok'; });
    const handler: ApprovalHandler = vi.fn();
    const wrapped = wrapToolWithApproval('danger', t, config({ mode: 'deny' }), session, handler);
    const result = await wrapped.execute?.({ value: 'x' }, {} as never);
    expect(handler).not.toHaveBeenCalled();
    expect(executed).toBe(0);
    expect(result).toMatchObject({ approvalDenied: true, toolName: 'danger' });
  });

  it('approves once without sticking when user answers y', async () => {
    const t = makeTool(() => { executed++; return 'ok'; });
    const handler: ApprovalHandler = vi.fn().mockResolvedValue('approve-once');
    const wrapped = wrapToolWithApproval('danger', t, config(), session, handler);
    await wrapped.execute?.({ value: 'x' }, {} as never);
    await wrapped.execute?.({ value: 'y' }, {} as never);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(executed).toBe(2);
  });

  it('approve-session means the handler is called only once for that tool', async () => {
    const t = makeTool(() => { executed++; return 'ok'; });
    const handler: ApprovalHandler = vi.fn().mockResolvedValue('approve-session');
    const wrapped = wrapToolWithApproval('danger', t, config(), session, handler);
    await wrapped.execute?.({ value: 'x' }, {} as never);
    await wrapped.execute?.({ value: 'y' }, {} as never);
    await wrapped.execute?.({ value: 'z' }, {} as never);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(executed).toBe(3);
  });

  it('deny-once refuses one call without aborting future calls', async () => {
    const t = makeTool(() => { executed++; return 'ok'; });
    const handler: ApprovalHandler = vi
      .fn()
      .mockResolvedValueOnce('deny-once')
      .mockResolvedValueOnce('approve-once');
    const wrapped = wrapToolWithApproval('danger', t, config(), session, handler);
    const r1 = await wrapped.execute?.({ value: 'x' }, {} as never);
    const r2 = await wrapped.execute?.({ value: 'y' }, {} as never);
    expect(r1).toMatchObject({ approvalDenied: true });
    expect(r2).toBe('ok');
    expect(executed).toBe(1);
  });

  it('abort denies and poisons the session so subsequent calls fail fast', async () => {
    const t = makeTool(() => { executed++; return 'ok'; });
    const handler: ApprovalHandler = vi.fn().mockResolvedValueOnce('abort');
    const wrapped = wrapToolWithApproval('danger', t, config(), session, handler);
    await wrapped.execute?.({ value: 'x' }, {} as never);
    await wrapped.execute?.({ value: 'y' }, {} as never);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(executed).toBe(0);
  });
});

describe('wrapToolSetWithApproval', () => {
  it('wraps only the tools whose names are in the approval list', () => {
    const tools: AIToolSet = {
      danger: makeTool(() => 'bad'),
      safe: makeTool(() => 'good'),
    };
    const handler: ApprovalHandler = vi.fn();
    const out = wrapToolSetWithApproval(
      tools,
      { enabled: true, mode: 'interactive', tools: ['danger'] },
      undefined,
      handler,
    );
    expect(out.safe).toBe(tools.safe);
    expect(out.danger).not.toBe(tools.danger);
  });

  it('returns input unchanged when enabled=false or tools list empty', () => {
    const tools: AIToolSet = { a: makeTool(() => 'x') };
    const handler: ApprovalHandler = vi.fn();
    expect(wrapToolSetWithApproval(tools, { enabled: false, mode: 'interactive', tools: ['a'] }, undefined, handler)).toBe(tools);
    expect(wrapToolSetWithApproval(tools, { enabled: true, mode: 'interactive', tools: [] }, undefined, handler)).toBe(tools);
  });
});
