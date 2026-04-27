import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProxyAgentExecutor } from './executor.js';
import type { TaskHandler } from '@foreman-stack/shared';
import type { ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';

function makeBus(): ExecutionEventBus {
  return {
    publish: vi.fn(),
    finished: vi.fn(),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
  };
}

function makeCtx(taskId: string, parts: unknown[] = []): RequestContext {
  return {
    taskId,
    contextId: 'ctx-' + taskId,
    userMessage: { kind: 'message', messageId: 'm', parts, role: 'user' },
  } as unknown as RequestContext;
}

describe('ProxyAgentExecutor', () => {
  let executor: ProxyAgentExecutor;
  let taskHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    taskHandler = vi.fn().mockResolvedValue(undefined);
    executor = new ProxyAgentExecutor(taskHandler as unknown as TaskHandler, 'http://proxy:4000');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishes working status on first execute', async () => {
    const bus = makeBus();
    const payload = { description: 'D', originator_intent: 'I', max_delegation_depth: 0 };
    const ctx = makeCtx('t1', [{ kind: 'data', data: payload }]);
    await executor.execute(ctx, bus);
    expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ kind: 'status-update' }));
  });

  it('calls taskHandler with parsed payload on first execute', async () => {
    const bus = makeBus();
    const payload = { description: 'D', originator_intent: 'I', max_delegation_depth: 0 };
    const ctx = makeCtx('t2', [{ kind: 'data', data: payload }]);
    await executor.execute(ctx, bus);
    expect(taskHandler).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'D' }),
      expect.objectContaining({ taskId: 't2' }),
    );
  });

  it('completeTask resolves the completion deferred and publishes terminal status', async () => {
    const bus = makeBus();
    const payload = { description: 'D', originator_intent: 'I', max_delegation_depth: 0 };
    const ctx = makeCtx('t3', [{ kind: 'data', data: payload }]);

    let completionCalled = false;
    taskHandler.mockImplementation(async (_p: any, handle: any) => {
      executor.completeTask(handle.taskId, {
        status: 'completed',
        stop_reason: 'end_turn',
        summary: '',
        branch_ref: 'main',
        session_transcript_ref: '',
        error: null,
      });
      completionCalled = true;
    });

    await executor.execute(ctx, bus);
    expect(completionCalled).toBe(true);
    // Verify a terminal status-update was published
    const calls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const terminal = calls.find((c: any) => c[0]?.status?.state === 'completed');
    expect(terminal).toBeTruthy();
  });

  it('cancelTask resolves completion and invokes cancelFn', async () => {
    const bus = makeBus();
    const payload = { description: 'D', originator_intent: 'I', max_delegation_depth: 0 };
    const ctx = makeCtx('t4', [{ kind: 'data', data: payload }]);

    let cancelled = false;
    taskHandler.mockImplementation(async (_p: any, handle: any) => {
      executor.setCancelFn(handle.taskId, () => { cancelled = true; });
      // Hang — wait for cancel
      await new Promise((r) => setTimeout(r, 100));
    });

    await executor.execute(ctx, bus);
    await executor.cancelTask('t4', bus);
    expect(cancelled).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // requestFollowUp — permissive mode behaviour
  // ---------------------------------------------------------------------------

  const completedResult = {
    status: 'completed' as const,
    stop_reason: 'end_turn' as const,
    summary: 'plan here',
    branch_ref: 'main',
    session_transcript_ref: '',
    error: null,
  };

  it('requestFollowUp publishes input-required (non-final) with result data', async () => {
    const bus = makeBus();
    const payload = { description: 'D', originator_intent: 'I', max_delegation_depth: 0 };
    const ctx = makeCtx('t5', [{ kind: 'data', data: payload }]);

    taskHandler.mockImplementation(async (_p: any, handle: any) => {
      // Trigger requestFollowUp and leave it pending (don't await in handler)
      void executor.requestFollowUp(handle.taskId, completedResult);
    });

    await executor.execute(ctx, bus);

    const calls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const inputRequired = calls.find((c: any) => c[0]?.status?.state === 'input-required');
    expect(inputRequired).toBeTruthy();
    expect(inputRequired![0].final).toBe(false);
    expect(inputRequired![0].status.message.parts[0].data).toMatchObject({ status: 'completed' });
  });

  it('requestFollowUp resolves with text from follow-up execute() re-entry', async () => {
    const bus = makeBus();
    const payload = { description: 'D', originator_intent: 'I', max_delegation_depth: 0 };
    const ctx = makeCtx('t6', [{ kind: 'data', data: payload }]);

    let resolvedText: string | null = null;
    taskHandler.mockImplementation(async (_p: any, handle: any) => {
      resolvedText = await executor.requestFollowUp(handle.taskId, completedResult);
    });

    await executor.execute(ctx, bus);

    // Simulate follow-up sendMessage from A2A client
    const followUpCtx = makeCtx('t6', [{ kind: 'text', text: 'which option?' }] as any);
    await executor.execute(followUpCtx, makeBus());

    // Allow microtasks to flush
    await Promise.resolve();

    expect(resolvedText).toBe('which option?');
  });

  it('requestFollowUp task remains in tasks map until explicitly completed', async () => {
    const bus = makeBus();
    const payload = { description: 'D', originator_intent: 'I', max_delegation_depth: 0 };
    const ctx = makeCtx('t7', [{ kind: 'data', data: payload }]);

    taskHandler.mockImplementation(async (_p: any, handle: any) => {
      void executor.requestFollowUp(handle.taskId, completedResult);
    });

    await executor.execute(ctx, bus);
    // Task should still be alive (not completed yet)
    const calls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const completedCall = calls.find((c: any) => c[0]?.status?.state === 'completed');
    expect(completedCall).toBeFalsy();
  });

  it('requestFollowUp returns null when cancelTask fires while waiting', async () => {
    const bus = makeBus();
    const payload = { description: 'D', originator_intent: 'I', max_delegation_depth: 0 };
    const ctx = makeCtx('t8', [{ kind: 'data', data: payload }]);

    let resolvedText: string | null = 'not-yet';
    taskHandler.mockImplementation(async (_p: any, handle: any) => {
      resolvedText = await executor.requestFollowUp(handle.taskId, completedResult);
    });

    await executor.execute(ctx, bus);
    await executor.cancelTask('t8', bus);
    await Promise.resolve();

    expect(resolvedText).toBeNull();
  });

  it('cancelTask publishes canceled (final) even when pendingFollowUp is set', async () => {
    const bus = makeBus();
    const payload = { description: 'D', originator_intent: 'I', max_delegation_depth: 0 };
    const ctx = makeCtx('t9', [{ kind: 'data', data: payload }]);

    taskHandler.mockImplementation(async (_p: any, handle: any) => {
      void executor.requestFollowUp(handle.taskId, completedResult);
    });

    await executor.execute(ctx, bus);
    await executor.cancelTask('t9', bus);

    const calls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const canceledCall = calls.find((c: any) => c[0]?.status?.state === 'canceled' && c[0]?.final === true);
    expect(canceledCall).toBeTruthy();
  });
});
