import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Plan, PermissionRequest, StreamEvent, TaskResult } from '@foreman-stack/shared';
import type { WorkerCatalog, WorkerCatalogEntry } from '../workers/catalog.js';
import type { DispatchManager } from '../workers/dispatch-manager.js';
import type { ForemanConfig } from '../config.js';
import { DispatchHandle } from '../workers/task-handle.js';
import { SessionState } from '../session/state.js';
import { PlanAbortedError, PlanExecutor } from './executor.js';
import pino from 'pino';

// ---------------------------------------------------------------------------
// Types for mock control
// ---------------------------------------------------------------------------

interface MockHandleControl {
  handle: DispatchHandle;
  push: (event: StreamEvent) => void;
  complete: () => void;
  isCancelled: () => boolean;
}

// ---------------------------------------------------------------------------
// Mock DispatchHandle factory
// ---------------------------------------------------------------------------

function makeMockHandle(taskId: string, agentUrl = 'http://mock.test'): MockHandleControl {
  const queue: StreamEvent[] = [];
  const waiters: Array<(result: IteratorResult<StreamEvent>) => void> = [];
  let terminated = false;
  let cancelled = false;

  const genBase = {
    async next(): Promise<IteratorResult<StreamEvent>> {
      if (queue.length > 0) {
        return { value: queue.shift()!, done: false };
      }
      if (terminated) {
        return { value: undefined as unknown as StreamEvent, done: true };
      }
      return new Promise<IteratorResult<StreamEvent>>((resolve) => {
        waiters.push(resolve);
      });
    },
    async return(value?: unknown): Promise<IteratorResult<StreamEvent>> {
      terminated = true;
      for (const w of waiters) {
        w({ value: undefined as unknown as StreamEvent, done: true });
      }
      waiters.length = 0;
      queue.length = 0;
      return { value: value as StreamEvent, done: true };
    },
    async throw(err?: unknown): Promise<IteratorResult<StreamEvent>> {
      terminated = true;
      throw err;
    },
    [Symbol.asyncIterator]() {
      return this as AsyncGenerator<StreamEvent>;
    },
    async [Symbol.asyncDispose](): Promise<void> {
      await genBase.return(undefined);
    },
  };
  const gen = genBase as unknown as AsyncGenerator<StreamEvent>;

  const cancelFn = async () => {
    cancelled = true;
    await gen.return(undefined);
  };

  const handle = new DispatchHandle(taskId, agentUrl, gen, cancelFn);

  return {
    handle,
    push(event: StreamEvent) {
      if (waiters.length > 0) {
        waiters.shift()!({ value: event, done: false });
      } else {
        queue.push(event);
      }
    },
    complete() {
      terminated = true;
      for (const w of waiters) {
        w({ value: undefined as unknown as StreamEvent, done: true });
      }
      waiters.length = 0;
    },
    isCancelled: () => cancelled,
  };
}

// ---------------------------------------------------------------------------
// StreamEvent builders
// ---------------------------------------------------------------------------

function makeCompletedStatusEvent(taskId = 'task-1'): StreamEvent {
  const result: TaskResult = {
    status: 'completed',
    stop_reason: 'end_turn',
    summary: 'done',
    branch_ref: '',
    session_transcript_ref: '',
    error: null,
  };
  return {
    type: 'status',
    taskId,
    data: {
      state: 'completed',
      final: true,
      message: {
        parts: [{ kind: 'data', data: result }],
      },
    },
    timestamp: new Date().toISOString(),
  };
}

function makeFailedStatusEvent(taskId = 'task-1'): StreamEvent {
  const result: TaskResult = {
    status: 'failed',
    stop_reason: 'subprocess_crash',
    summary: 'something went wrong',
    branch_ref: '',
    session_transcript_ref: '',
    error: { code: 'worker_error', message: 'worker failed' },
  };
  return {
    type: 'status',
    taskId,
    data: {
      state: 'failed',
      final: true,
      message: {
        parts: [{ kind: 'data', data: result }],
      },
    },
    timestamp: new Date().toISOString(),
  };
}

function makePermissionEvent(taskId = 'task-1'): StreamEvent {
  return {
    type: 'status',
    taskId,
    data: {
      state: 'input-required',
      final: false,
      message: {
        parts: [
          {
            kind: 'data',
            data: {
              type: 'fs.write',
              path: '/tmp/file.txt',
              message: 'need permission',
            },
          },
        ],
      },
    },
    timestamp: new Date().toISOString(),
  };
}

function makeTextMessageEvent(text: string, taskId = 'task-1'): StreamEvent {
  return {
    type: 'message',
    taskId,
    data: { parts: [{ kind: 'text', text }] },
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeEntry(name: string): WorkerCatalogEntry {
  return {
    url: `http://${name}.test`,
    agent_card: { name, url: `http://${name}.test`, version: '1.0', description: '' },
    status: 'available',
    last_check_at: new Date(),
  };
}

function makePlan(
  batches: Array<{ batchId: string; subtasks: Array<{ id: string; agent: string }> }>,
): Plan {
  return {
    plan_id: 'plan-1',
    originator_intent: 'test',
    goal_summary: 'test goal',
    source: 'self_planned',
    batches: batches.map(({ batchId, subtasks }) => ({
      batch_id: batchId,
      subtasks: subtasks.map(({ id, agent }) => ({
        id,
        assigned_agent: agent,
        description: `Task ${id}`,
        expected_output: null,
        inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Executor setup
// ---------------------------------------------------------------------------

const silentLogger = pino({ level: 'silent' });

function makeExecutor(
  mockDispatch: ReturnType<typeof vi.fn>,
  opts: {
    workerNames?: string[];
    onWorkerEscalation?: (taskId: string, req: PermissionRequest) => Promise<void>;
    onSubtaskEvent?: (subtaskId: string, event: StreamEvent) => void;
  } = {},
): { executor: PlanExecutor; sessionState: SessionState } {
  const workerNames = opts.workerNames ?? ['worker-a'];
  const entries = workerNames.map(makeEntry);

  const catalog: WorkerCatalog = {
    getAvailable: () => entries,
    getAll: () => entries,
    isPlanner: () => false,
    loadFromConfig: async () => {},
    recheckUnreachable: async () => {},
  } as unknown as WorkerCatalog;

  const dispatchManager = {
    dispatch: mockDispatch,
  } as unknown as DispatchManager;

  const config: ForemanConfig = {
    foreman: { name: 'test', version: '1.0' },
    runtime: {
      default_task_timeout_sec: 30,
      max_parallel_dispatches: 10,
      max_concurrent_sessions: 5,
      worker_discovery_timeout_sec: 5,
      planner_response_timeout_sec: 30,
    },
    workers: [],
    llm: { model: 'claude-sonnet-4-6', api_key: 'test' },
    logging: { level: 'silent', format: 'json', destination: 'stderr' },
  } as unknown as ForemanConfig;

  const sessionState = new SessionState('test-session', '/tmp');

  const executor = new PlanExecutor({
    dispatchManager,
    catalog,
    sessionState,
    config,
    logger: silentLogger,
    onWorkerEscalation: opts.onWorkerEscalation,
    onSubtaskEvent: opts.onSubtaskEvent,
  });

  return { executor, sessionState };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlanExecutor', () => {
  let mockDispatch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockDispatch = vi.fn();
  });

  // -------------------------------------------------------------------------
  // Basic happy path
  // -------------------------------------------------------------------------

  it('single-batch single-subtask plan succeeds', async () => {
    const { handle, push, complete } = makeMockHandle('task-1');
    mockDispatch.mockResolvedValueOnce(handle);

    const { executor } = makeExecutor(mockDispatch);
    const plan = makePlan([{ batchId: 'b1', subtasks: [{ id: 's1', agent: 'worker-a' }] }]);

    const executePromise = executor.execute(plan, 'test intent');

    push(makeCompletedStatusEvent('task-1'));
    complete();

    const result = await executePromise;
    expect(result.subtaskResults).toHaveLength(1);
    expect(result.subtaskResults[0].subtaskId).toBe('s1');
    expect(result.subtaskResults[0].result.status).toBe('completed');
  });

  // -------------------------------------------------------------------------
  // Sequential batches
  // -------------------------------------------------------------------------

  it('second batch only dispatches after first batch completes', async () => {
    const ctrl1 = makeMockHandle('task-1');
    const ctrl2 = makeMockHandle('task-2');

    mockDispatch
      .mockResolvedValueOnce(ctrl1.handle)
      .mockResolvedValueOnce(ctrl2.handle);

    const { executor } = makeExecutor(mockDispatch, { workerNames: ['worker-a', 'worker-b'] });
    const plan = makePlan([
      { batchId: 'b1', subtasks: [{ id: 's1', agent: 'worker-a' }] },
      { batchId: 'b2', subtasks: [{ id: 's2', agent: 'worker-b' }] },
    ]);

    const executePromise = executor.execute(plan, 'test');

    // Flush microtasks — only batch 1 should have dispatched
    await Promise.resolve();
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    // Complete batch 1
    ctrl1.push(makeCompletedStatusEvent('task-1'));
    ctrl1.complete();

    // Give event loop time to advance to batch 2 dispatch
    await new Promise((r) => setImmediate(r));
    expect(mockDispatch).toHaveBeenCalledTimes(2);

    // Complete batch 2
    ctrl2.push(makeCompletedStatusEvent('task-2'));
    ctrl2.complete();

    await executePromise;
    expect(mockDispatch).toHaveBeenCalledTimes(2);
  });

  it('failure in batch 1 prevents batch 2 from dispatching', async () => {
    const ctrl1 = makeMockHandle('task-1');

    mockDispatch.mockResolvedValueOnce(ctrl1.handle);

    const { executor } = makeExecutor(mockDispatch, { workerNames: ['worker-a', 'worker-b'] });
    const plan = makePlan([
      { batchId: 'b1', subtasks: [{ id: 's1', agent: 'worker-a' }] },
      { batchId: 'b2', subtasks: [{ id: 's2', agent: 'worker-b' }] },
    ]);

    const executePromise = executor.execute(plan, 'test').catch(() => {});

    ctrl1.push(makeFailedStatusEvent('task-1'));
    ctrl1.complete();

    await executePromise;

    // Batch 2 should never have been dispatched
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Parallel within batch
  // -------------------------------------------------------------------------

  it('all dispatch() calls in a batch start before any resolve', async () => {
    const dispatchCallCount = { value: 0 };
    const dispatchResolvers: Array<() => void> = [];
    const controls: MockHandleControl[] = [];

    for (let i = 0; i < 3; i++) {
      const ctrl = makeMockHandle(`task-${i}`);
      controls.push(ctrl);
      mockDispatch.mockImplementationOnce(
        () =>
          new Promise<DispatchHandle>((resolve) => {
            dispatchCallCount.value++;
            dispatchResolvers.push(() => resolve(ctrl.handle));
          }),
      );
    }

    const { executor } = makeExecutor(mockDispatch, {
      workerNames: ['worker-a', 'worker-b', 'worker-c'],
    });
    const plan = makePlan([
      {
        batchId: 'b1',
        subtasks: [
          { id: 's1', agent: 'worker-a' },
          { id: 's2', agent: 'worker-b' },
          { id: 's3', agent: 'worker-c' },
        ],
      },
    ]);

    const executePromise = executor.execute(plan, 'test');

    // Allow Promise.all to kick off all dispatch() calls (they are pending)
    await Promise.resolve();
    await Promise.resolve();

    // All 3 dispatch() calls should have been initiated (pending, not resolved)
    expect(dispatchCallCount.value).toBe(3);

    // Now resolve all dispatches and complete the handles
    dispatchResolvers.forEach((r) => r());
    await Promise.resolve();
    controls.forEach((ctrl, i) => {
      ctrl.push(makeCompletedStatusEvent(`task-${i}`));
      ctrl.complete();
    });

    const result = await executePromise;
    expect(result.subtaskResults).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // Failure and sibling cancellation
  // -------------------------------------------------------------------------

  it('throws PlanAbortedError when a subtask fails', async () => {
    const ctrl = makeMockHandle('task-1');
    mockDispatch.mockResolvedValueOnce(ctrl.handle);

    const { executor } = makeExecutor(mockDispatch);
    const plan = makePlan([{ batchId: 'b1', subtasks: [{ id: 's1', agent: 'worker-a' }] }]);

    const executePromise = executor.execute(plan, 'test');
    ctrl.push(makeFailedStatusEvent('task-1'));
    ctrl.complete();

    await expect(executePromise).rejects.toThrow(PlanAbortedError);
    const err = await executePromise.catch((e) => e);
    expect(err.subtaskId).toBe('s1');
    expect(err.taskResult.status).toBe('failed');
  });

  it('cancels sibling handles when a subtask fails in a batch', async () => {
    const ctrl1 = makeMockHandle('task-1'); // will fail
    const ctrl2 = makeMockHandle('task-2'); // sibling — should be cancelled
    const ctrl3 = makeMockHandle('task-3'); // sibling — should be cancelled

    mockDispatch
      .mockResolvedValueOnce(ctrl1.handle)
      .mockResolvedValueOnce(ctrl2.handle)
      .mockResolvedValueOnce(ctrl3.handle);

    const { executor } = makeExecutor(mockDispatch, {
      workerNames: ['worker-a', 'worker-b', 'worker-c'],
    });
    const plan = makePlan([
      {
        batchId: 'b1',
        subtasks: [
          { id: 's1', agent: 'worker-a' },
          { id: 's2', agent: 'worker-b' },
          { id: 's3', agent: 'worker-c' },
        ],
      },
    ]);

    const executePromise = executor.execute(plan, 'test').catch(() => {});

    // Let all 3 dispatch (they resolve immediately via mockResolvedValueOnce)
    await Promise.resolve();
    await Promise.resolve();

    // s1 fails
    ctrl1.push(makeFailedStatusEvent('task-1'));
    ctrl1.complete();

    await executePromise;

    expect(ctrl2.isCancelled()).toBe(true);
    expect(ctrl3.isCancelled()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Handle tracking in SessionState
  // -------------------------------------------------------------------------

  it('registers active handles in sessionState during execution and removes on completion', async () => {
    const ctrl = makeMockHandle('task-1');
    mockDispatch.mockResolvedValueOnce(ctrl.handle);

    const { executor, sessionState } = makeExecutor(mockDispatch);
    const plan = makePlan([{ batchId: 'b1', subtasks: [{ id: 's1', agent: 'worker-a' }] }]);

    const executePromise = executor.execute(plan, 'test');

    // Let dispatch resolve
    await Promise.resolve();
    await Promise.resolve();

    // Handle should be registered
    expect(sessionState.activeDispatchHandles.has('task-1')).toBe(true);

    ctrl.push(makeCompletedStatusEvent('task-1'));
    ctrl.complete();

    await executePromise;

    // Handle should be removed after completion
    expect(sessionState.activeDispatchHandles.has('task-1')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Escalation hook
  // -------------------------------------------------------------------------

  it('calls onWorkerEscalation when a permission event appears in the stream', async () => {
    const ctrl = makeMockHandle('task-1');
    mockDispatch.mockResolvedValueOnce(ctrl.handle);

    const escalationFn = vi.fn().mockResolvedValue(undefined);
    const { executor } = makeExecutor(mockDispatch, { onWorkerEscalation: escalationFn });
    const plan = makePlan([{ batchId: 'b1', subtasks: [{ id: 's1', agent: 'worker-a' }] }]);

    const executePromise = executor.execute(plan, 'test');

    // Push permission event then completed
    ctrl.push(makePermissionEvent('task-1'));
    ctrl.push(makeCompletedStatusEvent('task-1'));
    ctrl.complete();

    await executePromise;

    expect(escalationFn).toHaveBeenCalledOnce();
    const [taskId, req] = escalationFn.mock.calls[0] as [string, PermissionRequest];
    expect(taskId).toBe('task-1');
    expect(req.type).toBe('fs.write');
  });

  it('throws when no escalation handler is installed and a permission event arrives', async () => {
    const ctrl = makeMockHandle('task-1');
    mockDispatch.mockResolvedValueOnce(ctrl.handle);

    // No onWorkerEscalation provided — default should throw
    const { executor } = makeExecutor(mockDispatch);
    const plan = makePlan([{ batchId: 'b1', subtasks: [{ id: 's1', agent: 'worker-a' }] }]);

    const executePromise = executor.execute(plan, 'test');

    ctrl.push(makePermissionEvent('task-1'));
    ctrl.complete();

    await expect(executePromise).rejects.toThrow('no escalation handler installed');
  });

  // -------------------------------------------------------------------------
  // onSubtaskEvent hook
  // -------------------------------------------------------------------------

  it('calls onSubtaskEvent for every non-permission stream event', async () => {
    const ctrl = makeMockHandle('task-1');
    mockDispatch.mockResolvedValueOnce(ctrl.handle);

    const subtaskEvents: Array<[string, StreamEvent]> = [];
    const { executor } = makeExecutor(mockDispatch, {
      onSubtaskEvent: (subtaskId, event) => subtaskEvents.push([subtaskId, event]),
    });
    const plan = makePlan([{ batchId: 'b1', subtasks: [{ id: 's1', agent: 'worker-a' }] }]);

    const executePromise = executor.execute(plan, 'test');

    const msgEvent = makeTextMessageEvent('hello', 'task-1');
    const statusEvent = makeCompletedStatusEvent('task-1');
    ctrl.push(msgEvent);
    ctrl.push(statusEvent);
    ctrl.complete();

    await executePromise;

    expect(subtaskEvents).toHaveLength(2);
    expect(subtaskEvents[0][0]).toBe('s1');
    expect(subtaskEvents[0][1]).toBe(msgEvent);
    expect(subtaskEvents[1][1]).toBe(statusEvent);
  });

  it('does not call onSubtaskEvent for permission events', async () => {
    const ctrl = makeMockHandle('task-1');
    mockDispatch.mockResolvedValueOnce(ctrl.handle);

    const subtaskEvents: StreamEvent[] = [];
    const escalationFn = vi.fn().mockResolvedValue(undefined);
    const { executor } = makeExecutor(mockDispatch, {
      onWorkerEscalation: escalationFn,
      onSubtaskEvent: (_, event) => subtaskEvents.push(event),
    });
    const plan = makePlan([{ batchId: 'b1', subtasks: [{ id: 's1', agent: 'worker-a' }] }]);

    const executePromise = executor.execute(plan, 'test');

    ctrl.push(makePermissionEvent('task-1'));
    ctrl.push(makeCompletedStatusEvent('task-1'));
    ctrl.complete();

    await executePromise;

    // Only the completed status event should reach onSubtaskEvent
    expect(subtaskEvents).toHaveLength(1);
    expect(subtaskEvents[0].type).toBe('status');
    // Permission event should NOT be in subtaskEvents
    expect(escalationFn).toHaveBeenCalledOnce();
  });
});
