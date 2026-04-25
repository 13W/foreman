import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    // Give microtasks a tick
    await new Promise((r) => setTimeout(r, 10));
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
    await new Promise((r) => setTimeout(r, 20));
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
});
