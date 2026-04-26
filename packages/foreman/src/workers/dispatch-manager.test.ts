import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DispatchManager } from './dispatch-manager.js';
import type { A2AClient, StreamEvent, TaskPayload } from '@foreman-stack/shared';

// ---------------------------------------------------------------------------
// Mock A2AClient
// ---------------------------------------------------------------------------

const mockDispatchTask = vi.fn<(url: string, payload: TaskPayload) => Promise<string>>();
const mockStreamTask = vi.fn<(taskId: string) => AsyncIterableIterator<StreamEvent>>();
const mockPollTask = vi.fn<(taskId: string) => Promise<StreamEvent>>();
const mockCancelTask = vi.fn<(taskId: string) => Promise<void>>();

const mockClient: A2AClient = {
  fetchAgentCard: vi.fn(),
  dispatchTask: mockDispatchTask,
  streamTask: mockStreamTask,
  pollTask: mockPollTask,
  cancelTask: mockCancelTask,
  respondToPermission: vi.fn(),
};

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
};

function makeStatusEvent(
  taskId: string,
  state: string,
  final = false,
): StreamEvent {
  return { type: 'status', taskId, data: { state, final }, timestamp: '' };
}

async function* completedStream(taskId: string): AsyncGenerator<StreamEvent> {
  yield makeStatusEvent(taskId, 'completed', true);
}

async function consume(iter: AsyncIterableIterator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of iter) events.push(e);
  return events;
}

function nextTick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DispatchManager', () => {
  beforeEach(() => {
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
      mockDispatchTask.mockResolvedValue('task-abc');
      mockStreamTask.mockImplementation((taskId) => completedStream(taskId));

      const dm = new DispatchManager(mockClient, 5);
      const handle = await dm.dispatch(WORKER_URL, basePayload);

      expect(handle.taskId).toBe('task-abc');
      expect(handle.agentUrl).toBe(WORKER_URL);
    });

    it('streams events via for-await-of', async () => {
      mockDispatchTask.mockResolvedValue('task-1');
      mockStreamTask.mockImplementation((taskId) =>
        (async function* () {
          yield makeStatusEvent(taskId, 'working');
          yield makeStatusEvent(taskId, 'completed', true);
        })(),
      );

      const dm = new DispatchManager(mockClient, 5);
      const handle = await dm.dispatch(WORKER_URL, basePayload);
      const events = await consume(handle);

      expect(events).toHaveLength(2);
      expect((events[0].data as { state: string }).state).toBe('working');
      expect((events[1].data as { state: string }).state).toBe('completed');
    });
  });

  // -------------------------------------------------------------------------
  // Semaphore
  // -------------------------------------------------------------------------

  describe('semaphore', () => {
    it('enforces max_parallel_dispatches — blocks 3rd when limit is 2', async () => {
      let releaseStream1!: () => void;
      const stream1Gate = new Promise<void>((r) => (releaseStream1 = r));

      mockDispatchTask.mockResolvedValue('task-x');
      mockStreamTask.mockImplementation((taskId) =>
        (async function* () {
          if (taskId === 'task-x') await stream1Gate;
          yield makeStatusEvent(taskId, 'completed', true);
        })(),
      );

      const dm = new DispatchManager(mockClient, 2);

      const handle1 = await dm.dispatch(WORKER_URL, basePayload);
      await dm.dispatch(WORKER_URL, basePayload); // handle2 — semaphore now full

      // Start consuming handle1 so its generator is running
      const iter1 = consume(handle1);

      // 3rd dispatch should block on semaphore
      let resolved3 = false;
      const promise3 = dm.dispatch(WORKER_URL, basePayload).then((h) => {
        resolved3 = true;
        return h;
      });

      await nextTick();
      await nextTick();
      expect(resolved3).toBe(false);

      // Unblock stream1 → generator reaches terminal → semaphore releases a slot
      releaseStream1();
      await iter1;

      await promise3;
      expect(resolved3).toBe(true);
    });

    it('releases semaphore when dispatch fails all retries', async () => {
      vi.useFakeTimers();

      mockDispatchTask.mockRejectedValue(new Error('always fails'));

      const dm = new DispatchManager(mockClient, 1);

      const failPromise = dm.dispatch(WORKER_URL, basePayload);
      // Attach handler immediately to prevent unhandled rejection warning
      const assertion = expect(failPromise).rejects.toThrow('always fails');
      // Advance past all retries (1s + 5s with jitter headroom)
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(7_000);

      await assertion;

      // Semaphore should now be free — next dispatch should not block
      mockDispatchTask.mockResolvedValue('task-ok');
      mockStreamTask.mockImplementation((taskId) => completedStream(taskId));

      const handle = await dm.dispatch(WORKER_URL, basePayload);
      expect(handle.taskId).toBe('task-ok');
    });
  });

  // -------------------------------------------------------------------------
  // Retry before taskId
  // -------------------------------------------------------------------------

  describe('retry before taskId', () => {
    it('succeeds after 2 failures (3rd attempt)', async () => {
      vi.useFakeTimers();

      const err = new Error('network error');
      mockDispatchTask
        .mockRejectedValueOnce(err)
        .mockRejectedValueOnce(err)
        .mockResolvedValue('task-retry-ok');
      mockStreamTask.mockImplementation((taskId) => completedStream(taskId));

      const dm = new DispatchManager(mockClient, 5);
      const dispatchPromise = dm.dispatch(WORKER_URL, basePayload);

      // After 1st failure → sleep ~1s
      await vi.advanceTimersByTimeAsync(1_500);
      // After 2nd failure → sleep ~5s
      await vi.advanceTimersByTimeAsync(7_000);

      const handle = await dispatchPromise;

      expect(mockDispatchTask).toHaveBeenCalledTimes(3);
      expect(handle.taskId).toBe('task-retry-ok');
    });

    it('throws after all 3 attempts fail', async () => {
      vi.useFakeTimers();

      mockDispatchTask.mockRejectedValue(new Error('permanent failure'));

      const dm = new DispatchManager(mockClient, 5);
      const dispatchPromise = dm.dispatch(WORKER_URL, basePayload);
      // Attach handler immediately to prevent unhandled rejection warning
      const assertion = expect(dispatchPromise).rejects.toThrow('permanent failure');

      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(7_000);

      await assertion;
      expect(mockDispatchTask).toHaveBeenCalledTimes(3);
    });

    it('does not retry after taskId is received', async () => {
      mockDispatchTask.mockResolvedValue('task-fast');
      mockStreamTask.mockImplementation((taskId) => completedStream(taskId));

      const dm = new DispatchManager(mockClient, 5);
      const handle = await dm.dispatch(WORKER_URL, basePayload);
      await consume(handle);

      expect(mockDispatchTask).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Streaming → polling fallback
  // -------------------------------------------------------------------------

  describe('streaming → polling fallback', () => {
    it('falls back to polling when streamTask throws after taskId received', async () => {
      mockDispatchTask.mockResolvedValue('task-poll');

      // streamTask throws immediately (agent does not support SSE)
      mockStreamTask.mockImplementation(
        // eslint-disable-next-line require-yield
        async function* () {
          throw new Error('SSE not supported');
        },
      );

      mockPollTask.mockResolvedValue(makeStatusEvent('task-poll', 'completed', true));

      const dm = new DispatchManager(mockClient, 5);
      const handle = await dm.dispatch(WORKER_URL, basePayload);

      const events = await consume(handle);

      expect(mockPollTask).toHaveBeenCalledWith('task-poll');
      expect(events).toHaveLength(1);
      expect((events[0].data as { state: string }).state).toBe('completed');
    });

    it('polls multiple times until terminal state', async () => {
      vi.useFakeTimers();

      mockDispatchTask.mockResolvedValue('task-multi-poll');
      mockStreamTask.mockImplementation(async function* () {
        throw new Error('no SSE');
      });

      mockPollTask
        .mockResolvedValueOnce(makeStatusEvent('task-multi-poll', 'working'))
        .mockResolvedValueOnce(makeStatusEvent('task-multi-poll', 'working'))
        .mockResolvedValue(makeStatusEvent('task-multi-poll', 'completed', true));

      const dm = new DispatchManager(mockClient, 5);
      const handle = await dm.dispatch(WORKER_URL, basePayload);

      const eventsPromise = consume(handle);

      // Advance past poll sleep intervals (2s, 4s)
      await vi.advanceTimersByTimeAsync(2_500);
      await vi.advanceTimersByTimeAsync(5_000);

      const events = await eventsPromise;

      expect(mockPollTask).toHaveBeenCalledTimes(3);
      expect(events).toHaveLength(3);
    });

    it('yields error event after max consecutive poll failures', async () => {
      vi.useFakeTimers();

      mockDispatchTask.mockResolvedValue('task-lost');
      mockStreamTask.mockImplementation(async function* () {
        throw new Error('no SSE');
      });
      mockPollTask.mockRejectedValue(new Error('5xx'));

      const dm = new DispatchManager(mockClient, 5);
      const handle = await dm.dispatch(WORKER_URL, basePayload);

      const eventsPromise = consume(handle);

      // 10 consecutive failures → need to advance through all poll intervals
      // Intervals: 2s, 4s, 8s, 16s, 30s, 30s, 30s, 30s, 30s = ~180s total
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(35_000);
      }

      const events = await eventsPromise;

      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect((errorEvent!.data as { reason: string }).reason).toBe('connection_lost');
    });
  });

  // -------------------------------------------------------------------------
  // Cancel
  // -------------------------------------------------------------------------

  describe('cancel', () => {
    it('propagates cancel to DefaultA2AClient.cancelTask', async () => {
      mockDispatchTask.mockResolvedValue('task-cancel');
      mockCancelTask.mockResolvedValue(undefined);
      mockStreamTask.mockImplementation(
        async function* () {
          await new Promise<void>(() => {}); // never terminates
          yield {} as StreamEvent;
        },
      );

      const dm = new DispatchManager(mockClient, 5);
      const handle = await dm.dispatch(WORKER_URL, basePayload);

      await handle.cancel();

      expect(mockCancelTask).toHaveBeenCalledWith('task-cancel');
    });

    it('terminates iteration after cancel — generator suspended at yield', async () => {
      mockDispatchTask.mockResolvedValue('task-cancel2');
      mockCancelTask.mockResolvedValue(undefined);

      // Yields one event then hangs. cancel() is called while the generator is
      // suspended at the yield point (not the infinite await), so gen.return()
      // resolves immediately.
      mockStreamTask.mockImplementation((taskId) =>
        (async function* () {
          yield makeStatusEvent(taskId, 'working');
          await new Promise<void>(() => {}); // only reached if next() is called again
        })(),
      );

      const dm = new DispatchManager(mockClient, 5);
      const handle = await dm.dispatch(WORKER_URL, basePayload);

      // Consume first event — generator now suspended at the yield point
      const first = await handle.next();
      expect(first.done).toBe(false);

      // Cancel while suspended at yield — gen.return() completes quickly
      await handle.cancel();

      const result = await handle.next();
      expect(result.done).toBe(true);
    });
  });
});
