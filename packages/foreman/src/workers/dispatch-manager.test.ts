import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DispatchManager } from './dispatch-manager.js';
import type { A2AClient, StreamEvent, TaskPayload } from '@foreman-stack/shared';

// ---------------------------------------------------------------------------
// Mock A2AClient factory
// ---------------------------------------------------------------------------

interface MockClientControl {
  client: A2AClient;
  triggerDone: (taskId: string) => void;
  triggerError: (taskId: string, err: Error) => void;
}

function makeMockClient(): MockClientControl {
  const doneHandlers = new Map<string, Array<() => void>>();
  const errorHandlers = new Map<string, Array<(err: Error) => void>>();
  const subscribers = new Map<string, Array<(e: StreamEvent) => void>>();

  const client: A2AClient = {
    fetchAgentCard: vi.fn(),
    dispatchTask: vi.fn(),
    subscribe: vi.fn((taskId: string, listener: (e: StreamEvent) => void) => {
      if (!subscribers.has(taskId)) subscribers.set(taskId, []);
      subscribers.get(taskId)!.push(listener);
      return () => {
        const arr = subscribers.get(taskId) ?? [];
        const idx = arr.indexOf(listener);
        if (idx >= 0) arr.splice(idx, 1);
      };
    }),
    waitForDone: vi.fn((taskId: string) => {
      return new Promise<void>((resolve, reject) => {
        if (!doneHandlers.has(taskId)) doneHandlers.set(taskId, []);
        doneHandlers.get(taskId)!.push(resolve);
        if (!errorHandlers.has(taskId)) errorHandlers.set(taskId, []);
        errorHandlers.get(taskId)!.push(reject);
      });
    }),
    pollTask: vi.fn(),
    cancelTask: vi.fn().mockResolvedValue(undefined),
    respondToPermission: vi.fn(),
    sendFollowUp: vi.fn(),
  };

  return {
    client,
    triggerDone(taskId: string) {
      for (const h of doneHandlers.get(taskId) ?? []) h();
      doneHandlers.delete(taskId);
    },
    triggerError(taskId: string, err: Error) {
      for (const h of errorHandlers.get(taskId) ?? []) h(err);
      errorHandlers.delete(taskId);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKER_URL = 'http://worker.local';

const basePayload: TaskPayload = {
  description: 'do something',
  expected_output: null,
  inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
  originator_intent: 'test',
  max_delegation_depth: 3,
  parent_task_id: null,
  base_branch: null,
  timeout_sec: null,
  injected_mcps: [],
  cwd: null,
};

function nextTick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DispatchManager', () => {
  let ctrl: MockClientControl;

  beforeEach(() => {
    ctrl = makeMockClient();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Basic dispatch
  // -------------------------------------------------------------------------

  describe('basic dispatch', () => {
    it('returns a DispatchHandle with the taskId and agentUrl', async () => {
      (ctrl.client.dispatchTask as ReturnType<typeof vi.fn>).mockResolvedValue('task-abc');

      const dm = new DispatchManager(ctrl.client, 5);
      const handle = await dm.dispatch(WORKER_URL, basePayload);

      expect(handle.taskId).toBe('task-abc');
      expect(handle.agentUrl).toBe(WORKER_URL);

      ctrl.triggerDone('task-abc');
    });

    it('exposes onEvent and waitForDone on returned handle', async () => {
      (ctrl.client.dispatchTask as ReturnType<typeof vi.fn>).mockResolvedValue('task-1');

      const dm = new DispatchManager(ctrl.client, 5);
      const handle = await dm.dispatch(WORKER_URL, basePayload);

      expect(typeof handle.onEvent).toBe('function');
      expect(typeof handle.waitForDone).toBe('function');
      expect(typeof handle.cancel).toBe('function');
      expect(typeof handle.release).toBe('function');

      ctrl.triggerDone('task-1');
    });
  });

  // -------------------------------------------------------------------------
  // Semaphore
  // -------------------------------------------------------------------------

  describe('semaphore', () => {
    it('enforces max_parallel_dispatches — blocks 3rd when limit is 2', async () => {
      (ctrl.client.dispatchTask as ReturnType<typeof vi.fn>).mockResolvedValue('task-x');

      const dm = new DispatchManager(ctrl.client, 2);

      const handle1 = await dm.dispatch(WORKER_URL, basePayload);
      const handle2 = await dm.dispatch(WORKER_URL, basePayload);

      // 3rd dispatch should block on semaphore
      let resolved3 = false;
      const promise3 = dm.dispatch(WORKER_URL, basePayload).then((h) => {
        resolved3 = true;
        ctrl.triggerDone('task-x');
        return h;
      });

      await nextTick();
      await nextTick();
      expect(resolved3).toBe(false);

      // Release handle1's pump → semaphore releases a slot
      ctrl.triggerDone('task-x');
      await promise3;
      expect(resolved3).toBe(true);

      // Silence the remaining handles
      void handle2;
      ctrl.triggerDone('task-x');
    });

    it('releases semaphore when dispatch fails all retries', async () => {
      vi.useFakeTimers();

      (ctrl.client.dispatchTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('always fails'));

      const dm = new DispatchManager(ctrl.client, 1);

      const failPromise = dm.dispatch(WORKER_URL, basePayload);
      const assertion = expect(failPromise).rejects.toThrow('always fails');

      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(7_000);

      await assertion;

      // Semaphore should now be free — next dispatch should not block
      (ctrl.client.dispatchTask as ReturnType<typeof vi.fn>).mockResolvedValue('task-ok');

      const handle = await dm.dispatch(WORKER_URL, basePayload);
      expect(handle.taskId).toBe('task-ok');
      ctrl.triggerDone('task-ok');
    });
  });

  // -------------------------------------------------------------------------
  // Retry before taskId
  // -------------------------------------------------------------------------

  describe('retry before taskId', () => {
    it('succeeds after 2 failures (3rd attempt)', async () => {
      vi.useFakeTimers();

      const err = new Error('network error');
      (ctrl.client.dispatchTask as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(err)
        .mockRejectedValueOnce(err)
        .mockResolvedValue('task-retry-ok');

      const dm = new DispatchManager(ctrl.client, 5);
      const dispatchPromise = dm.dispatch(WORKER_URL, basePayload);

      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(7_000);

      const handle = await dispatchPromise;

      expect(ctrl.client.dispatchTask).toHaveBeenCalledTimes(3);
      expect(handle.taskId).toBe('task-retry-ok');

      ctrl.triggerDone('task-retry-ok');
    });

    it('throws after all 3 attempts fail', async () => {
      vi.useFakeTimers();

      (ctrl.client.dispatchTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('permanent failure'));

      const dm = new DispatchManager(ctrl.client, 5);
      const dispatchPromise = dm.dispatch(WORKER_URL, basePayload);
      const assertion = expect(dispatchPromise).rejects.toThrow('permanent failure');

      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(7_000);

      await assertion;
      expect(ctrl.client.dispatchTask).toHaveBeenCalledTimes(3);
    });

    it('does not retry after taskId is received', async () => {
      (ctrl.client.dispatchTask as ReturnType<typeof vi.fn>).mockResolvedValue('task-fast');

      const dm = new DispatchManager(ctrl.client, 5);
      const handle = await dm.dispatch(WORKER_URL, basePayload);

      expect(ctrl.client.dispatchTask).toHaveBeenCalledTimes(1);
      ctrl.triggerDone(handle.taskId);
    });
  });

  // -------------------------------------------------------------------------
  // Semaphore auto-release via waitForDone
  // -------------------------------------------------------------------------

  describe('semaphore auto-release', () => {
    it('releases semaphore when pump exits via waitForDone', async () => {
      (ctrl.client.dispatchTask as ReturnType<typeof vi.fn>).mockResolvedValue('task-auto');

      const dm = new DispatchManager(ctrl.client, 1);

      const handle = await dm.dispatch(WORKER_URL, basePayload);
      expect(handle.taskId).toBe('task-auto');

      // Semaphore at capacity — 2nd dispatch should block
      let resolved2 = false;
      const dispatch2Promise = dm.dispatch(WORKER_URL, basePayload).then((h) => {
        resolved2 = true;
        return h;
      });

      await nextTick();
      expect(resolved2).toBe(false);

      // Pump exits → auto-release
      ctrl.triggerDone('task-auto');

      await dispatch2Promise;
      expect(resolved2).toBe(true);

      (ctrl.client.dispatchTask as ReturnType<typeof vi.fn>).mockResolvedValue('task-auto-2');
      ctrl.triggerDone('task-auto-2');
    });
  });

  // -------------------------------------------------------------------------
  // Cancel
  // -------------------------------------------------------------------------

  describe('cancel', () => {
    it('delegates cancel to A2AClient.cancelTask', async () => {
      (ctrl.client.dispatchTask as ReturnType<typeof vi.fn>).mockResolvedValue('task-cancel');

      const dm = new DispatchManager(ctrl.client, 5);
      const handle = await dm.dispatch(WORKER_URL, basePayload);

      await handle.cancel();

      expect(ctrl.client.cancelTask).toHaveBeenCalledWith('task-cancel');
      ctrl.triggerDone('task-cancel');
    });
  });
});
